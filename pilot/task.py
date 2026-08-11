"""Long work on a background thread, reported safely to the GUI.

WHY THIS EXISTS. Loading a folder takes ninety seconds, projecting takes
twenty-five, and a search takes minutes. Doing any of them on the frame thread
freezes the window -- and a frozen window is not just unpleasant, it stops the
operator seeing the search they opened the tool to watch.

THE RULE: the worker owns the work, the GUI owns the drawing, and the only
thing that crosses between them is a small immutable snapshot behind a lock.
The GUI never touches a half-built Gallery, and the worker never touches imgui.

Deliberately not a general job system. One task at a time, no cancellation
beyond a cooperative flag, no queue -- because the GUI has exactly one "do the
slow thing" button at a time and anything more would be machinery in search of
a use.
"""

from __future__ import annotations

import threading
import traceback
from dataclasses import dataclass, field


@dataclass
class Progress:
    """What the GUI is allowed to see while work is in flight."""

    label: str = ''
    lines: list = field(default_factory=list)
    done: bool = False
    failed: bool = False
    error: str = ''
    result: object = None

    @property
    def latest(self):
        return self.lines[-1] if self.lines else ''


class Task:
    """One piece of background work.

    Usage from the GUI:

        task = Task.start("loading", lambda report: build(...))
        ...
        if task.progress.done:  collect task.progress.result

    The callable receives a `report` function to call with status strings. It
    must not touch anything the GUI reads except through that.
    """

    #: Keep the tail of the log; a long embed emits one line per chunk and the
    #: GUI only has room for a few.
    MAX_LINES = 200

    def __init__(self, label, work):
        self._work = work
        self._lock = threading.Lock()
        self._progress = Progress(label=label)
        self._cancel = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"pilot-{label}",
                                        daemon=True)

    @classmethod
    def start(cls, label, work):
        task = cls(label, work)
        task._thread.start()
        return task

    def _report(self, message):
        text = str(message).strip()
        if not text:
            return
        with self._lock:
            self._progress.lines.append(text)
            if len(self._progress.lines) > self.MAX_LINES:
                del self._progress.lines[:-self.MAX_LINES]

    def _run(self):
        try:
            result = self._work(self._report)
        except Exception as e:                                  # noqa: BLE001
            # Caught rather than allowed to kill the thread silently: a
            # background failure that only prints to a console nobody is
            # watching looks exactly like a hang.
            traceback.print_exc()
            with self._lock:
                self._progress.failed = True
                self._progress.error = f"{type(e).__name__}: {e}"
                self._progress.done = True
            return
        with self._lock:
            self._progress.result = result
            self._progress.done = True

    @property
    def progress(self):
        """A snapshot. Copied under the lock so the GUI cannot read a list
        that the worker is appending to mid-frame."""
        with self._lock:
            return Progress(label=self._progress.label,
                            lines=list(self._progress.lines),
                            done=self._progress.done,
                            failed=self._progress.failed,
                            error=self._progress.error,
                            result=self._progress.result)

    @property
    def running(self):
        with self._lock:
            return not self._progress.done

    def cancel(self):
        """Ask the work to stop. Cooperative -- the callable must check."""
        self._cancel.set()

    @property
    def cancelled(self):
        return self._cancel.is_set()

    def join(self, timeout=None):
        self._thread.join(timeout)
