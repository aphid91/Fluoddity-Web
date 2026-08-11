# The piloting API

Drive Fluoddity from another program: load configs, tune sliders, move the
camera, capture frames, checkpoint and restore, and schedule all of it against
frame numbers.

```
python main.py --api-port 8765
```

Off unless the flag is given. Without it the app behaves exactly as it always
has — the API's state exists on the Orchestrator either way, and the frame
loop's two extra lines are no-ops while the transport is absent. A research
instrument should not alter the thing it is there to observe.

The app **keeps its window and keeps rendering**. There is no headless mode and
none is wanted: the point is to watch a search work.

---

## Why it is shaped like this

**The GL context belongs to the main thread.** Every command that touches the
simulation, the camera or a framebuffer has to run there. A GL call from an HTTP
handler thread does not raise — it corrupts.

So a request is never executed where it arrives. It is queued, the arriving
thread blocks on a `threading.Event`, and the frame loop executes it during its
drain step and signals completion. That is the whole mechanism
(`api/protocol.py`), and it is deliberately the smallest thing that works.

Queuing to a *point in the frame* matters beyond thread safety. A screenshot
taken mid-physics-loop would capture a half-accumulated buffer; a config load
applied between motion-blur samples would blend two different simulations into
one image. Commands land at the top of the frame, before anything is drawn.

**Loopback only, no authentication.** That is not an oversight to be fixed
later — it *is* the security model. The socket binds to `127.0.0.1`, so reaching
it already means being on this machine. These endpoints load files, write files
and shut the app down; do not expose them without adding auth first.

---

## Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/cmd` | one command, synchronous |
| `POST` | `/batch` | several commands, all within one frame |
| `POST` | `/schedule` | a frame-keyed batch, fire-and-forget |
| `POST` | `/schedule/cancel` | abandon the running schedule |
| `GET` | `/schedule/status` | state, progress, per-command results |
| `GET` | `/state` | full app state, JSON-safe |
| `GET` | `/screenshot` | PNG bytes, or write to a path |
| `GET` | `/health` | frame number, asleep, paused |

`/cmd` takes `{"name": ..., "args": {...}}` and returns
`{"ok": true, "result": ...}`. Errors return `{"ok": false, "error": "..."}`
with **400 for your mistake** (unknown command, missing config, bad setting
name) and **500 for ours**. A 504 means the frame loop never got to it.

`/health` is answered **without** the frame loop, on purpose: it must stay
answerable while the app is asleep, which is exactly when a pilot polls it.

```bash
curl -X POST localhost:8765/cmd -d '{"name":"reset"}'
curl localhost:8765/state
curl -o shot.png 'localhost:8765/screenshot?width=1024&height=1024'
```

---

## Commands

### Simulation

| Command | Args | Notes |
|---|---|---|
| `reset` | — | restarts the simulation |
| `reload` | — | hot-reloads every shader |
| `set_paused` | `paused` | idempotent; prefer over `toggle_pause` |
| `toggle_pause` | — | |
| `randomize_seed` | — | new mutation seed |
| `randomize_behavior` | — | zeroes the rule *and* rerolls the seed |
| `undo` / `redo` | — | |
| `quit` | — | closes the app |

### Configs

| Command | Args | Notes |
|---|---|---|
| `load_config_path` | `path` | load any file by path |
| `save_config_to` | `path`, `save_all=false`, `adopt=false` | arbitrary destination |
| `next_preset` / `prev_preset` | — | cycle the discovered list |
| `select_config` / `duplicate_config` / `remove_config` | | multi-config editing |

Relative paths resolve against the **repo root**, not the working directory —
the app already refuses to depend on CWD, and a pilot launched from elsewhere
must not get a different filesystem. The resolved absolute path comes back in
the response.

`adopt` defaults to **false**. A GUI save renames the project and rescans the
config tree, because choosing a destination in a dialog *is* an act of
adoption. A pilot writing 500 candidates into a sequence folder wants neither —
500 renames it did not ask for, and 500 full-tree directory scans inside a
search loop.

### Settings

```json
{"name": "set_setting",
 "args": {"source": "prefs", "field": "physics_steps", "value": 60}}
```

`source` is `config` (per-particle, saved), `world` (global, saved) or `prefs`
(editor state, not saved with a config). Every field in
[`ui/settings_spec.py`](../ui/settings_spec.py) is reachable; the response
echoes the value that landed and whether the edit was `disruptive`.

**Values are not clamped to the slider bounds.** Those bounds are soft in the
interface too — ctrl+click types outside them — and a search over mutation space
is precisely the caller that legitimately wants to leave the nominal range.
Clamping here would make the API stricter than the interface it mirrors.

Useful fields: `mutation_scale`, `mutation_seed`, `cohorts` (config);
`trail_persistence`, `boundary_conditions` (world); `brightness`,
`physics_steps`, `motion_blur_samples`, `bloom_enabled`, `world_size`,
`canvas_aspect` (prefs).

`world_size` and `canvas_aspect` are **disruptive**: they reallocate GPU
buffers, restart the simulation and discard the strafe field. Never put them in
a per-candidate inner loop.

### Camera and window

| Command | Args |
|---|---|
| `set_camera` | `pan=[x,y]`, `zoom`, `mode` — each optional |
| `set_camera_mode` | `mode`: `"particles"` or `"trail"` |
| `reset_camera` | — |
| `set_window_size` | `width`, `height` |

Zoom is clamped to 0.1–100 by the camera itself, so the API cannot put it
somewhere the interface could not.

### Selection

```json
{"name": "select_particle_at", "args": {"index": 4271}}
```

Exactly one of `index`, `world` or `pixel`.

**Use `index`. It is synchronous and exact.** The rule a given entity obeys is a
pure function of `(config, index, entity_count)` — `particle_system/mutation.py`
reproduces the shader's arithmetic exactly, which is why selection never needed
a GPU readback — so naming an index skips the picker entirely and the answer is
immediate.

`world` and `pixel` go through the GPU picker and are **asynchronous**: the pick
is dispatched now and adopted at the top of the *next* frame. The response says
`{"pending": true, "resolves_on_frame": N+1}`, and `/state` reports
`selection_pending`. A pilot that saves the config on the same frame it selected
writes the *previous* rule and never notices.

### Checkpoints

`set_checkpoint_named`, `load_checkpoint_named`, `delete_checkpoint_named`, all
taking `name`. In-session only — nothing is written to disk. Setting a name that
already exists replaces it.

### Capture

```
GET /screenshot?width=1024&height=1024        -> PNG bytes
GET /screenshot?path=out/frame.png            -> {"path": "..."}
```

or as a command with `path`, `width`, `height`, `include_overlays`.

**No interface in the image, by construction rather than by suppression.** The
capture assembles a second time into an offscreen target that imgui never draws
into, so there is nothing to hide. Overlays (the field, the brush reticle) are
off by default — an embedding of a frame with a reticle in it is partly an
embedding of the reticle.

Missing directories are created. Bytes-back needs no disk at all, which is what
a tight search loop wants.

---

## Three things that will bite you

### 1. `set_window_size` takes effect next frame

GLFW delivers the resize during `poll_events()`, at the top of the *following*
frame. **`set_window_size` then `screenshot` in the same breath captures the old
size.** The response says `{"pending": true, "effective_after_frames": 1}` to
make it visible. Put them on consecutive frames.

Forcing it synchronous would mean polling events mid-frame, outside imgui's
begin/end pair, which corrupts the input accumulators. Not worth it.

### 2. Capture resolution is resampling, not detail

The camera's accumulation buffer is allocated at **window** size. Asking for
1024×1024 from a 512×512 window enlarges 512×512 worth of pixels. For genuine
detail, resize the window first and let a frame pass.

(In practice this matters less than instinct suggests — CLIP preprocesses to
224×224. See [CLIP_INTEGRATION.md](CLIP_INTEGRATION.md).)

### 3. App frames are not a fixed amount of simulation

"Frame 1000" is 30,000 physics steps at the default rate and 60,000 at 60. **A
schedule that wants to be reproducible pins `physics_steps` on frame 0.**

The scheduling clock is `Orchestrator.app_frame` — displayed frames since
startup, monotonic, never reset. Not `system.frame_count`, which counts physics
sub-steps and returns to zero on every reset.

---

## Schedules

For things that are about *time*: let this config run a thousand frames, then
move the camera, then capture. Submitted, acknowledged immediately, executed by
the frame loop as the frames go by.

```json
{
  "version": 1,
  "label": "sweep-042",
  "commands": [
    {"at": 0,       "cmd": "load_config_path", "args": {"path": "configs/custom/xxx.json"}},
    {"at": 0,       "cmd": "reset"},
    {"at": 0,       "cmd": "set_setting", "args": {"source": "prefs", "field": "physics_steps", "value": 60}},
    {"at": "+1000", "cmd": "set_camera", "args": {"pan": [0.5, 0.5], "zoom": 4.0}},
    {"at": "+1000", "cmd": "set_setting", "args": {"source": "prefs", "field": "brightness", "value": 1.0}},
    {"at": "+1000", "cmd": "set_window_size", "args": {"width": 640, "height": 480}},
    {"at": "+1001", "cmd": "screenshot", "args": {"path": "documents/sequences/screenshots/zzz.png"}},
    {"at": "+1002", "cmd": "sleep"}
  ]
}
```

Note the resize on `+1000` and the capture on `+1001` — that is gotcha 1, in the
schema rather than in a paragraph.

**`at`** is an absolute frame (`1000`) or an offset from submission (`"+1000"`).
Use offsets: on its fortieth batch a pilot has no idea what the absolute counter
is at. Resolution happens once, at submission, and the resolved frames come back
in the response so you can check them.

**Rules:**

- Commands on the same frame run in **written order**. `load` → `reset` → `set
  rate` is never reordered.
- **A skipped frame runs late, not never.** If the loop hitches past frame N,
  everything due fires on the tick that notices, in order, with `late_by`
  recorded. Dropping would make results depend on machine speed.
- Immediate `/cmd` requests drain **before** the schedule each frame.
- **One schedule at a time.** Submitting a second is an error;
  `/schedule/cancel` is the way out.
- **A scheduled screenshot must have a `path`.** There is no open connection to
  return bytes on, and buffering PNGs for later collection is an unbounded leak.
  Rejected at submission, while you are still holding the connection.

Errors are caught at submission — an unknown command in position 40 of a batch
is a 400 you see now, not a log line seventeen seconds later.

---

## Sleep and wake

```json
{"name": "sleep", "args": {"timeout": 300}}
```

Parks the frame loop: no physics, no render, no interface. This is how the pilot
stops the app competing for the GPU while it runs embeddings.

**Not the same as pause.** Pausing freezes the physics and keeps rendering and
the whole interface live — a paused app still burns a GPU. Sleeping stops the
loop.

The window **stays responsive** while parked: the idle loop keeps pumping the OS
event queue, so Windows does not grey it out, and the close button still works.

**Any command wakes the app**, so a pilot never has to remember what state it
left things in. `sleep` itself does not, obviously. The `timeout` is a safety
valve, not a feature — a pilot that crashes while the app is asleep would
otherwise leave a window responding to nothing.

---

## The search loop

The intended shape, and why:

```python
submit_schedule(batch_ending_in_sleep)      # POST /schedule
poll("/health") until asleep                # cheap; the app is idle
collect(screenshots)                        # embed, score, rank
submit_schedule(next_batch)                 # wakes the app
```

Ending each batch with `sleep` makes scheduling and sleep/wake one coherent
story rather than two features: the app parks itself the moment the batch
completes, and `/health` going `asleep: true` *is* the completion signal.
`/schedule/status` is there when you want per-command results.

**Use synchronous `/cmd` for setup and interrogation, schedules only for
time-keyed sequences.** Synchronous gives you an error at the moment you made
the mistake. Fire-and-forget swallows it into a result list nobody reads until
the batch is done.

---

## What is not exposed, and why

`preview_config`, `snapshot_configs`, `restore_configs`, `clipboard_apply` are
**UI-only**. They are half of a cursor-driven state machine: a snapshot taken
and never restored leaves the preview origin pointing at a project that has
since been replaced, and the next committed load records its undo entry against
the wrong state. They only make sense as a matched pair driven by a mouse.

Handlers taking objects (`edit_setting`, `load_config`, `save_config`,
`load_checkpoint`) are shadowed by name-taking siblings — use `set_setting`,
`load_config_path`, `save_config_to`, `load_checkpoint_named`. Asking for the
object-taking name returns a 400 that says which to use instead.

The allowlist lives in `api/server.py` as `API_COMMANDS`. It is an allowlist
rather than a denylist because the command table it filters is shared with the
interface — without it, adding a GUI-only command would silently make it
remotely callable.

---

## Where the code is

```
api/protocol.py     the socket-thread -> frame-loop handoff
api/schedule.py     parsing, resolution, ordering (pure; no app access)
api/runner.py       the frame loop's half: draining, schedule execution
api/server.py       HTTP routes and the command allowlist

orchestrator/api_commands.py    the handlers themselves
```

The transport is a directory: `api/` touches no GL and holds no simulation
state, so removing the feature is a deletion plus the flag. The handlers live in
a mixin beside the app's other commands, because that is what they are.

Both surfaces dispatch into the **same** command table
(`Orchestrator._command_table()`). There is no second registry to keep in step.

## Testing

```
Scratch.venv/Scripts/python.exe tests/test_schedule_parse.py   # pure, no GPU
Scratch.venv/Scripts/python.exe tests/test_api_capture.py      # GPU, no window
Scratch.venv/Scripts/python.exe tests/test_api_loopback.py     # needs a display
```

The loopback test launches the real app and drives it over HTTP, including the
sleep/wake cycle and a schedule. It is the one that catches transport bugs,
because those look like hangs rather than errors.
