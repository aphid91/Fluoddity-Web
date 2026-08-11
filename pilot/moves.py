"""A move in mutation space: what it is, and how to make the app perform one.

THE RECIPE
Evaluating a candidate means looking at one picture, so the population has to
obey ONE rule while it is being judged. That is what `mutation_scale = 0` buys.
Mutating means briefly letting the population spread, taking one of the variants
it produced, and adopting that as the new base rule:

    mutation_scale = S        the population fans out around the current rule
    select particle #0        adopt one variant -- it becomes the new base
    mutation_scale = 0        collapse back to a single behaviour
    reset + warmup            grow the pattern from a clean canvas
    capture                   the picture that gets embedded

Siblings come from rerolling `mutation_seed` before the same step, which is why
a parent is checkpointed BEFORE its children are made: each child starts from
the same state and differs only in the seed.

WHY INDEX 0 IS ARBITRARY-BY-CONSTRUCTION
The search pins `cohorts = 1`. get_cohort() returns `cohorts * index / count`,
a fraction in [0, 1) for every index, and the shader floors it -- so every
particle in the buffer resolves to cohort 0 and carries the identical rule.
Verified directly against particle_system/mutation.py across the whole buffer.
There is nothing to choose between particles, so the choice is free.

THE ZERO-RULE TRAP
An all-zero rule is a SENTINEL meaning "no behaviour authored": the shader
generates one from mutation_seed instead of reading one, and generated rules are
never mutated. So a config in that state ignores mutation_scale completely --
measured, 0.35 and 1.0 produce byte-identical results. `randomize_behavior`
produces exactly this state, which means every random immigrant would be
sterile. The app's fresh_candidate() defuses it by adopting once, turning the
generated rule into a real one. See _cmd_fresh_candidate.

The three functions here are the ONLY place the recipe is written down. A
strategy says "mutate this parent"; none of them knows what that involves.
"""

from __future__ import annotations

import random

from .candidate import IMMIGRANT, MUTANT, ROOT, Candidate


def checkpoint_name(candidate_id):
    """The app-side checkpoint holding a candidate's state.

    Prefixed so a search cannot collide with checkpoints a human made in the
    same session, and so they are recognizable in the UI while a run is
    watched.
    """
    return f"srch_{candidate_id}"


def evaluate(client, cfg, candidate, capture_path, mutate=None):
    """Realize one candidate in the app and capture it.

    Returns the app's result payload. The candidate's rule is read back from
    it rather than assumed: after a mutation the authoritative rule is whatever
    the app adopted, and recomputing it here would be a second implementation
    of the shader's arithmetic to keep in sync.
    """
    return client.evaluate_candidate(
        warmup_steps=cfg.warmup_steps,
        mutate=mutate,
        reset=True,
        capture={'path': str(capture_path),
                 'width': cfg.capture_size,
                 'height': cfg.capture_size},
    )


def make_root(client, cfg, candidate_id, generation, config_path,
              capture_path):
    """Load a config from disk and evaluate it unchanged.

    Generation zero, when the user supplied starting points. No mutation: the
    config is being asked "are you any good", not "is a variant of you".
    """
    client.load_config(config_path)
    # Re-pin after loading. A saved config carries its own cohorts and
    # mutation_scale, and a file authored by hand very likely has neither at
    # the values the recipe needs -- so a load silently breaks the invariant
    # unless it is restored here.
    client.set_config(cohorts=cfg.cohorts, mutation_scale=0.0)

    result = evaluate(client, cfg, None, capture_path)
    return Candidate(
        id=candidate_id,
        generation=generation,
        origin=ROOT,
        rule=tuple(result['rule']),
        capture_path=str(capture_path),
        extra={'source_config': str(config_path)},
    )


def make_immigrant(client, cfg, candidate_id, generation, capture_path):
    """A fresh random behaviour, evaluated.

    The escape hatch. Every mutant is a small step from something already in
    the beam, so a converged beam can only be left by introducing a rule that
    is not descended from it at all.

    fresh_candidate() does the randomize AND the adopt that defuses the
    zero-rule sentinel -- see this module's docstring. Doing only the first
    half would produce a candidate that silently ignores every subsequent
    mutation.
    """
    fresh = client.fresh_candidate()
    client.set_config(cohorts=cfg.cohorts, mutation_scale=0.0)

    result = evaluate(client, cfg, None, capture_path)
    return Candidate(
        id=candidate_id,
        generation=generation,
        origin=IMMIGRANT,
        rule=tuple(result['rule']),
        mutation_seed=fresh.get('mutation_seed'),
        capture_path=str(capture_path),
    )


def make_mutant(client, cfg, candidate_id, generation, parent, capture_path,
                scale=None, seed=None, rng=None):
    """Step from `parent` to a child, and evaluate it.

    Restores the parent's checkpoint first, so siblings all start from exactly
    the same state and differ only by seed. Without that restore, each child
    would be a step from the previous child -- a random walk rather than a
    fan-out, and the beam would lose its parent after one generation.

    The seed is drawn here rather than left to the app so it lands in the
    manifest: given (parent, scale, seed) the child is exactly reproducible,
    and that is what makes a surprising result investigable.
    """
    rng = rng or random
    scale = cfg.mutation_scale if scale is None else scale
    seed = rng.random() if seed is None else seed

    client.load_checkpoint(checkpoint_name(parent.id))
    result = evaluate(client, cfg, None, capture_path,
                      mutate={'scale': scale, 'seed': seed})

    # The app pins scale to 0 when the parent carries the zero-rule sentinel,
    # because there is nothing there to step from -- the seed generates a fresh
    # rule instead and the adopt makes it real. Record what ACTUALLY happened
    # rather than what was asked for, so the manifest does not claim a scale
    # that had no effect.
    applied = result.get('mutated') or {}
    from_zero = bool(applied.get('from_zero_rule'))
    extra = {'from_zero_rule': True} if from_zero else {}

    return Candidate(
        id=candidate_id,
        generation=generation,
        origin=MUTANT,
        rule=tuple(result['rule']),
        parent_id=parent.id,
        mutation_scale=applied.get('scale', scale),
        mutation_seed=seed,
        capture_path=str(capture_path),
        extra=extra,
    )


def checkpoint(client, candidate):
    """Preserve a candidate's state so children can be grown from it.

    In-session only. A candidate worth keeping past the run gets written to
    disk as a config instead -- checkpoints vanish when the app closes.
    """
    client.set_checkpoint(checkpoint_name(candidate.id))


def release_checkpoints(client, candidates):
    """Drop checkpoints for candidates that did not survive the cull.

    The app keeps every checkpoint for the whole session, and a run of fifty
    generations at thirty-six candidates each would otherwise accumulate
    eighteen hundred whole projects. Failures are ignored: a checkpoint that is
    already gone is exactly the state being asked for.
    """
    for candidate in candidates:
        try:
            client.delete_checkpoint(checkpoint_name(candidate.id))
        except Exception:                                       # noqa: BLE001
            pass


def prepare_session(client, cfg):
    """Put the app into the state every move assumes. Once per run.

    world_size FIRST and alone: it is disruptive -- the simulation is rebuilt
    around a new entity buffer and canvas -- so anything set before it would be
    applied to a system that is about to be thrown away.
    """
    client.set_paused(False)
    client.set_setting('prefs', 'world_size', cfg.world_size)

    client.set_prefs(physics_steps=cfg.physics_steps,
                     motion_blur_samples=1)
    client.set_config(cohorts=cfg.cohorts, mutation_scale=0.0)

    # Native-resolution captures: the camera's accumulation buffer is allocated
    # at window size, so capturing larger than the window would enlarge pixels
    # rather than reveal any. Waits for the resize to actually land, because it
    # takes effect a frame later than it is requested.
    return client.wait_for_window_size(cfg.capture_size, cfg.capture_size)
