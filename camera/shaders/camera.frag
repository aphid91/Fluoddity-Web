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
uniform float brightness;

in vec2 uv;          // fullscreen quad uv [0,1]
out vec4 fragColor;

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

    vec4 canv = texture(tex, canvas_uv);
    fragColor = vec4(3*8*hsv2rgb(vec3(atan(canv.y,canv.x)/3.1415/2.,.75,length(canv.xy))),1);
    float len = length(fragColor.xyz);
    if (len > 0.0) {
        fragColor.xyz /= pow(len, 0.575);
    }
    // Applied last, after tone shaping, so it scales the final image rather
    // than feeding back into the curve.
    fragColor.xyz *= brightness;
}
