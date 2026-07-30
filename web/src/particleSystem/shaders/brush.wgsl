// ============================================================================
// brush.wgsl -- the trail splat.
//
// The WGSL translation of `particle_system/shaders/brush.vert` (45 lines) and
// `brush.frag` (38), joined into one module because a WebGPU pipeline takes
// both stages from one place.
//
// One instanced quad per entity, additively blended into the canvas. There is
// NO VERTEX BUFFER: the quad comes from @builtin(vertex_index) and the entity
// from @builtin(instance_index) reading the storage buffer directly.
//
// ---------------------------------------------------------------------------
// THE CORNER ORDER IS NOT THE GLSL'S, AND THE DIFFERENCE IS INVISIBLE
// ---------------------------------------------------------------------------
// The desktop draws TRIANGLE_FAN over 4 vertices in the order
//
//     (-,-)  (+,-)  (+,+)  (-,+)
//
// which a fan turns into triangles (0,1,2) and (0,2,3) -- the quad. WebGPU HAS
// NO triangle-fan topology. A triangle-strip over those same four vertices
// produces (0,1,2) and (2,1,3), which is a BOWTIE, not a quad.
//
// So the arrays below are in STRIP order -- (-,-) (+,-) (-,+) (+,+) -- and the
// uv array is permuted THE SAME WAY, so every corner keeps the uv it has on the
// desktop.
//
// Why this needs saying: brush.frag's kernel is `gaussian(uv - 0.5)` gated by
// `length(uv - 0.5) > 0.5`. That is RADIALLY SYMMETRIC about the quad's centre,
// so permuting the uvs wrongly -- swapping two corners, say -- renders a
// splat that is pixel-for-pixel identical. It cannot be caught by looking at
// it. Permute both arrays together, or not at all.
//
// (The plan doc suggests "0,1,3,2 reordering", which is the equivalent fix
// expressed as an index buffer. Reordering the arrays needs no index buffer.)
// ============================================================================

#include "common.wgsl"

struct BrushUniforms {
    world      : WorldData,
    // xy: canvas resolution   zw: reserved
    canvas_res : vec4f,
    // x: frame_count(i)   yzw: reserved
    flags      : vec4f,
}

@group(0) @binding(0) var<uniform> u : BrushUniforms;
// READ-ONLY here, and read in the VERTEX STAGE. The same buffer is bound
// read_write to the compute pass; only the binding type differs, which is why
// this needs its own bind group layout.
@group(0) @binding(1) var<storage, read> entities : array<Entity>;

fn frame_count() -> i32 { return bitcast<i32>(u.flags.x); }

struct VsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
    @location(1) pos_vel : vec4f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_id : u32,
           @builtin(instance_index) instance_id : u32) -> VsOut {
    let e = entities[instance_id];
    let entity_pos = e_pos(e);
    let entity_vel = e_vel(e);
    let size = e_size(e);

    // STRIP ORDER -- see the header. Not the fan order of brush.vert:25-36.
    var offsets = array<vec2f, 4>(
        vec2f(-size, -size),
        vec2f( size, -size),
        vec2f(-size,  size),
        vec2f( size,  size),
    );
    // Permuted to match, corner for corner.
    var uv_coords = array<vec2f, 4>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0),
    );

    let particle_uv = uv_coords[vertex_id];
    let vertex_pos = entity_pos + offsets[vertex_id];

    var out : VsOut;
    // THE Y FLIP. `world_to_ndc` and `world_to_uv` are the same mapping up to
    // scale, and both are Y-UP -- which is what makes "splat at world p" and
    // "sense at world p" land on the same texel under OpenGL, whose framebuffer
    // origin is bottom-left.
    //
    // WebGPU's framebuffer origin is TOP-left, so rasterizing y-up NDC deposits
    // the splat in the mirrored row from the one `get_can` reads back. The
    // splat and the sensor would then disagree about where a particle is, which
    // does not look like an upside-down image -- it looks like the physics is
    // subtly wrong. Negating y here puts the deposit where the sensor looks.
    //
    // Note this is the SAME correction canvas.wgsl's vertex stage makes, for
    // the same reason; see the longer note there.
    let ndc = world_to_ndc(vertex_pos, u.canvas_res.xy);
    out.clip = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = particle_uv;
    out.pos_vel = vec4f(entity_pos, entity_vel);
    return out;
}

fn gaussian(pos: vec2f, sigma: f32) -> f32 {
    let sigma2 = sigma * sigma;
    let norm = 1.0 / (2.0 * 3.14159265359 * sigma2);
    let exponent = -(dot(pos, pos)) / (2.0 * sigma2);
    return norm * exp(exponent);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let kernel_func = gaussian(in.uv - 0.5, 0.163);
    // The circular cutout, and the frame-0 sentinel: on a reset frame nothing
    // is deposited, so the canvas pass's clear is not immediately re-dirtied.
    // This is the third leg of reset() -- see particle_system.py:259-275.
    if (length(in.uv - 0.5) > 0.5 || frame_count() == 0) {
        discard;
    }
    // Splat directly into the canvas, premultiplied by (1-P)/P so that after the
    // canvas pass's P decay the steady contribution matches the old (1-P)*brush mix.
    // kernel_func*kernel_func reproduces the old SRC_ALPHA blend's quadratic weighting.
    // CANVAS_VALUE_SCALE keeps the deposit out of fp16's subnormal range at high
    // P -- every canvas reader divides it back out (see common.wgsl).
    let P = clamp(world_trail_persistence(u.world),
                  TRAIL_PERSISTENCE_MIN, TRAIL_PERSISTENCE_MAX);
    let premult = (1.0 - P) / P;
    let vel = in.pos_vel.zw;
    // The target is rg16float, so zw are discarded by the format -- the canvas
    // is a velocity flow field, not a colour.
    return vec4f(vel * kernel_func * kernel_func * premult * CANVAS_VALUE_SCALE,
                 0.0, 0.0);
}
