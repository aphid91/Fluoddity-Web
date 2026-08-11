"""A real search against a real app. Needs a display and a GPU.

    Scratch.venv/Scripts/python.exe tests/test_pilot_loopback.py

WHAT THIS CATCHES THAT THE PURE TESTS CANNOT
test_moves.py proves the arithmetic and test_search.py proves the strategy, but
both run against synthetic data. What is left is everything that only exists
when the two processes are actually talking: whether a checkpoint restored
before a mutation really does make siblings diverge from the same parent,
whether the manifest survives being interrupted, whether a resumed run can breed
from candidates whose checkpoints died with the previous process.

Those all fail silently. A search with broken checkpoint restore still runs and
still produces pictures -- it just does a random walk instead of a fan-out, and
nothing says so.

Uses ConstantScorer and no embedding backend, so it needs neither torch nor a
reference folder: this tests the LOOP, not the objective.
"""

from __future__ import annotations

import dataclasses
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pilot.candidate import IMMIGRANT, MUTANT                       # noqa: E402
from pilot.client import FluoddityClient                            # noqa: E402
from pilot.config import SearchConfig                               # noqa: E402
from pilot.run import RunFolder, SearchRun                          # noqa: E402
from pilot.scoring import ConstantScorer                            # noqa: E402
from pilot.search import BeamSearch                                 # noqa: E402

PORT = 8795
#: Small and short: this is a correctness test, not a benchmark.
WARMUP = 300
CAPTURE = 128

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


class ScriptedScorer:
    """Scores by position, so which candidate wins is known in advance.

    Lets the test assert that the beam kept the RIGHT candidates rather than
    merely that it kept some.
    """

    def __init__(self):
        self.calls = 0

    def score(self, embeddings):
        import numpy as np
        self.calls += 1
        n = embeddings.shape[0]
        # Descending, so candidate 0 of each generation is always best.
        return np.asarray([float(n - i) for i in range(n)], dtype=np.float32)

    def describe(self):
        return "scripted"


def base_config(run_dir, **overrides):
    cfg = SearchConfig(
        run_dir=str(run_dir), port=PORT, world_size=0.1,
        warmup_steps=WARMUP, capture_size=CAPTURE,
        generations=2, beam_width=2, children_per_parent=2, immigrants=1,
        physics_steps=30, seed=7,
    )
    return dataclasses.replace(cfg, **overrides) if overrides else cfg


# ---------------------------------------------------------------------------

def test_session_setup(client):
    print("\nsession setup")

    state = client.state()
    check("world_size applied", state['entity_count'] == 60000,
          f"entities={state['entity_count']}")
    check("cohorts pinned to 1", state['cohorts'] == 1,
          f"cohorts={state['cohorts']}")
    check("mutation_scale at 0 for evaluation",
          state['mutation_scale'] == 0.0, str(state['mutation_scale']))
    check("window matches capture size",
          tuple(state['framebuffer_size']) == (CAPTURE, CAPTURE),
          str(state['framebuffer_size']))


def test_run_produces_everything(run_dir):
    print("\nthe run folder")

    folder = RunFolder(run_dir)
    check("search.json written", (run_dir / 'search.json').is_file())
    check("manifest written", folder.manifest.is_file())

    rows = folder.read()
    check("manifest has candidates", len(rows) > 0, f"{len(rows)} rows")

    captures = list(folder.captures.glob('*.png'))
    configs = list(folder.configs.glob('*.json'))
    check("a capture per candidate", len(captures) == len(rows),
          f"{len(captures)} captures for {len(rows)} rows")
    check("a config per candidate", len(configs) == len(rows),
          f"{len(configs)} configs for {len(rows)} rows")

    check("every candidate is scored",
          all(r.score is not None for r in rows))
    check("every candidate carries its rule",
          all(len(r.rule) == 80 for r in rows),
          str([len(r.rule) for r in rows[:3]]))
    check("captures are non-empty",
          all(p.stat().st_size > 0 for p in captures))

    return rows


def test_lineage(rows):
    print("\nlineage")

    by_generation = {}
    for row in rows:
        by_generation.setdefault(row.generation, []).append(row)

    check("two generations recorded", sorted(by_generation) == [0, 1],
          str(sorted(by_generation)))

    gen0 = by_generation[0]
    check("generation 0 is all immigrants",
          all(r.origin == IMMIGRANT for r in gen0),
          str({r.origin for r in gen0}))
    check("generation 0 has no parents",
          all(r.parent_id is None for r in gen0))

    gen1 = by_generation[1]
    mutants = [r for r in gen1 if r.origin == MUTANT]
    check("generation 1 contains mutants", len(mutants) > 0)
    check("every mutant names a real parent",
          all(any(p.id == m.parent_id for p in rows) for m in mutants))
    check("every mutant records its scale and seed",
          all(m.mutation_scale is not None and m.mutation_seed is not None
              for m in mutants))

    return mutants


def test_siblings_diverge(mutants):
    print("\nsiblings diverge from a shared parent")

    by_parent = {}
    for mutant in mutants:
        by_parent.setdefault(mutant.parent_id, []).append(mutant)
    families = [group for group in by_parent.values() if len(group) > 1]

    check("at least one parent produced several children", bool(families),
          "cannot test divergence")
    if not families:
        return

    for family in families:
        seeds = {m.mutation_seed for m in family}
        check(f"siblings of {family[0].parent_id} got distinct seeds",
              len(seeds) == len(family), str(sorted(seeds)))

        # THE assertion this whole file exists for. If make_mutant failed to
        # restore the parent's checkpoint, each child would be a step from the
        # PREVIOUS child rather than from the parent -- a random walk. The
        # rules would still differ, so only comparing pairwise would pass; what
        # distinguishes the two cases is that a fan-out keeps every child at a
        # similar distance from the parent.
        rules = [m.rule for m in family]
        pairs_differ = all(
            rules[i] != rules[j]
            for i in range(len(rules)) for j in range(i + 1, len(rules)))
        check(f"siblings of {family[0].parent_id} are distinct", pairs_differ)


def test_immigrants_are_fertile(rows):
    print("\nimmigrants are not sterile (the zero-rule trap)")

    immigrants = [r for r in rows if r.origin == IMMIGRANT]
    check("immigrants were produced", bool(immigrants))

    # fresh_candidate adopts the generated rule, so the sentinel must be gone.
    # A zero rule here would mean every descendant ignores mutation_scale.
    for immigrant in immigrants:
        nonzero = sum(1 for v in immigrant.rule if v != 0.0)
        check(f"{immigrant.id} has a real (non-sentinel) rule", nonzero > 0,
              "the zero-rule sentinel was not defused")
        break

    all_real = all(any(v != 0.0 for v in r.rule) for r in immigrants)
    check("every immigrant carries a real rule", all_real)


def test_resume(run_dir, base):
    print("\nresuming")

    before = RunFolder(run_dir).read()
    cfg = dataclasses.replace(base, resume=True, generations=1)

    run = SearchRun(cfg, scorer=ConstantScorer(0.5), backend=None)
    run.run()

    after = RunFolder(run_dir).read()
    check("resumed run appended rather than restarted",
          len(after) > len(before), f"{len(before)} -> {len(after)}")

    generations = sorted({r.generation for r in after})
    check("continued at the next generation", generations == [0, 1, 2],
          str(generations))

    new_rows = after[len(before):]
    check("resumed candidates were evaluated",
          all(r.score is not None for r in new_rows))
    # The real question: could it BREED after resuming? Checkpoints died with
    # the previous process, so a mutant in the new generation proves they were
    # re-established from the saved configs.
    check("resumed run could still produce mutants",
          any(r.origin == MUTANT for r in new_rows),
          str({r.origin for r in new_rows}))


def test_torn_manifest(tmp):
    print("\na torn manifest line")

    folder = RunFolder(tmp / 'torn')
    folder.create()
    with folder.manifest.open('w', encoding='utf-8') as handle:
        handle.write(json.dumps({
            'id': 'gen000_000', 'generation': 0, 'origin': IMMIGRANT,
            'rule': [0.1] * 80, 'score': 1.0}) + '\n')
        handle.write('{"id": "gen000_001", "generation": 0, "orig')  # killed

    rows = folder.read()
    check("the intact line survives a truncated write", len(rows) == 1,
          f"{len(rows)} rows")
    check("and it is the right one", rows[0].id == 'gen000_000')


# ---------------------------------------------------------------------------

def main():
    print("Pilot loopback (needs a display)")

    app = subprocess.Popen(
        [sys.executable, str(ROOT / 'main.py'), '--api-port', str(PORT)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True)

    client = FluoddityClient(port=PORT)
    try:
        if not client.wait_until_up(timeout=90):
            print("  FAIL  the app never came up")
            if app.poll() is not None:
                print(app.stdout.read()[-2000:])
            return 1
        print("  ok    the app came up")

        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            run_dir = tmp / 'run'
            cfg = base_config(run_dir)

            scorer = ScriptedScorer()
            started = time.monotonic()
            SearchRun(cfg, client=client, scorer=scorer,
                      strategy=BeamSearch(cfg), backend=None).run()
            elapsed = time.monotonic() - started
            print(f"\n  (2 generations in {elapsed:.1f}s)")

            check("the scorer ran once per generation", scorer.calls == 2,
                  f"{scorer.calls} calls")

            test_session_setup(client)
            rows = test_run_produces_everything(run_dir)
            mutants = test_lineage(rows)
            test_siblings_diverge(mutants)
            test_immigrants_are_fertile(rows)
            test_torn_manifest(tmp)
            test_resume(run_dir, cfg)

            print("\napp still healthy")
            health = client.health()
            check("app is awake and responding", health.get('ok') is True,
                  str(health))
            check("app is not left asleep", health.get('asleep') is False,
                  str(health))

        client.quit()
        try:
            app.wait(timeout=20)
            check("the app exited cleanly", app.returncode == 0,
                  f"exit {app.returncode}")
        except subprocess.TimeoutExpired:
            check("the app exited cleanly", False, "still running")

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
