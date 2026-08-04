// Bloom downsample: halve the resolution with a 4-tap box filter.
// A port of `assembler/shaders/bloom_downsample.frag`.
//
// The taps sit half a SOURCE texel off-centre, so each one lands exactly
// between four source texels and bilinear filtering averages them for free --
// four samples covering a 4x4 neighbourhood.
//
// Everything here is linear HDR. The original Fluoddity has to inverse-tonemap
// on the first pass because it tonemaps before blooming; we bloom first, so
// there is nothing to undo.
#include "fullscreenQuad.wgsl"

struct BloomDownsampleUniforms {
    // xy: 1.0 / SOURCE resolution   z: threshold   w: apply_threshold(i)
    //
    // "SOURCE" is load-bearing: the texel size is the level being READ, not the
    // one being written (bloom.py:113,121 takes it from `src`). Using the
    // destination's would halve every tap offset and read as a tuning
    // difference rather than as a bug.
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : BloomDownsampleUniforms;
@group(0) @binding(1) var source_tex : texture_2d<f32>;
@group(0) @binding(2) var source_sampler : sampler;

fn apply_threshold() -> bool { return bitcast<i32>(u.params.w) != 0; }

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    let texel = u.params.xy;

    let a = textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(-0.5, -0.5), 0.0).rgb;
    let b = textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f( 0.5, -0.5), 0.0).rgb;
    let c = textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f(-0.5,  0.5), 0.0).rgb;
    let d = textureSampleLevel(source_tex, source_sampler, in.uv + texel * vec2f( 0.5,  0.5), 0.0).rgb;

    var color = (a + b + c + d) * 0.25;

    // Thresholded on the FIRST pass only: this is where the bloom source is
    // separated from the image, and every later mip is just blurring what came
    // out of it. Re-applying it would eat the glow it was meant to spread.
    //
    // Subtracting from the max channel and rescaling preserves hue -- clamping
    // per-channel instead would tint bright colours toward white.
    if (apply_threshold()) {
        let brightness = max(color.r, max(color.g, color.b));
        color *= max(0.0, brightness - u.params.z) / max(brightness, 0.0001);
    }

    return vec4f(color, 1.0);
}
