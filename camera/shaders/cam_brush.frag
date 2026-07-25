#version 430

// Particle-cam fragment: a soft gaussian disc per entity, colored by heading.
//
// Colored by velocity DIRECTION (not speed) so the image reads as a flow field
// -- the same hue mapping camera.frag uses for trails, which keeps the two
// modes visually comparable when toggling between them.

in vec2 uv;
in vec4 pos_vel;
out vec4 frag_out;

uniform float particle_alpha;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float gaussian(vec2 pos, float sigma) {
    float sigma2 = sigma * sigma;
    float norm = 1.0 / (2.0 * 3.14159265359 * sigma2);
    return norm * exp(-dot(pos, pos) / (2.0 * sigma2));
}

void main() {
    vec2 centered = uv - 0.5;
    if (length(centered) > 0.5) discard;   // circular sprite, not a square

    float kernel = gaussian(centered, 0.163);
    vec2 vel = pos_vel.zw;
    float hue = atan(vel.y, vel.x) / 3.1415926 / 2.0;

    frag_out = vec4(hsv2rgb(vec3(hue, 0.75, 1.0)) * kernel * particle_alpha, 1.0);
}
