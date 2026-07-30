// ============================================================================
// debugPresent.wgsl -- THROWAWAY. Step 5 deletes this file.
//
// Step 4 ports the engine but not the renderer: `camera.frag`, the bloom
// chain, the tone curve and the overlays are all Step 5. Without SOMETHING
// putting the canvas on screen, Step 4's deliverable is a black canvas -- which
// is also this app's SUCCESSFUL output for Steps 1-3, so a total failure would
// look identical to success. That is not a state to verify physics in.
//
// So this exists purely to make the simulation observable for the A/B, and it
// deliberately implements NONE of the real pipeline:
//
//   NO camera transform   (no pan, no zoom, no inverse walk)
//   NO letterbox          (the canvas is stretched to the window)
//   NO bloom, NO tone curve, NO brightness, NO overlays
//   NO motion blur accumulation
//
// The one thing it DOES copy from `camera/shaders/camera.frag:57-59` is the
// colorize -- hue from the velocity vector's angle, value from its magnitude --
// because a plain `rg -> rg` dump makes a velocity field almost unreadable and
// the A/B is a comparison of how structure LOOKS. `CANVAS_VALUE_SCALE` is
// divided back out for the same reason it is there: every canvas reader does.
//
// STEP 5: delete this file and `presentPass` in main.ts; `camera.frag`'s port
// replaces both, and it is the one that has to be right.
// ============================================================================

#include "common.wgsl"

// Matches camera.frag's CANVAS_GAIN. Turns the canvas's stored magnitude into a
// sensible starting exposure. Not a tone curve -- a plain linear gain.
const CANVAS_GAIN: f32 = 24.0;

@group(0) @binding(0) var canvas_texture : texture_2d<f32>;
@group(0) @binding(1) var canvas_sampler : sampler;

struct VsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VsOut {
    var corners = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0),
    );
    let p = corners[vi];
    var out : VsOut;
    out.clip = vec4f(p, 0.0, 1.0);
    // NO FLIP HERE, deliberately. The canvas is written by brush.wgsl through a
    // y-negated NDC (see the note there), so the texture is already stored in
    // WebGPU's top-left-origin convention. Sampling it straight puts world +y
    // at the top of the screen, matching the desktop. Adding a flip here would
    // mirror the picture -- and on a roughly symmetric trail field that is easy
    // to miss and would silently poison every A/B comparison.
    out.uv = p * 0.5 + 0.5;
    return out;
}

fn hsv2rgb(c: vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let canv = textureSampleLevel(canvas_texture, canvas_sampler, in.uv, 0.0)
               / CANVAS_VALUE_SCALE;
    let color = CANVAS_GAIN * hsv2rgb(vec3f(atan2(canv.y, canv.x) / 3.1415 / 2.0,
                                            0.75, length(canv.xy)));
    return vec4f(color, 1.0);
}
