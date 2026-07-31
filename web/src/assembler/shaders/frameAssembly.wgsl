// Frame assembly: everything between the finished camera frame and the screen.
// A port of `assembler/shaders/frame_assembly.frag`.
//
//   composite bloom  (linear)
//   brightness       (linear)
//   tone curve       linear -> display
//   field overlay    on top of the curve
//   brush reticle    on top of the curve
//
// ORDER MATTERS IN BOTH DIRECTIONS. Bloom and brightness go before the curve
// because they are physical quantities -- adding light, then exposing it. The
// overlays go after because they are not part of the image at all: they are
// annotations, and running them through a compressive curve would dim the
// reticle's white and make its apparent thickness depend on scene brightness.
//
// EVERY TEXTURE READ HERE IS textureSampleLevel, NOT textureSample. The field
// sample sits inside a branch on `inside`, which is per-fragment -- non-uniform
// control flow, where WGSL forbids implicit-derivative sampling outright. The
// other two would be legal either way; using one form throughout means nobody
// has to work out which is which, and no mips exist so level 0 is identical.
#include "common.wgsl"
#include "fullscreenQuad.wgsl"

struct FrameAssemblyUniforms {
    canvas_res : vec4f,   // xy: canvas size   zw: window size
    camera     : vec4f,   // xy: pan   z: zoom   w: reserved
    // x: bloom_intensity   y: brightness   z: tonemap_softness   w: field_opacity
    tone       : vec4f,
    reticle    : vec4f,   // xy: center (canvas uv)   z: radius   w: reserved
    flags      : vec4f,   // x: reticle_dashed(i)   yzw: reserved
    reserved   : vec4f,   // room for Step 9/10 overlay state
}

@group(0) @binding(0) var<uniform> u : FrameAssemblyUniforms;

// group 1 is the TEXTURES, which change identity on resize and when bloom is
// toggled. Splitting them from the uniform means the uniform is bound once.
@group(1) @binding(0) var source : texture_2d<f32>;        // accumulated camera frame, linear HDR
@group(1) @binding(1) var bloom_tex : texture_2d<f32>;     // half-res bloom. A 1x1 dummy when off
@group(1) @binding(2) var strafe_field : texture_2d<f32>;  // painted vector field. A 1x1 dummy until Step 9
@group(1) @binding(3) var tex_sampler : sampler;

fn reticle_dashed() -> bool { return bitcast<i32>(u.flags.x) != 0; }

// Turns the field's small magnitudes into visible grey. A default stroke peaks
// near 0.06 (0.01 * draw_power/5 / draw_size), so this puts a typical stroke
// high on the saturating curve without a heavy one clipping flat.
const FIELD_OVERLAY_GAIN: f32 = 40.0;

// Reticle line width, in pixels. Converted to uv via fwidth, so the ring stays
// this thick on screen at any zoom.
const RETICLE_WIDTH_PX: f32 = 1.5;

// Dashed-ring geometry. A FIXED NUMBER OF DASHES around the circumference
// rather than a fixed dash length: the ring changes size with the brush and
// with zoom, and a fixed length would collapse into a dotted blur on a small
// brush and stretch into near-solid arcs on a big one. A fixed count keeps the
// pattern recognisable at every size, which is the entire job here -- it has to
// read as "dashed, therefore Shove" at a glance.
const RETICLE_DASH_COUNT: f32 = 16.0;
// Fraction of each dash cell that is drawn, so the gap is 1 - this. Tuned by
// eye: enough gap to read as deliberately dashed, but small enough that the
// ring still reads as a circle whose radius you can judge.
const RETICLE_DASH_DUTY: f32 = 0.6625;

// asinh is NOT a WGSL builtin. asinh(x) = log(x + sqrt(x*x + 1)).
//
// The argument here is `len * softness` -- a vector length and a preference the
// host clamps to >= 0 -- so it is non-negative, the sqrt argument is >= 1 and
// the log argument is >= 1. No domain hazard, and no need for the
// sign-preserving form. DO NOT copy this helper somewhere it might see a
// negative input without restoring the `sign(x) *` factor.
fn asinh_f32(x: f32) -> f32 {
    return log(x + sqrt(x * x + 1.0));
}

@fragment
fn fs_main(in: FsQuadVsOut) -> @location(0) vec4f {
    var color = textureSampleLevel(source, tex_sampler, in.uv, 0.0).rgb;

    // -- bloom, added in linear space where adding light is meaningful --
    // The intensity carries the on/off switch (assembler.py:102-109): at zero
    // the fetch is skipped, so the 1x1 dummy bound in that case is never read.
    if (u.tone.x > 0.0) {
        color += textureSampleLevel(bloom_tex, tex_sampler, in.uv, 0.0).rgb * u.tone.x;
    }

    // -- exposure, then tone --
    color *= u.tone.y;

    // asinh, applied to the LENGTH of the colour rather than per channel, so
    // the direction of the vector -- hue and saturation -- survives untouched.
    // Dividing by softness keeps the curve tangent to the identity at the
    // origin for every setting, so dim regions stay put as the slider moves and
    // only the highlights compress. Unbounded: it never asymptotes to 1, so a
    // bright enough region still clips at the 8-bit present.
    //
    // `if (len > 0.0)` is non-uniform control flow, but contains no sampling
    // and no derivatives -- pure arithmetic, which is always legal.
    let softness = u.tone.z;
    let len = length(color);
    if (len > 0.0) {
        color *= asinh_f32(len * softness) / (len * softness);
    }

    // ------------------------------------------------------------------
    // Overlays. Both walk the inverse view transform, so they pan and zoom
    // with the world rather than sitting on the glass.
    //
    // ================== fwidth() BELOW IS LEGAL, AND IT IS LEGAL FOR A
    // ================== REASON THAT A REFACTOR CAN DESTROY.
    //
    // WGSL permits derivative builtins (fwidth/dpdx/dpdy) only in UNIFORM
    // CONTROL FLOW. Both calls sit inside `if (u.reticle.z > 0.0)`, nested in
    // the `if` just below -- and BOTH conditions read UNIFORMS ONLY. Every
    // invocation in a quad takes the same branch, so the flow is uniform and
    // the derivative is well defined.
    //
    // This breaks the moment either guard gains a per-fragment term. Note
    // `inside` IS per-fragment and is deliberately NOT in the reticle's guard
    // -- frame_assembly.frag:117-119 keeps the ring drawn outside the canvas on
    // purpose, and that choice is also what keeps fwidth legal here. Hoisting
    // `inside` up into the outer condition is a plausible-looking tidy-up that
    // makes this shader fail to compile.
    // ------------------------------------------------------------------
    if (u.tone.w > 0.0 || u.reticle.z > 0.0) {
        let ndc = in.uv * 2.0 - 1.0;
        let canvas_uv = screen_ndc_to_canvas_uv(ndc, u.canvas_res.xy, u.canvas_res.zw,
                                                u.camera.xy, u.camera.z);
        let inside = all(canvas_uv >= vec2f(0.0)) && all(canvas_uv <= vec2f(1.0));

        // The field is the same SHAPE as the canvas -- only its resolution is
        // capped -- so canvas uv indexes it directly with no correction.
        if (u.tone.w > 0.0 && inside) {
            let m = length(textureSampleLevel(strafe_field, tex_sampler, canvas_uv, 0.0).rg);
            // Saturating rather than clamped: a faint field and a heavily
            // overpainted one both stay readable, and repainting the same spot
            // approaches white instead of flattening into a solid blob.
            let g = 1.0 - exp(-m * FIELD_OVERLAY_GAIN);
            color = mix(color, vec3f(g), u.tone.w * g);
        }

        // Drawn outside the canvas too: the brush paints right up to the edge,
        // so clipping the ring there would hide where the stroke lands.
        if (u.reticle.z > 0.0) {
            // The SAME correction strafe_draw applies when it paints (both take
            // it from common.wgsl) -- the ring must be measured in the metric
            // the brush works in, or it would read as an oval exactly when the
            // canvas is not square.
            let rel = aspect_correct_uv(canvas_uv - u.reticle.xy, u.canvas_res.xy);
            let d = length(rel);
            let w = fwidth(d) * RETICLE_WIDTH_PX;
            var ring = 1.0 - smoothstep(0.0, w, abs(d - u.reticle.z));

            // SHOVE draws the same circle dashed, so the two brush tools are
            // told apart at a glance without moving or resizing the reticle.
            if (reticle_dashed()) {
                // Position around the ring, in dash cells. atan2 is the one
                // place this fragment cares about angle at all.
                let cell = (atan2(rel.y, rel.x) / (2.0 * PI) + 0.5) * RETICLE_DASH_COUNT;

                // Antialias along the ARC, which needs the angular derivative
                // rather than the radial one used for `w` above. fwidth(cell) is
                // wrong on its own: atan2 wraps once per revolution, and at that
                // seam the derivative explodes and smears one cell into a solid
                // blob. Deriving the arc footprint from the radial measure
                // instead is continuous everywhere.
                let arc = fwidth(d) * RETICLE_DASH_COUNT
                        / max(2.0 * PI * u.reticle.z, 1e-6);

                // Triangle wave over the cell, so both dash ends antialias with
                // one smoothstep and the pattern has no seam.
                let t = abs(fract(cell) - 0.5) * 2.0;
                ring *= 1.0 - smoothstep(RETICLE_DASH_DUTY - arc,
                                         RETICLE_DASH_DUTY + arc, t);
            }

            color = mix(color, vec3f(1.0), ring);
        }
    }

    return vec4f(color, 1.0);
}
