// Bloom upsample: 3x3 tent filter, added into the next mip up.
// A port of `assembler/shaders/bloom_upsample.frag`.
//
// Walking back up the chain adding each blurred level to the one above is what
// gives bloom its wide, soft falloff: the smallest mip contributes a huge
// diffuse halo, the largest a tight glow, and the sum of them is far smoother
// than any single blur of the same width.
//
// THE ADDITION IS DONE BY THE BLEND UNIT (ONE, ONE), not by sampling the
// destination here. The original Fluoddity binds the destination mip as a
// sampler while rendering into it, which is undefined behaviour -- it works
// only because the read is 1:1 at the fragment's own uv. Blending is correct
// and cheaper, and on the web it is the only option: WebGPU rejects the bind
// group outright.
//
// THE PASS MUST LOAD, NOT CLEAR. The destination already holds its own
// downsampled content and this pass ADDS to it. moderngl simply does not clear,
// so the GLSL has nothing to say about it; WebGPU makes the choice explicit and
// 'clear' would silently discard the entire down-chain, leaving only the
// smallest mip's contribution -- a plausible, slightly-too-diffuse glow that
// reads as "the radius is too big". See bloom.ts, which sets it.
//
// No per-level weight: every mip is added at full strength and bloom_intensity
// is the single global scale, applied once during composite.
#include "fullscreenQuad.wgsl"

struct BloomUpsampleUniforms {
    // xy: 1.0 / SOURCE resolution (the LOWER-res mip being read)
    // z: bloom_radius, scaling the tap offsets   w: reserved
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : BloomUpsampleUniforms;
@group(0) @binding(1) var source_tex : texture_2d<f32>;
@group(0) @binding(2) var source_sampler : sampler;

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    let texel = u.params.xy;
    let r = u.params.z;

    var sum = vec3f(0.0);
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f( -r,  -r), 0.0).rgb * 1.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(0.0,  -r), 0.0).rgb * 2.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(  r,  -r), 0.0).rgb * 1.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f( -r, 0.0), 0.0).rgb * 2.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(0.0, 0.0), 0.0).rgb * 4.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(  r, 0.0), 0.0).rgb * 2.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f( -r,   r), 0.0).rgb * 1.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(0.0,   r), 0.0).rgb * 2.0;
    sum += textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(  r,   r), 0.0).rgb * 1.0;
    sum /= 16.0;

    return vec4f(sum, 1.0);
}
