"""Schedule parsing, ordering and dispatch. No GPU, no window, no app.

Runs anywhere:

    Scratch.venv/Scripts/python.exe tests/test_schedule_parse.py

WHAT THIS IS GUARDING
The scheduler's failure modes are all quiet ones. A same-frame reordering, a
command dropped because the loop skipped its frame number, a "+1000" resolved
against the wrong base -- none of these raise. They produce a search that
worked yesterday and produces different pictures today, which is the most
expensive kind of bug to have in a system whose whole output is pictures.

So the interesting cases here are the ones where a wrong implementation still
runs to completion.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from api import schedule as sched                                   # noqa: E402
from api.server import API_COMMANDS, UI_ONLY                        # noqa: E402
from ui import settings_spec as spec                                # noqa: E402

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


def raises(label, fn, expected=sched.ScheduleError):
    try:
        fn()
    except expected:
        print(f"  ok    {label}")
    except Exception as e:                                          # noqa: BLE001
        print(f"  FAIL  {label}  -- raised {type(e).__name__}: {e}")
        _failures.append(label)
    else:
        print(f"  FAIL  {label}  -- no error raised")
        _failures.append(label)


def doc(commands, **extra):
    return {'version': sched.FORMAT_VERSION, 'commands': commands, **extra}


# ---------------------------------------------------------------------------

def test_frame_resolution():
    print("\nframe resolution")

    s = sched.parse(doc([
        {'at': 0, 'cmd': 'reset'},
        {'at': '+1000', 'cmd': 'reset'},
        {'at': 250, 'cmd': 'reset'},
    ]), app_frame=500)

    frames = [c.frame for c in s.commands]
    # Absolute stays absolute; relative resolves against submission; and the
    # result is SORTED, so the 250 comes first despite being written last.
    check("absolute and relative resolve, then sort", frames == [0, 250, 1500],
          str(frames))

    s2 = sched.parse(doc([{'at': '+10', 'cmd': 'reset'}]), app_frame=0)
    check("relative against frame 0", s2.commands[0].frame == 10)

    raises("negative absolute rejected",
           lambda: sched.parse(doc([{'at': -5, 'cmd': 'reset'}]), 0))
    raises("negative offset rejected",
           lambda: sched.parse(doc([{'at': '+-5', 'cmd': 'reset'}]), 0))
    raises("unreadable 'at' rejected",
           lambda: sched.parse(doc([{'at': 'soon', 'cmd': 'reset'}]), 0))
    raises("missing 'at' rejected",
           lambda: sched.parse(doc([{'cmd': 'reset'}]), 0))
    # bool is an int subclass, so `at: true` would silently mean frame 1.
    raises("boolean 'at' rejected",
           lambda: sched.parse(doc([{'at': True, 'cmd': 'reset'}]), 0))


def test_same_frame_ordering():
    print("\nsame-frame ordering")

    # The canonical batch head: these three MUST run in this order, or the
    # reset lands on the old config and the rate applies to the wrong one.
    s = sched.parse(doc([
        {'at': 0, 'cmd': 'load_config_path', 'args': {'path': 'a.json'}},
        {'at': 0, 'cmd': 'reset'},
        {'at': 0, 'cmd': 'set_setting',
         'args': {'source': 'prefs', 'field': 'physics_steps', 'value': 60}},
    ]), app_frame=0)

    names = [c.name for c in s.commands]
    check("declaration order preserved within a frame",
          names == ['load_config_path', 'reset', 'set_setting'], str(names))

    # Interleaved frames must sort by frame while keeping written order inside
    # each -- the case a naive sort on frame alone gets right by luck and a
    # sort on the wrong key gets wrong invisibly.
    s2 = sched.parse(doc([
        {'at': 5, 'cmd': 'reset'},
        {'at': 1, 'cmd': 'undo'},
        {'at': 5, 'cmd': 'redo'},
        {'at': 1, 'cmd': 'reload'},
    ]), app_frame=0)
    pairs = [(c.frame, c.name) for c in s2.commands]
    check("sorted by frame, stable within it",
          pairs == [(1, 'undo'), (1, 'reload'), (5, 'reset'), (5, 'redo')],
          str(pairs))


def test_due_never_drops():
    print("\ndue(): a skipped frame runs late, not never")

    s = sched.parse(doc([
        {'at': 998, 'cmd': 'reset'},
        {'at': 1000, 'cmd': 'undo'},
        {'at': 1001, 'cmd': 'redo'},
        {'at': 1003, 'cmd': 'reload'},
        {'at': 2000, 'cmd': 'reset'},
    ]), app_frame=0)

    # The loop hitches: 997 then 1003. Everything in the gap must still fire,
    # in order, on the tick that notices.
    fired, cursor = s.due(997, 0)
    check("nothing due before the first command", fired == [], str(fired))

    fired, cursor = s.due(1003, cursor)
    names = [c.name for c in fired]
    check("the whole skipped span fires, in order",
          names == ['reset', 'undo', 'redo', 'reload'], str(names))

    fired, cursor = s.due(1003, cursor)
    check("already-fired commands do not repeat", fired == [], str(fired))

    fired, cursor = s.due(2000, cursor)
    check("later command still fires", [c.name for c in fired] == ['reset'])
    check("cursor lands at the end", cursor == len(s.commands))


def test_due_exact_frames():
    print("\ndue(): one frame at a time")

    s = sched.parse(doc([
        {'at': 1, 'cmd': 'reset'},
        {'at': 2, 'cmd': 'undo'},
        {'at': 2, 'cmd': 'redo'},
    ]), app_frame=0)

    cursor = 0
    seen = []
    for frame in range(0, 4):
        fired, cursor = s.due(frame, cursor)
        seen.append((frame, [c.name for c in fired]))

    check("each command fires on exactly its frame",
          seen == [(0, []), (1, ['reset']), (2, ['undo', 'redo']), (3, [])],
          str(seen))


def test_round_trip():
    print("\nserialization round-trip")

    original = doc([
        {'at': 0, 'cmd': 'reset'},
        {'at': 100, 'cmd': 'screenshot', 'args': {'path': 'out/a.png'}},
        {'at': 200, 'cmd': 'sleep'},
    ], label='sweep-042')

    first = sched.parse(original, app_frame=0)
    second = sched.parse(first.to_dict(), app_frame=0)

    check("commands survive the round-trip",
          [(c.frame, c.name, c.args) for c in first.commands]
          == [(c.frame, c.name, c.args) for c in second.commands])
    check("label survives", second.label == 'sweep-042')

    # A schedule saved relative can be replayed in a later session, where the
    # absolute frame counter is somewhere else entirely.
    relative = first.to_dict(relative_to=0)
    replayed = sched.parse(relative, app_frame=50_000)
    frames = [c.frame for c in replayed.commands]
    check("relative save replays against a new base",
          frames == [50_000, 50_100, 50_200], str(frames))


def test_rejections():
    print("\nrejections at submission")

    raises("unknown command rejected",
           lambda: sched.parse(doc([{'at': 0, 'cmd': 'frobnicate'}]), 0,
                               allowed=API_COMMANDS))
    raises("UI-only command rejected",
           lambda: sched.parse(doc([{'at': 0, 'cmd': 'preview_config'}]), 0,
                               allowed=API_COMMANDS))
    # A scheduled capture has no connection to return bytes on, so a missing
    # path has to be caught now rather than after the batch has run.
    raises("pathless scheduled screenshot rejected",
           lambda: sched.parse(doc([{'at': 0, 'cmd': 'screenshot'}]), 0,
                               allowed=API_COMMANDS))
    raises("empty command list rejected", lambda: sched.parse(doc([]), 0))
    raises("wrong version rejected",
           lambda: sched.parse({'version': 99, 'commands': [
               {'at': 0, 'cmd': 'reset'}]}, 0))
    raises("non-object args rejected",
           lambda: sched.parse(doc([{'at': 0, 'cmd': 'reset', 'args': []}]), 0))
    raises("non-dict document rejected", lambda: sched.parse([], 0))

    # Path present: the same command must be accepted.
    ok = sched.parse(doc([{'at': 0, 'cmd': 'screenshot',
                           'args': {'path': 'x.png'}}]), 0,
                     allowed=API_COMMANDS)
    check("screenshot with a path accepted", len(ok.commands) == 1)


def test_command_surface():
    print("\ncommand surface consistency")

    # The allowlist and the UI-only list must not overlap: a name in both would
    # resolve differently depending on which check ran first.
    overlap = API_COMMANDS & set(UI_ONLY)
    check("allowlist and UI-only list are disjoint", not overlap, str(overlap))

    # Every allowlisted name must exist in the real command table, or a pilot
    # gets "unknown command" from a name the server advertised.
    from orchestrator.orchestrator import Orchestrator
    import inspect
    table = inspect.getsource(Orchestrator._command_table)
    missing = sorted(n for n in API_COMMANDS if f"'{n}':" not in table)
    check("every allowlisted command is in the table", not missing, str(missing))


def test_settings_registry():
    print("\nsettings registry lookup")

    # set_setting resolves (source, field) through this; an entry the registry
    # cannot find is a control the API silently cannot touch.
    unfindable = [(s.source, s.field) for s in spec.SETTINGS
                  if spec.find(s.source, s.field) is not s]
    check("every registered setting is findable", not unfindable,
          str(unfindable))

    check("unknown field returns None", spec.find('prefs', 'nope') is None)
    check("unknown source returns None", spec.find('nope', 'brightness') is None)
    # Keyed on the pair, so a field name that exists under a different source
    # must not resolve.
    check("wrong source does not resolve",
          spec.find('prefs', 'mutation_scale') is None)

    duplicates = len(spec.SETTINGS) - len(spec._BY_KEY)
    check("no duplicate (source, field) keys", duplicates == 0,
          f"{duplicates} collisions")


def main():
    print("Schedule parsing and dispatch")
    test_frame_resolution()
    test_same_frame_ordering()
    test_due_never_drops()
    test_due_exact_frames()
    test_round_trip()
    test_rejections()
    test_command_surface()
    test_settings_registry()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
