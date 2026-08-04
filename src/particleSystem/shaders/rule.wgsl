// ============================================================================
// rule.wgsl -- how an entity's Rule is derived, and THE ONLY COPY of that.
//
// WHY THIS FILE EXISTS. Two shaders need to answer the same question -- "what
// rule is entity N obeying?" -- and they must never answer it differently:
//
//   entityUpdate.wgsl  derives it every step, for every entity, to simulate.
//   entityPick.wgsl    derives it once, for the clicked entity, to ADOPT.
//
// On the desktop that question has THREE implementations: entity_update.glsl,
// entity_pick's caller, and particle_system/mutation.py -- a float32 host mirror
// that recomputes the rule so selection needs no GPU readback. The web port
// deletes the mirror (docs/WEB_PORT_PLAN.md Step 6) and derives on the GPU
// instead, precisely because a wrong adopted rule LOOKS LIKE A LEGITIMATE
// RESULT. That leaves two callers, and they share this file, so they cannot
// drift. ARCHITECTURE.md:715-718 records what happened the one time they did:
// selection adopted near-zero coefficients and the simulation appeared to die.
//
// WHY NOT common.wgsl. That file is included by brush.wgsl and camBrush.wgsl in
// VERTEX stages, and its own rules 3 and 4 (common.wgsl:38-52) require it to
// hold pure, stage-agnostic code only. generate_random_centers is an 80-call
// hash loop that no vertex stage wants, and get_cohort below could not live
// there at all -- see its comment. This file is a SIBLING of the two shaders
// that include it; wgslInclude.ts resolves sibling-first (:125-141), so both
// find it with no build config.
//
// The include guard is per compilation unit (wgslInclude.ts:92-99), so the
// diamond entityUpdate -> {common, rule -> common} emits common.wgsl once.
// ============================================================================

#include "common.wgsl"

//=========================================================================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//====================================VVVVVVVVVVVVVVVVVVVVV================================

// PCG hash - bit-exact across all platforms.
// The u32 multiplies wrap in WGSL exactly as they do in GLSL, so this is a
// verbatim translation. (JavaScript would have needed Math.imul; the GPU does
// not -- which is part of why Step 6 moves rule derivation onto the GPU.)
fn pcg_hash(seed: u32) -> u32 {
    let state = seed * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hash(co: vec2f) -> f32 {
    let u_bits = vec2u(bitcast<u32>(co.x), bitcast<u32>(co.y));
    let h = pcg_hash(u_bits.x ^ pcg_hash(u_bits.y));
    return f32(h) / f32(0xffffffffu);
}

// Three implicit promotions in four lines on the GLSL side (:68-70); the int
// literals are written as floats here and the values are identical.
fn hash4(co: vec2f) -> vec4f {
    return vec4f(
        hash(co),
        hash(co * -1.0 + 5.0),
        hash(co.yx - 100.0),
        hash(co.yx * -1.0 + 25.0)
    );
}

// Given a seed, return 10 random FourierCenters: enough for a Rule.
//
// DO NOT REWRITE `pow(h, 2.0)` AS `h*h`. `freq_scale` and `frequency.x` draw
// from the SAME hash lane (`i*8+0`), so frequency.x is `(h*2-1) * (1+2*pow(h,2))`.
// pow(h,2) and h*h differ by 1 ULP, and the chaotic hash amplifies that into a
// completely different rule -- measured on the desktop as seed 0.3088 vs 0.2605
// (see the comment at mutation.py:149, and entity_update.glsl:446-451).
//
// THIS IS NOW MORE LOAD-BEARING THAN IT WAS IN STEP 4, not less: the rule this
// produces is read back and adopted into the config when a user clicks a
// particle, so "simplifying" this line changes what selection gives you.
fn generate_random_centers(seed: f32) -> array<FourierCenter, 10> {
    var centers : array<FourierCenter, 10>;

    for (var i = 0; i < 10; i++) {
        // Generate frequency vectors
        // Bias towards lower frequencies for smoother base behaviors
        // Range: [-2, 2] with bias towards [-1, 1]
        let freq_scale = 1.0 + 2.0 * pow(hash(vec2f(seed, f32(i * 8 + 0))), 2.0);
        centers[i].frequency.x = (hash(vec2f(seed, f32(i * 8 + 0))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.y = (hash(vec2f(seed, f32(i * 8 + 1))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.z = (hash(vec2f(seed, f32(i * 8 + 2))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.w = (hash(vec2f(seed, f32(i * 8 + 3))) * 2.0 - 1.0) * freq_scale;

        // Generate amplitude vectors
        // Range: [-1, 1]
        centers[i].amplitude.x = hash(vec2f(seed, f32(i * 8 + 4))) * 2.0 - 1.0;
        centers[i].amplitude.y = hash(vec2f(seed, f32(i * 8 + 5))) * 2.0 - 1.0;
        centers[i].amplitude.z = hash(vec2f(seed, f32(i * 8 + 6))) * 2.0 - 1.0;
        centers[i].amplitude.w = hash(vec2f(seed, f32(i * 8 + 7))) * 2.0 - 1.0;
    }

    return centers;
}

//=====================================^^^^^^^^^^^^^^^^^^==================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//=========================================================================================

// Simply assigns each to a cohort based on its index.
// floor(get_cohort(index)) should be used for cohort equality tests.
//
// THE ENTITY COUNT IS A PARAMETER, and that is not a style choice. This file is
// included by two shaders that bind the entity array with DIFFERENT access
// qualifiers -- entityUpdate.wgsl as `storage, read_write`, entityPick.wgsl as
// `storage, read` -- so a function here may not name the binding at all.
// `arrayLength(&entities)` is therefore evaluated at the CALL SITE and handed
// in. (Reverting it to name the binding compiles in entityUpdate and fails only
// in entityPick, i.e. in a browser and not in `npm test`, so shaders.test.ts
// asserts it.)
//
// BOTH CALL SITES PASS arrayLength(&entities), never the host's entityCount
// uniform. The buffer is sized exactly entityCount * 32
// (particleSystem.ts:200-206) so the two are identical today -- but if that ever
// stopped being true, the physics and the picker must still divide by the SAME
// number or the rule the picker derives is not the rule the entity obeys.
fn get_cohort(index: u32, config: ConfigData, entity_count: u32) -> f32 {
    return f32(cfg_cohorts(config)) * f32(index) / f32(entity_count);
}

// Randomly change noise function parameters, scaled by parameter 'amount'.
// Each cohort gets a unique mutation for any given rule.
//
// GLSL took `inout Rule`; WGSL has no inout, so the mutated rule comes back as
// a return value and the call site assigns it.
fn mutate_rule(current_rule: Rule, amount: f32, cohort: f32) -> Rule {
    var rule = current_rule;
    let seed = hash(rule.centers[4].frequency.xy
                    + rule.centers[7].amplitude.yx
                    + rule.centers[1].frequency.zw) + cohort;

    for (var i = 0; i < 10; i++) {
        // Operand order kept as the GLSL writes it (`-.5 + vec2(...)`), since
        // reassociating a float add is not required to be value-preserving.
        let amp_mutation = amount * (-1.0 + 2.0 * hash4(-0.5 + vec2f(-f32(i) + seed, f32(i))));
        rule.centers[i].amplitude += amp_mutation;
        rule.centers[i].frequency *= 1.0 + amount * 0.5 * (hash(vec2f(seed, f32(i))) - 0.5);
    }
    return rule;
}

// The rule an entity actually obeys: the generate-or-mutate branch, in one
// place. entity_update.glsl:439-460 on the desktop, mirrored there a THIRD time
// in mutation.py:208-236 -- which is exactly what Step 6 deletes.
//
// A GENERATED RULE IS NEVER MUTATED. It is already random, and the seed that
// produced it rerolls it wholesale, so Mutation Scale has nothing to add -- and
// letting it apply would mean that slider silently reshaping a rule the user
// never authored. `entity_update` therefore branches: generate *or* mutate,
// never both.
//
// On the desktop that also had a numerical reason: mutate_rule derives its own
// seed by HASHING the rule's coefficients, hash() is chaotic, and the GPU fuses
// a multiply-add in the generator that numpy cannot -- so mutating on top of a
// generated rule amplified a 1-ULP difference into a completely different rule,
// and the host mirror could not reproduce what the particle obeyed. THE WEB
// PORT HAS NO HOST MIRROR, so that argument does not apply here. The design
// reason above does, and it is sufficient on its own.
//
// GLSL's `==` on a vector is whole-vector equality returning a scalar bool;
// WGSL's is componentwise and returns vec4<bool>, hence all().
fn derive_entity_rule(rule_in: Rule, cohort: f32, config: ConfigData) -> Rule {
    let rule_seed = cfg_mutation_seed(config) + floor(cohort);

    // If a few arbitrary coefficients are exactly 0, then assume the rule is
    // all 0s (no target) and generate a random rule instead. Zeroing is how the
    // host asks for a new behaviour without reproducing this generator --
    // Randomize Behavior (`B`) does exactly that. See ARCHITECTURE.md
    // "Particle selection and history".
    if (all(rule_in.centers[0].frequency == vec4f(0.0))
        && all(rule_in.centers[5].amplitude == vec4f(0.0))) {
        return Rule(generate_random_centers(rule_seed));
    }

    // Each cohort gets a random mutation.
    return mutate_rule(rule_in, cfg_mutation_scale(config), rule_seed);
}
