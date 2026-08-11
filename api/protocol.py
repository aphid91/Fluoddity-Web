"""The handoff between the socket thread and the frame loop.

THE PROBLEM THIS SOLVES
The GL context belongs to the main thread. Every command that touches the
simulation, the camera or a framebuffer must run there, and nowhere else -- a
GL call from another thread does not raise, it corrupts. But HTTP requests
arrive on their own threads, and the caller needs an answer.

So a request is not executed where it arrives. It is queued, the arriving
thread blocks on it, and the frame loop executes it during its drain step and
signals completion. That is the whole mechanism, and it is deliberately the
smallest thing that works: a queue, a dataclass and one Event per request. No
asyncio, no futures library, nothing to learn beyond what is written here.

WHY NOT JUST LOCK THE ORCHESTRATOR
Because the work has to happen at a particular POINT in the frame, not merely
one-at-a-time. A screenshot taken mid-physics-loop would capture a half-drawn
accumulation buffer; a config load applied between the camera's samples would
blend two different simulations into one image. Queuing to a known point in the
frame is what makes the results meaningful, and the mutual exclusion falls out
of it for free.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

#: How long an HTTP request waits for the frame loop before giving up. Generous
#: because the loop may be mid-rebuild (reallocating GPU buffers for a new world
#: size takes a moment) -- but finite, because a caller blocked forever on a
#: crashed frame loop is worse than an error.
DEFAULT_TIMEOUT = 30.0


class CommandError(Exception):
    """A command that failed for a reason the caller should hear about.

    Distinct from an unexpected exception: this is "you asked for a config that
    isn't there", not "the renderer fell over". The server maps it to a 400 and
    everything else to a 500, so a pilot can tell its own bug from ours.
    """


@dataclass
class Request:
    """One command in flight between the socket thread and the frame loop.

    `result` and `error` are written by the MAIN THREAD ONLY, before `done` is
    set; the requesting thread reads them only after `done` has fired. That
    ordering is the whole synchronization contract -- there is no lock because
    the Event is the handoff.
    """

    name: str
    args: dict = field(default_factory=dict)
    done: threading.Event = field(default_factory=threading.Event)
    result: object = None
    error: str | None = None
    #: True when `error` came from a bad request rather than a broken app.
    bad_request: bool = False

    def complete(self, result):
        self.result = result
        self.done.set()

    def fail(self, message, bad_request=False):
        self.error = str(message)
        self.bad_request = bad_request
        self.done.set()

    def wait(self, timeout=DEFAULT_TIMEOUT):
        """Block until the frame loop has run this. True if it did.

        False means the loop never got to it -- asleep with no waker, mid-hang,
        or shutting down. The caller reports a timeout rather than a result,
        because a request that may still execute later must not be reported as
        having failed to execute at all.
        """
        return self.done.wait(timeout)


class PilotHost:
    """What the server is allowed to do to the app. Deliberately three things.

    The server is handed THIS, not the Orchestrator. It is the same discipline
    the interface follows (ARCHITECTURE rule 10: the UI owns no simulation
    truth) applied to the second surface that drives the app -- and enforced by
    construction rather than by remembering, because a module holding a
    reference to the Orchestrator will eventually use it.

    `wake` is the odd one out and the reason this class exists at all. Every
    other call goes THROUGH the frame loop; wake has to reach the app WHILE the
    frame loop is parked and therefore draining nothing. It is safe to call
    off-thread precisely because it does nothing but assign a flag.
    """

    def __init__(self, submit, wake, on_close=None):
        #: Queue a Request for the frame loop and return it, unexecuted.
        self.submit = submit
        #: Unpark the frame loop. Called from the socket thread.
        self.wake = wake
        #: Called when the server shuts down. Optional.
        self.on_close = on_close
