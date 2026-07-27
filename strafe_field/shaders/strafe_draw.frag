#version 430

// Airbrush pass for the Strafe Field.
//
// Runs once per RENDERED frame, never per physics sub-step: paint rate must not
// scale with Preferences.physics_steps, or raising the simulation rate would
// silently make the brush 30x stronger.
//
// Two passes share this shader, distinguished by erase_mode:
//   draw   additive blending (ONE, ONE) accumulates a signed vector per texel.
//   erase  blending OFF, so the fragments it touches are written as literal zero.
//
// The field texture is never READ here -- each fragment writes only its own
// texel -- which is what makes it safe to render in place with no ping-pong.

in vec2 uv;              // from shared/shaders/fullscreen_quad.vert
out vec2 fragColor;      // RG32F target: the strafe vector for this texel

uniform vec2 canvas_resolution;
uniform vec2 mouse;            // field uv [0,1], this frame
uniform vec2 previous_mouse;   // field uv [0,1], previous frame of this stroke
uniform float draw_size;       // gaussian sigma, in the aspect-corrected metric
uniform float draw_power;
uniform bool erase_mode;

// World space is area-preserving (see particle_system/coords.py), so a raw uv
// delta is anisotropic on a non-square canvas. Correcting it here is what keeps
// the brush a circle rather than an oval when canvas_aspect != 1.
vec2 aspect_correct_uv(vec2 d) {
    float ca = canvas_resolution.x / canvas_resolution.y;
    return d * vec2(sqrt(ca), 1.0 / sqrt(ca));
}

// Distance from `p` to the segment a->b, in the aspect-corrected metric, plus
// the nearest point on that segment.
//
// THE SEGMENT IS THE POINT OF THIS FUNCTION. The reference splats a single
// gaussian at the current mouse position each frame, which visibly breaks into
// dots on a fast drag because nothing connects one frame's splat to the next.
// Painting the whole segment travelled since the last frame is what makes a
// stroke continuous at any drag speed.
float dist_to_stroke(vec2 p, vec2 a, vec2 b, out vec2 nearest) {
    vec2 pa = aspect_correct_uv(p - a);
    vec2 ba = aspect_correct_uv(b - a);
    float denom = dot(ba, ba);
    // denom == 0 on the first frame of a stroke, where a == b and the segment
    // degenerates to a point. h = 0 then, which is exactly a point splat.
    float h = denom > 0.0 ? clamp(dot(pa, ba) / denom, 0.0, 1.0) : 0.0;
    nearest = mix(a, b, h);
    return length(pa - ba * h);
}

void main() {
    vec2 nearest;
    float d = dist_to_stroke(uv, previous_mouse, mouse, nearest);

    if (erase_mode) {
        // Hard circle at 2*draw_size: the drawn gaussian's visible extent is
        // roughly 2 sigma, so this makes the eraser match what you can see.
        // Blending is disabled for this pass, so writing zero here IS the erase;
        // every other fragment discards and keeps whatever it held.
        //
        // Written unconditionally. The reference conditionally assigns from
        // fragColor itself here, which reads an uninitialized out variable --
        // undefined behaviour that happens to be unreachable in its case.
        if (d < draw_size * 2.0) {
            fragColor = vec2(0.0);
        } else {
            discard;
        }
        return;
    }

    if (draw_power <= 0.0) {
        discard;
        return;
    }

    // Out-Repel: a unit vector pointing away from the stroke. Measured from the
    // NEAREST POINT ON THE SEGMENT rather than from the mouse, so on a fast
    // drag the whole length of the stroke pushes outward instead of the tail
    // pointing back at wherever the cursor ended up.
    vec2 away = aspect_correct_uv(uv - nearest);
    float len = length(away);
    // Exactly on the stroke the direction is undefined; contribute nothing
    // rather than a NaN that would poison the texel permanently.
    vec2 dir = len > 0.0 ? away / len : vec2(0.0);

    // Unnormalized gaussian, sigma = draw_size. No cutoff radius: distant
    // fragments contribute a denormal rather than nothing, which costs the same
    // full-screen pass either way.
    float kernel = exp(-d * d / (2.0 * draw_size * draw_size));

    // Dividing by draw_size keeps a small brush from feeling useless: per-texel
    // intensity rises as the footprint shrinks, so the total painted impulse
    // stays in the same range across the size slider.
    fragColor = dir * 0.01 * (draw_power / 5.0) * kernel / draw_size;
}
