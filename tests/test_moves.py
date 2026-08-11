"""The move recipe's arithmetic. No GPU, no window, no app.

    Scratch.venv/Scripts/python.exe tests/test_moves.py

WHAT THIS IS GUARDING
The search rests on four claims about mutation that are true today and are not
obviously true:

  1. At cohorts=1 every particle carries the identical rule, so "select an
     arbitrary particle" is well-defined and index 0 is as good as any.
  2. Mutating actually moves the rule, and rerolling the seed moves it
     somewhere else.
  3. The move is deterministic, so a manifest can reproduce a candidate.
  4. A ZERO RULE IS IMMUNE TO MUTATION -- the trap that would make random
     immigrants silently sterile.

None of these fails loudly if it breaks. A search whose immigrants are sterile
still runs, still produces pictures, and simply never explores; a change to
get_cohort() that made rules index-dependent would make candidates
irreproducible without ever raising. So they are asserted here against
particle_system/mutation.py, which is the host-side mirror of the shader and
the same arithmetic the app's selection uses.
"""

from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from particle_system import mutation, persistence                   # noqa: E402
from pilot.candidate import Candidate, IMMIGRANT, MUTANT            # noqa: E402
from pilot.config import SearchConfig                               # noqa: E402
from pilot.moves import checkpoint_name                             # noqa: E402

#: A realistic buffer. Big enough that a cohort bug would show at the far end.
ENTITY_COUNT = 60_000

_failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok    {label}")
    else:
        print(f"  FAIL  {label}{'  -- ' + detail if detail else ''}")
        _failures.append(label)


def base_config():
    saved = persistence.load(ROOT / 'configs' / 'Starcrossed.json')
    return saved.configs[0]


def cfg(**kw):
    return dataclasses.replace(base_config(), **kw)


def rule_of(config, index):
    return np.asarray(mutation.entity_rule(config, index, ENTITY_COUNT))


# ---------------------------------------------------------------------------

def test_cohorts_one_is_uniform():
    print("\ncohorts=1 makes every particle identical")

    c = cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.5)
    indices = [0, 1, 2, 7, 999, ENTITY_COUNT // 2, ENTITY_COUNT - 1]
    rules = [rule_of(c, i) for i in indices]

    check("every sampled index gives the same rule",
          all(np.array_equal(rules[0], r) for r in rules),
          "selection would depend on which particle was clicked")

    # The mechanism, asserted directly: floor(cohort) is what the shader
    # branches on, and it must be 0 everywhere.
    floors = {int(np.floor(mutation.cohort_of(i, 1, ENTITY_COUNT)))
              for i in indices}
    check("floor(cohort) is 0 across the whole buffer", floors == {0},
          f"got {sorted(floors)}")

    # And the contrast: at cohorts>1 particles genuinely differ, which is why
    # the recipe pins it to 1.
    many = cfg(cohorts=8, mutation_scale=0.35, mutation_seed=0.5)
    first = rule_of(many, 0)
    last = rule_of(many, ENTITY_COUNT - 1)
    check("at cohorts=8 particles differ (so cohorts=1 is load-bearing)",
          not np.array_equal(first, last))


def test_mutation_moves_the_rule():
    print("\nmutation produces a distinct child")

    parent = cfg(cohorts=1, mutation_scale=0.0, mutation_seed=0.5)
    parent_rule = np.asarray(parent.rule)

    child = rule_of(cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.5), 0)
    check("child differs from parent", not np.allclose(parent_rule, child),
          "mutation had no effect")

    # Siblings: same parent and scale, different seed.
    seeds = [0.11, 0.5, 0.72, 0.9312]
    siblings = {s: rule_of(cfg(cohorts=1, mutation_scale=0.35,
                               mutation_seed=s), 0) for s in seeds}
    distinct = all(
        not np.array_equal(siblings[a], siblings[b])
        for i, a in enumerate(seeds) for b in seeds[i + 1:])
    check("rerolling the seed gives a different child", distinct,
          "siblings would be duplicates and the beam would not branch")


def test_scale_is_a_step_size():
    print("\nmutation_scale behaves as a step size")

    parent = np.asarray(cfg().rule)
    distances = []
    for scale in (0.05, 0.1, 0.35, 1.0):
        child = rule_of(cfg(cohorts=1, mutation_scale=scale,
                            mutation_seed=0.5), 0)
        distances.append(float(np.linalg.norm(child - parent)))

    check("distance grows monotonically with scale",
          all(a < b for a, b in zip(distances, distances[1:])),
          str([f"{d:.3f}" for d in distances]))

    # Roughly linear -- the property that makes annealing the scale meaningful.
    # Loose bound: this asserts the shape, not the exact constant.
    ratio = distances[-1] / distances[0]
    check("20x the scale gives roughly 20x the distance",
          10.0 < ratio < 30.0, f"ratio {ratio:.1f}")


def test_move_is_reproducible():
    print("\nthe move is deterministic")

    args = dict(cohorts=1, mutation_scale=0.35, mutation_seed=0.5)
    first = rule_of(cfg(**args), 0)
    second = rule_of(cfg(**args), 0)
    check("same inputs give a byte-identical child",
          np.array_equal(first, second),
          "a manifest could not reproduce its own candidates")


def test_zero_rule_is_immune_to_mutation():
    print("\nTHE TRAP: a zero rule ignores mutation entirely")

    zero = cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.5,
               rule=(0.0,) * 80)
    check("an all-zero rule is the sentinel",
          mutation.is_zero_rule(zero.rule))

    low = rule_of(zero, 0)
    high = rule_of(cfg(cohorts=1, mutation_scale=1.0, mutation_seed=0.5,
                       rule=(0.0,) * 80), 0)
    # THE assertion this file exists for. If this ever starts failing, the
    # shader's generate-vs-mutate branch changed and fresh_candidate()'s adopt
    # may no longer be needed -- but until then, an immigrant that skips the
    # adopt is permanently sterile.
    check("scale 0.35 and 1.0 give IDENTICAL results on a zero rule",
          np.array_equal(low, high),
          "the trap may have been fixed upstream -- re-check "
          "_cmd_fresh_candidate before relying on this")

    check("the generated rule is itself nonzero", np.abs(low).max() > 0,
          "nothing was generated")

    # Which is why the adopt matters: once the generated rule is written back
    # into the config as a real rule, mutation starts working on it.
    adopted = cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.5,
                  rule=tuple(float(v) for v in low))
    check("the adopted rule is no longer the sentinel",
          not mutation.is_zero_rule(adopted.rule))

    stepped = rule_of(adopted, 0)
    check("and mutation now moves it",
          not np.allclose(np.asarray(adopted.rule), stepped),
          "the adopt did not make the candidate mutable")


def test_zero_rule_parent_children():
    """Children of a zero-rule SEED CONFIG: random samples, not siblings.

    The case a hand-authored seed hits. `randomize_behavior` is not the only
    way to get an all-zero rule -- a config saved before a behaviour was
    authored carries one too, and it becomes a search's starting point.

    What the move does there is still useful, and is the intended path: the
    seed generates a fresh rule, and adopting it writes it in as a real one so
    the child leaves the sentinel behind. But it is NOT a small step from the
    parent, and the manifest should not claim otherwise.
    """
    print("\nchildren of a zero-rule parent")

    zero_parent = cfg(cohorts=1, mutation_scale=0.2, mutation_seed=0.3,
                      rule=(0.0,) * 80)
    check("the seed config is the sentinel",
          mutation.is_zero_rule(zero_parent.rule))

    children = {}
    for seed in (0.11, 0.42, 0.73, 0.95):
        child = rule_of(cfg(cohorts=1, mutation_scale=0.2, mutation_seed=seed,
                            rule=(0.0,) * 80), 0)
        children[seed] = child

    check("every child is distinct",
          len({tuple(np.round(v, 6)) for v in children.values()}) == 4)
    check("every child escapes the sentinel",
          all(not mutation.is_zero_rule(tuple(v)) for v in children.values()),
          "children would inherit a sterile rule")

    # The measured contrast: children of a zero rule are independent samples,
    # not neighbours. ~8-12 apart versus ~0.75 for authored siblings.
    values = list(children.values())
    spread = min(float(np.linalg.norm(values[i] - values[j]))
                 for i in range(len(values)) for j in range(i + 1, len(values)))

    authored_a = rule_of(cfg(cohorts=1, mutation_scale=0.2,
                             mutation_seed=0.11), 0)
    authored_b = rule_of(cfg(cohorts=1, mutation_scale=0.2,
                             mutation_seed=0.42), 0)
    sibling = float(np.linalg.norm(authored_a - authored_b))

    check("zero-rule children are far apart (random sampling, not a fan-out)",
          spread > 5.0 * sibling,
          f"min separation {spread:.2f} vs authored siblings {sibling:.2f}")

    # And the reason scale is pinned: it does nothing here.
    scales = {tuple(np.round(rule_of(cfg(cohorts=1, mutation_scale=s,
                                         mutation_seed=0.42,
                                         rule=(0.0,) * 80), 0), 6))
              for s in (0.0, 0.2, 0.5, 1.0)}
    check("mutation_scale has NO effect on a zero-rule parent",
          len(scales) == 1,
          "the sentinel branch may have changed -- re-check "
          "_cmd_evaluate_candidate's from_zero pin")

    # A child, once adopted, mutates normally.
    adopted = cfg(cohorts=1, mutation_scale=0.2, mutation_seed=0.5,
                  rule=tuple(float(v) for v in values[0]))
    stepped = rule_of(adopted, 0)
    step = float(np.linalg.norm(stepped - np.asarray(adopted.rule)))
    check("a child mutates normally once adopted",
          0.0 < step < spread,
          f"step {step:.3f} should be a small move, not a resample")


def test_seed_reroll_on_generated_rules():
    print("\na zero-rule config can still be JUMPED by seed")

    # The corollary: scale does nothing, but the seed regenerates wholesale.
    # That is the only move available before the adopt.
    a = rule_of(cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.2,
                    rule=(0.0,) * 80), 0)
    b = rule_of(cfg(cohorts=1, mutation_scale=0.35, mutation_seed=0.8,
                    rule=(0.0,) * 80), 0)
    check("different seeds generate different rules",
          not np.array_equal(a, b))


def test_candidate_roundtrip():
    print("\nCandidate survives the manifest")

    original = Candidate(
        id='gen003_007', generation=3, origin=MUTANT,
        rule=tuple(float(i) * 0.01 for i in range(80)),
        parent_id='gen002_001', mutation_scale=0.35, mutation_seed=0.4242,
        capture_path='captures/gen003_007.png',
        config_path='configs/gen003_007.json',
    ).scored(0.87, raw=0.42)

    restored = Candidate.from_row(original.to_row())
    check("round-trips unchanged", restored == original,
          "a resumed run would lose lineage")

    import json
    check("the row is JSON-serializable",
          json.loads(json.dumps(original.to_row()))['id'] == 'gen003_007')

    check("lineage survives", restored.parent_id == 'gen002_001'
          and restored.mutation_seed == 0.4242)
    check("extra survives", restored.extra.get('raw') == 0.42)


def test_checkpoint_names():
    print("\ncheckpoint naming")

    name = checkpoint_name('gen003_007')
    check("prefixed so a run cannot collide with a human's checkpoints",
          name.startswith('srch_'), name)
    check("distinct ids give distinct names",
          checkpoint_name('a') != checkpoint_name('b'))


def test_config_validation():
    print("\nSearchConfig validation")

    check("defaults are valid", SearchConfig().validate() == [])

    problems = SearchConfig(cohorts=4).validate()
    check("cohorts != 1 is rejected",
          any('cohorts' in p for p in problems), str(problems))

    problems = SearchConfig(children_per_parent=0, immigrants=0).validate()
    check("a search that would produce nothing is rejected",
          any('produce nothing' in p for p in problems), str(problems))

    problems = SearchConfig(backend='banana').validate()
    check("an unknown backend is rejected",
          any('backend' in p for p in problems), str(problems))

    problems = SearchConfig(reference_dir='/definitely/not/here').validate()
    check("a missing reference_dir is caught BEFORE the run starts",
          any('reference_dir' in p for p in problems), str(problems))

    check("candidates_per_generation counts immigrants too",
          SearchConfig(beam_width=8, children_per_parent=4,
                       immigrants=4).candidates_per_generation == 36)


def test_presets():
    """The shipped search presets load, validate, and mean what they say."""
    print("\nshipped presets")

    for name in ('search.json', 'fan_search.json'):
        path = ROOT / name
        if not path.is_file():
            check(f"{name} exists", False, "missing")
            continue
        config = SearchConfig.load(path)
        problems = config.validate()
        check(f"{name} validates", problems == [], str(problems))

    fan = SearchConfig.load(ROOT / 'fan_search.json')
    # The preset's whole shape: seeds, then exactly one round of children.
    check("fan_search runs 2 generations", fan.generations == 2,
          str(fan.generations))
    check("fan_search adds no immigrants", fan.immigrants == 0,
          str(fan.immigrants))
    # A beam narrower than the seed list would silently drop the worst seeds
    # before they ever fan out, which is the opposite of what a fan is for.
    check("fan_search's beam is wide enough not to cull seeds",
          fan.beam_width >= 32, str(fan.beam_width))
    check("fan_search fans each parent out",
          fan.children_per_parent > 1, str(fan.children_per_parent))


def main():
    print("Move recipe")
    test_cohorts_one_is_uniform()
    test_mutation_moves_the_rule()
    test_scale_is_a_step_size()
    test_move_is_reproducible()
    test_zero_rule_is_immune_to_mutation()
    test_zero_rule_parent_children()
    test_seed_reroll_on_generated_rules()
    test_presets()
    test_candidate_roundtrip()
    test_checkpoint_names()
    test_config_validation()

    print()
    if _failures:
        print(f"FAIL  {len(_failures)} check(s): {', '.join(_failures)}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
