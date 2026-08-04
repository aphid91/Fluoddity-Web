// Present pass for TRAIL mode: sample the canvas through the camera transform
// and colorize it. A port of `camera/shaders/camera.frag`.
//
// The camera is applied HERE rather than by moving the quad, because the quad is
// always fullscreen: we walk each screen pixel backwards to the world point it
// shows. That inverse is what puts the letterbox bars in the right place and
// keeps zoom anchored, and it lives in common.wgsl -- not in this file.
#include "common.wgsl"
#include "fullscreenQuad.wgsl"

// Turns the canvas's stored magnitude into a sensible starting exposure, so the
// Brightness slider lands near 1.0 for a typical scene. Not a tone curve: a
// plain linear gain, applied before anything else sees the value.
const CANVAS_GAIN: f32 = 24.0;

struct CameraViewUniforms {
    canvas_res : vec4f,   // xy: canvas size   zw: window size
    camera     : vec4f,   // xy: pan   z: zoom   w: reserved
    flags      : vec4f,   // reserved; TRAIL has no int state
}

@group(0) @binding(0) var<uniform> u : CameraViewUniforms;

// Group 1 is the SWAPPING group: the canvas is double-buffered and its front
// texture changes every sub-step, so keeping it out of group 0 means the
// uniform is bound once. The same split `canvas.wgsl` makes, for the same
// reason.
@group(1) @binding(0) var canvas_texture : texture_2d<f32>;
@group(1) @binding(1) var canvas_sampler : sampler;

// Duplicated from `camBrush.wgsl` deliberately. The GLSL duplicates it too
// (`camera.frag:26` and `cam_brush.frag:37`) and it is NOT in common.glsl, so
// hoisting it into common.wgsl would make that file diverge from the .glsl it
// mirrors -- which `common.wgsl.test.ts` scans. Five lines is the cheaper cost.
fn hsv2rgb(c: vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    // GLSL's clamp(vec3, float, float) overload does not exist in WGSL, so the
    // bounds widen to vec3f.
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    let ndc = in.uv * 2.0 - 1.0;
    let canvas_uv = screen_ndc_to_canvas_uv(ndc, u.canvas_res.xy, u.canvas_res.zw,
                                            u.camera.xy, u.camera.z);

    // Outside the canvas: letterbox bar (window aspect != canvas aspect) or
    // panned/zoomed past the world edge. Paint it black rather than clamping,
    // so the world's extent is visible instead of smeared edge pixels.
    //
    // GLSL's `any(lessThan(v, vec2(0.0)))` becomes `any(v < vec2f(0.0))` --
    // WGSL's comparison operators are already component-wise on vectors.
    if (any(canvas_uv < vec2f(0.0)) || any(canvas_uv > vec2f(1.0))) {
        return vec4f(0.0, 0.0, 0.0, 1.0);
    }

    // textureSampleLevel, NOT textureSample. The early-out above makes this
    // NON-UNIFORM CONTROL FLOW, and WGSL forbids implicit-derivative sampling
    // there -- it is a compile error, not a subtle wrong answer. The canvas has
    // no mips, so level 0 is numerically identical; this is the same
    // substitution `entityUpdate.wgsl` makes for the compute stage, arrived at
    // for a different reason.
    //
    // Stored canvas values ride CANVAS_VALUE_SCALE above their physical meaning
    // (an fp16 range fix -- see common.wgsl); divide it back out so brightness
    // means what it always did.
    let canv = textureSampleLevel(canvas_texture, canvas_sampler, canvas_uv, 0.0)
               / CANVAS_VALUE_SCALE;

    // LINEAR HDR OUT. The tone curve, brightness and bloom all belong to the
    // assembler. That matters for more than tidiness: the accumulator averages
    // what this pass emits, and averaging display values rather than energy
    // would make motion blur darken as it smeared.
    //
    // The colorize stays HERE, though, rather than moving downstream with the
    // rest. The canvas holds a vector field, and the accumulator has to average
    // COLORS, not vectors -- a particle that reverses direction mid-frame would
    // otherwise average toward zero and punch a black hole in the blur.
    //
    // 3.1415, not PI. `camera.frag:58` uses this literal; common.wgsl's PI is
    // 3.1415926. They differ by a ~2e-5 hue rotation, which is invisible -- but
    // changing it is a gratuitous divergence in a step verified by eye.
    let color = CANVAS_GAIN * hsv2rgb(vec3f(atan2(canv.y, canv.x) / 3.1415 / 2.0,
                                            0.75, length(canv.xy)));
    return vec4f(color, 1.0);
}
