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

    #: How far along, 0..1, or None when the work cannot say. Kept separate
    #: from the log lines because a bar needs a number and a status line needs
    #: a sentence, and deriving either from the other means parsing text.
    fraction: float | None = None
    #: What the fraction is counting -- "1200/5000 images". Shown inside the
    #: bar, where a percentage alone is much less useful: on a long embed the
    #: interesting question is how many are left, not what share is done.
    detail: str = ''

    @property
    def latest(self):
        return self.lines[-1] if self.lines else ''


class Reporter:
    """What background work is handed to describe its own progress.

    CALLABLE, so anything already written against `progress=print` works
    unchanged; `.step()` is the addition, for work that can count. Keeping
    both on one object means a function does not need to know whether its
    caller wants a bar -- it says what it knows and the GUI decides.
    """

    def __init__(self, log, step=None):
        self._log = log
        self._step = step

    def __call__(self, message):
        self._log(message)

    def step(self, done, total, noun='', label=None):
        if self._step is not None:
            self._step(done, total, noun, label)


def null_reporter(message=None):
    """A reporter that discards everything. For callers with no GUI."""


null_reporter.step = lambda *a, **k: None


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
        """Append a status line. Callable, so plain `progress=print` code works.

        Also carries .step() for work that can say how far along it is; making
        the reporter an object rather than two arguments means a function that
        only logs needs no changes to be driven by one that also measures.
        """
        text = str(message).strip()
        if not text:
            return
        with self._lock:
            self._progress.lines.append(text)
            if len(self._progress.lines) > self.MAX_LINES:
                del self._progress.lines[:-self.MAX_LINES]

    def _step(self, done, total, noun='', label=None):
        """Set the completed fraction. `total` of 0 clears it."""
        with self._lock:
            if not total:
                self._progress.fraction = None
                self._progress.detail = ''
            else:
                self._progress.fraction = max(0.0, min(1.0, done / total))
                self._progress.detail = (f"{done}/{total} {noun}".strip())
            if label is not None:
                self._progress.label = label

    def _make_reporter(self):
        """The `report` handed to the work: callable, with .step()."""
        return Reporter(self._report, self._step)

    def _run(self):
        try:
            result = self._work(self._make_reporter())
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
                            result=self._progress.result,
                            fraction=self._progress.fraction,
                            detail=self._progress.detail)

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
