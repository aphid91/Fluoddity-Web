"""Commands the piloting API needs and the GUI never did.

WHY THESE ARE NOT IN THE OTHER MIXINS
The existing handlers were written for imgui, which hands them OBJECTS it is
already holding -- the Setting a slider drew, the ConfigEntry a menu row
represents, the Checkpoint a list item wraps. A pilot has none of those. It has
names, paths and numbers off a wire.

So most of what follows is a lookup plus a delegating call: turn a name into the
object the real handler wants, then call the real handler. That is deliberate
and it is the whole design. Reimplementing "save the project" or "route a
setting edit" here would give the app two subtly different ways to do the same
thing, and the second one would be the one nobody tested.

Three commands genuinely implement something new, because nothing in the GUI
ever wanted them: screenshot capture, window resize, and sleep/wake.

A fourth group -- run_steps, fresh_candidate, evaluate_candidate -- exists for
LATENCY rather than for capability. Each is a sequence the pilot could issue as
separate calls, and at world_size 0.1 a candidate is ~0.3s of simulation, so six
HTTP round trips and their PNG encodes stop being free. Composing them here
turns a candidate into one request. They add no behaviour: every one is a
handful of calls to handlers that already exist. See docs/SEARCH.md.

EVERYTHING HERE RUNS ON THE MAIN THREAD, inside the frame loop's drain step.
The API's socket thread never calls these directly -- see api/protocol.py for
the handoff. Anything touching GL depends on that and says so.
"""

from __future__ import annotations

import io
import threading
import time
from pathlib import Path

import glfw

from camera import CameraMode
from particle_system import mutation, persistence
from particle_system.picker import DEFAULT_PICK_RADIUS_PX, radius_px_to_world
from ui import settings_spec as spec

from .clipboard_commands import Checkpoint

# `api` is NOT imported here. It is the optional transport, and importing it at
# module scope would make these handlers -- which are useful on their own --
# depend on the socket layer they are only sometimes driven by. start_api()
# imports it at the point it is actually wanted.

#: Where a relative path handed to the API resolves from. The repo root, NOT
#: the working directory: the app already refuses to depend on CWD (shaders and
#: configs are located relative to their own modules), and a pilot launched from
#: a different folder than the app must not get a different filesystem.
_REPO_ROOT = Path(__file__).parent.parent

#: How long the frame loop parks per idle iteration while asleep. Short enough
#: that the window keeps servicing OS events and a wake lands promptly, long
#: enough that parking costs essentially no CPU.
IDLE_POLL_SECONDS = 0.05

#: Default cap on a sleep, in seconds. A pilot that dies mid-schedule must not
#: leave a window that can only be killed from Task Manager.
DEFAULT_SLEEP_TIMEOUT = 300.0

#: Ceiling on one run_steps() call. The frame loop is blocked for the whole of
#: it -- no render, no input, no OS event pump -- so this is the point past
#: which the window would be marked unresponsive. At world_size 0.1 (~17k
#: steps/s) this is about ten seconds; at full size, closer to three minutes,
#: which is why a caller wanting a long warmup should issue several calls.
MAX_RUN_STEPS = 200_000

#: The entity a search selects from. Arbitrary BY CONSTRUCTION: the search runs
#: at cohorts=1, where get_cohort() returns a fraction in [0,1) for every index
#: and the shader floors it, so every particle carries the identical rule.
#: There is nothing to choose between them, so choose the cheapest.
_SEARCH_ENTITY_INDEX = 0


class ApiCommands:
    """API handlers. Expects the Orchestrator's attributes."""

    # ------------------------------------------------------------------
    # Transport wiring
    # ------------------------------------------------------------------

    def start_api(self, port):
        """Bring up the piloting API on `port`. Called once, from main.py.

        Everything the server can reach goes through the PilotHost built here:
        queue a command, or wake the loop. It never sees the Orchestrator, for
        the same reason the interface never does.
        """
        from api import CommandQueue, PilotHost, PilotServer, ScheduleRunner
        from api.server import API_COMMANDS

        self._api_queue = CommandQueue(self._api_dispatch)
        self._api_schedules = ScheduleRunner(
            self._api_dispatch, lambda: self.app_frame, API_COMMANDS)

        self.pilot = PilotServer(
            port,
            PilotHost(submit=self._api_queue.submit, wake=self._cmd_wake),
            schedules=self._api_schedules,
            # Answerable WITHOUT the frame loop, which is the point: a pilot
            # polls this precisely when the app is asleep and draining nothing.
            health=lambda: {'ok': True, 'frame': self.app_frame,
                            'asleep': self._asleep,
                            'paused': self.paused},
        )
        self.pilot.start()

    def _api_dispatch(self, name, args):
        """Run one command by name. Main thread only.

        The same table the interface dispatches into -- the API adds no second
        registry, it only reaches a subset of the one that already exists (the
        allowlist lives in api/server.py, where the wire is).
        """
        handler = self.commands.get(name)
        if handler is None:
            raise ValueError(f"unknown command {name!r}")
        return handler(**(args or {}))

    def _drain_api(self):
        """Service queued commands, then the schedule. Top of the frame.

        ORDER MATTERS. Immediate requests run first so that a wake, or a
        cancel, takes effect before a scheduled command that the pilot was
        trying to get ahead of.
        """
        if self.pilot is None:
            return
        self._api_queue.drain()
        # Not while parked: a schedule measured in app frames must not advance
        # through frames that are not being drawn.
        if not self._asleep:
            self._api_schedules.tick(self.app_frame)

    # ------------------------------------------------------------------
    # Paths
    # ------------------------------------------------------------------

    def _resolve_path(self, path):
        """An API-supplied path, made absolute against the repo root."""
        resolved = Path(path).expanduser()
        if not resolved.is_absolute():
            resolved = _REPO_ROOT / resolved
        return resolved

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    def _cmd_set_setting(self, source, field, value):
        """Edit a setting named by (source, field).

        DOES NOT CLAMP to the registry's lo/hi. Those bounds are soft in the
        GUI too -- ctrl+click types a value outside them -- and a search over
        mutation space is exactly the caller that legitimately wants to leave
        the nominal range. Clamping here would make the API stricter than the
        interface it mirrors, and silently so.

        Returns the value that landed, so a caller can see what the app
        actually accepted rather than assuming its request survived intact.
        """
        setting = spec.find(source, field)
        if setting is None:
            raise ValueError(f"unknown setting {source}.{field}")

        # INT-kinded settings are integers on the far side of the wire too;
        # JSON will happily deliver 60.0 for physics_steps, and a float there
        # reaches range() and raises three modules away from the cause.
        if setting.kind in (spec.INT, spec.GATED_INT):
            value = int(value)
        elif setting.kind == spec.BOOL:
            value = bool(value)
        elif setting.kind != spec.CHOICE:
            value = float(value)

        self._cmd_edit_setting(setting, value)
        return {'source': source, 'field': field, 'value': value,
                'disruptive': setting.disruptive}

    # ------------------------------------------------------------------
    # Configs
    # ------------------------------------------------------------------

    def _cmd_save_config_to(self, path, save_all=False, adopt=False):
        """Save the project to an arbitrary path.

        SEPARATE FROM _cmd_save_config, whose contract is "a name, in the
        user's save folder" -- sanitize_filename() exists precisely so a typed
        name cannot escape configs/. A pilot is not a typing user and does need
        to write to documents/sequences/, so it gets a path instead of a name.
        Both end at _write_project, which is the only place a save happens.

        `adopt` DEFAULTS TO FALSE and that is the interesting parameter. A GUI
        save renames the project and rescans the config tree, because choosing
        a destination in a dialog IS an act of adoption. A pilot writing 500
        candidates into a sequence folder wants neither: 500 renames it did not
        ask for, and 500 full-tree discover() scans in the middle of a search
        loop.
        """
        target = self._resolve_path(path)
        if target.suffix != '.json':
            target = target.with_suffix('.json')

        error = self._write_project(target, save_all)
        if error:
            raise OSError(error)

        if adopt:
            self.system.set_config_path(str(target))
            self.project = self.project.renamed(target.stem)
            self._refresh_config_list()

        return {'path': str(target), 'adopted': bool(adopt)}

    def _cmd_load_config_path(self, path):
        """Load a config by path rather than by menu entry.

        Builds the ConfigEntry the real handler expects. The category is
        cosmetic here -- it exists so the load menu can group files -- so this
        reports where the file actually came from rather than inventing a
        category the menu would then disagree with.
        """
        target = self._resolve_path(path)
        if not target.is_file():
            raise FileNotFoundError(f"no config at {target}")

        entry = persistence.ConfigEntry(name=target.stem, path=target,
                                        category=target.parent.name)
        self._cmd_load_config(entry)
        return {'path': str(target), 'name': entry.name}

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def _find_checkpoint(self, name):
        for checkpoint in self.checkpoints:
            if checkpoint.name == name:
                return checkpoint
        raise ValueError(f"no checkpoint named {name!r}")

    def _cmd_set_checkpoint_named(self, name):
        """Capture the project under a chosen name.

        The GUI's _cmd_set_checkpoint auto-names ('<project>00', '<project>01')
        because a user clicking a button has not got a name in mind. A pilot
        does: the name is how it will find this state again after forty other
        checkpoints have come and gone.
        """
        self.checkpoints = [c for c in self.checkpoints if c.name != name]
        self.checkpoints.insert(
            0, Checkpoint(name=name, project=self.project.renamed(name)))
        return {'name': name, 'count': len(self.checkpoints)}

    def _cmd_load_checkpoint_named(self, name):
        self._cmd_load_checkpoint(self._find_checkpoint(name))
        return {'name': name}

    def _cmd_delete_checkpoint_named(self, name):
        self._cmd_delete_checkpoint(self._find_checkpoint(name))
        return {'name': name, 'count': len(self.checkpoints)}

    # ------------------------------------------------------------------
    # Selection
    # ------------------------------------------------------------------

    def _cmd_select_particle_at(self, index=None, world=None, pixel=None):
        """Adopt a particle's rule. Exactly one of index / world / pixel.

        INDEX IS THE PATH A PILOT SHOULD USE, and it is synchronous. The rule a
        given entity obeys is a pure function of (config, index, entity_count)
        -- mutation.py reproduces the shader's arithmetic exactly, which is why
        selection never needed a readback -- so naming an index skips the GPU
        picker entirely and the answer is exact and immediate.

        world/pixel go through the picker and are therefore ASYNCHRONOUS: the
        pick is dispatched now and adopted at the top of the NEXT frame by
        _resolve_pending_selection(). The return value says so rather than
        hiding it, because a pilot that saves the config on the same frame it
        selected would otherwise write the PREVIOUS rule and never notice.
        """
        given = [k for k, v in (('index', index), ('world', world),
                                ('pixel', pixel)) if v is not None]
        if len(given) != 1:
            raise ValueError("pass exactly one of index, world, pixel; "
                             f"got {given or 'none'}")

        if index is not None:
            count = self.system.entity_count
            index = int(index)
            if not 0 <= index < count:
                raise ValueError(f"index {index} outside 0..{count - 1}")
            before = self.project
            rule = mutation.entity_rule(self.project.config, index, count)
            self._set_project(self.project.adopt_rule(rule))
            self._record_history(before, f"select particle #{index}")
            return {'pending': False, 'index': index}

        if world is not None:
            # Straight to the picker, skipping screen_to_world: a pilot naming
            # a world point means that point, and routing it through the view
            # transform would make the same request land differently depending
            # on where the camera happened to be.
            radius = radius_px_to_world(
                DEFAULT_PICK_RADIUS_PX, self.window.size(),
                self.system.canvas_size, self.camera.state.pan,
                self.camera.state.zoom)
            self.system.request_pick((float(world[0]), float(world[1])), radius)
            self._pending_selection = self.project
        else:
            self._cmd_select_particle((float(pixel[0]), float(pixel[1])))

        return {'pending': True, 'resolves_on_frame': self.app_frame + 1}

    # ------------------------------------------------------------------
    # Camera, window, pause
    # ------------------------------------------------------------------

    def _cmd_set_camera(self, pan=None, zoom=None, mode=None):
        """Set any of pan / zoom / mode. Omitted fields are left alone.

        Goes through set_zoom() rather than assigning, so the API cannot put
        the camera somewhere the GUI could not -- the clamp is a property of
        the camera, not of the widget that happened to drive it.
        """
        state = self.camera.state
        if pan is not None:
            state.pan = (float(pan[0]), float(pan[1]))
        if zoom is not None:
            state.set_zoom(float(zoom))
        if mode is not None:
            resolved = next((m for m in CameraMode if m.value == mode), None)
            if resolved is None:
                raise ValueError(f"unknown camera mode {mode!r}")
            state.mode = resolved
        return {'pan': list(state.pan), 'zoom': state.zoom,
                'mode': state.mode.value}

    def _cmd_set_paused(self, paused):
        """Set the pause state directly.

        An idempotent setter beside the GUI's toggle, because a script that has
        lost track of the current state cannot toggle its way to a known one.
        """
        self.paused = bool(paused)
        return {'paused': self.paused}

    def _cmd_set_camera_mode(self, mode):
        return self._cmd_set_camera(mode=mode)

    def _cmd_set_window_size(self, width, height):
        """Resize the window. TAKES EFFECT NEXT FRAME.

        The lag is reported rather than papered over: glfw delivers the resize
        during poll_events(), at the top of the following frame, so a caller
        that resizes and captures in the same breath captures the old size.
        This is the most likely piloting bug in the whole API, which is why the
        response says so out loud.
        """
        self.window.set_size(width, height)
        return {'requested': [int(width), int(height)],
                'pending': True, 'effective_after_frames': 1,
                'current_framebuffer': list(self.window.size())}

    # ------------------------------------------------------------------
    # Sleep / wake
    # ------------------------------------------------------------------

    def _cmd_sleep(self, timeout=DEFAULT_SLEEP_TIMEOUT):
        """Park the frame loop until woken.

        NOT THE SAME AS PAUSE, and the difference is the point. Pausing freezes
        the physics but keeps rendering and the whole interface live -- a
        paused app still burns a GPU. Sleeping stops the loop: no physics, no
        render, no imgui. It exists so the pilot can compute embeddings without
        this process competing for the same GPU.

        The timeout is a safety valve, not a feature. A pilot that crashes
        while the app is asleep would otherwise leave a window that responds to
        nothing; waking on our own after a while means the worst case is a
        confusing few minutes rather than a kill.
        """
        self._asleep = True
        self._sleep_deadline = (None if timeout is None
                                else time.monotonic() + float(timeout))
        return {'asleep': True, 'timeout': timeout}

    def _cmd_wake(self):
        """Wake the frame loop.

        Safe to call from the API thread, which is the entire reason it does
        nothing but assign: while asleep the main thread is parked inside
        glfw.wait_events_timeout() and is not draining commands, so a wake that
        needed the frame loop to run could never arrive.
        """
        self._asleep = False
        self._sleep_deadline = None
        return {'asleep': False}

    def _api_idle(self):
        """One iteration of the parked loop.

        PUMPS THE OS EVENT QUEUE, which is why this is not time.sleep(). A
        top-level window that stops servicing its message queue gets marked
        unresponsive by Windows and greys out -- and the whole premise here is
        that the operator is watching the app work, so a ghosted window is a
        real failure rather than a cosmetic one. wait_events_timeout costs
        essentially no CPU and keeps the window alive.
        """
        glfw.wait_events_timeout(IDLE_POLL_SECONDS)

        # The X button has to keep working while parked, or a sleeping app can
        # only be killed.
        if self.window.should_close():
            self._asleep = False
            return

        if (self._sleep_deadline is not None
                and time.monotonic() >= self._sleep_deadline):
            print("API: sleep timed out; waking")
            self._asleep = False
            self._sleep_deadline = None

    # ------------------------------------------------------------------
    # Screenshots
    # ------------------------------------------------------------------

    def _screenshot_target(self, size):
        """A cached offscreen RGB target of `size`, reallocated when it changes.

        Cached rather than created per capture because a schedule that shoots
        every frame at a fixed size would otherwise allocate and free a
        framebuffer every frame.
        """
        if getattr(self, '_shot_fbo', None) is not None:
            if self._shot_size == size:
                return self._shot_fbo
            self._shot_fbo.release()
            self._shot_texture.release()

        ctx = self.window.ctx
        self._shot_texture = ctx.texture(size, 4, dtype='f1')
        self._shot_fbo = ctx.framebuffer(color_attachments=[self._shot_texture])
        self._shot_size = size
        return self._shot_fbo

    def _cmd_screenshot(self, path=None, width=None, height=None,
                        include_overlays=False):
        """Capture the rendered frame. Returns PNG bytes, or writes to `path`.

        NO IMGUI, BY CONSTRUCTION rather than by suppression. The interface is
        drawn into the default framebuffer at the end of the frame; this
        assembles a second time into an offscreen target the UI never touches,
        so there is nothing to hide. That also means a capture can be taken at
        a size the window is not.

        OVERLAYS ARE OFF BY DEFAULT. The reticle and the field overlay are
        interface, not image -- an embedding of a frame with a reticle in it is
        partly an embedding of the reticle.

        RESOLUTION IS RESAMPLING, NOT DETAIL. The camera's accumulation buffer
        is allocated at window size, so asking for 1024x1024 from a 512x512
        window enlarges 512x512 worth of pixels. For genuine detail, resize the
        window first and let a frame pass.
        """
        # A GL call from the API's socket thread produces intermittent
        # corruption rather than a clean error, and would be miserable to
        # track down. Two lines to make it impossible.
        if threading.get_ident() != self._main_thread_ident:
            raise RuntimeError("screenshot must run on the main thread")

        source = self.camera.result()
        if source is None:
            raise RuntimeError("no rendered frame yet")

        window_size = self.window.size()
        size = (int(width or window_size[0]), int(height or window_size[1]))
        if size[0] <= 0 or size[1] <= 0:
            raise ValueError(f"bad capture size {size}")

        fbo = self._screenshot_target(size)
        overlays = (self._overlay_args() if include_overlays
                    else {'show_field': False, 'reticle_radius': 0.0})
        self.assembler.present(
            source,
            framebuffer=fbo,
            prefs=self.prefs,
            canvas_size=self.system.canvas_size,
            # The FBO's own size, so the letterbox is computed for the image
            # being made rather than for the window it is not going to.
            window_size=size,
            cam_pan=self.camera.state.pan,
            cam_zoom=self.camera.state.zoom,
            strafe_field=self.strafe_field.current_texture(),
            **overlays,
        )

        # A synchronous readback, and a deliberate one: it stalls the GPU, but a
        # screenshot is an explicitly requested act rather than a per-frame
        # cost, so paying for it here is cheaper than the machinery that would
        # avoid it.
        raw = fbo.read(components=3, alignment=1)

        # Imported here rather than at module scope: Pillow is only needed to
        # encode a capture, and the app runs perfectly well without anyone ever
        # taking one.
        from PIL import Image
        image = Image.frombytes('RGB', size, raw).transpose(
            Image.FLIP_TOP_BOTTOM)      # GL origin is bottom-left

        # The render path binds its own framebuffers every frame, so the
        # capture target being left bound here is harmless -- but leaving the
        # screen bound is what every other path in this app assumes.
        self.window.ctx.screen.use()

        if path is None:
            buffer = io.BytesIO()
            image.save(buffer, format='PNG')
            return {'png': buffer.getvalue(), 'size': list(size)}

        target = self._resolve_path(path)
        if target.suffix.lower() not in ('.png', '.jpg', '.jpeg'):
            target = target.with_suffix('.png')
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target)
        return {'path': str(target), 'size': list(size)}

    # ------------------------------------------------------------------
    # Search support
    #
    # Composed from the handlers above. These exist because the search loop is
    # latency-bound, not because the app needs to know what a search is.
    # ------------------------------------------------------------------

    def _cmd_run_steps(self, steps, capture=None):
        """Advance EXACTLY `steps` physics steps, then optionally capture.

        THE REPRODUCIBLE WARMUP. The obvious alternative -- schedule the
        capture N app frames out -- is wrong for evaluating candidates: an app
        frame runs `physics_steps` sub-steps, so "1000 frames" is 30,000 steps
        at the default rate and 60,000 at double, and a search whose candidates
        depend on the physics rate is not comparing like with like. Counting
        steps is the only way to make two candidates the same experiment.

        BLOCKS THE FRAME LOOP for the duration: nothing renders, no input is
        polled, no OS events are pumped. That is the intended trade -- a
        warmup nobody is going to look at should not pay for 160 presented
        frames -- but it is why MAX_RUN_STEPS exists. Split a long warmup
        across several calls if the window needs to stay responsive.

        Rendering is NOT skipped as an optimization. It was measured: at
        world_size 1.0 the render costs 6-9% on top of advance(), which is
        inside the noise. The simulation is GPU-bound in advance() itself, so
        there is nothing to win by dropping the frame -- see docs/SEARCH.md.
        """
        steps = int(steps)
        if steps < 0:
            raise ValueError(f"steps must be >= 0, got {steps}")
        if steps > MAX_RUN_STEPS:
            raise ValueError(
                f"steps {steps} exceeds MAX_RUN_STEPS ({MAX_RUN_STEPS}); "
                "issue several calls so the window stays responsive")

        if self.paused:
            raise ValueError("cannot run steps while paused; set_paused(false)")

        # Hoisted exactly as the frame loop hoists them: the field cannot
        # change while this runs (no input is being polled), and shove is a
        # cursor condition that has no meaning here.
        strafe_field = self.strafe_field.current_texture()
        for _ in range(steps):
            self.system.advance(strafe_field, None)

        result = {'steps': steps, 'physics_frame': self.system.frame_count}
        if capture is not None:
            # A capture needs a rendered frame to assemble from, and the loop
            # has not run one since the simulation moved. Render here rather
            # than making the caller wait a frame -- which would also mean the
            # capture showed a state `physics_steps` further on than the one
            # it asked for.
            self._render_for_capture()
            result['capture'] = self._cmd_screenshot(**capture)
        return result

    def _render_for_capture(self):
        """Draw one camera sample of the CURRENT state, off the frame loop.

        A single sample, deliberately: motion blur averages several renders
        taken at different points in an advance, and there is no advance
        happening here. Averaging one moment N times is the same picture.
        """
        window_size = self.window.size()
        self.camera.begin_frame(window_size, 1)
        self.camera.render(
            canvas_texture=self.system.current_canvas_texture(),
            entity_buffer=self.system.entity_buffer,
            entity_count=self.system.entity_count,
            canvas_size=self.system.canvas_size,
            window_size=window_size,
            color_sensitivity=self.project.config.color_sensitivity,
            color_by_cohort=self.project.config.color_by_cohort,
        )

    def _cmd_fresh_candidate(self):
        """A brand-new random behaviour, made step-mutable.

        THE SECOND HALF IS NOT OPTIONAL. randomize_behavior zeroes the rule,
        and an all-zero rule is a SENTINEL: the shader generates a behaviour
        from mutation_seed instead of reading one, and generated rules are
        never mutated. So a fresh candidate ignores mutation_scale entirely --
        measured, scale 0.35 and scale 1.0 on a zeroed config give byte-
        identical results -- and cannot be stepped, only rerolled wholesale.

        Adopting the generated rule writes it into the config as a real rule.
        The sentinel stops firing, and the candidate becomes mutable like any
        other. Without this a search's random immigrants would be permanently
        sterile, in a way that looks like the mutation rate being ignored.
        """
        self._cmd_randomize_behavior()
        self._cmd_select_particle_at(index=_SEARCH_ENTITY_INDEX)
        return {'rule': list(self.project.config.rule),
                'mutation_seed': self.project.config.mutation_seed}

    def _cmd_evaluate_candidate(self, warmup_steps, mutate=None, reset=True,
                                capture=None):
        """Optionally mutate, then run the candidate and capture it.

        ONE ROUND TRIP FOR ONE CANDIDATE. The sequence is the user's move
        recipe, and every step of it is an existing handler:

            mutation_scale = S        the population spreads around the rule
            select particle #0        adopt one variant as the new base rule
            mutation_scale = 0        the child is ONE behaviour, not a spread
            reset                     start from a clean canvas
            run N steps               the warmup
            capture                   the thing that gets embedded

        `mutate` is {'scale': S, 'seed': optional}. Omit it to evaluate the
        current config unchanged -- which is what a parent needs.

        WHY SCALE RETURNS TO ZERO. A candidate is judged from one picture, so
        the population has to obey one rule while it is being judged; at
        nonzero scale the image is a blend of a whole spread of behaviours and
        the score would describe the spread rather than the child.
        """
        applied = None
        if mutate is not None:
            scale = float(mutate['scale'])
            seed = mutate.get('seed')
            if seed is not None:
                self._cmd_set_setting('config', 'mutation_seed', float(seed))
            self._cmd_set_setting('config', 'mutation_scale', scale)
            # Synchronous and exact: with cohorts=1 the rule is a pure function
            # of the config and the index, so no GPU pick is involved.
            self._cmd_select_particle_at(index=_SEARCH_ENTITY_INDEX)
            self._cmd_set_setting('config', 'mutation_scale', 0.0)
            applied = {'scale': scale,
                       'seed': self.project.config.mutation_seed}

        if reset:
            self._cmd_reset()

        result = self._cmd_run_steps(warmup_steps, capture=capture)
        result['mutated'] = applied
        result['rule'] = list(self.project.config.rule)
        return result

    # ------------------------------------------------------------------
    # State
    # ------------------------------------------------------------------

    def _cmd_query_state(self):
        """Everything a pilot needs to decide what to do next, JSON-safe.

        Deliberately NOT the UI's status dict. That one carries live objects
        (ConfigEntry lists, Checkpoint objects, a tooltip renderer) which do not
        serialize and which the API has no business handing out. This reports
        the same underlying values, flattened to scalars.
        """
        cam = self.camera.state
        config = self.project.config
        return {
            'app_frame': self.app_frame,
            'physics_frame': self.system.frame_count,
            'paused': self.paused,
            'asleep': self._asleep,

            'project': self.project.name,
            'config_path': self.system.config_path,
            'config_count': self.project.count,
            'selected_config': self.project.selected,

            'entity_count': self.system.entity_count,
            'canvas_size': list(self.system.canvas_size),
            # Both, because HiDPI makes them differ and a capture follows the
            # framebuffer rather than the window.
            'framebuffer_size': list(self.window.size()),

            'camera': {'pan': list(cam.pan), 'zoom': cam.zoom,
                       'mode': cam.mode.value},

            'mutation_seed': config.mutation_seed,
            'mutation_scale': config.mutation_scale,
            'cohorts': config.cohorts,

            # A pilot that selected by world/pixel must wait for this to clear
            # before reading the rule it asked for.
            'selection_pending': self._pending_selection is not None,
            'selected_entity': (self.selected.index if self.selected.hit
                                else None),

            'checkpoints': [c.name for c in self.checkpoints],
            'mouse_mode': self.mouse_mode.value,
            'can_undo': self.history.can_undo,
            'can_redo': self.history.can_redo,

            'prefs': {'brightness': self.prefs.brightness,
                      'physics_steps': self.prefs.physics_steps,
                      'motion_blur_samples': self.prefs.motion_blur_samples,
                      'bloom_enabled': self.prefs.bloom_enabled,
                      'world_size': self.prefs.world_size,
                      'canvas_aspect': self.prefs.canvas_aspect},
        }
