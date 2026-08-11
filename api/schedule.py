"""Commands keyed to app frames: the batch half of the piloting API.

WHAT A SCHEDULE IS FOR
Some things a pilot wants cannot be expressed as a request/response, because
they are about TIME: let this config run for a thousand frames, then move the
camera, then capture it. Holding an HTTP connection open for the seventeen
seconds that takes would be absurd, so a schedule is submitted, acknowledged
immediately, and executed by the frame loop as the frames go by.

THE CLOCK IS Orchestrator.app_frame -- displayed frames since startup,
monotonic. NOT system.frame_count, which counts physics sub-steps and returns
to zero on every reset; scheduling against that would drift the moment anyone
changed the physics rate, and silently.

Because app frames are not a fixed amount of simulation ("frame 1000" is 30,000
physics steps at the default rate and 60,000 at double), a schedule that wants
to be reproducible pins physics_steps at the start. See docs/API.md.

This module is PURE: it parses, validates, resolves and orders. It never
touches the app, which is what lets the whole of it be tested without a GPU.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

#: Bumped when the document shape changes incompatibly. Refusing an unknown
#: version is friendlier than silently misreading one.
FORMAT_VERSION = 1


class ScheduleError(ValueError):
    """A schedule document that cannot be executed as written."""


@dataclass(frozen=True)
class ScheduledCommand:
    """One command, at one resolved absolute app frame."""

    frame: int
    name: str
    args: dict
    #: Position in the submitted document. THE TIEBREAKER: several commands
    #: routinely share a frame ("load, then reset, then set the rate") and the
    #: order they were written in is the order they must run in. Sorting on
    #: (frame, seq) with this present is what makes that a guarantee rather
    #: than an accident of Python's sort being stable.
    seq: int


@dataclass(frozen=True)
class Schedule:
    """A submitted batch, resolved to absolute frames and ordered."""

    id: int
    commands: tuple
    label: str = ""

    @property
    def last_frame(self):
        return self.commands[-1].frame if self.commands else 0

    def due(self, app_frame, cursor):
        """Commands due at or before `app_frame`, starting from `cursor`.

        Returns (commands, new_cursor).

        A MISSED FRAME RUNS LATE RATHER THAN NOT AT ALL. The loop can skip past
        a frame number -- a rebuild hitched, the app was asleep, a capture
        stalled the GPU -- and a schedule that dropped those commands would
        produce different results on a slower machine, which for a search that
        is meant to be repeatable is the worst possible failure. So the test is
        `frame <= app_frame`, not equality, and lateness is reported instead of
        being hidden.

        The cursor is an index rather than a search because the list is sorted:
        everything before it has run, so nothing needs re-examining.
        """
        out = []
        while cursor < len(self.commands) and self.commands[cursor].frame <= app_frame:
            out.append(self.commands[cursor])
            cursor += 1
        return out, cursor

    def to_dict(self, relative_to=None):
        """Serialize. With `relative_to`, frames come back out as "+N" offsets.

        Round-tripping through absolute frames would bake in the app_frame the
        schedule happened to be submitted at, making a saved schedule unusable
        in any later session -- which is exactly what a saved schedule is for.
        """
        commands = []
        for command in self.commands:
            at = (command.frame if relative_to is None
                  else f"+{command.frame - relative_to}")
            entry = {'at': at, 'cmd': command.name}
            if command.args:
                entry['args'] = command.args
            commands.append(entry)
        return {'version': FORMAT_VERSION, 'label': self.label,
                'commands': commands}


def parse(document, app_frame, schedule_id=0, allowed=None):
    """Build a Schedule from a submitted document.

    `app_frame` is what "+N" is relative to: the frame the schedule was
    submitted on. Resolution happens HERE, once, so the executing loop only
    ever deals in absolute numbers and cannot drift.

    `allowed` is the set of command names a schedule may contain. Checking at
    submission rather than at execution is the point -- a typo in command 40 of
    a batch should be an error the pilot sees while it is still holding the
    connection, not a log line seventeen seconds later that nobody reads.
    """
    if not isinstance(document, dict):
        raise ScheduleError("schedule must be a JSON object")

    version = document.get('version', FORMAT_VERSION)
    if version != FORMAT_VERSION:
        raise ScheduleError(
            f"unsupported schedule version {version} (expected {FORMAT_VERSION})")

    raw = document.get('commands')
    if not isinstance(raw, list) or not raw:
        raise ScheduleError("schedule needs a non-empty 'commands' list")

    commands = []
    for seq, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ScheduleError(f"command {seq} is not an object")

        name = entry.get('cmd')
        if not isinstance(name, str) or not name:
            raise ScheduleError(f"command {seq} has no 'cmd'")
        if allowed is not None and name not in allowed:
            raise ScheduleError(f"command {seq}: {name!r} cannot be scheduled")

        args = entry.get('args', {})
        if not isinstance(args, dict):
            raise ScheduleError(f"command {seq}: 'args' must be an object")

        # A scheduled capture has nowhere to return bytes to -- there is no
        # open connection any more -- and buffering PNGs in memory for later
        # collection is an unbounded leak in a loop designed to run thousands
        # of times. Caught here rather than at execution, where a whole batch
        # would already have run.
        if name == 'screenshot' and not args.get('path'):
            raise ScheduleError(
                f"command {seq}: a scheduled screenshot needs a 'path' "
                "(use GET /screenshot for bytes back)")

        commands.append(ScheduledCommand(
            frame=_resolve_frame(entry.get('at'), app_frame, seq),
            name=name, args=args, seq=seq))

    # Stable on (frame, seq): same-frame commands keep their written order.
    commands.sort(key=lambda c: (c.frame, c.seq))
    return Schedule(id=schedule_id, commands=tuple(commands),
                    label=str(document.get('label', '')))


def _resolve_frame(at, app_frame, seq):
    """An 'at' field -> an absolute app frame.

    Accepts an int (absolute) or a "+N" string (relative to submission).
    Relative is the idiom a pilot should use: on its fortieth batch it has no
    idea what the absolute counter is at, and should not have to ask.
    """
    if at is None:
        raise ScheduleError(f"command {seq} has no 'at'")

    if isinstance(at, bool):        # bool is an int subclass; reject it early
        raise ScheduleError(f"command {seq}: 'at' must be a frame number")

    if isinstance(at, int):
        if at < 0:
            raise ScheduleError(f"command {seq}: negative frame {at}")
        return at

    if isinstance(at, str):
        text = at.strip()
        if text.startswith('+'):
            try:
                offset = int(text[1:])
            except ValueError:
                raise ScheduleError(
                    f"command {seq}: cannot read offset {at!r}") from None
            if offset < 0:
                raise ScheduleError(f"command {seq}: negative offset {at!r}")
            return app_frame + offset
        try:
            value = int(text)
        except ValueError:
            raise ScheduleError(f"command {seq}: cannot read 'at' {at!r}") from None
        if value < 0:
            raise ScheduleError(f"command {seq}: negative frame {at!r}")
        return value

    raise ScheduleError(f"command {seq}: 'at' must be a number or \"+N\"")


def load(path, app_frame, schedule_id=0, allowed=None):
    """Read a schedule document from disk."""
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    return parse(document, app_frame, schedule_id=schedule_id, allowed=allowed)


def save(path, schedule, relative_to=None):
    """Write a schedule document to disk."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(schedule.to_dict(relative_to=relative_to), indent=2),
        encoding='utf-8')
    return target
