// Particle-cam: one instanced quad per entity, drawn straight to the screen.
// A port of `camera/shaders/cam_brush.vert` + `cam_brush.frag`, joined into one
// module because a WebGPU pipeline takes both stages from one place.
//
// Unlike `brush.wgsl` (which splats into the canvas in canvas-ndc), this goes
// all the way to SCREEN ndc, so the camera transform is baked into the vertices
// here. The present pass must therefore NOT apply the camera again.
//
// Colour is decided HERE and nowhere upstream. `entityUpdate` transmits BOTH
// signals and chooses neither: `col_params.x` is a raw output of the black box
// the particle evaluates each step, `col_params.y` is its cohort index.
//
// THAT SPLIT IS THE POINT. Colour is a display decision, so deciding it in the
// compute shader would mean a checkbox that does nothing until the next physics
// step -- appearing broken exactly while paused, which is when you most want to
// flip between the two and compare. Here, both toggles are immediate.
#include "common.wgsl"

struct CamBrushUniforms {
    canvas_res : vec4f,   // xy: canvas size   zw: window size
    camera     : vec4f,   // xy: pan   z: zoom   w: reserved
    // x: sprite_size   y: particle_alpha   z: color_sensitivity   w: reserved
    sprite     : vec4f,
    flags      : vec4f,   // x: color_by_cohort(i)   yzw: reserved
}

@group(0) @binding(0) var<uniform> u : CamBrushUniforms;
// READ-ONLY, in the VERTEX STAGE -- exactly how `brush.wgsl` reads it. A vertex
// stage cannot write storage at all, so `read` is not a choice here.
@group(0) @binding(1) var<storage, read> entities : array<Entity>;

fn color_by_cohort() -> bool { return bitcast<i32>(u.flags.x) != 0; }

// How far apart consecutive cohorts land on the hue wheel. Three quarters of a
// turn separates neighbours without the arbitrary jumble a hash gives, and hue
// is periodic so it wraps on its own -- no normalizing by the cohort count.
const COHORT_COLOR_CONSTANT: f32 = 0.75;

struct VsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
    @location(1) pos_vel : vec4f,
    // `flat` because every vertex of a sprite reads the same entity, so the
    // value is constant across the quad -- interpolating it would be four
    // identical corners' worth of arithmetic for the same answer. Dropping the
    // attribute does not error: the hue would simply interpolate across each
    // sprite, which reads as a rendering style rather than as a bug.
    @location(2) @interpolate(flat) col_params : vec2f,
}

// Rotate a local offset into the entity's velocity frame, so the sprite is
// oriented along travel. Falls back to axis-aligned when nearly stationary.
//
// An `if`, NOT `select()`. `select` evaluates both arms, and the discarded arm
// here is `normalize(vec2f(0.0))` -- a divide by zero. The same decision
// recorded in web/README.md for the engine's singularity guards.
fn to_velocity_frame(offset: vec2f, vel: vec2f) -> vec2f {
    if (dot(vel, vel) == 0.0) { return offset; }
    let forward = normalize(vel);
    let left = vec2f(-forward.y, forward.x);
    return forward * offset.x + left * offset.y;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_id : u32,
           @builtin(instance_index) instance_id : u32) -> VsOut {
    let e = entities[instance_id];
    let entity_pos = e_pos(e);
    let entity_vel = e_vel(e);
    let size = e_size(e) * u.sprite.x;

    // STRIP ORDER -- (-,-) (+,-) (-,+) (+,+) -- not the fan order of
    // cam_brush.vert:46-54. TRIANGLE_FAN is not a WebGPU topology, and a strip
    // over the fan's vertex order draws a bowtie.
    //
    // The uv array is permuted THE SAME WAY, corner for corner. This matters
    // more than it looks: the fragment kernel below is `gaussian(uv - 0.5)`
    // gated by `length(uv - 0.5) > 0.5`, which is RADIALLY SYMMETRIC about the
    // quad's centre -- so permuting the uvs wrongly renders a sprite that is
    // pixel-for-pixel identical. It cannot be caught by looking at it. Permute
    // both arrays together, or not at all.
    var offsets = array<vec2f, 4>(
        vec2f(-size, -size),
        vec2f( size, -size),
        vec2f(-size,  size),
        vec2f( size,  size),
    );
    var uv_coords = array<vec2f, 4>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 1.0),
    );

    // The offset is added in WORLD space, before the transform, which is what
    // makes particles world-sized: they grow as you zoom in, exactly as if you
    // were moving closer to a physical object.
    let vertex_pos = entity_pos + to_velocity_frame(offsets[vertex_id], entity_vel);

    // ========================================================================
    // NO Y FLIP HERE -- and note that brush.wgsl, which this file otherwise
    // mirrors, DOES negate y. The difference is the TARGET, not the shader.
    //
    //   brush.wgsl    rasterizes into the CANVAS TEXTURE, which is read back
    //                 through world_to_uv (y-up). WebGPU's top-left framebuffer
    //                 origin means an unflipped y-up NDC deposits into the
    //                 mirrored row from the one the sensor reads -- a feedback
    //                 loop reading its own mirror. Hence the negation there.
    //
    //   camBrush.wgsl rasterizes into the HDR SCREEN target, which is consumed
    //                 by accumulate -> frameAssembly -> swap chain, all
    //                 unflipped fullscreen passes. Its only correctness partner
    //                 is camera.wgsl (TRAIL), which walks this same transform
    //                 BACKWARDS from an unflipped quad. The two modes agree
    //                 exactly when neither flips.
    //
    // THAT AGREEMENT IS THE TEST. camera.py:14-18 -- toggling between TRAIL and
    // PARTICLES must not shift the image. If this file gained a flip, PARTICLES
    // would be vertically mirrored relative to TRAIL, which IS visible: switch
    // ?camera=trail to ?camera=particles and watch whether the structure jumps.
    // ========================================================================
    var out : VsOut;
    out.clip = vec4f(
        world_to_screen_ndc(vertex_pos, u.canvas_res.xy, u.canvas_res.zw,
                            u.camera.xy, u.camera.z),
        0.0, 1.0);
    out.uv = uv_coords[vertex_id];
    out.pos_vel = vec4f(entity_pos, entity_vel);
    out.col_params = e_col_params(e);
    return out;
}

// Duplicated from camera.wgsl deliberately -- the GLSL duplicates it too
// (`camera.frag:26`, `cam_brush.frag:37`) and it is NOT in common.glsl, so
// hoisting it would make common.wgsl diverge from the file it mirrors.
fn hsv2rgb(c: vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn gaussian(pos: vec2f, sigma: f32) -> f32 {
    let sigma2 = sigma * sigma;
    let norm = 1.0 / (2.0 * 3.14159265359 * sigma2);
    return norm * exp(-dot(pos, pos) / (2.0 * sigma2));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let centered = in.uv - 0.5;
    if (length(centered) > 0.5) { discard; }   // circular sprite, not a square

    let kernel = gaussian(centered, 0.163);

    // Hue is periodic, so no clamping or wrapping is needed -- a large signal
    // simply travels further around the wheel. Saturation and value are fixed:
    // only hue carries information, which keeps every particle equally legible
    // against the black background.
    //
    // Sensitivity scales BOTH signals, so it stays meaningful in either mode:
    // by cohort it sets how far apart the populations sit on the wheel.
    //
    // NOTE `select(false_value, true_value, condition)` -- the argument order is
    // the REVERSE of a ternary. Safe here where `?:` was not in camera.wgsl:
    // both arms are cheap scalar reads with no singularity.
    let signal = select(in.col_params.x,
                        in.col_params.y * COHORT_COLOR_CONSTANT,
                        color_by_cohort());
    let hue = u.sprite.z * signal;

    return vec4f(hsv2rgb(vec3f(hue, 0.8, 1.0)) * kernel * u.sprite.y, 1.0);
}
