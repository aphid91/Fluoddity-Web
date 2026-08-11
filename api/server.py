"""The HTTP surface: routes in, Requests out.

RUNS ENTIRELY OFF THE MAIN THREAD and touches no GL, no simulation state and no
Orchestrator. Everything it wants done, it queues (see protocol.py). What it is
allowed to reach is the three-callable PilotHost it was handed, which is the
whole of its access to the app.

WHY HTTP
Because a screenshot is bytes. Every other transport considered needed the
image base64'd into a JSON envelope, or a framing protocol written by hand; HTTP
returns a PNG with a content type and is done. It also means the app can be
launched by hand and a pilot attached, detached and restarted against a running
simulation -- which a stdin/stdout protocol, where the app is a child process,
cannot do.

LOOPBACK ONLY, NO AUTH. That is not an oversight to be fixed later, it IS the
security model: the socket is bound to 127.0.0.1, so reaching it already means
being on this machine. Do not "improve" this into a listening socket without
adding authentication first -- these endpoints load files, write files and shut
the app down.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .protocol import Request

#: Commands a pilot may call. AN ALLOWLIST, not a denylist, because the command
#: table it filters is shared with the interface: without this, adding a
#: GUI-only command would silently make it remotely callable.
#:
#: What is missing from here is as deliberate as what is in it. The
#: hover-preview handlers (snapshot_configs / restore_configs /
#: clipboard_apply / preview_config) are half of a cursor-driven state machine
#: -- a snapshot taken and never restored leaves _preview_origin pointing at a
#: project that has since been replaced, and the next committed load records
#: its undo entry against the wrong state. They only make sense as a matched
#: pair driven by a mouse, so they stay out.
API_COMMANDS = frozenset({
    # simulation
    'reset', 'reload', 'toggle_pause', 'set_paused',
    'randomize_seed', 'randomize_behavior',
    'undo', 'redo', 'quit',
    # configs
    'load_config_path', 'save_config_to', 'next_preset', 'prev_preset',
    'select_config', 'duplicate_config', 'remove_config',
    # settings
    'set_setting',
    # camera + window
    'set_camera', 'set_camera_mode', 'toggle_camera_mode', 'reset_camera',
    'set_window_size',
    # checkpoints
    'set_checkpoint', 'set_checkpoint_named', 'load_checkpoint_named',
    'delete_checkpoint_named', 'load_latest_checkpoint',
    # selection + tools
    'select_particle_at', 'set_mouse_mode', 'clear_strafe_field',
    # capture, state, lifecycle
    'screenshot', 'query_state', 'sleep', 'wake',
})

#: Commands that exist in the table but are UI-only, listed so the error can say
#: WHY rather than "unknown command" -- a pilot that tries preview_config has
#: made a reasonable guess and deserves a reasonable answer.
UI_ONLY = {
    'preview_config': 'hover-preview is a cursor-driven state machine; '
                      'use load_config_path',
    'snapshot_configs': 'hover-preview internals; use set_checkpoint_named',
    'restore_configs': 'hover-preview internals; use load_checkpoint_named',
    'clipboard_snapshot': 'hover-preview internals',
    'clipboard_restore': 'hover-preview internals',
    'clipboard_apply': 'hover-preview internals; use load_checkpoint_named',
    'edit_setting': 'takes a Setting object; use set_setting',
    'load_config': 'takes a ConfigEntry; use load_config_path',
    'save_config': 'saves into configs/custom by name; use save_config_to',
    'load_checkpoint': 'takes a Checkpoint; use load_checkpoint_named',
    'delete_checkpoint': 'takes a Checkpoint; use delete_checkpoint_named',
    'append_config_file': 'opens a file dialog',
    'clear_save_error': 'clears a UI message',
    'edit_draw_pref': 'use set_setting',
}


class _Handler(BaseHTTPRequestHandler):
    """One request. `server.host` is the PilotHost; nothing else is reachable."""

    #: HTTP/1.1 so a pilot can keep the connection alive across a tight loop of
    #: hundreds of commands instead of paying for a new socket each time.
    protocol_version = 'HTTP/1.1'

    # ---- plumbing ----

    def log_message(self, fmt, *args):
        """Silence the default per-request stderr line.

        The app prints genuinely interesting things (loads, saves, shader
        errors) to the same stream, and a schedule issuing thousands of
        commands would bury all of it.
        """

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if not length:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"body is not valid JSON: {e}") from None
        if not isinstance(payload, dict):
            raise ValueError("body must be a JSON object")
        return payload

    def _send(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, data, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _fail(self, status, message):
        self._send(status, {'ok': False, 'error': message})

    # ---- the one path everything real goes through ----

    def _run(self, name, args):
        """Queue a command, wait for the frame loop, return its result.

        Raises _Refused for anything the caller got wrong, so the routes below
        do not each have to repeat the same four checks.
        """
        if name in UI_ONLY:
            raise _Refused(400, f"{name!r} is UI-only: {UI_ONLY[name]}")
        if name not in API_COMMANDS:
            raise _Refused(400, f"unknown command {name!r}")

        host = self.server.host
        request = Request(name=name, args=args or {})
        host.submit(request)

        # A sleeping frame loop drains nothing, so a command sent to a parked
        # app would time out rather than run. Waking on submission means a
        # pilot never has to remember which state it left the app in.
        if name != 'sleep':
            host.wake()

        if not request.wait():
            raise _Refused(504, f"{name!r} timed out waiting for the frame loop")
        if request.error is not None:
            raise _Refused(400 if request.bad_request else 500, request.error)
        return request.result

    # ---- routes ----

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)
        try:
            if route.path == '/health':
                # Answered WITHOUT the frame loop, on purpose: it must stay
                # answerable while the app is asleep, which is exactly when a
                # pilot polls it to find out whether its batch has finished.
                self._send(200, self.server.health())
            elif route.path == '/state':
                self._send(200, {'ok': True, 'result': self._run('query_state', {})})
            elif route.path == '/schedule/status':
                self._send(200, {'ok': True, 'result': self.server.schedule_status()})
            elif route.path == '/screenshot':
                self._screenshot(query)
            else:
                self._fail(404, f"no route {route.path}")
        except _Refused as e:
            self._fail(e.status, e.message)
        except Exception as e:                      # noqa: BLE001
            self._fail(500, f"{type(e).__name__}: {e}")

    def do_POST(self):
        route = urlparse(self.path)
        try:
            payload = self._body()
            if route.path == '/cmd':
                name = payload.get('name')
                if not name:
                    raise _Refused(400, "need a 'name'")
                self._send(200, {'ok': True,
                                 'result': self._run(name, payload.get('args'))})
            elif route.path == '/batch':
                self._batch(payload)
            elif route.path == '/schedule':
                self._send(200, {'ok': True,
                                 'result': self.server.submit_schedule(payload)})
            elif route.path == '/schedule/cancel':
                self._send(200, {'ok': True, 'result': self.server.cancel_schedule()})
            else:
                self._fail(404, f"no route {route.path}")
        except _Refused as e:
            self._fail(e.status, e.message)
        except ValueError as e:
            self._fail(400, str(e))
        except Exception as e:                      # noqa: BLE001
            self._fail(500, f"{type(e).__name__}: {e}")

    def _batch(self, payload):
        """Several commands, all on ONE frame.

        The distinction from looping over /cmd is the whole point: a batch of
        'load, reset, set the rate' applied across three different frames means
        two frames of simulation ran against a half-applied state. Here they
        share a single drain step, so nothing is rendered in between.
        """
        commands = payload.get('commands')
        if not isinstance(commands, list) or not commands:
            raise _Refused(400, "need a non-empty 'commands' list")

        for entry in commands:
            name = entry.get('cmd') or entry.get('name')
            if name in UI_ONLY:
                raise _Refused(400, f"{name!r} is UI-only: {UI_ONLY[name]}")
            if name not in API_COMMANDS:
                raise _Refused(400, f"unknown command {name!r}")

        host = self.server.host
        request = Request(name='__batch__',
                          args={'commands': list(commands)})
        host.submit(request)
        host.wake()
        if not request.wait():
            raise _Refused(504, "batch timed out waiting for the frame loop")
        if request.error is not None:
            raise _Refused(400 if request.bad_request else 500, request.error)
        self._send(200, {'ok': True, 'result': request.result})

    def _screenshot(self, query):
        """Capture. Returns PNG bytes, or JSON when a path was given.

        A route of its own rather than /cmd with name=screenshot, for one
        reason: the response can then be an actual image with an actual content
        type, which is what makes `curl -o shot.png` work and what keeps a
        pilot from having to base64-decode every frame of a search.
        """
        def one(key, cast=int):
            values = query.get(key)
            return cast(values[0]) if values else None

        args = {'path': one('path', str),
                'width': one('width'),
                'height': one('height'),
                'include_overlays': (query.get('overlays', ['0'])[0]
                                     in ('1', 'true', 'yes'))}
        result = self._run('screenshot', args)

        if 'png' in result:
            self._send_bytes(result['png'], 'image/png')
        else:
            self._send(200, {'ok': True, 'result': result})


class _Refused(Exception):
    """A request the server is declining, with the status it should get."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class _Server(ThreadingHTTPServer):
    daemon_threads = True        # a stuck request must not block shutdown
    allow_reuse_address = True


class PilotServer:
    """The HTTP transport. Owns a thread and a socket; nothing else.

    Constructed with a PilotHost, so it can queue work and wake the loop and do
    nothing else to the app.
    """

    def __init__(self, port, host, schedules=None, health=None, address='127.0.0.1'):
        self._server = _Server((address, int(port)), _Handler)
        self._server.host = host
        # Bound methods supplied by the Orchestrator's drain machinery, kept on
        # the server object because that is what the handler can reach.
        self._server.submit_schedule = schedules.submit
        self._server.cancel_schedule = schedules.cancel
        self._server.schedule_status = schedules.status
        self._server.health = health

        self._thread = threading.Thread(
            target=self._server.serve_forever, name='fluoddity-api',
            daemon=True)

    @property
    def address(self):
        return self._server.server_address

    def start(self):
        self._thread.start()
        host, port = self.address
        print(f"API listening on http://{host}:{port}")

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
