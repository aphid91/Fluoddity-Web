#version 330 core
// Bloom downsample: 4-tap box filter.
// First pass: inverse-tonemap from display space to linear HDR, then threshold.
// Subsequent passes: already in linear HDR, just downsample.
uniform sampler2D source_tex;
uniform vec2 source_texel_size;  // 1.0 / source resolution
uniform bool apply_threshold;
uniform float threshold;
uniform float tonemap_softness;

in vec2 uv;
out vec4 fragColor;

vec3 inverse_asinh(vec3 color) {
    // Undo the asinh curve only; brightness stays baked in as linear intensity.
    float len = length(color);
    if (len > 0.0) {
        color = normalize(color) * sinh(len * tonemap_softness) / tonemap_softness;
    }
    return color;
}

void main() {
    // 4-tap bilinear downsample (sample between texels for free filtering)
    vec3 a = texture(source_tex, uv + source_texel_size * vec2(-0.5, -0.5)).rgb;
    vec3 b = texture(source_tex, uv + source_texel_size * vec2( 0.5, -0.5)).rgb;
    vec3 c = texture(source_tex, uv + source_texel_size * vec2(-0.5,  0.5)).rgb;
    vec3 d = texture(source_tex, uv + source_texel_size * vec2( 0.5,  0.5)).rgb;

    // Undo asinh curve on first pass to get linear HDR before averaging
    if (apply_threshold) {
        a = inverse_asinh(a);
        b = inverse_asinh(b);
        c = inverse_asinh(c);
        d = inverse_asinh(d);
    }

    vec3 color = (a + b + c + d) * 0.25;

    if (apply_threshold) {
        float brightness = max(color.r, max(color.g, color.b));
        color *= max(0.0, brightness - threshold) / max(brightness, 0.0001);
    }

    fragColor = vec4(color, 1.0);
}
