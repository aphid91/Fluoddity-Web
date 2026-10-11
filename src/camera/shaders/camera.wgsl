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
    // The NCA display pass has already turned channels into linear colour
    // (`ncaShaders.ts`), so this is a passthrough.
    let color = textureSampleLevel(canvas_texture, canvas_sampler, canvas_uv, 0.0).rgb;
    return vec4f(color, 1.0);
}
