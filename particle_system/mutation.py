"""Host-side mirror of the shader's rule-mutation math.

WHY THIS EXISTS
Every particle obeys a rule derived from its config's base rule:

    mutate_rule(config.rule, mutation_scale, mutation_seed + floor(cohort))

Particle selection adopts *that derived rule* as the new base rule -- "zoom in
on the variant I like". To do that the host needs the same value the GPU
computed for the picked entity.

The original solved this with a shader mode that wrote every particle's mutated
rule to a buffer for readback. This recomputes it instead: the mutation is
deterministic in (rule, amount, cohort), so Python can reproduce it exactly.
No extra buffer, no GPU readback -- and, because it is pure host-side
arithmetic, the rule for any entity index can be had synchronously and exactly,
which is what the piloting API's index-based selection uses.

THE PRICE IS THAT THIS MUST TRACK THE SHADER.
Ported line-for-line from entity_update.glsl (pcg_hash/hash/hash4,
generate_random_centers and mutate_rule). If you edit either side, edit both,
and re-run the GPU-vs-Python probe -- it lifts the shader's own function bodies
out of the .glsl, compiles them, and compares. A silent divergence here means
selection adopts a rule the particle never had, which looks like "the sim
jumped" rather than like a bug.

AGREEMENT IS TO ONE ULP, NOT BIT-EXACT. Measured, not assumed: the GPU is free
to contract a multiply-add into an FMA, rounding once where numpy rounds twice.
That is harmless as long as nothing amplifies it -- which is exactly why a
generated rule is NOT mutated on either side. mutate_rule derives its seed by
hashing the rule's own coefficients, and hash() is chaotic, so feeding it a
1-ULP difference produced a completely different rule (internal seed 0.3088 vs
0.2605). Generate or mutate, never both.

TWO TRAPS, both load-bearing:

  1. EVERYTHING IS float32. GLSL floats are 32-bit; numpy promotes to float64
     at the slightest provocation (a Python scalar in an expression is enough).
     Every operation here is kept in float32 deliberately.

  2. get_cohort divides by the ACTUAL entity count, which changes with the
     World Size preference. Pass the live count, never a module constant, or
     Python and the GPU will agree at the default size and diverge everywhere
     else.
"""

from __future__ import annotations

import numpy as np

#: Number of FourierCenters in a Rule, and floats per center (freq4 + amp4).
CENTERS = 10
FLOATS_PER_CENTER = 8
RULE_FLOATS = CENTERS * FLOATS_PER_CENTER   # 80


def _f32(value):
    return np.float32(value)


def pcg_hash(seed: np.ndarray) -> np.ndarray:
    """PCG hash. Mirrors pcg_hash() in entity_update.glsl.

    uint32 throughout; numpy wraps on overflow like GLSL does. The shader
    comments this as bit-exact across platforms, which is what makes the whole
    approach viable.
    """
    state = np.uint32(seed) * np.uint32(747796405) + np.uint32(2891336453)
    word = ((state >> ((state >> np.uint32(28)) + np.uint32(4))) ^ state) \
        * np.uint32(277803737)
    return (word >> np.uint32(22)) ^ word


def hash2(x, y) -> np.float32:
    """hash(vec2) from the shader: PCG over the float bit patterns.

    Reinterprets the floats as uint32 (GLSL floatBitsToUint) rather than
    converting them, so the result depends on the exact bits.
    """
    with np.errstate(over='ignore'):
        u = np.array([np.float32(x), np.float32(y)], dtype=np.float32).view(np.uint32)
        h = pcg_hash(u[0] ^ pcg_hash(u[1]))
        return np.float32(np.float64(h) / np.float64(0xffffffff))


def hash4(x, y) -> np.ndarray:
    """hash4(vec2) -> vec4. Mirrors the four sample points exactly.

    The shader's expressions are `co`, `co*-1+5`, `co.yx-100`, `co.yx*-1+25`,
    where `co.yx` is a swizzle -- the components swap.
    """
    x = np.float32(x)
    y = np.float32(y)
    return np.array([
        hash2(x, y),
        hash2(_f32(-x + _f32(5)), _f32(-y + _f32(5))),
        hash2(_f32(y - _f32(100)), _f32(x - _f32(100))),
        hash2(_f32(-y + _f32(25)), _f32(-x + _f32(25))),
    ], dtype=np.float32)


def cohort_of(index: int, cohorts: int, entity_count: int) -> np.float32:
    """Mirrors get_cohort(): a fractional cohort value for an entity index.

    Callers comparing cohorts should floor() this, as the shader does. Note the
    entity_count argument -- see trap 2 in the module docstring.
    """
    if entity_count <= 0:
        return np.float32(0)
    return np.float32(np.float32(cohorts) * np.float32(index)
                      / np.float32(entity_count))


def is_zero_rule(rule) -> bool:
    """True if the shader would treat `rule` as "no target given".

    THE SENTINEL, mirrored exactly: entity_update tests two specific lanes --
    centers[0].frequency and centers[5].amplitude -- for exactly zero, not the
    whole rule. Testing all 80 floats here would be a different predicate, and
    a rule that happened to zero only those lanes would then diverge.
    """
    flat = np.asarray(rule, dtype=np.float32)
    if flat.size != RULE_FLOATS:
        return False
    centers = flat.reshape(CENTERS, 2, 4)
    return not centers[0][0].any() and not centers[5][1].any()


def generate_random_centers(seed) -> tuple:
    """Mirrors generate_random_centers() in entity_update.glsl.

    What a particle actually obeys when its config carries no authored rule.
    Ported line-for-line, same float32 discipline as everything else here --
    see the module docstring's two traps.
    """
    seed = np.float32(seed)
    centers = np.zeros((CENTERS, 2, 4), dtype=np.float32)

    for i in range(CENTERS):
        base = i * 8
        # Frequencies: [-2,2], biased toward [-1,1] by squaring the scale.
        # NOTE the shader reuses lane 0's hash for freq_scale AND for
        # frequency.x -- not a typo to tidy, it is what the GPU computes.
        h0 = hash2(seed, _f32(base + 0))
        # pow(h, 2.0), NOT h*h. They differ by an ULP on this hardware, and an
        # ULP is not survivable here: mutate_rule derives its seed by hashing
        # these very coefficients, and hash() is chaotic by design -- one bit
        # in gives a completely different seed out (measured: 0.3088 vs
        # 0.2605), so the mutation that follows diverges entirely.
        freq_scale = _f32(_f32(1.0) + _f32(2.0) * _f32(np.power(h0, _f32(2.0))))
        for lane in range(4):
            h = h0 if lane == 0 else hash2(seed, _f32(base + lane))
            centers[i][0][lane] = _f32(_f32(h * _f32(2.0) - _f32(1.0))
                                       * freq_scale)
        # Amplitudes: [-1,1], unscaled.
        for lane in range(4):
            h = hash2(seed, _f32(base + 4 + lane))
            centers[i][1][lane] = _f32(h * _f32(2.0) - _f32(1.0))

    return tuple(float(v) for v in centers.reshape(-1))


def mutate_rule(rule, amount, cohort) -> tuple:
    """Mutate a rule the way the shader does. Returns 80 floats.

    `rule`   80 floats, laid out as 10 x (frequency[4], amplitude[4])
    `amount` mutation_scale
    `cohort` mutation_seed + floor(cohort)  -- the shader's `cohort` argument

    Mirrors mutate_rule() in entity_update.glsl. At amount == 0 the frequencies
    are still scaled by (1 + 0), i.e. unchanged, and amplitudes get a zero
    offset -- so this correctly returns the rule untouched.
    """
    flat = np.asarray(rule, dtype=np.float32)
    if flat.size != RULE_FLOATS:
        raise ValueError(f"rule must be {RULE_FLOATS} floats, got {flat.size}")

    # (10, 2, 4): [center][frequency|amplitude][xyzw]
    centers = flat.reshape(CENTERS, 2, 4).copy()
    freq = centers[:, 0, :]
    amp = centers[:, 1, :]

    amount = np.float32(amount)
    cohort = np.float32(cohort)

    # seed = hash(centers[4].frequency.xy + centers[7].amplitude.yx
    #             + centers[1].frequency.zw) + cohort
    seed_x = _f32(_f32(freq[4][0] + amp[7][1]) + freq[1][2])
    seed_y = _f32(_f32(freq[4][1] + amp[7][0]) + freq[1][3])
    seed = _f32(hash2(seed_x, seed_y) + cohort)

    for i in range(CENTERS):
        fi = np.float32(i)
        # amp += amount * (-1 + 2 * hash4(-.5 + vec2(-i + seed, i)))
        hx = _f32(_f32(-0.5) + _f32(-fi + seed))
        hy = _f32(_f32(-0.5) + fi)
        amp_mutation = (amount * (_f32(-1.0) + _f32(2.0) * hash4(hx, hy))
                        ).astype(np.float32)
        amp[i] = (amp[i] + amp_mutation).astype(np.float32)

        # freq *= 1 + amount * 0.5 * (hash(vec2(seed, i)) - .5)
        scale = _f32(_f32(1.0) + amount * _f32(0.5)
                     * _f32(hash2(seed, fi) - _f32(0.5)))
        freq[i] = (freq[i] * scale).astype(np.float32)

    return tuple(float(v) for v in centers.reshape(-1))


def entity_rule(config, index: int, entity_count: int) -> tuple:
    """The rule a given entity is actually obeying.

    Composes the same three steps the shader takes: work out the entity's
    cohort, substitute a generated rule if the config carries none, then mutate
    by (mutation_seed + floor(cohort)).

    THE SENTINEL BRANCH IS NOT OPTIONAL, though it once looked it. This used to
    skip it, on the reasoning that an unauthored rule was not worth adopting --
    which held only while nothing produced zero rules. Randomize Behavior does
    exactly that, so skipping it meant selection mutated all-zero coefficients
    while the particle obeyed a generated rule: a near-zero rule adopted from a
    particle that never had it, which reads as the simulation dying rather than
    as a bug. Both sides must branch the same way or neither should.

    A GENERATED RULE IS NOT MUTATED, matching the shader. It is already random,
    and the seed that produced it already rerolls it wholesale, so Mutation
    Scale has nothing to add. That also makes this path exactly reproducible:
    mutate_rule hashes the rule's own coefficients to derive its seed, and the
    GPU fuses a multiply-add in the generator that numpy cannot, so a 1-ULP
    difference would otherwise be amplified by a chaotic hash into a completely
    different rule.
    """
    cohort = cohort_of(index, config.cohorts, entity_count)
    seed = np.float32(np.float32(config.mutation_seed) + np.floor(cohort))

    if is_zero_rule(config.rule):
        return generate_random_centers(seed)
    return mutate_rule(config.rule, config.mutation_scale, seed)
