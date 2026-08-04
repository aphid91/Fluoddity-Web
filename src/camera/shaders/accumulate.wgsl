// Add one temporal sample into the accumulation buffer.
// A port of `camera/shaders/accumulate.frag`.
//
// This is the whole of motion blur's math. The pass runs with ONE, ONE
// blending, so the accumulator receives a straight sum; weighting each sample
// by 1/N here rather than dividing the sum at the end is what makes that sum a
// box average.
//
// WHY BLENDING, RATHER THAN READ-MODIFY-WRITE. The obvious implementation binds
// the accumulator as a sampler and adds to what it reads -- which is what the
// original Fluoddity does, and which is undefined behaviour: a texture must not
// be sampled while it is attached to the bound framebuffer. It happens to work
// there because sampling is 1:1 at the fragment's own uv. Letting the blend unit
// do the addition is both correct and cheaper, and it removes the reference's
// is_first_frame branch: clearing once per cycle IS the reset.
//
// On the web that argument gains teeth -- WebGPU does not merely leave the
// read-while-attached case undefined, it rejects the bind group outright.
#include "fullscreenQuad.wgsl"

struct AccumulateUniforms {
    // x: inv_samples   yzw: reserved
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : AccumulateUniforms;
@group(0) @binding(1) var hdr : texture_2d<f32>;
@group(0) @binding(2) var hdr_sampler : sampler;

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    // 1.0 / sample count. The count is DERIVED from the cadence, not the target
    // the user asked for -- see camera/blurSchedule.ts. Passed as a uniform
    // rather than baked in as a constant so changing the slider does not
    // recompile a shader mid-frame.
    //
    // Alpha is written as 1.0 and the blend adds it, so after N samples the
    // accumulator's alpha is N. That is harmless and deliberate: frameAssembly
    // reads .rgb only, and the swap chain is opaque. Do not "fix" it to 0 --
    // it would change nothing visible while making the buffer's meaning murkier.
    return vec4f(
        textureSampleLevel(hdr, hdr_sampler, in.uv, 0.0).rgb * u.params.x,
        1.0);
}
