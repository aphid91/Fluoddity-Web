#version 430

// Bloom upsample: 3x3 tent filter, added into the next mip up.
//
// Walking back up the chain adding each blurred level to the one above is what
// gives bloom its wide, soft falloff: the smallest mip contributes a huge
// diffuse halo, the largest a tight glow, and the sum of them is far smoother
// than any single blur of the same width.
//
// THE ADDITION IS DONE BY THE BLEND UNIT (ONE, ONE), not by sampling the
// destination here. The reference binds the destination mip as a sampler while
// rendering into it, which is undefined behaviour -- it works only because the
// read is 1:1 at the fragment's own uv. Blending is correct and cheaper.
//
// No per-level weight: every mip is added at full strength and bloom_intensity
// is the single global scale, applied once during composite.

uniform sampler2D source_tex;    // the lower-res mip being upsampled
uniform vec2 source_texel_size;  // 1.0 / source (lower-res) resolution
uniform float bloom_radius;      // scales the tap offsets

in vec2 uv;
out vec4 fragColor;

void main() {
    float r = bloom_radius;
    vec3 sum = vec3(0.0);
    sum += texture(source_tex, uv + source_texel_size * vec2(-r, -r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(0.0, -r)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r, -r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(-r, 0.0)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(0.0, 0.0)).rgb * 4.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r, 0.0)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(-r,  r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(0.0,  r)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r,  r)).rgb * 1.0;
    sum /= 16.0;

    fragColor = vec4(sum, 1.0);
}
