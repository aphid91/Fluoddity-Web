#version 430

// Present pass for TRAIL mode: sample the canvas through the camera transform
// and colorize it.
//
// The camera is applied HERE rather than by moving the quad, because the quad
// is always fullscreen: we walk each screen pixel backwards to the world point
// it shows. That inverse is what puts the letterbox bars in the right place and
// keeps zoom anchored, and it lives in common.glsl -- not in this file.
#include "common.glsl"

uniform sampler2D tex;
uniform vec2 canvas_resolution;
uniform vec2 window_resolution;
uniform vec2 cam_pan;
uniform float cam_zoom;

in vec2 uv;          // fullscreen quad uv [0,1]
out vec4 fragColor;

// Turns the canvas's stored magnitude into a sensible starting exposure, so
// the Brightness slider lands near 1.0 for a typical scene. Not a tone curve:
// a plain linear gain, applied before anything else sees the value.
#define CANVAS_GAIN 24.0

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    vec2 ndc = uv * 2.0 - 1.0;
    vec2 canvas_uv = screen_ndc_to_canvas_uv(ndc, canvas_resolution,
                                             window_resolution, cam_pan, cam_zoom);

    // Outside the canvas: letterbox bar (window aspect != canvas aspect) or
    // panned/zoomed past the world edge. Paint it black rather than clamping,
    // so the world's extent is visible instead of smeared edge pixels.
    if (any(lessThan(canvas_uv, vec2(0.0))) || any(greaterThan(canvas_uv, vec2(1.0)))) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // LINEAR HDR OUT. The tone curve, brightness and bloom all belong to the
    // assembler now. That matters for more than tidiness: the accumulator
    // averages what this pass emits, and averaging display values rather than
    // energy would make motion blur darken as it smeared.
    //
    // The colorize stays HERE, though, rather than moving downstream with the
    // rest. The canvas holds a vector field, and the accumulator has to average
    // COLORS, not vectors -- a particle that reverses direction mid-frame would
    // otherwise average toward zero and punch a black hole in the blur.
    // Stored canvas values ride CANVAS_VALUE_SCALE above their physical
    // meaning (an fp16 range fix -- see common.glsl); divide it back out so
    // brightness means what it always did.
    vec4 canv = texture(tex, canvas_uv) / CANVAS_VALUE_SCALE;
    vec3 color = CANVAS_GAIN * hsv2rgb(vec3(atan(canv.y, canv.x) / 3.1415 / 2.,
                                            .75, length(canv.xy)));
    fragColor = vec4(color, 1.0);
}
