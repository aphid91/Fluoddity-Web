#version 330 core
// Bloom upsample: bilinear upsample with 3x3 tent filter, additively blended with the next mip level.
uniform sampler2D source_tex;       // Lower-res bloom mip being upsampled
uniform sampler2D destination_tex;  // Higher-res mip to blend into
uniform vec2 source_texel_size;     // 1.0 / source (lower-res) resolution
uniform float bloom_radius;         // Controls blur spread (scales the tent filter kernel)

in vec2 uv;
out vec4 fragColor;

void main() {
    // 3x3 tent filter for smooth upsampling
    float r = bloom_radius;
    vec3 sum = vec3(0.0);
    sum += texture(source_tex, uv + source_texel_size * vec2(-r, -r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( 0, -r)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r, -r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(-r,  0)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( 0,  0)).rgb * 4.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r,  0)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2(-r,  r)).rgb * 1.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( 0,  r)).rgb * 2.0;
    sum += texture(source_tex, uv + source_texel_size * vec2( r,  r)).rgb * 1.0;
    sum /= 16.0;

    // Add to the higher-res destination
    vec3 dest = texture(destination_tex, uv).rgb;
    fragColor = vec4(dest + sum, 1.0);
}
