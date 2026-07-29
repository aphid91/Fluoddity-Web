"""Orchestrator: the sole broker of commands and data between modules.

Owns one instance each of AppWindow, Camera, ParticleSystem, and UI. Modules
hold no references to one another; all inter-module communication flows through
here. Two examples of the pattern:

  - Data: each frame the Orchestrator pulls the current canvas texture from
    ParticleSystem (via a narrow accessor) and hands it to Camera. Camera never
    holds a persistent reference to it.
  - Commands: UI reports named intents ('reload', 'next_preset', ...) which the
    Orchestrator translates into public method calls on the right module.

The moderngl `ctx` is the one sanctioned shared substrate: created by AppWindow
and injected once into Camera and ParticleSystem at construction.

THIS FILE HOLDS THE LOOP, THE WIRING AND THE STATE -- NOT THE HANDLERS.
"Sole broker" means it routes, not that it implements. As features landed the
class grew to 24 handlers in 574 lines, and its own section comments were
marking the seams; those groups are now mixins:

    project_commands         save / load / preview / preset cycling
    clipboard_commands       in-session checkpoints
    settings_commands        slider edits, preference edits
    config_manager_commands  multi-config editing (scoped for removal)

The mixins own no state. They read and replace the attributes defined here,
which keeps the state in one readable place while the behaviour lives next to
the feature it serves.

FRAME ORDER
Input is polled at the TOP of the frame, so the physics and rendering that
follow act on this frame's input rather than the previous frame's. The imgui
frame spans the whole loop body -- opened before the simulation runs, closed
after all GL drawing -- so the interface composites on top of the sim.
"""

import dataclasses
from pathlib import Path

import glfw

from app_window import AppWindow
from assembler import Assembler
from camera import Camera
from camera.camera_state import PAN_PER_SECOND, ZOOM_PER_SECOND
from particle_system import coords
from particle_system.config import BC_WRAP
from particle_system.particle_system import MAX_CONFIGS
from particle_system.picker import MISS
from preferences import Preferences
from project import Project, History
from strafe_field import StrafeField
from tooltip_graphic import TooltipGraphic
from ui import UI

from .clipboard_commands import ClipboardCommands, Checkpoint
from .config_manager_commands import ConfigManagerCommands
from .drawing_commands import DrawingCommands
from .project_commands import ProjectCommands
from .selection_commands import SelectionCommands, MouseMode
from .settings_commands import SettingsCommands
from .shove_commands import ShoveCommands

# Physics sub-steps per frame is a live preference (Preferences.physics_steps).

_CONFIG_DIR = Path(__file__).parent.parent / "configs"

__all__ = ['Orchestrator', 'Checkpoint', 'blur_schedule']


def blur_schedule(prefs):
    """(samples, stride) for one displayed frame of motion blur.

    Motion blur here is a TEMPORAL SUPERSAMPLE: the frame shown is the average
    of several renders taken at different points in the simulation's advance,
    which is why a fast particle smears instead of stepping.

    THE SAMPLE COUNT IS A TARGET, NOT A PROMISE. The user asks for X samples;
    what is achievable is set by the stride, which must be a whole number of
    physics steps. At 120 steps X=10 lands exactly (stride 12); at 100 steps
    X=8 gives stride 12 and so 9 samples. Returning the count that will ACTUALLY
    occur is the entire point of this function -- weighting by the requested X
    instead would darken the image by the ratio between them whenever the two
    disagree, and only for some slider positions, which is a miserable bug to
    find by eye.

    The count of steps satisfying `step % stride == 0` over range(n) is exactly
    ceil(n / stride). That is an identity, not an approximation, so the
    accumulator always receives precisely the number of samples it divided by.
    It depends on the loop starting at zero and the test being `== 0`; the
    un-blurred path below deliberately uses a different test and does not share
    this guarantee (it does not need to -- it takes one sample).
    """
    steps = max(1, int(prefs.physics_steps))
    requested = max(1, int(prefs.motion_blur_samples))
    if requested <= 1:
        # A sample count of 1 IS motion blur off; there is no separate flag.
        # One sample, taken on the LAST sub-step, so the un-blurred image shows
        # the newest state -- which is what rendering after the loop used to do.
        return 1, steps
    stride = max(1, steps // requested)
    samples = -(-steps // stride)  # ceil
    return samples, stride


class Orchestrator(ProjectCommands, ClipboardCommands, SettingsCommands,
                   ConfigManagerCommands, SelectionCommands, DrawingCommands,
                   ShoveCommands):

    #: Where configs live. An attribute so the command mixins can reach it.
    _config_dir = _CONFIG_DIR

    def __init__(self):
        self.window = AppWindow()
        ctx = self.window.ctx

        # Editor state, distinct from anything saved with a project.
        self.prefs = Preferences.load()

        self.camera = Camera(ctx)
        #: Turns the camera's finished HDR frame into what the screen shows:
        #: bloom, tone curve, overlays. Holds no state of its own.
        self.assembler = Assembler(ctx)
        self.system = self._build_system()
        #: The painted strafe field. Sized to the canvas, so a disruptive
        #: preference change rebuilds it alongside the system.
        self.strafe_field = StrafeField(ctx, self.system.canvas_size)
        #: The diagram drawn inside the sensor tooltips. Built here rather than
        #: in the UI because it owns a framebuffer, and the UI owns no GPU
        #: resources (rule 10); the UI is handed it and only asks it to draw.
        self.tooltip_graphic = TooltipGraphic(ctx)

        # --- state the command mixins read and replace ---

        #: The current project: configs + name + selection, as one immutable
        #: value. Replaced wholesale rather than mutated, so its invariants
        #: (selection in range, name tracks contents) hold by construction --
        #: see project/project.py for why that matters.
        self.project = Project(
            configs=tuple(self.system.configs),
            world=self.system.world,
            name=Path(self.system.config_path).stem,
        )
        # Startup builds the project directly rather than through _set_project,
        # so the field's sampling mode is initialized here to match.
        self.strafe_field.set_wrap(
            self.project.world.boundary_conditions == BC_WRAP)

        #: In-session project checkpoints, newest first. Not persisted:
        #: File > Save is the route for anything worth keeping.
        self.checkpoints = []
        self._checkpoint_serial = 0

        #: Config list on disk, grouped into load-menu categories.
        self.config_categories = {}
        self.presets = []
        self.preset_index = 0

        #: The last clicked entity. Picking is on-demand -- a dispatch scans
        #: every entity -- so this changes only when the user selects.
        #:
        #: There is deliberately NO `hovered` counterpart. One existed, was
        #: permanently MISS because nothing ever wrote it, and showed as an
        #: always-empty debug row. Reinstating it would mean picking every
        #: frame, which is precisely the per-frame cost the on-demand design
        #: exists to avoid.
        self.selected = MISS

        #: Project state at the moment of a click whose pick is still in
        #: flight, or None. Selection is asynchronous (see
        #: selection_commands.py): the click dispatches, the next frame reads
        #: the answer, and history has to record against the state from when
        #: the user clicked rather than from when the result landed.
        self._pending_selection = None

        #: The active tool: what the mouse does on the canvas. Select by
        #: default -- it is the only tool whose effect is a single undoable
        #: step, so a stray click on startup cannot smear the simulation.
        #: (Navigation is no longer a tool; it lives on WASD/QE.)
        self.mouse_mode = MouseMode.SELECT

        #: Whether the simulation is frozen. Pausing stops the physics AND the
        #: Shove tool, so a paused frame is genuinely untouchable; the camera,
        #: the overlays and the whole UI stay live, so a frozen state can still
        #: be navigated and inspected.
        self.paused = False

        #: Where the cursor was on the previous frame of the stroke in progress,
        #: in field uv. None between strokes -- see drawing_commands.py.
        self._stroke_prev_uv = None

        #: Undo/redo timeline. Seeded with the startup state so the first
        #: undo has somewhere to return to. Only selection and seed
        #: randomization record entries -- see project/history.py for why the
        #: obvious hook (_set_project) would be wrong.
        self.history = History()
        self.history.seed(self.project)

        #: Project state from before a hover-preview began, so a committed
        #: load records against it rather than against the preview showing at
        #: click time. None when no browse session is open.
        self._preview_origin = None

        #: Transient UI messages.
        self._manager_message = ""
        self._save_error = ""

        self.ui = UI(self.window.window, commands={
            'reload': self._cmd_reload,
            'reset': self._cmd_reset,
            'toggle_pause': self._cmd_toggle_pause,
            'next_preset': self._cmd_next_preset,
            'prev_preset': self._cmd_prev_preset,
            'toggle_camera_mode': self._cmd_toggle_camera_mode,
            'reset_camera': self._cmd_reset_camera,
            'set_mouse_mode': self._cmd_set_mouse_mode,
            'undo': self._cmd_undo,
            'redo': self._cmd_redo,
            'quit': self._cmd_quit,
            # save / load
            'save_config': self._cmd_save_config,
            'clear_save_error': self._cmd_clear_save_error,
            'load_config': self._cmd_load_config,
            'delete_config': self._cmd_delete_config,
            'preview_config': self._cmd_preview_config,
            'snapshot_configs': self._cmd_snapshot_configs,
            'restore_configs': self._cmd_restore_configs,
            # config manager
            'select_config': self._cmd_select_config,
            'duplicate_config': self._cmd_duplicate_config,
            'remove_config': self._cmd_remove_config,
            'append_config_file': self._cmd_append_config_file,
            # config clipboard
            'set_checkpoint': self._cmd_set_checkpoint,
            'delete_checkpoint': self._cmd_delete_checkpoint,
            'load_checkpoint': self._cmd_load_checkpoint,
            'load_latest_checkpoint': self._cmd_load_latest_checkpoint,
            # Same handlers as the Load menu's snapshot/restore: the
            # Orchestrator's half of hover-preview is identical for both
            # surfaces (see project_commands.py). Distinct names so the two
            # surfaces can diverge later without a UI change.
            'clipboard_snapshot': self._cmd_snapshot_configs,
            'clipboard_restore': self._cmd_restore_configs,
            'clipboard_apply': self._cmd_clipboard_apply,
            # settings
            'edit_setting': self._cmd_edit_setting,
            'randomize_seed': self._cmd_randomize_seed,
            'randomize_behavior': self._cmd_randomize_behavior,
            # drawing
            'edit_draw_pref': self._cmd_edit_draw_pref,
            'clear_strafe_field': self._cmd_clear_strafe_field,
        })

        # Handed over once, not per frame: it is a fixed renderer the UI draws
        # with, unlike the values in _report_status() which change every frame.
        self.ui.set_status(tooltip_graphic=self.tooltip_graphic)

        self._refresh_config_list()

    # ------------------------------------------------------------------
    # The frame loop
    # ------------------------------------------------------------------

    def run(self):
        while not self.window.should_close():
            # Poll + snapshot input, open the imgui frame. Everything below
            # sees this frame's input.
            state = self.ui.begin_frame()

            # FINISH LAST FRAME'S SELECTION FIRST, before _apply_canvas_input
            # can dispatch this frame's. Reading a pick the same frame it was
            # requested is exactly the GPU stall the two-phase design avoids
            # (and WebGPU cannot do it at all -- see picker.py), so the read
            # has to happen before the write, not after it.
            #
            # Here rather than inside advance(): advance() is skipped while
            # paused, and clicking to select must keep working when it is.
            self._resolve_pending_selection()

            self._apply_canvas_input(state)

            # PICKING IS DELIBERATELY NOT RUN PER FRAME. A pick dispatches over
            # every entity, which measured in the tens of milliseconds per
            # frame at large world sizes -- far too much for something whose
            # answer is only wanted when the user acts. It is on-demand: a
            # SELECT-mode click requests one above, and the line at the top of
            # the next frame reads it.

            # Physics rate is a live preference, read each frame. The field
            # texture is hoisted out of the loop: it cannot change mid-frame,
            # and painting happened once, above, in _apply_canvas_input.
            strafe_field = self.strafe_field.current_texture()
            window_size = self.window.size()

            # The Shove tool, resolved ONCE per frame and held for every
            # sub-step. Hoisted out of the loop like the field texture and for
            # the same reason: the cursor cannot move mid-frame, so asking
            # again per sub-step would be the same answer at 120x the cost.
            #
            # Returns None while paused -- that guard lives inside
            # shove_state(), so a frozen frame stays frozen no matter who asks.
            shove = self.shove_state(state)

            # MOTION BLUR PUTS THE RENDER INSIDE THE PHYSICS LOOP. A displayed
            # frame is the average of `samples` renders taken `stride` steps
            # apart, so the camera must see the simulation mid-advance rather
            # than only at the end of it. With blur off this is one render, on
            # the last sub-step, exactly as before.
            # PAUSED IS ONE SAMPLE OF A STILL IMAGE. Nothing moves, so there is
            # nothing for motion blur to average -- N samples of an unchanging
            # scene is the same picture at N times the cost.
            samples, stride = (1, 1) if self.paused else blur_schedule(self.prefs)
            self.camera.begin_frame(window_size, samples)

            # Which step within each group of `stride` gets rendered. Blurring
            # samples the FIRST, because that is what makes the sample count
            # come out to exactly ceil(steps/stride) -- see blur_schedule().
            # The single un-blurred sample takes the LAST instead, so a still
            # image shows the newest state rather than a stale one.
            # Keyed on the RESOLVED count rather than the preference, so the
            # paused case and a sample count of 1 take the same branch without
            # this line having to restate either condition.
            sample_at = 0 if samples > 1 else stride - 1

            # Still one iteration when paused: the camera has to draw the
            # frozen state, or the screen would go black. advance() is what is
            # skipped, not the render.
            steps = 1 if self.paused else self.prefs.physics_steps
            for step in range(steps):
                if not self.paused:
                    self.system.advance(strafe_field, shove)
                if step % stride == sample_at:
                    # Pulled per sample, not per frame: the canvas
                    # double-buffer swaps inside advance(), so a texture
                    # hoisted out of this loop would go stale immediately.
                    self.camera.render(
                        canvas_texture=self.system.current_canvas_texture(),
                        entity_buffer=self.system.entity_buffer,
                        entity_count=self.system.entity_count,
                        canvas_size=self.system.canvas_size,
                        window_size=window_size,
                        # From the SELECTED config. Per-particle in the shader
                        # would mean handing Camera the config buffer, which
                        # belongs to ParticleSystem -- so with several configs
                        # loaded, the selected one sets the palette for all.
                        color_sensitivity=self.project.config.color_sensitivity,
                        color_by_cohort=self.project.config.color_by_cohort,
                    )

            # AFTER the loop, not before: the camera binds its own framebuffers
            # for every sample above, so binding and clearing the screen any
            # earlier would simply be undone.
            self.window.begin_frame()
            self.assembler.present(
                self.camera.result(),
                framebuffer=self.window.ctx.screen,
                prefs=self.prefs,
                canvas_size=self.system.canvas_size,
                window_size=window_size,
                cam_pan=self.camera.state.pan,
                cam_zoom=self.camera.state.zoom,
                strafe_field=strafe_field,
                **self._overlay_args(),
            )

            # Hand the UI display-only values; it owns no simulation truth.
            self._report_status()
            self.ui.end_frame()

            self.window.end_frame()

        self.ui.shutdown()
        self.window.terminate()

    # ------------------------------------------------------------------
    # Per-frame plumbing
    # ------------------------------------------------------------------

    def _set_project(self, project):
        """Adopt a new project and push it to the GPU.

        THE single place project state changes. Everything that used to be
        "apply the configs, fix the name, re-clamp the selection" is now one
        call, with the invariants enforced inside Project rather than repeated
        at each call site.
        """
        self.project = project
        self.system.apply_project(project)
        # The field samples the world the same way the canvas does, so its
        # wrap mode follows the boundary condition. Here because this is THE
        # single place project state changes -- anywhere else and a load or an
        # undo could leave the two disagreeing.
        self.strafe_field.set_wrap(project.world.boundary_conditions == BC_WRAP)

    def _apply_canvas_input(self, state):
        """Translate canvas input into whatever the ACTIVE TOOL means.

        The UI reports *what happened* (a drag, a click); deciding what it means
        is the Orchestrator's job. Every field consulted here is already
        filtered for imgui capture, so dragging a panel never pans the view and
        clicking a button never selects a particle.

        THE TOOL ARBITRATES THE LEFT BUTTON. Selecting and painting both want
        it, and they must not both fire -- without a tool, every click would
        select a particle on the way down and paint on the way across.

        NAVIGATION IS NOT A TOOL. WASD, Q/E and the scroll wheel move the view
        in every mode, so the mouse is free for tools and the view can be
        adjusted mid-stroke.

        Painting happens HERE, above the render, because draw() binds its own
        framebuffer; running it after window.begin_frame() would paint over the
        screen instead.
        """
        window_size = self.window.size()
        canvas_size = self.system.canvas_size

        self._apply_camera_keys(state, canvas_size)

        if self.mouse_mode is MouseMode.SELECT:
            if state.left_pressed:
                self._cmd_select_particle(state.mouse_pos)
            # Right-click undoes, mirroring the original's binding.
            if state.right_pressed:
                self._cmd_undo()
        elif self.mouse_mode is MouseMode.SHOVE:
            # Nothing to do here: a shove is not an event, it is a condition
            # that holds while the button is down, and it has to be applied
            # INSIDE the physics loop rather than once before it. run() reads
            # it from shove_state() for exactly that reason. The branch exists
            # so the tool still claims the left button and the fall-through
            # below cannot pan the view out from under it.
            pass
        elif self.mouse_mode is MouseMode.DRAW:
            self._apply_draw_input(state)

        # Zoom works in every tool: it is navigation, not a tool.
        if state.scroll:
            self.camera.state.zoom_at_pixel(state.scroll, state.mouse_pos,
                                            window_size, canvas_size)

    def _apply_camera_keys(self, state, canvas_size):
        """WASD pans, Q/E zooms. Navigation, so it works in every tool.

        Reads keys_HELD rather than keys_pressed: this is continuous motion for
        as long as the key is down, not a one-shot. Scaled by dt so the speed is
        the same at any framerate -- a per-frame step would move twice as fast
        at 120fps as at 60.

        These are the only movement bindings now: the Pan tool is gone, because
        a tool that only moved the view spent a mouse button on something the
        keyboard does better, and blocked every other tool while held.
        """
        dt = state.dt
        if dt <= 0.0:
            return

        held = state.keys_held
        # W is up on screen, which is +y in world space.
        dx = (glfw.KEY_D in held) - (glfw.KEY_A in held)
        dy = (glfw.KEY_W in held) - (glfw.KEY_S in held)
        if dx or dy:
            step = PAN_PER_SECOND * dt
            self.camera.state.pan_by_fraction((dx * step, dy * step),
                                              canvas_size)

        # E zooms in, Q out -- E is the "forward" of the pair, next to W.
        dz = (glfw.KEY_E in held) - (glfw.KEY_Q in held)
        if dz:
            self.camera.state.zoom_by_factor(ZOOM_PER_SECOND ** (dz * dt))

    def _overlay_args(self):
        """Whether the drawing overlays are on screen, and where.

        THE ACTIVE TOOL DECIDES, so this is the Orchestrator's call: the
        assembler renders what it is told and the UI owns no simulation truth
        (rule 10). The field can optionally stay visible outside the Draw tool;
        the reticle never does, because it shows where a brush that is not
        currently usable would land.

        The reticle serves BOTH brush tools: Draw and Shove share draw_size, so
        the ring means the same thing in each -- the reach of what the button
        is about to do. The field overlay does not, because only Draw touches
        it.

        Because one ring serves two tools, its SHAPE cannot say which is armed,
        so its LINE STYLE does: Shove dashes it, Draw leaves it solid. The
        circle stays identical either way, which is the honest thing to draw --
        the reach genuinely is the same, and only what the button does differs.
        """
        drawing = self.mouse_mode is MouseMode.DRAW
        shoving = self.mouse_mode is MouseMode.SHOVE
        brushing = drawing or shoving
        show_field = self.prefs.field_always_show or drawing

        if not (brushing and self.prefs.show_reticle):
            return {'show_field': show_field, 'reticle_radius': 0.0}

        # The brush's VISIBLE extent, which is 2 sigma of its gaussian -- and
        # also exactly the eraser's hard radius (strafe_draw.frag), so the ring
        # reads as "what the eraser will take". Measured in the aspect-corrected
        # metric the brush shader paints in; the shader applies that same
        # correction, so what crosses this boundary is a plain scalar.
        return {
            'show_field': show_field,
            'reticle_center': self._mouse_field_uv(self.ui.state.mouse_pos),
            'reticle_radius': 2.0 * self.prefs.draw_size,
            'reticle_dashed': shoving,
        }

    #: THE STATUS INTERFACE, enumerated. This is the Orchestrator -> UI data
    #: contract: 30 keys, one untyped dict, and until the port turns it into a
    #: typed API this tuple is the only place it is written down.
    #:
    #: The guarantee that makes it usable: _report_status() supplies EVERY key
    #: below, every frame, before the UI builds a single panel (run() calls it
    #: immediately before ui.end_frame(), which is what invokes _build_ui).
    #: That is why UI code indexes `self._status['key']` rather than defending
    #: itself with .get('key', fallback) -- a KeyError means the Orchestrator
    #: forgot a key, which is a bug worth hearing about, not something to paper
    #: over with a default that silently renders as '-' forever.
    #:
    #: Three of these keys used to carry DIFFERENT defaults at different call
    #: sites (config_count was 1 here and '-' there), which is the specific
    #: failure mode this replaces.
    STATUS_KEYS = (
        # camera / cursor
        'mouse_world', 'cam_mode', 'cam_pan', 'cam_zoom',
        'canvas_size', 'window_size',
        # simulation
        'mouse_mode', 'paused', 'preset', 'entity_count', 'frame_count',
        # history
        'can_undo', 'can_redo', 'undo_label', 'history_depth', 'history_cursor',
        # picking (selection only -- see self.selected for why there is no
        # 'hovered')
        'selected',
        # project / configs
        'config_categories', 'project_name', 'selected_config', 'config_count',
        'max_configs', 'checkpoints',
        # transient messages
        'save_error', 'manager_message',
        # settings payloads, from _settings_dicts()
        'edit_config', 'edit_world', 'edit_prefs',
        # set ONCE at construction, not per frame -- a fixed renderer, not a
        # value. Listed because it is part of the same interface.
        'tooltip_graphic',
    )

    def _report_status(self):
        """Push read-only status into the UI for display (ARCHITECTURE rule 10).

        Supplies every key in STATUS_KEYS except `tooltip_graphic`, which is
        handed over once at construction.
        """
        state = self.ui.state
        cam = self.camera.state
        window_size = self.window.size()
        canvas_size = self.system.canvas_size
        self.ui.set_status(
            # Through the full inverse chain, so the readout accounts for pan,
            # zoom and letterboxing -- it is the world point actually under the
            # cursor, not an approximation.
            mouse_world=coords.screen_to_world(
                state.mouse_pos, window_size, canvas_size, cam.pan, cam.zoom),
            cam_mode=cam.mode.value,
            mouse_mode=self.mouse_mode.value,
            paused=self.paused,
            can_undo=self.history.can_undo,
            can_redo=self.history.can_redo,
            undo_label=self.history.undo_label(),
            history_depth=self.history.depth,
            history_cursor=self.history.cursor,
            cam_pan=cam.pan,
            cam_zoom=cam.zoom,
            canvas_size=f"{canvas_size[0]}x{canvas_size[1]}",
            window_size=f"{window_size[0]}x{window_size[1]}",
            selected=self.selected,
            config_categories=self.config_categories,
            save_error=self._save_error,
            project_name=self.project.name,
            selected_config=self.project.selected,
            max_configs=MAX_CONFIGS,
            manager_message=self._manager_message,
            checkpoints=self.checkpoints,
            # The three settings sources, as plain dicts the window reads by
            # field name. Snapshots, not references: the UI never holds live
            # simulation objects (rule 10). Built only when a window that reads
            # them is open -- see _settings_dicts().
            **self._settings_dicts(),
            preset=Path(self.system.config_path).stem,
            entity_count=self.system.entity_count,
            config_count=self.project.count,
            frame_count=self.system.frame_count,
        )

    #: Empty payload reused when no settings window is open, so the common case
    #: allocates nothing at all.
    _NO_SETTINGS = {'edit_config': {}, 'edit_world': {}, 'edit_prefs': {}}

    def _settings_dicts(self):
        """Settings payloads for the UI, built only when something reads them.

        `asdict` on a SimulationConfig deep-copies its 80-float rule tuple. Doing
        that every frame for a window that is closed is pure garbage; with both
        windows shut this returns a shared empty payload instead.
        """
        if not (self.ui.show_settings or self.ui.show_preferences
                or self.ui.show_drawing):
            return self._NO_SETTINGS
        return {
            'edit_config': dataclasses.asdict(self.project.config),
            'edit_world': dataclasses.asdict(self.system.current_world_config()),
            'edit_prefs': dataclasses.asdict(self.prefs),
        }

    # ------------------------------------------------------------------
    # Simple commands. Feature groups live in the command mixins.
    # ------------------------------------------------------------------

    def _cmd_reload(self):
        self.camera.reload()
        self.assembler.reload()
        self.system.reload()
        # Does not reallocate the field texture, so a painted field survives --
        # which is what makes it practical to tune the brush against a stroke
        # you already like.
        self.strafe_field.reload()
        self.tooltip_graphic.reload()

    def _cmd_reset(self):
        self.system.reset()

    def _cmd_toggle_pause(self):
        self.paused = not self.paused

    def _cmd_toggle_camera_mode(self):
        self.camera.state.toggle_mode()

    def _cmd_reset_camera(self):
        self.camera.state.reset()

    def _cmd_quit(self):
        glfw.set_window_should_close(self.window.window, True)
