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

// HOW MANY SWATCH COLOURS RIDE THE UNIFORM. Must equal `SLOT_COUNT` in
// `sand/palette.ts`, which is the length of the ConfigData array and therefore
// the range a particle's config_index can take; `shaders.test.ts` asserts they
// agree. A mismatch would colour the materials above the cut from whatever
// followed the array in memory.
const SWATCH_COLOR_COUNT: i32 = 40;

// THE THREE COLOUR MODES. Mirrored from `sand/colorMode.ts`, whose
// `colorModeIndex` produces exactly these; shaders.test.ts pins the pair.
//
// Zero is BEHAVIOR so that a uniform which failed to be written (all zeroes)
// renders the original look rather than an unrecognised mode.
const MODE_BEHAVIOR: i32 = 0;
const MODE_COHORT: i32   = 1;
const MODE_SWATCH: i32   = 2;

struct CamBrushUniforms {
    canvas_res : vec4f,   // xy: canvas size   zw: window size
    camera     : vec4f,   // xy: pan   z: zoom   w: reserved
    // x: sprite_size   y: particle_alpha   z: color_sensitivity   w: reserved
    sprite     : vec4f,
    // x: color_mode(i)   y: highlighted cohort (< 0 = none)   zw: reserved
    flags      : vec4f,
    // ONE SWATCH PER LANE PAIR: xy holds hue and saturation, zw are unused.
    //
    // A vec4f array rather than a vec2f one because a uniform array's elements
    // are padded to 16 bytes each in the std140-style layout WGSL uses for the
    // `uniform` address space -- declaring it as vec2f would reserve the same
    // memory while making the stride a lie. Saying vec4f keeps the shape
    // honest, and the packer writes the two spare lanes as zero.
    swatches   : array<vec4f, 40>,
}

@group(0) @binding(0) var<uniform> u : CamBrushUniforms;
// READ-ONLY, in the VERTEX STAGE -- exactly how `brush.wgsl` reads it. A vertex
// stage cannot write storage at all, so `read` is not a choice here.
@group(0) @binding(1) var<storage, read> entities : array<Entity>;

fn color_mode() -> i32 { return bitcast<i32>(u.flags.x); }

// A swatch's hue and saturation, clamped into the table.
//
// CLAMPED RATHER THAN TRUSTED: `config_index` is bounds-checked everywhere it
// is read in the physics (`entityUpdate.wgsl` clamps it too), and an index past
// the table here would be an out-of-bounds uniform read. The dead-particle test
// in the vertex stage means this is never reached with a negative index, but
// the clamp costs nothing and makes the read safe on its own terms.
fn swatch_color(index: i32) -> vec2f {
    return u.swatches[clamp(index, 0, SWATCH_COLOR_COUNT - 1)].xy;
}

// The cohort the mouse is resting on, or negative when none is. A PLAIN FLOAT
// AND NOT A SEPARATE BOOLEAN LANE: cohorts are non-negative (`get_cohort` is a
// non-negative ramp), so "no highlight" has a spare value of its own and a
// second lane could only ever disagree with this one.
fn highlighted_cohort() -> f32 { return u.flags.y; }

// How far apart consecutive cohorts land on the hue wheel. Three quarters of a
// turn separates neighbours without the arbitrary jumble a hash gives, and hue
// is periodic so it wraps on its own -- no normalizing by the cohort count.
//
// NOT SCALED BY SENSITIVITY any more. It used to be, which made a sensitivity
// of 0.0 collapse every cohort onto hue 0 -- the slider's own midpoint was the
// one setting where the mode did not work. The spacing is now fixed and
// sensitivity drives the per-particle wobble instead, so the populations stay
// reliably distinct at every slider position.
const COHORT_COLOR_CONSTANT: f32 = 0.75;

// HOW FAR THE PER-PARTICLE WOBBLE CAN PUSH A HUE, at sensitivity 1.0.
//
// A TWELFTH OF THE WHEEL, which is the constant that decides whether this
// feature reads as "texture within a material" or as "the material's colour is
// unreliable". A swatch set to orange must still be recognisably orange across
// its whole population -- the author picked that colour and the mode exists to
// honour it -- so the wobble has to stay inside the band a viewer would call
// one colour. A twelfth is 30 degrees: enough for visible internal variation,
// narrow enough that orange never becomes yellow or red.
//
// Deliberately much smaller than Behavior mode's gain, which is unbounded by
// design because there the signal IS the colour. Here it is a modifier on a
// colour that has already been chosen, and the two want opposite tunings.
const HUE_VARIATION_SPAN: f32 = 1.0 / 12.0;

// THE TWO HIGHLIGHT KNOBS. Both describe what a particle OUTSIDE the
// highlighted cohort KEEPS, so both run 0..1 and 1.0 is "no effect" -- setting
// both to 1.0 disables the visual highlight without disabling the two-stage
// selection that depends on it.
//
// Tweak these; do not tweak the arithmetic at the bottom of the fragment stage.
const COHORT_DIM: f32 = 0.125;    // ...of its brightness
const COHORT_WASH: f32 = 0.25;    // ...of its saturation

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
    // WHICH SWATCH PAINTED THIS PARTICLE, for Color By Swatch.
    //
    // `flat` and an i32 for the same reason as above and one more: a config
    // index is an identity, not a quantity, so interpolating it across the quad
    // would produce indices that belong to no material at all. It is carried
    // rather than re-read in the fragment stage because the entity buffer is
    // bound to the VERTEX stage only -- see the binding's note.
    @location(3) @interpolate(flat) config_index : i32,
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

    // DEAD PARTICLES ARE NOT DRAWN. Same vertex-stage cull as brush.wgsl, for
    // the same reason -- see the longer note there. A w of 0 empties the clip
    // volume, so nothing is rasterized and no fragment cost is paid.
    if (e_is_dead(e)) {
        var dead : VsOut;
        dead.clip = vec4f(0.0, 0.0, 0.0, 0.0);
        dead.uv = vec2f(0.0);
        dead.pos_vel = vec4f(0.0);
        dead.col_params = vec2f(0.0);
        // ZERO, not the entity's own index -- a dead particle's is negative
        // (that IS the death flag), and nothing downstream should see one.
        // Nothing is rasterized from this vertex anyway; this keeps the struct
        // fully written rather than leaving one field to whatever was there.
        dead.config_index = 0;
        return dead;
    }

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
    out.config_index = e_config_index(e);
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

// The per-particle hue wobble, for the two modes that have a base hue to
// modify. Zero when Color Sensitivity is zero, which is what makes those modes
// pure at the slider's midpoint.
//
// ## THE SIGNAL MUST BE BOUNDED, and this is the whole reason the function
// exists rather than being written inline.
//
// `col_params.x` is a raw output of the particle's black box -- deliberately
// arbitrary in scale, tuned by eye, and explicitly documented in common.wgsl
// as something nothing downstream should read meaning into. Multiplying it
// straight into the hue would let one particle with an extreme value travel
// right around the wheel, so a material would show occasional pixels in a
// completely unrelated colour. That is exactly the failure this mode exists to
// avoid, and it would look like a bug in the palette rather than in the gain.
//
// `tanh` maps the whole real line into -1..1, smoothly and with no threshold:
// typical outputs pass through nearly linearly, so ordinary variation is
// preserved, while outliers saturate instead of wrapping. The result is then a
// bounded fraction of HUE_VARIATION_SPAN and the material stays recognisable
// no matter what the brain produces.
fn hue_variation(signal: f32) -> f32 {
    return u.sprite.z * HUE_VARIATION_SPAN * tanh(signal);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let centered = in.uv - 0.5;
    if (length(centered) > 0.5) { discard; }   // circular sprite, not a square

    let kernel = gaussian(centered, 0.163);

    // THE THREE COLOUR MODES. Exactly one applies -- see `sand/colorMode.ts` on
    // why this is an enumerated mode rather than two independent toggles.
    //
    // Hue is periodic, so no clamping or wrapping is needed anywhere here -- a
    // large signal simply travels further around the wheel.
    //
    // ## WHAT SENSITIVITY MEANS IN EACH MODE
    //
    // BEHAVIOR: a bare gain on the brain's output, which is the only thing
    // making an arbitrary-scaled signal legible as hue at all. Unchanged.
    //
    // SWATCH and COHORT: a BASE HUE the particle is assigned, plus a small
    // per-particle wobble taken from the same brain output, scaled by
    // sensitivity. At 0.0 the wobble vanishes and the mode is pure -- every
    // particle of a swatch is exactly the colour its author picked, every
    // cohort exactly its own hue. Turning the slider up lets the population's
    // internal state show through as variation WITHIN that colour, so a
    // material reads as a material rather than as a flat fill.
    //
    // This is why the wobble is ADDED rather than multiplied in: multiplying
    // the base would rotate the whole material away from the chosen colour,
    // and at zero would collapse every hue to red. Cohort mode used to do
    // exactly that -- `sensitivity * cohort * CONSTANT` meant a sensitivity of
    // 0.0 painted every cohort hue 0, which made the slider's midpoint a
    // degenerate state rather than the pure one.
    //
    // SENSITIVITY RUNS -1..1 (see settingsSpec.ts), so the wobble is signed and
    // a negative value simply reverses which way a given brain output pushes
    // the hue. Nothing needs to special-case that.
    var hue : f32;
    var saturation = 0.8;
    let mode = color_mode();
    let wobble = hue_variation(in.col_params.x);
    if (mode == MODE_SWATCH) {
        let picked = swatch_color(in.config_index);
        hue = picked.x + wobble;
        saturation = picked.y;
    } else if (mode == MODE_COHORT) {
        // The cohort's own place on the wheel is FIXED, independent of the
        // slider -- that is what makes the populations reliably distinct.
        hue = in.col_params.y * COHORT_COLOR_CONSTANT + wobble;
    } else {
        hue = u.sprite.z * in.col_params.x;
    }

    // THE COHORT HIGHLIGHT. `col_params.y` is floor(cohort)
    // (entityUpdate.wgsl:531) and the highlighted cohort arrives already
    // floored by entityPick.wgsl's derive pass, so both sides of this
    // comparison are integers-in-a-float and `==` is exact. Comparing a floored
    // value against a raw one would match nothing and dim the entire field.
    //
    // INDEPENDENT OF THE COLOUR MODE. The highlight answers "which particles am
    // I about to select", the mode answers "how is hue assigned" -- a user
    // colouring by the black-box signal, or by swatch, still needs to see what a
    // click will take. Applied to the returned COLOUR rather than to alpha, so
    // it dims what the particle contributes without changing the additive
    // blend's shape.
    // TWO KNOBS, BOTH APPLIED TO THE SAME PARTICLES. Brightness alone reads as
    // "further away"; pulling the colour toward grey as well reads as "not the
    // thing you are looking at", which is what the highlight actually means. The
    // saturation is the one below, so the wash multiplies it rather than
    // replacing it -- COHORT_WASH of 1.0 leaves the hue exactly as it was and
    // turns this half off, the same way COHORT_DIM of 1.0 turns the other half
    // off.
    var dim = 1.0;
    var wash = 1.0;
    if (highlighted_cohort() >= 0.0 && in.col_params.y != highlighted_cohort()) {
        dim = COHORT_DIM;
        wash = COHORT_WASH;
    }

    // `saturation` rather than a literal 0.8: the two signal modes set it to
    // exactly that above, so their output is unchanged, while Swatch mode
    // carries the saturation its author picked. The wash still multiplies it,
    // so a desaturated swatch washes further toward grey when it is outside the
    // highlighted cohort -- which is the highlight doing its job in every mode.
    return vec4f(hsv2rgb(vec3f(hue, saturation * wash, 1.0)) * kernel * u.sprite.y * dim, 1.0);
}
