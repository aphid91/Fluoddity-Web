// ============================================================================
// cameraBlur.wgsl -- one axis of a separable gaussian over both scalars.
//
// Run twice, horizontal then vertical, between ingest and map. For Motion the
// blur is load-bearing rather than cosmetic: the raw derivative of a
// camera frame is sensor grain, and particles chasing it jitter in place. A
// blur wide enough turns a hand into one smooth basin with a slope pointing at
// it, which is what "toward the moving thing" needs.
//
// FIXED TAP COUNT, VARIABLE SPACING. 25 taps whose spacing grows with sigma, so
// the cost is the same at every slider position and the kernel always spans
// +-3 sigma. At wide sigma the taps are several texels apart, which the linear
// sampler and the field's smoothness make invisible.
//
// Same coordinate convention as cameraIngest.wgsl: texels by position, v = 0 at
// row 0. A blur cannot flip anything, but it must not start to.
// ============================================================================

#include "fullscreenQuad.wgsl"

struct BlurUniforms {
    // xy: uv offset between adjacent taps (one axis is zero)
    // z:  1 to blur, 0 to pass through (sigma below half a texel)
    // w:  unused
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : BlurUniforms;
@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var src_sampler : sampler;

const TAPS_EACH_SIDE : i32 = 12;
// Sigma, in TAPS: 12 taps cover 3 sigma.
const SIGMA_TAPS : f32 = 4.0;

@fragment
fn blur_fs(in : FsQuadVsOut) -> @location(0) vec4f {
    let f = in.clip.xy / vec2f(textureDimensions(src));
    if (u.params.z < 0.5) {
        return vec4f(textureSampleLevel(src, src_sampler, f, 0.0).rg, 0.0, 1.0);
    }
    var sum = vec2f(0.0);
    var weight = 0.0;
    for (var i = -TAPS_EACH_SIDE; i <= TAPS_EACH_SIDE; i++) {
        let t = f32(i) / SIGMA_TAPS;
        let w = exp(-0.5 * t * t);
        sum += textureSampleLevel(src, src_sampler, f + f32(i) * u.params.xy, 0.0).rg * w;
        weight += w;
    }
    return vec4f(sum / weight, 0.0, 1.0);
}
