// ============================================================================
// hash.wgsl -- the PCG hash family. THE ONLY COPY.
//
// WHY THIS FILE EXISTS. Three shaders now need the same random generator, and
// they sit in two different directories:
//
//   particleSystem/shaders/rule.wgsl  rule derivation (and through it,
//                                     entityUpdate and entityPick)
//   sand/shaders/spawn.wgsl           where a painted particle lands
//
// `rule.wgsl` held these and is a SIBLING of its two callers, which is what let
// them find it with no build config. The sand brushes are not siblings of it,
// and pulling the whole file in would drag `generate_random_centers` -- an
// 80-call hash loop -- into a shader that wants three random numbers. So the
// hash family moved here, to the shared directory every shader can reach, and
// `rule.wgsl` includes it like everyone else.
//
// WHY NOT common.wgsl. That file is included by vertex stages and its own rules
// 3 and 4 hold it to struct layout and coordinate math. A hash is neither, and
// keeping it out means a vertex shader that needs only the Entity layout does
// not also compile a hash it never calls.
//
// BIT-EXACTNESS IS THE POINT. The u32 multiplies wrap in WGSL exactly as they do
// in GLSL, so this is a verbatim translation of the desktop's. `hash` is chaotic
// by design: a 1-ULP difference in an input produces a COMPLETELY DIFFERENT
// output, which is why rule derivation had to move to the GPU rather than keep a
// JavaScript mirror. Do not "simplify" the arithmetic here.
//
// The include guard is per compilation unit, so the diamond
// entityUpdate -> {common, rule -> hash} emits each file once.
// ============================================================================

// PCG hash - bit-exact across all platforms.
fn pcg_hash(seed: u32) -> u32 {
    let state = seed * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

// Two floats in, one pseudo-random float in [0,1) out.
//
// The inputs are BITCAST, not converted: the hash consumes the float's bit
// pattern, so two inputs that differ in the last mantissa bit are unrelated
// outputs. That is what makes `hash(vec2f(f32(index), f32(frame)))` a usable
// per-particle-per-frame draw.
fn hash(co: vec2f) -> f32 {
    let u_bits = vec2u(bitcast<u32>(co.x), bitcast<u32>(co.y));
    let h = pcg_hash(u_bits.x ^ pcg_hash(u_bits.y));
    return f32(h) / f32(0xffffffffu);
}

// Four decorrelated draws from one seed.
//
// Three implicit promotions in four lines on the GLSL side; the int literals
// became float literals here. Operand order is kept exactly, because the
// bitcast above makes `co * -1.0 + 5.0` and `5.0 - co` different seeds.
fn hash4(co: vec2f) -> vec4f {
    return vec4f(
        hash(co),
        hash(co * -1.0 + 5.0),
        hash(co.yx - 100.0),
        hash(co.yx * -1.0 + 25.0)
    );
}
