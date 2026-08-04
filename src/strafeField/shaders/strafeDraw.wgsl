// ============================================================================
// strafeDraw.wgsl -- the Strafe Field's airbrush pass.
//
// The WGSL translation of `strafe_field/shaders/strafe_draw.frag` (98 lines),
// plus `shared/shaders/fullscreen_quad.vert` (9), folded in here for the V FLIP
// described below.
//
// Runs once per RENDERED frame, never per physics sub-step: paint rate must not
// scale with the physics rate, or raising it would silently make the brush 30x
// stronger. The cadence is enforced by WHERE this is called from -- the
// Orchestrator's frame loop, above `runFrame` -- not by anything here.
//
// The field texture is never READ by this pass; each fragment writes only its
// own texel. That is what makes it safe to render in place with no ping-pong,
// unlike the canvas, which diffuses and must double-buffer.
//
// ----------------------------------------------------------------------------
// THE V FLIP, AND WHY THIS FILE DOES NOT USE fullscreenQuad.wgsl
// ----------------------------------------------------------------------------
// This pass RASTERIZES INTO a texture that `entityUpdate.wgsl` later SAMPLES
// through `world_to_uv_bc` (:184-188) -- the same Y-up mapping `get_can` uses to
// read the canvas. So the field falls on the same side of the port's rule as
// `canvas.wgsl` and `brush.wgsl`:
//
//     Rasterizing INTO the canvas -> flip.  Sampling it TO the screen -> no flip.
//
// `fullscreenQuad.wgsl`'s header (:12-18) excludes exactly this case, and its
// comment at :59 names `frameAssembly.wgsl` READING the strafe field as one of
// the two externally-observable no-flip sites. Reading, not writing. Both
// consumers agree the field is stored top-left-origin, same as the canvas.
//
// WITHOUT THE FLIP THE PICTURE IS NOT UPSIDE DOWN. Strokes would deflect
// particles in the MIRRORED direction, while the field overlay -- which samples
// with the same unflipped canvas uv the mouse produced -- draws the stroke
// exactly where you painted it. THE OVERLAY WOULD CONFIRM THE WRONG THING,
// which makes this worse than the brush.wgsl flip it mirrors: there, at least,
// nothing agreed with the bug.
// ============================================================================

#include "common.wgsl"

struct StrafeDrawUniforms {
    // xy: the FIELD's resolution   zw: reserved
    //
    // THE FIELD'S, NOT THE CANVAS'S. The GLSL names this `canvas_resolution`
    // because it shares `aspect_correct_uv` with the assembler, whose copy
    // really is fed the canvas; here it means "the texture I am drawing into"
    // (`strafe_field.py:144-150`). Renamed rather than carrying the misnomer,
    // because fed the canvas size the aspect correction computes against the
    // wrong ratio and the brush becomes an oval -- invisible at the default 1:1.
    field_res : vec4f,
    // xy: this frame's cursor in field uv   zw: the previous frame's
    stroke : vec4f,
    // x: draw_size (gaussian sigma)   y: draw_power   z: erase_mode(i)   w: reserved
    brush : vec4f,
}

@group(0) @binding(0) var<uniform> u : StrafeDrawUniforms;

fn field_res()  -> vec2f { return u.field_res.xy; }
fn mouse()      -> vec2f { return u.stroke.xy; }
fn prev_mouse() -> vec2f { return u.stroke.zw; }
fn draw_size()  -> f32   { return u.brush.x; }
fn draw_power() -> f32   { return u.brush.y; }
fn erase_mode() -> bool  { return bitcast<i32>(u.brush.z) != 0; }

struct VsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
}

// The fullscreen triangle-strip quad, from the vertex index alone. Strip order:
// (-1,-1) (1,-1) (-1,1) (1,1) -- the same order `canvas.wgsl` uses.
//
// NOTE THE V FLIP in `out.uv`, and see the file header for why it is here and
// not in the GLSL. It is the same expression `canvas.wgsl:80` carries.
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

// `dist_to_stroke`'s two return values. GLSL used an `out` parameter
// (`strafe_draw.frag:42`); WGSL has none, so they come back together.
struct StrokeHit {
    // In the ASPECT-CORRECTED metric.
    dist : f32,
    // In RAW uv. THE ASYMMETRY WITH `dist` IS LOAD-BEARING -- see below.
    nearest : vec2f,
}

// Distance from `p` to the segment a->b, plus the nearest point on it.
//
// THE SEGMENT IS THE POINT OF THIS FUNCTION. Splatting a single gaussian at the
// current mouse position visibly breaks into dots on a fast drag, because
// nothing connects one frame's splat to the next. Painting the whole segment
// travelled since the last frame is what makes a stroke continuous at any drag
// speed.
fn dist_to_stroke(p: vec2f, a: vec2f, b: vec2f, res: vec2f) -> StrokeHit {
    let pa = aspect_correct_uv(p - a, res);
    let ba = aspect_correct_uv(b - a, res);
    let denom = dot(ba, ba);

    // denom == 0 on a stroke's first frame, where a == b and the segment
    // degenerates to a point. h = 0 then, which is exactly a point splat.
    //
    // `var` + `if`, NOT `select()`. select() evaluates BOTH arms, and the
    // discarded one here divides by zero. Same reasoning as `safenorm` in
    // common.wgsl -- this is the third site in the port with that note.
    var h = 0.0;
    if (denom > 0.0) {
        h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
    }

    // `dist` IS CORRECTED AND `nearest` IS NOT, deliberately. The only consumer
    // of `nearest` re-corrects it:
    //
    //     away = aspect_correct_uv(uv - hit.nearest, res)
    //
    // Returning it already-corrected would DOUBLE-APPLY the correction and skew
    // the repel direction by the aspect ratio. That is correct on a square
    // canvas -- which is the default -- and silently wrong on every other,
    // making it the hardest version of this bug to notice.
    return StrokeHit(length(pa - ba * h), mix(a, b, h));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec2f {
    let res = field_res();
    let hit = dist_to_stroke(in.uv, prev_mouse(), mouse(), res);

    if (erase_mode()) {
        // Hard circle at 2*draw_size: the drawn gaussian's visible extent is
        // roughly 2 sigma, so the eraser matches what you can see -- and matches
        // the reticle, which is drawn at the same radius.
        //
        // THE ERASE PIPELINE HAS NO BLEND STATE, so writing zero here IS the
        // erase; every other fragment discards and keeps whatever it held. Both
        // halves are required: without the discard this would zero the whole
        // field on every erase frame.
        if (hit.dist < draw_size() * 2.0) {
            return vec2f(0.0);
        }
        discard;
    }

    // A zero-power brush contributes nothing. Discarding rather than returning
    // vec2f(0.0) matters because the DRAW pipeline blends additively -- a
    // returned zero is a no-op there too, but only by arithmetic accident, and
    // the discard says what is meant.
    if (draw_power() <= 0.0) {
        discard;
    }

    // Out-Repel: a unit vector pointing away from the stroke. Measured from the
    // NEAREST POINT ON THE SEGMENT rather than from the mouse, so on a fast drag
    // the whole length of the stroke pushes outward instead of the tail pointing
    // back at wherever the cursor ended up.
    let away = aspect_correct_uv(in.uv - hit.nearest, res);
    let len = length(away);

    // Exactly on the stroke the direction is undefined; contribute nothing
    // rather than a NaN.
    //
    // `var` + `if`, NOT `select()`, and here the stakes are higher than in
    // dist_to_stroke: select() would evaluate `away / 0`, and the target is FP16
    // UNDER ADDITIVE BLENDING. One NaN texel is PERMANENT -- it survives every
    // subsequent frame, renders as black in the overlay (indistinguishable from
    // empty), and poisons the physics every sub-step until a clear or an erase
    // happens to cover it.
    var dir = vec2f(0.0);
    if (len > 0.0) {
        dir = away / len;
    }

    // Unnormalized gaussian, sigma = draw_size. No cutoff radius: distant
    // fragments contribute a denormal rather than nothing, which costs the same
    // fullscreen pass either way.
    let kernel = exp(-hit.dist * hit.dist / (2.0 * draw_size() * draw_size()));

    // Dividing by draw_size keeps a small brush from feeling useless: per-texel
    // intensity rises as the footprint shrinks, so the total painted impulse
    // stays in the same range across the size slider. The /5.0 normalizes
    // draw_power against the top of its 0.1..5.0 range.
    return dir * 0.01 * (draw_power() / 5.0) * kernel / draw_size();
}
