// TEMPORARY. Copy the accumulated HDR frame to the swap chain, unchanged.
//
// Sub-step 5.4 deletes this file and its helper in main.ts: `frameAssembly.wgsl`
// does this and the brightness, tone curve, bloom composite and overlays.
//
// It exists for one sub-step only, and earns it: with the accumulator landing in
// the same commit, a wrong `inv_samples` and a wrong tone curve would be
// indistinguishable -- both look like "the image is the wrong brightness". This
// pass has no arithmetic at all, so anything wrong on screen during 5.3 is the
// accumulator's.
#include "fullscreenQuad.wgsl"

@group(0) @binding(0) var source : texture_2d<f32>;
@group(0) @binding(1) var source_sampler : sampler;

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    return vec4f(textureSampleLevel(source, source_sampler, in.uv, 0.0).rgb, 1.0);
}
