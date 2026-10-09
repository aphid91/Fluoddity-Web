// ============================================================================
// cameraMap.wgsl -- the blurred scalars into the vector field the particles read.
//
// The output IS the camera field: entityUpdate.wgsl's `get_camera` samples it
// and multiplies by the destination's strength, nothing more. So every number
// the particles see is decided here and in the gain arithmetic in
// `webcamSettings.ts` -- there is no third place.
//
// ----------------------------------------------------------------------------
// VECTORS ARE IN WORLD AXES, y UP
// ----------------------------------------------------------------------------
// Texel row increases with v, and v increases toward the TOP of the world (see
// cameraIngest.wgsl), so a difference taken along +row is a derivative along
// world +y with no sign fix. The vector this writes is added straight to a
// world position (walls) or to a sensed trail vector (trails), both y-up.
//
// ----------------------------------------------------------------------------
// THE STENCIL IS ISOTROPIC IN THE WORLD, NOT IN THE TEXTURE
// ----------------------------------------------------------------------------
// The field is square and the world usually is not, so a texel is wider than
// it is tall (or the reverse). Neighbours are therefore taken a fixed WORLD
// distance away -- `radius` along v, `radius / aspect` along u -- so a circle in
// the picture yields a symmetric gradient rather than one stretched along the
// world's long axis. The radius follows the blur (never under one texel on
// either axis -- the host guarantees it), which keeps every mapping's output
// O(1) at any blur: a difference ACROSS a blurred edge, not along a fraction of
// one.
//
// The index of each mapping is `CAMERA_MAPPINGS`' order in webcamSettings.ts.
// ============================================================================

#include "fullscreenQuad.wgsl"

struct MapUniforms {
    // x: mapping   0 edges across, 1 edges along, 2 motion
    // y: sign      +1 toward, -1 away
    // z: aspect    world width / world height
    // w: radius    stencil distance, in field-v units (world-height fractions)
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : MapUniforms;
@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var src_sampler : sampler;

// Motion values are small next to brightness (a smear of 0.3 is a lot of
// movement), so its slope is scaled up to sit beside the others at one Gain.
const MOTION_SLOPE_GAIN : f32 = 3.0;
// A step from black to white scores 4 under the Sobel weights, so this puts
// the strongest edge a picture can hold at 1.
const SOBEL_FULL : f32 = 4.0;

// The channel this mapping reads: motion (g) for Motion, brightness (r) else.
fn scalar_at(uv : vec2f, channel : i32) -> f32 {
    let s = textureSampleLevel(src, src_sampler, uv, 0.0);
    return select(s.r, s.g, channel == 1);
}

@fragment
fn map_fs(in : FsQuadVsOut) -> @location(0) vec4f {
    let f = in.clip.xy / vec2f(textureDimensions(src));
    let mapping = i32(round(u.params.x));
    let dx = vec2f(u.params.w / u.params.z, 0.0);
    let dy = vec2f(0.0, u.params.w);

    var v = vec2f(0.0);
    if (mapping == 2) {
        // Motion: central differences of the motion scalar across the stencil,
        // so the vector points toward whatever is moving.
        let g = vec2f(scalar_at(f + dx, 1) - scalar_at(f - dx, 1),
                      scalar_at(f + dy, 1) - scalar_at(f - dy, 1));
        v = g * MOTION_SLOPE_GAIN;
    } else {
        // Sobel: direction and strength kept apart, so a soft ramp steers as
        // firmly as a hard edge and Gain means the same thing for both.
        let tl = scalar_at(f - dx + dy, 0);
        let tc = scalar_at(f + dy, 0);
        let tr = scalar_at(f + dx + dy, 0);
        let ml = scalar_at(f - dx, 0);
        let mr = scalar_at(f + dx, 0);
        let bl = scalar_at(f - dx - dy, 0);
        let bc = scalar_at(f - dy, 0);
        let br = scalar_at(f + dx - dy, 0);
        let g = vec2f((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl),
                      (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br));
        let len = length(g);
        // An `if`, not select(): `g / len` at len == 0 is a NaN.
        var dir = vec2f(0.0);
        if (len > 1e-5) { dir = g / len; }
        let mag = clamp(len / SOBEL_FULL, 0.0, 1.0);
        v = dir * mag;
        // Along: a quarter turn, so particles trace the outline rather than
        // crossing it.
        if (mapping == 1) { v = vec2f(-v.y, v.x); }
    }

    v *= u.params.y;
    // Soft ceiling at length 1, so Gain alone decides how hard the strongest
    // feature pushes -- Motion's slope gain can otherwise overshoot on a fast
    // hand, and a slope steeper than one stencil can on a hard edge.
    v /= max(1.0, length(v));
    // The particles must never see a non-finite value; it would poison a
    // position for good.
    if (any(v != v) || any(abs(v) > vec2f(1e4))) { v = vec2f(0.0); }
    return vec4f(v, 0.0, 1.0);
}
