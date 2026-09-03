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
    // xy: center (canvas uv)   z: radius   w: draw angle (the `fixed` arrow)
    reticle    : vec4f,
    // x: reticle_style(i)   y: trails_opacity   z: line_enable   w: reserved
    flags      : vec4f,
    // xy: crop half-extent as a fraction of the window   z: enable
    // w: how far the surround is dimmed, 0..1
    crop       : vec4f,
    // xy: uv scale   zw: uv offset. The identity (1,1,0,0) on the screen pass;
    // the crop sub-rect on the recording pass. See `fs_main`'s first statement.
    capture    : vec4f,
    // xy: the line tool's anchor   zw: the cursor. Both in canvas uv. Gated by
    // `flags.z`, NOT by being non-zero: a zero-length segment is a legitimate
    // preview on the frame the line arms.
    line       : vec4f,
}

@group(0) @binding(0) var<uniform> u : FrameAssemblyUniforms;

// group 1 is the TEXTURES, which change identity on resize and when bloom is
// toggled. Splitting them from the uniform means the uniform is bound once.
@group(1) @binding(0) var source : texture_2d<f32>;        // accumulated camera frame, linear HDR
@group(1) @binding(1) var bloom_tex : texture_2d<f32>;     // half-res bloom. A 1x1 dummy when off
@group(1) @binding(2) var strafe_field : texture_2d<f32>;  // painted vector field. A 1x1 dummy until Step 9
@group(1) @binding(3) var tex_sampler : sampler;

fn reticle_style() -> i32 { return bitcast<i32>(u.flags.x); }
fn trails_opacity() -> f32 { return u.flags.y; }
fn line_enabled() -> bool { return u.flags.z > 0.0; }
fn draw_angle() -> f32 { return u.reticle.w; }

// Reticle styles. MUST match `RETICLE_STYLES` in `assemblerUniforms.ts`, whose
// array order IS this numbering.
const RETICLE_PLAIN  : i32 = 0;
const RETICLE_DASHED : i32 = 1;
const RETICLE_OUT    : i32 = 2;
const RETICLE_IN     : i32 = 3;
const RETICLE_FIXED  : i32 = 4;

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

// Crop box border width, in pixels. Converted via fwidth like the reticle's, so
// the rule stays this thick on screen whatever the window size.
const CROP_BORDER_PX: f32 = 1.0;

// How many rays the In and Out reticles carry, and how long they are.
//
// Eight is enough to read as "radiating" at a glance without the rays merging
// into a solid annulus on a small brush. The length is a FRACTION OF THE RADIUS
// rather than a fixed distance, so the decoration scales with the ring instead of
// swamping a small brush and vanishing on a large one.
const RETICLE_RAY_COUNT: f32 = 8.0;
const RETICLE_RAY_LENGTH: f32 = 1.0 / 6.0;

// The `fixed` arrow: one ray with a head, at the Draw Angle.
const RETICLE_ARROW_LENGTH: f32 = 1.0 / 6.0;
// The barbs' length, as a fraction of the RADIUS, so the head scales with the
// ring. Deliberately more than half the shaft's own length: a head shorter than
// that reads as a thickening rather than as an arrow at the default brush size.
const RETICLE_ARROW_HEAD: f32 = 0.10;

// The line tool's preview, drawn at half opacity: it is a proposal, not a mark.
const LINE_PREVIEW_ALPHA: f32 = 0.5;

// hsv2rgb, for the TRAILS overlay's direction colouring. The same function
// `camera.wgsl:35` carries, and deliberately the same one: the trails layer is
// colourized by exactly the formula the Trail Map View uses on the canvas, so a
// painted trail and a simulated one at the same angle are the same colour.
fn hsv2rgb(c: vec3f) -> vec3f {
    let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - vec3f(3.0));
    return c.z * mix(vec3f(1.0), clamp(p - vec3f(1.0), vec3f(0.0), vec3f(1.0)), c.y);
}

// Distance from `p` to the segment a->b, in whatever metric the caller passes in.
// The line preview's capsule, and the same shape `strafeDraw.wgsl` paints along --
// which is what makes the preview show the stroke's real footprint rather than an
// approximation of it.
fn dist_to_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
    let pa = p - a;
    let ba = b - a;
    let denom = dot(ba, ba);
    // denom == 0 while the line is armed but the cursor has not moved. h = 0 then,
    // which degenerates to a point -- the correct preview for a zero-length line.
    // `var` + `if`, not select(): the discarded arm divides by zero.
    var h = 0.0;
    if (denom > 0.0) {
        h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
    }
    return length(pa - ba * h);
}

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
    // THE CAPTURE REMAP, and it is the first thing that happens because
    // EVERYTHING downstream must agree about which part of the image this
    // fragment is.
    //
    // On the screen pass `capture_scale` is 1 and `capture_offset` is 0, so this
    // is the identity and costs a multiply-add. On the RECORDING pass they
    // describe the crop box, and this maps the recording's full-frame quad onto
    // that sub-rectangle of the source -- which is what makes the exported
    // pixels the interior of the box, 1:1 at native resolution, with no
    // upscaling and no second render of the world.
    //
    // The remapped uv then feeds the source sample AND the overlay transform
    // below, which is the point of doing it once here: a crop that moved the
    // image without moving the field overlay would put the painted field in the
    // wrong place in the exported video, and only in the exported video.
    let uv = in.uv * u.capture.xy + u.capture.zw;

    var color = textureSampleLevel(source, tex_sampler, uv, 0.0).rgb;

    // -- bloom, added in linear space where adding light is meaningful --
    // The intensity carries the on/off switch (assembler.py:102-109): at zero
    // the fetch is skipped, so the 1x1 dummy bound in that case is never read.
    //
    // **THE BLOOM READ IS Y-FLIPPED, and nothing else here is.** The mip chain
    // is both written and read by `fullscreen_vs` consumers, so it is internally
    // consistent whatever convention it picked -- but that convention is the
    // opposite of `source`'s, and the two only ever meet HERE. So the flip
    // belongs at this one boundary, on the bloom fetch alone.
    //
    // DO NOT "fix" this in `fullscreenQuad.wgsl` instead: that quad is shared
    // with the camera present and accumulate passes, its header commits to "NO
    // Y FLIP, for every consumer", and two shader tests assert the absence of a
    // flip there. Flipping it would mirror the camera to un-mirror the bloom.
    if (u.tone.x > 0.0) {
        // The REMAPPED uv: the bloom mips are the same size and orientation as
        // the source, so a crop must take the same sub-rect from both or the
        // glow would slide against the image it belongs to.
        let bloom_uv = vec2f(uv.x, 1.0 - uv.y);
        color += textureSampleLevel(bloom_tex, tex_sampler, bloom_uv, 0.0).rgb * u.tone.x;
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
    if (u.tone.w > 0.0 || trails_opacity() > 0.0 || u.reticle.z > 0.0 || line_enabled()) {
        // The REMAPPED uv, so the field lands on the same particles it does on
        // screen. Using `in.uv` here would put the painted field in the wrong
        // place in the exported video and nowhere else -- a bug visible only in
        // the finished file, which is the worst place to find one.
        let ndc = uv * 2.0 - 1.0;
        let canvas_uv = screen_ndc_to_canvas_uv(ndc, u.canvas_res.xy, u.canvas_res.zw,
                                                u.camera.xy, u.camera.z);
        let inside = all(canvas_uv >= vec2f(0.0)) && all(canvas_uv <= vec2f(1.0));

        // The field is the same SHAPE as the canvas -- only its resolution is
        // capped -- so canvas uv indexes it directly with no correction.
        //
        // ONE SAMPLE FOR BOTH LAYERS: walls in rg, trails in ba.
        if ((u.tone.w > 0.0 || trails_opacity() > 0.0) && inside) {
            let field = textureSampleLevel(strafe_field, tex_sampler, canvas_uv, 0.0);

            // WALLS: greyscale by magnitude. Direction is deliberately not shown
            // -- a wall's job is to be in the way, and which way it pushes is
            // legible from what the particles do when they hit it.
            if (u.tone.w > 0.0) {
                let m = length(field.rg);
                // Saturating rather than clamped: a faint field and a heavily
                // overpainted one both stay readable, and repainting the same spot
                // approaches white instead of flattening into a solid blob.
                let g = 1.0 - exp(-m * FIELD_OVERLAY_GAIN);
                color = mix(color, vec3f(g), u.tone.w * g);
            }

            // TRAILS: HUE BY DIRECTION, exactly as the Trail Map View colours the
            // canvas (`camera.wgsl:85`). The two are the same kind of data -- a 2D
            // vector field the sensors read -- so painting them with one formula
            // is what lets a user compare a drawn trail against a simulated one
            // and see that they agree. Greyscale here would hide the very thing
            // the trails layer is for, since a trail's DIRECTION is what steers.
            //
            // 3.1415, not PI, matching the camera literal it mirrors: the ~2e-5
            // hue difference is invisible, and a gratuitous divergence between two
            // formulas that must look identical is worse than the rounding.
            if (trails_opacity() > 0.0) {
                let m = length(field.ba);
                let g = 1.0 - exp(-m * FIELD_OVERLAY_GAIN);
                let hue = atan2(field.a, field.b) / 3.1415 / 2.0;
                color = mix(color, hsv2rgb(vec3f(hue, 0.75, 1.0)), trails_opacity() * g);
            }
        }

        // THE LINE TOOL'S PREVIEW, under the reticle so the ring stays readable
        // where the two cross.
        //
        // A CAPSULE AT THE BRUSH'S RADIUS: this is the stroke's FOOTPRINT -- where
        // the line will land and how wide it will be -- not the vector field it
        // would deposit. The footprint is what is being aimed, and a field of
        // arrows at preview opacity would be unreadable over a moving simulation.
        //
        // Measured in the aspect-corrected metric, like the reticle and like the
        // brush that will paint it, so the preview is the same shape as the result
        // on a non-square canvas.
        //
        // ONE RADIUS SERVES BOTH A DRAWING AND AN ERASING LINE (shift+left and
        // shift+right). `u.reticle.z` is 2 sigma of the brush's gaussian, which is
        // ALSO the eraser's hard cutoff -- the two coincide by construction, and
        // that is what lets this preview be honest about a gesture whose effect
        // depends on which button ends it.
        if (line_enabled()) {
            let from_p = aspect_correct_uv(canvas_uv - u.line.xy, u.canvas_res.xy);
            let to_p = aspect_correct_uv(canvas_uv - u.line.zw, u.canvas_res.xy);
            // Both endpoints are expressed relative to this fragment, so the
            // segment runs between them and the fragment sits at the origin.
            let d = dist_to_segment(vec2f(0.0), from_p, to_p);
            let edge = fwidth(d) * RETICLE_WIDTH_PX;
            let band = 1.0 - smoothstep(0.0, edge, abs(d - u.reticle.z));
            color = mix(color, vec3f(1.0), band * LINE_PREVIEW_ALPHA);
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

            let style = reticle_style();

            // SHOVE draws the same circle dashed, so it is told apart from the
            // painting tools at a glance without moving or resizing the reticle.
            // UNCHANGED BY THE BRUSH MODES: Shove has none, and its reticle must
            // keep meaning exactly what it meant.
            if (style == RETICLE_DASHED) {
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

            // IN / OUT: eight short rays saying which way the brush deposits.
            //
            // The rays live OUTSIDE the ring for Out and INSIDE it for In, which
            // is the whole signal -- the ring is the brush's edge, and the rays
            // show what crosses it in which direction. Drawn as an angular repeat
            // crossed with a radial band, so both are one smoothstep each.
            if (style == RETICLE_OUT || style == RETICLE_IN) {
                // Each ray is a SEGMENT, tested by distance-to-segment, rather
                // than an angular sector crossed with a radial band.
                //
                // **THE BAND VERSION DOES NOT SURVIVE A SMALL BRUSH, and that is
                // the default brush.** A ray is 1/6 of the radius -- ~0.0033 uv at
                // the default size -- while `w`, the line's antialiasing
                // half-width, is ~0.002. Two opposed smoothsteps whose transition
                // bands are each 2w then overlap the whole 0.0033 extent, their
                // product never approaches 1, and the decoration washes out to
                // nothing. It looked correct on a large brush and vanished on the
                // one every session starts with.
                //
                // Distance-to-segment has no such failure: the ray is drawn at the
                // SAME width as the ring itself, so it is exactly as visible as the
                // circle it decorates, at every brush size.
                let len = u.reticle.z * RETICLE_RAY_LENGTH;
                var inner = u.reticle.z;
                var outer = u.reticle.z + len;
                if (style == RETICLE_IN) {
                    inner = u.reticle.z - len;
                    outer = u.reticle.z;
                }

                // Snap this fragment to its nearest ray's direction, so one
                // distance test covers all eight. Rounding the turn fraction to
                // the nearest 1/8 IS the angular repeat.
                let turn = atan2(rel.y, rel.x);
                let step_angle = 2.0 * PI / RETICLE_RAY_COUNT;
                let snapped = round(turn / step_angle) * step_angle;
                let dir = vec2f(cos(snapped), sin(snapped));

                // The ray runs from `inner` to `outer` along that direction.
                let a = dir * inner;
                let b = dir * outer;
                let ray = dist_to_segment(rel, a, b);
                ring = max(ring, 1.0 - smoothstep(0.0, w, ray));
            }

            // FIXED: one arrow, pointing where the brush will push.
            //
            // ROTATES LIVE WITH THE DRAW ANGLE SLIDER, which is the point of
            // drawing it at all: the direction a `fixed` brush deposits is
            // otherwise invisible until after the first stroke.
            //
            // ANGLE 0 IS UP, AND CANVAS UV IS Y-UP HERE -- so this is `+cos(a)`,
            // with no negation.
            //
            // `world_to_uv` (common.wgsl) is a plain scale-and-offset with NO Y
            // FLIP, so `rel` inherits world space's y-up orientation. The flip
            // that does exist in this feature belongs to `strafeDraw.wgsl`, which
            // RASTERIZES INTO the field through its own flipped quad -- a
            // different space entirely, and not this one. Assuming "uv means
            // y-down" here put the arrow at the bottom of the ring while the
            // brush it describes pushed upward.
            if (style == RETICLE_FIXED) {
                let a = draw_angle();
                let dir = vec2f(sin(a), cos(a));
                let perp = vec2f(-dir.y, dir.x);
                let tip = u.reticle.z * (1.0 + RETICLE_ARROW_LENGTH);

                // THE SHAFT, as a segment from the ring to the tip. Segment
                // distance for the same reason the rays above use it: a shaft
                // built from an across-axis smoothstep is thinner than its own
                // antialiasing band at the default brush size and disappears.
                let shaft = dist_to_segment(rel, dir * u.reticle.z, dir * tip);

                // THE HEAD: two short barbs swept back from the tip, drawn as
                // segments like everything else here. A filled triangle would need
                // a taper test whose width again collapses below `w` on a small
                // brush -- the exact trap the shaft above just escaped.
                let barb = u.reticle.z * RETICLE_ARROW_HEAD;
                let base = dir * (tip - barb);
                let left = base + perp * barb;
                let right = base - perp * barb;
                let head = min(
                    dist_to_segment(rel, dir * tip, left),
                    dist_to_segment(rel, dir * tip, right),
                );

                ring = max(ring, 1.0 - smoothstep(0.0, w, min(shaft, head)));
            }

            color = mix(color, vec3f(1.0), ring);
        }
    }

    // ------------------------------------------------------------------
    // The recording crop box.
    //
    // LAST, and ON THE GLASS. Unlike the field and the reticle above, this does
    // NOT walk the inverse view transform: it marks a region of the OUTPUT
    // IMAGE -- the pixels that will be in the video file -- so it must stay put
    // when the world pans and zoom underneath it. Panning does change which
    // particles are inside it, which is the entire point of aiming a crop.
    //
    // NEVER DRAWN INTO THE RECORDING. `crop.z` is the enable, and the capture
    // pass always packs it zero -- the same rule the brush reticle follows, for
    // the same reason: a box marking what will be recorded, recorded, would be
    // burned into the thing it describes.
    //
    // In SCREEN uv throughout. `crop.xy` is the box's half-extent as a fraction
    // of the window and the box is centred, so the test is a single symmetric
    // distance from the middle -- which is why no origin needs to be passed.
    if (u.crop.z > 0.0) {
        let from_center = abs(in.uv - vec2f(0.5));
        let half_extent = u.crop.xy;

        // Signed distance to the box edge, in uv. Positive outside.
        let outside = any(from_center > half_extent);
        if (outside) {
            // Dim, not black: the surround still shows what is happening just
            // beyond the frame, which is what makes it possible to aim a crop at
            // something that is about to move into it.
            color *= 1.0 - u.crop.w;
        }

        // The white rule, drawn at the boundary in both axes. `fwidth` is legal
        // here for the same reason it is above -- this whole block is guarded on
        // a UNIFORM only, so every invocation in a quad agrees. `from_center` is
        // per-fragment but is not in the guard.
        let d = max(from_center.x - half_extent.x, from_center.y - half_extent.y);
        let w = fwidth(d) * CROP_BORDER_PX;
        let border = 1.0 - smoothstep(0.0, w, abs(d));
        color = mix(color, vec3f(1.0), border);
    }

    return vec4f(color, 1.0);
}
