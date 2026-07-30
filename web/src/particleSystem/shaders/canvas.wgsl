// ============================================================================
// canvas.wgsl -- the trail canvas's decay and diffuse pass.
//
// The WGSL translation of `particle_system/shaders/canvas.frag` (61 lines),
// plus `shared/shaders/fullscreen_quad.vert` (9), which is folded in here
// because WebGPU has no free-floating vertex programs to share.
//
// Runs once per sub-step, over every texel, reading the front canvas and
// writing the back one. The host swaps them afterwards.
//
// THREE TRANSLATIONS WORTH KNOWING:
//
//  1. `getCan(vec2 p, sampler2D sam)` (canvas.frag:18) took a SAMPLER AS A
//     FUNCTION PARAMETER, which WGSL forbids outright. It is inlined into the
//     one place it is used -- there is exactly one texture here, so the
//     parameter was never buying anything.
//
//  2. The quad comes from `@builtin(vertex_index)`, not a vertex buffer. The
//     desktop's fullscreen_quad.vert reads `in vec2 in_position` from a VBO;
//     generating it in the shader deletes the buffer, the layout and the VAO.
//
//  3. `pow(5, D)` (canvas.frag:48) has an INT base literal. WGSL's pow is
//     float-only, so it is written `pow(5.0, D)`.
// ============================================================================

#include "common.wgsl"

struct CanvasUniforms {
    world : WorldData,
    // x: frame_count(i)   yzw: reserved
    flags : vec4f,
}

@group(0) @binding(0) var<uniform> u : CanvasUniforms;
@group(1) @binding(0) var canvas_texture : texture_2d<f32>;
@group(1) @binding(1) var canvas_sampler : sampler;

fn frame_count() -> i32 { return bitcast<i32>(u.flags.x); }

struct VsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
}

// The fullscreen triangle-strip quad, from the vertex index alone.
//
// Four vertices in STRIP order: (-1,-1) (1,-1) (-1,1) (1,1). The desktop draws
// two triangles from a 6-vertex VBO; the shape covered is identical.
//
// ---------------------------------------------------------------------------
// THE V FLIP, AND WHY IT IS NOT IN THE GLSL
// ---------------------------------------------------------------------------
// fullscreen_quad.vert:7 is `uv = in_position * 0.5 + 0.5`, with no flip. That
// is correct THERE because OpenGL's framebuffer origin is BOTTOM-left: row 0 of
// the render target sits at NDC y = -1, which is also where uv.y = 0 samples.
// The two agree, so a fragment always reads the texel it is about to write.
//
// WebGPU's framebuffer origin is TOP-left. Row 0 sits at NDC y = +1 while
// uv.y = 0 still samples row 0, so the unflipped formula makes every fragment
// read the texel MIRRORED about the horizontal axis instead of its own.
//
// That is not a cosmetic upside-down image -- this pass is a feedback loop, and
// reading the wrong row means the decay and the 5-tap diffusion operate on the
// mirror of the trail field. Measured cost: the canvas held ~3x less energy by
// sub-step 3, and the simulation settled into visibly different dynamics (many
// small curls instead of large sweeping arcs). It looks like a physics
// difference, not like a flipped picture, which is what makes it dangerous.
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
    out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
    return out;
}

// The diffusion stencil reaches one texel past the edge, so it has to obey the
// same boundary the particles do: wrap across the seam only in BC_WRAP,
// otherwise clamp so trails stop at the wall instead of bleeding through it.
//
// This is the INLINED getCan (canvas.frag:18-22) -- the sampler parameter is
// gone, per the header. Note the sampler's OWN address mode is set to match by
// the host (`_apply_boundary_sampling`); these are two layers of one decision
// and must not disagree (invariant 9).
fn get_can(p: vec2f) -> vec4f {
    var uv = clamp(p, vec2f(0.0), vec2f(1.0));
    if (world_boundary_conditions(u.world) == BC_WRAP) {
        uv = fract(p);
    }
    return textureSampleLevel(canvas_texture, canvas_sampler, uv, 0.0);
}

// Weighted 5-tap cross: centre weight K, four neighbours weight 1.
fn get_blur(pos: vec2f, diffusion_constant: f32) -> vec4f {
    let imsz = textureDimensions(canvas_texture, 0);
    let off = vec3f(1.0 / vec2f(imsz), 0.0);
    let np = pos + off.zy;
    let sp = pos - off.zy;
    let wp = pos - off.xz;
    let ep = pos + off.xz;
    let nc = get_can(np);
    let sc = get_can(sp);
    let wc = get_can(wp);
    let ec = get_can(ep);
    let K = diffusion_constant;
    return (get_can(pos) * K + nc + sc + wc + ec) / (4.0 + K);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    // FRAME 0 IS THE TRAIL CLEAR. This is not bookkeeping -- `reset()` on the
    // host does nothing but set frame_count to 0, and this line is what
    // actually erases the canvas (see particle_system.py:259-275).
    if (frame_count() == 0) { return vec4f(0.0, 0.0, 0.0, 0.0); }

    var canvas_color : vec4f;
    var TRAIL_DIFFUSION = clamp(world_trail_diffusion(u.world), 0.001, 1.0);
    // Same bounds as brush.wgsl's premultiply, from common.wgsl -- the splat
    // and the decay must agree about what P means.
    let TRAIL_PERSISTENCE = clamp(world_trail_persistence(u.world),
                                  TRAIL_PERSISTENCE_MIN, TRAIL_PERSISTENCE_MAX);
    if (TRAIL_DIFFUSION > 0.0) {
        TRAIL_DIFFUSION = TRAIL_DIFFUSION * TRAIL_DIFFUSION;      // better scaling for slider
        TRAIL_DIFFUSION = 4.0 / (pow(5.0, TRAIL_DIFFUSION) - 1.0); // better scaling for slider
        canvas_color = get_blur(in.uv, TRAIL_DIFFUSION);
    }
    else {
        // Unreachable as written -- the clamp above has a floor of 0.001, so
        // the branch above always wins. Kept because the GLSL keeps it.
        canvas_color = textureSampleLevel(canvas_texture, canvas_sampler, in.uv, 0.0);
    }
    // Brush splats are already mixed into the canvas; just decay by persistence.
    // The clamp is fp16 insurance, not a look decision: past 65504 a texel
    // rounds to inf, and inf survives decay forever (see CANVAS_VALUE_MAX in
    // common.wgsl). This pass touches every texel every step, so a transient
    // inf from an extreme splat pile-up is scrubbed within one step.
    return clamp(canvas_color * TRAIL_PERSISTENCE,
                 vec4f(-CANVAS_VALUE_MAX), vec4f(CANVAS_VALUE_MAX));
}
