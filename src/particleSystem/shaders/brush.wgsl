// ============================================================================
// brush.wgsl -- the trail splat.
//
// Descended from `particle_system/shaders/brush.vert` + `brush.frag`, which draw
// one instanced gaussian QUAD per entity. This draws one POINT per entity
// instead: a single pixel, additively blended into the canvas. There is NO
// VERTEX BUFFER: the entity comes from @builtin(instance_index) reading the
// storage buffer directly.
//
// ---------------------------------------------------------------------------
// WHY A POINT, AND WHY IT DEPOSITS THE SAME TRAILS
// ---------------------------------------------------------------------------
// The quad was ~1.5 px wide, so the rasterizer's per-primitive work (four
// vertices, two triangles, a discarded circle) dwarfed the pixels it wrote,
// and what it deposited swung ~700x with the particle's subpixel position:
// the kernel is only sampled at the pixel centres the quad happens to cover.
//
// This is the desktop's atomic deposit (entity_update.glsl `deposit`, commit
// ca7b4a5) done with the rasterizer's blending instead of atomics. Each entity
// deposits the quad's EXPECTED TOTAL into ONE pixel, chosen at random with the
// same odds the quad spread its weight over pixels -- so every pixel receives
// the same amount on average, without the aliasing and at a fraction of the
// cost. The trails match the quad's in expectation, not texel for texel.
//
// The quad blended `vel * k^2` per pixel, with k = gaussian(uv - 0.5, SIGMA)
// normalised in the quad's 0..1 uv and cut off at radius RADIUS. Over a quad
// `dot_px` pixels wide, the sum of k^2 is dot_px^2 times its integral over the
// disc -- closed form below -- and k^2 is itself a gaussian of sigma SIGMA/sqrt(2),
// which is the spread the random pixel is drawn with.
// ============================================================================

#include "common.wgsl"
#include "hash.wgsl"

struct BrushUniforms {
    world      : WorldData,
    // xy: canvas resolution   zw: reserved
    canvas_res : vec4f,
    // x: frame_count(i)   y: cull probability (EXPERIMENT)   zw: reserved
    flags      : vec4f,
}

@group(0) @binding(0) var<uniform> u : BrushUniforms;
// READ-ONLY here, and read in the VERTEX STAGE. The same buffer is bound
// read_write to the compute pass; only the binding type differs, which is why
// this needs its own bind group layout.
@group(0) @binding(1) var<storage, read> entities : array<Entity>;

fn frame_count() -> i32 { return bitcast<i32>(u.flags.x); }
// EXPERIMENT: the Monte Carlo cull. 0 draws every particle.
fn cull_probability() -> f32 { return u.flags.y; }

// The old quad's kernel: brush.frag's `gaussian(uv - 0.5, 0.163)`, cut off at
// `length(uv - 0.5) > 0.5`.
const SIGMA: f32 = 0.163;
const RADIUS: f32 = 0.5;

struct VsOut {
    @builtin(position) clip : vec4f,
    // The whole deposit, already scaled for the canvas. Flat: a point has one
    // fragment, so there is nothing to interpolate.
    @location(0) @interpolate(flat) deposit : vec2f,
}

@vertex
fn vs_main(@builtin(instance_index) instance_id : u32) -> VsOut {
    let e = entities[instance_id];

    var out : VsOut;
    out.deposit = vec2f(0.0);

    // DEAD PARTICLES DEPOSIT NOTHING, and neither does anyone on a reset frame
    // (the frame-0 sentinel: the canvas pass is clearing, and must not be
    // immediately re-dirtied -- the third leg of reset(), particle_system.py
    // :259-275). Both are culled HERE rather than discarded in the fragment
    // stage: w = 0 makes the clip volume empty, so no fragment ever exists. At
    // a mostly-empty sand world, dead particles are nearly the whole draw.
    if (e_is_dead(e) || frame_count() == 0) {
        out.clip = vec4f(0.0, 0.0, 0.0, 0.0);
        return out;
    }

    // EXPERIMENT: THE MONTE CARLO CULL. Each particle is dropped with
    // probability p and the survivors deposit 1/(1-p) as much, so the expected
    // total is unchanged and only the noise grows. Its own seed, independent of
    // the pixel draw's two below.
    //
    // Culled points go PLAINLY OUTSIDE the clip volume, not to (0,0,0,0): that
    // point satisfies -w <= x <= w with equality and leaves the driver a divide
    // by w = 0, which at 90% of the draw may be a slow path of its own.
    let p = cull_probability();
    if (p > 0.0 && hash(vec2f(f32(frame_count()) + 0.5, f32(instance_id) + 0.5)) < p) {
        out.clip = vec4f(-2.0, -2.0, 0.0, 1.0);
        return out;
    }

    let res = u.canvas_res.xy;
    // Canvas pixels per world unit. The same on both axes -- world space is
    // area-preserving (common.wgsl) -- so x stands for both.
    let px_per_world = res.x / (2.0 * world_half_extent_from_res(res).x);
    // The old quad spanned +-size in world units.
    let dot_px = 2.0 * e_size(e) * px_per_world;

    // The quad's expected total: dot_px^2 times the integral of k^2 over the
    // cut-off disc, (1 - exp(-R^2/sigma^2)) / (4 pi sigma^2).
    let amount = (1.0 - exp(-RADIUS * RADIUS / (SIGMA * SIGMA)))
                 / (4.0 * PI * SIGMA * SIGMA) * dot_px * dot_px;

    // Box-Muller: a gaussian offset with k^2's spread, in pixels. Seeded on
    // (index, frame) like the desktop's, so each particle lands somewhere new
    // every step. u1 is kept off zero, where log() is -inf.
    let fc = f32(frame_count());
    let u1 = max(hash(vec2f(f32(instance_id), fc + 0.25)), 1e-7);
    let u2 = hash(vec2f(fc + 0.75, f32(instance_id)));
    let offset_px = sqrt(-2.0 * log(u1)) * vec2f(cos(2.0 * PI * u2), sin(2.0 * PI * u2))
                    * (SIGMA / sqrt(2.0)) * dot_px;

    // Into canvas uv. In BC_WRAP a deposit that lands past an edge wraps onto
    // the far side, as the particle itself would; in every other mode it falls
    // outside the viewport and is clipped, as the quad's overhang was.
    var uv = world_to_uv(e_pos(e), res) + offset_px / res;
    if (world_boundary_conditions(u.world) == BC_WRAP) {
        uv = fract(uv);
    }

    // THE Y FLIP. `world_to_uv` is Y-UP -- which is what makes "splat at world
    // p" and "sense at world p" land on the same texel under OpenGL, whose
    // framebuffer origin is bottom-left.
    //
    // WebGPU's framebuffer origin is TOP-left, so rasterizing y-up NDC deposits
    // the splat in the mirrored row from the one `get_can` reads back. The
    // splat and the sensor would then disagree about where a particle is, which
    // does not look like an upside-down image -- it looks like the physics is
    // subtly wrong. Negating y here puts the deposit where the sensor looks.
    //
    // Note this is the SAME correction canvas.wgsl's vertex stage makes, for
    // the same reason; see the longer note there.
    let ndc = uv * 2.0 - 1.0;
    out.clip = vec4f(ndc.x, -ndc.y, 0.0, 1.0);

    // Splat directly into the canvas, premultiplied by (1-P)/P so that after
    // the canvas pass's P decay the steady contribution matches the old
    // (1-P)*brush mix. CANVAS_VALUE_SCALE keeps the deposit out of fp16's
    // subnormal range at high P -- every canvas reader divides it back out
    // (see common.wgsl).
    let P = clamp(world_trail_persistence(u.world),
                  TRAIL_PERSISTENCE_MIN, TRAIL_PERSISTENCE_MAX);
    let premult = (1.0 - P) / P;
    out.deposit = e_vel(e) * amount * premult * CANVAS_VALUE_SCALE / (1.0 - p);
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    // The target is rg16float, so zw are discarded by the format -- the canvas
    // is a velocity flow field, not a colour.
    return vec4f(in.deposit, 0.0, 0.0);
}
