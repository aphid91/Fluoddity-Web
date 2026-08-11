"""The API end to end: launch the app, drive it over HTTP, shut it down.

NEEDS A DISPLAY as well as a GPU -- unlike the other tests here, which use a
standalone context. It launches the real app, with a real window, because that
is the only way to exercise the frame loop's drain step, the sleep guard and
the schedule runner, none of which exist outside a running loop.

    Scratch.venv/Scripts/python.exe tests/test_api_loopback.py

WHAT IT IS GUARDING
The transport's failure modes are the ones the pure tests cannot see: a command
that queues but is never drained, a sleep that parks the loop with no way back,
a schedule that never fires because the clock it reads is not the clock the loop
advances. Each of those looks like a hang rather than an error, which is why
every wait here has a timeout and reports what it was waiting for.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

#: An unusual port, so a stray previous run is obvious rather than confusing.
PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"

#: How long to wait for the app to come up. Generous: first launch compiles
#: every shader.
STARTUP_TIMEOUT = 60.0

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


# ---------------------------------------------------------------------------
# HTTP helpers

def request(method, path, payload=None, timeout=30.0):
    """One request. Returns (status, body) with body parsed when it is JSON."""
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read()
            kind = response.headers.get('Content-Type', '')
            if 'json' in kind:
                return response.status, json.loads(body)
            return response.status, body
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, body


def cmd(_command, **args):
    """Dispatch a command with keyword args.

    The parameter is _command, not `name`: several commands take a `name`
    argument of their own (the checkpoint handlers), and the obvious spelling
    collides with them.
    """
    return request('POST', '/cmd', {'name': _command, 'args': args})


def wait_for(predicate, timeout, description):
    """Poll until `predicate()` is true. False on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception:                                           # noqa: BLE001
            pass
        time.sleep(0.1)
    print(f"        (timed out waiting for {description})")
    return False


# ---------------------------------------------------------------------------

def test_health_and_state():
    print("\nhealth and state")

    status, body = request('GET', '/health')
    check("/health answers", status == 200 and body.get('ok'), str(body))

    status, body = request('GET', '/state')
    state = body.get('result', {})
    check("/state answers", status == 200 and body.get('ok'), str(body)[:200])
    for key in ('app_frame', 'entity_count', 'camera', 'prefs', 'project'):
        check(f"/state carries {key}", key in state)
    check("/state is JSON-serializable", json.dumps(state) is not None)


def test_rejections():
    print("\nrejections")

    status, body = cmd('frobnicate')
    check("unknown command is a 400", status == 400, f"got {status}")

    # A UI-only command should say WHY, not merely "unknown" -- the pilot made
    # a reasonable guess and the error is the only place to explain it.
    status, body = cmd('preview_config')
    check("UI-only command is a 400", status == 400, f"got {status}")
    check("UI-only error explains itself",
          'UI-only' in str(body.get('error', '')), str(body))

    status, body = cmd('set_setting', source='prefs', field='not_a_field',
                       value=1)
    check("unknown setting is a 400", status == 400, f"got {status}")


def test_settings_and_camera():
    print("\nsettings and camera")

    status, body = cmd('set_setting', source='prefs', field='brightness',
                       value=1.5)
    check("brightness accepted", status == 200, str(body))
    check("the accepted value comes back",
          body.get('result', {}).get('value') == 1.5, str(body))

    # physics_steps is an INT setting; JSON delivers 45 as an int here but a
    # pilot may well send 45.0, and float(45.0) reaching range() would raise
    # three modules away from the cause.
    status, body = cmd('set_setting', source='prefs', field='physics_steps',
                       value=45.0)
    check("float for an int setting is coerced",
          status == 200 and body['result']['value'] == 45, str(body))

    status, body = cmd('set_camera', pan=[0.25, -0.5], zoom=4.0,
                       mode='particles')
    result = body.get('result', {})
    check("camera set", status == 200 and result.get('zoom') == 4.0, str(body))
    check("pan set", result.get('pan') == [0.25, -0.5], str(body))

    # The clamp belongs to the camera, so the API must not be able to exceed
    # what the interface could.
    status, body = cmd('set_camera', zoom=10_000.0)
    check("zoom is clamped, not accepted raw",
          body.get('result', {}).get('zoom') == 100.0, str(body))

    _, body = request('GET', '/state')
    check("state reflects the edits",
          body['result']['prefs']['physics_steps'] == 45, str(body)[:200])


def test_selection():
    print("\nselection")

    _, body = request('GET', '/state')
    count = body['result']['entity_count']

    # Index selection is synchronous and exact -- no picker, no frame boundary.
    status, body = cmd('select_particle_at', index=count // 3)
    check("index selection succeeds", status == 200, str(body))
    check("index selection is not pending",
          body.get('result', {}).get('pending') is False, str(body))

    status, body = cmd('select_particle_at', index=count + 1)
    check("out-of-range index is a 400", status == 400, f"got {status}")

    status, body = cmd('select_particle_at')
    check("no target at all is a 400", status == 400, f"got {status}")

    status, body = cmd('select_particle_at', index=0, world=[0.0, 0.0])
    check("two targets at once is a 400", status == 400, f"got {status}")

    # World selection goes through the picker, so it resolves next frame. The
    # response must say so rather than pretending otherwise.
    status, body = cmd('select_particle_at', world=[0.0, 0.0])
    check("world selection is pending",
          body.get('result', {}).get('pending') is True, str(body))
    check("world selection names the frame it resolves on",
          'resolves_on_frame' in body.get('result', {}), str(body))


def test_checkpoints():
    print("\ncheckpoints")

    check("checkpoint set", cmd('set_checkpoint_named', name='probe')[0] == 200)

    _, body = request('GET', '/state')
    check("checkpoint appears in state",
          'probe' in body['result']['checkpoints'], str(body['result']['checkpoints']))

    check("checkpoint loads",
          cmd('load_checkpoint_named', name='probe')[0] == 200)

    status, _ = cmd('load_checkpoint_named', name='no-such-checkpoint')
    check("missing checkpoint is a 400", status == 400, f"got {status}")

    check("checkpoint deletes",
          cmd('delete_checkpoint_named', name='probe')[0] == 200)


def test_screenshot(tmp):
    print("\nscreenshot")

    status, body = request('GET', '/screenshot?width=200&height=150')
    check("bytes-back capture succeeds", status == 200, str(body)[:120])
    check("the response is PNG bytes",
          isinstance(body, bytes) and body[:8] == b'\x89PNG\r\n\x1a\n',
          f"got {type(body).__name__}")

    if isinstance(body, bytes):
        try:
            from PIL import Image
            import io
            image = Image.open(io.BytesIO(body))
            check("PNG decodes at the requested size", image.size == (200, 150),
                  str(image.size))
        except ImportError:
            print("        (Pillow missing; skipped decode)")

    target = tmp / 'sequences' / 'shot.png'
    status, body = cmd('screenshot', path=str(target), width=128, height=128)
    check("capture-to-path succeeds", status == 200, str(body))
    check("the file was written", target.is_file(), str(target))
    # The parent directory did not exist: a pilot writing into a sequence
    # folder should not have to create it first.
    check("intermediate directories were created", target.parent.is_dir())


def test_config_roundtrip(tmp):
    print("\nconfig save and load")

    target = tmp / 'sequences' / 'candidate.json'
    status, body = cmd('save_config_to', path=str(target))
    check("save to an arbitrary path succeeds", status == 200, str(body))
    check("the config file exists", target.is_file(), str(target))
    check("the resolved path is reported",
          body.get('result', {}).get('path') is not None, str(body))
    # adopt defaults to False: a pilot dumping candidates must not have its
    # project renamed 500 times.
    check("save did not adopt by default",
          body.get('result', {}).get('adopted') is False, str(body))

    status, body = cmd('load_config_path', path=str(target))
    check("load by path succeeds", status == 200, str(body))

    status, _ = cmd('load_config_path', path=str(tmp / 'nope.json'))
    check("missing config is a 400", status == 400, f"got {status}")


def test_batch():
    print("\nbatch")

    status, body = request('POST', '/batch', {'commands': [
        {'cmd': 'set_paused', 'args': {'paused': True}},
        {'cmd': 'reset'},
        {'cmd': 'set_setting',
         'args': {'source': 'prefs', 'field': 'physics_steps', 'value': 30}},
        {'cmd': 'set_paused', 'args': {'paused': False}},
    ]})
    check("batch runs", status == 200, str(body)[:200])
    results = body.get('result', [])
    check("every batch command reports ok",
          len(results) == 4 and all(r.get('ok') for r in results), str(results)[:200])

    status, _ = request('POST', '/batch', {'commands': [{'cmd': 'preview_config'}]})
    check("a UI-only command rejects the whole batch", status == 400, f"got {status}")


def test_schedule():
    print("\nschedule")

    _, body = request('GET', '/state')
    start = body['result']['app_frame']

    status, body = request('POST', '/schedule', {'version': 1, 'label': 'probe',
                                                 'commands': [
        {'at': '+2', 'cmd': 'set_setting',
         'args': {'source': 'prefs', 'field': 'brightness', 'value': 0.75}},
        {'at': '+4', 'cmd': 'set_camera', 'args': {'zoom': 2.0}},
    ]})
    check("schedule accepted", status == 200, str(body)[:200])
    result = body.get('result', {})
    check("resolved frames are echoed back", 'resolved' in result, str(result)[:200])
    if 'resolved' in result:
        frames = [c['frame'] for c in result['resolved']]
        check("'+N' resolved against the submission frame",
              frames == [start + 2, start + 4] or frames[0] > start,
              f"{frames} vs start {start}")

    done = wait_for(
        lambda: request('GET', '/schedule/status')[1]['result']['state'] == 'done',
        timeout=30.0, description="the schedule to finish")
    check("schedule reaches 'done'", done)

    _, body = request('GET', '/schedule/status')
    results = body['result'].get('results', [])
    check("both scheduled commands ran",
          len(results) == 2 and all(r.get('ok') for r in results), str(results)[:300])

    _, body = request('GET', '/state')
    check("the scheduled edit actually landed",
          body['result']['prefs']['brightness'] == 0.75,
          str(body['result']['prefs']))

    # A pathless scheduled screenshot has nowhere to put the bytes, and must be
    # refused while the pilot is still holding the connection.
    status, _ = request('POST', '/schedule', {'version': 1, 'commands': [
        {'at': '+1', 'cmd': 'screenshot'}]})
    check("pathless scheduled screenshot is a 400", status == 400, f"got {status}")


def test_sleep_wake():
    print("\nsleep and wake")

    status, body = cmd('sleep', timeout=120)
    check("sleep accepted", status == 200, str(body))

    parked = wait_for(lambda: request('GET', '/health')[1].get('asleep') is True,
                      timeout=10.0, description="the loop to park")
    check("the app reports asleep", parked)

    # /health must answer while parked: this is exactly when a pilot polls it.
    status, body = request('GET', '/health')
    check("/health still answers while asleep", status == 200, str(body))

    # The frame counter must STOP. If it keeps climbing, the loop never parked
    # and the whole point of sleeping -- not competing for the GPU -- is lost.
    first = request('GET', '/health')[1]['frame']
    time.sleep(1.0)
    second = request('GET', '/health')[1]['frame']
    check("the frame counter is frozen while asleep", first == second,
          f"{first} -> {second}")

    # Any command wakes the app, so a pilot never has to remember what state it
    # left it in.
    status, body = request('GET', '/state')
    check("a command wakes the app and is serviced", status == 200, str(body)[:120])

    awake = wait_for(lambda: request('GET', '/health')[1].get('asleep') is False,
                     timeout=10.0, description="the loop to wake")
    check("the app reports awake", awake)

    third = request('GET', '/health')[1]['frame']
    time.sleep(0.5)
    fourth = request('GET', '/health')[1]['frame']
    check("the frame counter advances again", fourth > third,
          f"{third} -> {fourth}")


# ---------------------------------------------------------------------------

def main():
    print("API loopback (needs a display)")

    app = subprocess.Popen(
        [sys.executable, str(ROOT / 'main.py'), '--api-port', str(PORT)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True)

    try:
        up = wait_for(lambda: request('GET', '/health', timeout=2.0)[0] == 200,
                      STARTUP_TIMEOUT, "the app to start")
        if not up:
            print("  FAIL  the app never answered /health")
            if app.poll() is not None:
                print(app.stdout.read()[-2000:])
            return 1
        print("  ok    the app came up")

        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            test_health_and_state()
            test_rejections()
            test_settings_and_camera()
            test_selection()
            test_checkpoints()
            test_screenshot(tmp)
            test_config_roundtrip(tmp)
            test_batch()
            test_schedule()
            test_sleep_wake()

        print("\nshutdown")
        cmd('quit')
        try:
            app.wait(timeout=20)
            check("the app exited cleanly", app.returncode == 0,
                  f"exit code {app.returncode}")
        except subprocess.TimeoutExpired:
            check("the app exited cleanly", False, "still running after quit")

    finally:
        if app.poll() is None:
            app.kill()
            app.wait(timeout=10)

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
