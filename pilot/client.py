"""A typed client for the piloting API.

Everything the search does to the app goes through here, so there is one place
that knows the wire format and one place to look when a call misbehaves.

STDLIB ONLY. This module is the boundary: it must be importable in a process
that has torch loaded and in one that does not, and it must not drag either
into the other.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

#: Long enough for a big run_steps or a world_size rebuild (which reallocates
#: GPU buffers), short enough that a wedged app is reported rather than waited
#: on forever.
DEFAULT_TIMEOUT = 180.0


class ApiError(RuntimeError):
    """The app refused a command, or could not carry it out.

    Carries the HTTP status so a caller can tell "you asked wrongly" (400)
    from "it broke" (500) -- the API draws that line deliberately and it is
    worth not losing.
    """

    def __init__(self, status, message):
        super().__init__(f"[{status}] {message}")
        self.status = status
        self.message = message


class FluoddityClient:
    """Drives a running Fluoddity instance over HTTP.

    Not thread-safe, and not meant to be: the app services one command at a
    time from its frame loop, so parallel callers would only queue behind each
    other with less visibility.
    """

    def __init__(self, port=8765, host='127.0.0.1', timeout=DEFAULT_TIMEOUT):
        self.base = f"http://{host}:{port}"
        self.timeout = timeout

    # ------------------------------------------------------------------
    # Transport
    # ------------------------------------------------------------------

    def _request(self, method, path, payload=None, timeout=None):
        data = None if payload is None else json.dumps(payload).encode('utf-8')
        request = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(
                    request, timeout=timeout or self.timeout) as response:
                body = response.read()
                if 'json' in response.headers.get('Content-Type', ''):
                    return json.loads(body)
                return body
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                message = json.loads(raw).get('error', raw.decode('utf-8'))
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = raw[:200]
            raise ApiError(e.code, message) from None

    def cmd(self, _command, **args):
        """Run one command. Returns its result payload.

        The parameter is `_command`, not `name`: several commands take a `name`
        argument of their own -- the checkpoint handlers -- and the obvious
        spelling collides with them.
        """
        return self._request('POST', '/cmd',
                             {'name': _command, 'args': args})['result']

    def batch(self, commands):
        """Several commands within a single frame.

        Use when a group of settings must take effect together -- the app
        renders nothing between them, so the simulation never runs against a
        half-applied state.
        """
        return self._request('POST', '/batch', {'commands': commands})['result']

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def wait_until_up(self, timeout=90.0, poll=0.25):
        """Block until the app answers. True if it did.

        Generous default: a cold start compiles every shader.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                self._request('GET', '/health', timeout=2.0)
                return True
            except (ApiError, OSError):
                time.sleep(poll)
        return False

    def health(self):
        """Frame number, asleep, paused. Answered WITHOUT the frame loop, so
        this is the one call that stays fast while the app is parked."""
        return self._request('GET', '/health', timeout=10.0)

    def state(self):
        return self._request('GET', '/state')['result']

    def sleep(self, timeout=300):
        return self.cmd('sleep', timeout=timeout)

    def wake(self):
        return self.cmd('wake')

    def quit(self):
        """Ask the app to close. Tolerates the connection dropping mid-reply --
        the app may well shut the socket before it finishes answering."""
        try:
            self.cmd('quit')
        except (ApiError, OSError):
            pass

    # ------------------------------------------------------------------
    # Settings, camera, window
    # ------------------------------------------------------------------

    def set_setting(self, source, field, value):
        return self.cmd('set_setting', source=source, field=field, value=value)

    def set_prefs(self, **fields):
        """Several preference edits in one frame."""
        return self.batch([
            {'cmd': 'set_setting',
             'args': {'source': 'prefs', 'field': k, 'value': v}}
            for k, v in fields.items()])

    def set_config(self, **fields):
        """Several config edits in one frame."""
        return self.batch([
            {'cmd': 'set_setting',
             'args': {'source': 'config', 'field': k, 'value': v}}
            for k, v in fields.items()])

    def set_camera(self, pan=None, zoom=None, mode=None):
        args = {k: v for k, v in
                (('pan', pan), ('zoom', zoom), ('mode', mode))
                if v is not None}
        return self.cmd('set_camera', **args)

    def set_window_size(self, width, height):
        """Resize. TAKES EFFECT NEXT FRAME -- capture immediately after this
        and you get the old size. Callers that care should let a frame pass;
        see wait_for_window_size()."""
        return self.cmd('set_window_size', width=width, height=height)

    def wait_for_window_size(self, width, height, timeout=10.0):
        """Resize and block until the framebuffer actually reports it.

        Exists because the resize lag is the single most likely piloting bug:
        glfw delivers it on the next poll, so a naive resize-then-capture
        silently captures at the previous size. Polling state until it agrees
        is cheap and removes the class of error entirely.

        Note the framebuffer size may not equal what was asked for on a HiDPI
        display, so this waits for STABILITY rather than for a specific pair.
        """
        self.set_window_size(width, height)
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            current = tuple(self.state()['framebuffer_size'])
            if current == last and current != (0, 0):
                return current
            last = current
            time.sleep(0.05)
        return tuple(self.state()['framebuffer_size'])

    # ------------------------------------------------------------------
    # Configs
    # ------------------------------------------------------------------

    def load_config(self, path):
        return self.cmd('load_config_path', path=str(path))

    def save_config(self, path, save_all=False, adopt=False):
        return self.cmd('save_config_to', path=str(path),
                        save_all=save_all, adopt=adopt)

    def reset(self):
        return self.cmd('reset')

    def set_paused(self, paused):
        return self.cmd('set_paused', paused=paused)

    # ------------------------------------------------------------------
    # Checkpoints
    # ------------------------------------------------------------------

    def set_checkpoint(self, name):
        return self.cmd('set_checkpoint_named', name=name)

    def load_checkpoint(self, name):
        return self.cmd('load_checkpoint_named', name=name)

    def delete_checkpoint(self, name):
        return self.cmd('delete_checkpoint_named', name=name)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def run_steps(self, steps, capture=None):
        """Advance exactly `steps` physics steps. Optionally capture at the end.

        The reproducible warmup: a candidate must be the same experiment every
        time, and app frames are not a fixed quantity of simulation.
        """
        return self.cmd('run_steps', steps=steps, capture=capture)

    def fresh_candidate(self):
        """A new random behaviour, already made step-mutable.

        The app defuses the zero-rule sentinel for us -- see
        _cmd_fresh_candidate. Without that a random immigrant would ignore
        mutation_scale forever.
        """
        return self.cmd('fresh_candidate')

    def evaluate_candidate(self, warmup_steps, mutate=None, reset=True,
                           capture=None):
        """Optionally mutate, run the warmup, and capture. One round trip."""
        return self.cmd('evaluate_candidate', warmup_steps=warmup_steps,
                        mutate=mutate, reset=reset, capture=capture)

    def screenshot(self, path=None, width=None, height=None,
                   include_overlays=False):
        """Capture. Returns PNG bytes when `path` is None."""
        if path is None:
            query = [f"{k}={v}" for k, v in
                     (('width', width), ('height', height)) if v is not None]
            if include_overlays:
                query.append('overlays=1')
            suffix = ('?' + '&'.join(query)) if query else ''
            return self._request('GET', '/screenshot' + suffix)
        return self.cmd('screenshot', path=str(Path(path)), width=width,
                        height=height, include_overlays=include_overlays)
