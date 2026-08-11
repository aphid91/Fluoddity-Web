"""The frame loop's half of the API: draining requests and running schedules.

Everything here executes ON THE MAIN THREAD, called from the top of the frame.
The socket thread's job ended when it put a Request on the queue; this is where
those Requests actually happen, at a known point in the frame, with the GL
context available.

WHY THIS IS NOT IN THE ORCHESTRATOR
It is bookkeeping -- a queue, a cursor, a results list -- with no simulation
meaning. The Orchestrator holds two lines: drain, then run due commands. Keeping
the rest here means the API remains a directory that can be deleted.
"""

from __future__ import annotations

import queue

from . import schedule as schedule_mod


class CommandQueue:
    """Requests waiting for the frame loop.

    A plain queue.Queue with a drain that never blocks: the frame loop cannot
    afford to wait on an empty queue, because rendering the next frame is not
    optional.
    """

    def __init__(self, dispatch):
        #: name, args -> result. Supplied by the Orchestrator; this module does
        #: not know what any command means.
        self._dispatch = dispatch
        self._queue = queue.Queue()

    def submit(self, request):
        self._queue.put(request)
        return request

    def drain(self, limit=64):
        """Execute everything queued, and complete each Request.

        `limit` caps one frame's work so a pilot that floods the queue slows
        the app down rather than freezing it -- an app that stops drawing is an
        app that cannot be watched, which is the one thing this design will not
        trade away. Anything left over runs next frame.
        """
        for _ in range(limit):
            try:
                request = self._queue.get_nowait()
            except queue.Empty:
                return
            self._execute(request)

    def _execute(self, request):
        try:
            if request.name == '__batch__':
                request.complete(self._batch(request.args['commands']))
            else:
                request.complete(self._dispatch(request.name, request.args))
        except (ValueError, KeyError, FileNotFoundError, OSError) as e:
            # The caller's mistake: a config that isn't there, a setting name
            # that doesn't exist, an unwritable path. Reported as a bad request
            # so a pilot can tell its own bug from a broken app.
            request.fail(f"{type(e).__name__}: {e}", bad_request=True)
        except Exception as e:                      # noqa: BLE001
            request.fail(f"{type(e).__name__}: {e}")

    def _batch(self, commands):
        """Run several commands within one drain, so no frame renders between.

        Stops at the first failure and reports how far it got. Continuing would
        apply the back half of a batch to a state the front half failed to
        establish, which is a worse outcome than a short result list.
        """
        results = []
        for entry in commands:
            name = entry.get('cmd') or entry.get('name')
            try:
                results.append({'cmd': name, 'ok': True,
                                'result': self._dispatch(name, entry.get('args') or {})})
            except Exception as e:                  # noqa: BLE001
                results.append({'cmd': name, 'ok': False,
                                'error': f"{type(e).__name__}: {e}"})
                break
        return results


class ScheduleRunner:
    """The one active schedule, and where it has got to.

    ONE AT A TIME, deliberately. Two overlapping schedules writing to the same
    camera and the same config would be untraceable after the fact, and nothing
    about the search this exists for wants them. Submitting a second while one
    runs is an error; /schedule/cancel is the way out.
    """

    def __init__(self, dispatch, current_frame, allowed):
        self._dispatch = dispatch
        #: () -> the app's current frame. A callable rather than a value
        #: because the runner is built once and asked repeatedly.
        self._current_frame = current_frame
        self._allowed = allowed

        self._schedule = None
        self._cursor = 0
        self._results = []
        self._state = 'idle'
        self._next_id = 1

    # ---- called from the socket thread ----

    def submit(self, document):
        if self._state == 'running':
            raise ValueError(
                f"schedule {self._schedule.id} is still running "
                f"({len(self._schedule.commands) - self._cursor} left); "
                "POST /schedule/cancel first")

        app_frame = self._current_frame()
        parsed = schedule_mod.parse(document, app_frame,
                                    schedule_id=self._next_id,
                                    allowed=self._allowed)
        self._next_id += 1
        self._schedule = parsed
        self._cursor = 0
        self._results = []
        self._state = 'running'
        return {
            'schedule_id': parsed.id,
            'label': parsed.label,
            'submitted_on_frame': app_frame,
            'command_count': len(parsed.commands),
            'last_frame': parsed.last_frame,
            # Echoed back so a pilot can check that "+1000" resolved to what it
            # expected, rather than discovering seventeen seconds later that it
            # did not.
            'resolved': [{'frame': c.frame, 'cmd': c.name}
                         for c in parsed.commands],
        }

    def cancel(self):
        if self._schedule is None:
            return {'cancelled': False, 'state': self._state}
        remaining = len(self._schedule.commands) - self._cursor
        self._state = 'cancelled'
        return {'cancelled': True, 'schedule_id': self._schedule.id,
                'remaining': remaining}

    def status(self):
        if self._schedule is None:
            return {'state': 'idle', 'app_frame': self._current_frame()}
        return {
            'state': self._state,
            'schedule_id': self._schedule.id,
            'label': self._schedule.label,
            'app_frame': self._current_frame(),
            'pending': max(0, len(self._schedule.commands) - self._cursor),
            'last_frame': self._schedule.last_frame,
            'results': self._results,
        }

    # ---- called from the frame loop ----

    def tick(self, app_frame):
        """Run whatever is due at `app_frame`. Main thread only."""
        if self._state != 'running' or self._schedule is None:
            return

        due, self._cursor = self._schedule.due(app_frame, self._cursor)
        for command in due:
            record = {'frame': command.frame, 'cmd': command.name}
            # Lateness is recorded rather than smoothed over: a schedule whose
            # commands consistently run late is one whose frame numbers are
            # lying to the pilot, and that is worth being able to see.
            if app_frame > command.frame:
                record['late_by'] = app_frame - command.frame
            try:
                record['result'] = self._dispatch(command.name, command.args)
                record['ok'] = True
            except Exception as e:                  # noqa: BLE001
                record['ok'] = False
                record['error'] = f"{type(e).__name__}: {e}"
            self._results.append(record)

        if self._cursor >= len(self._schedule.commands):
            self._state = 'done'
