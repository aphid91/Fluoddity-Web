#version 430

// Bloom downsample: halve the resolution with a 4-tap box filter.
//
// The taps sit half a SOURCE texel off-centre, so each one lands exactly
// between four source texels and bilinear filtering averages them for free --
// four samples covering a 4x4 neighbourhood.
//
// Everything here is linear HDR. The reference has to inverse-tonemap on the
// first pass because it tonemaps before blooming; we bloom first, so there is
// nothing to undo.

uniform sampler2D source_tex;
uniform vec2 source_texel_size;  // 1.0 / source resolution
uniform bool apply_threshold;
uniform float threshold;

in vec2 uv;
out vec4 fragColor;

void main() {
    vec3 a = texture(source_tex, uv + source_texel_size * vec2(-0.5, -0.5)).rgb;
    vec3 b = texture(source_tex, uv + source_texel_size * vec2( 0.5, -0.5)).rgb;
    vec3 c = texture(source_tex, uv + source_texel_size * vec2(-0.5,  0.5)).rgb;
    vec3 d = texture(source_tex, uv + source_texel_size * vec2( 0.5,  0.5)).rgb;

    vec3 color = (a + b + c + d) * 0.25;

    // Thresholded on the FIRST pass only: this is where the bloom source is
    // separated from the image, and every later mip is just blurring what came
    // out of it. Subtracting from the max channel and rescaling preserves hue
    // -- clamping per-channel instead would tint bright colours toward white.
    if (apply_threshold) {
        float brightness = max(color.r, max(color.g, color.b));
        color *= max(0.0, brightness - threshold) / max(brightness, 0.0001);
    }

    fragColor = vec4(color, 1.0);
}
