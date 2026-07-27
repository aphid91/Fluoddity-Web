#version 430

// Particle-cam fragment: a soft gaussian disc per entity, colored by the
// particle's own brain.
//
// The hue comes from col_params.x -- a raw output of the black box the particle
// evaluates each step, written by entity_update. So two particles running the
// same rule agree, and particles running mutated rules drift apart in colour:
// the image shows the POPULATION'S STRUCTURE rather than just where things are
// heading, which is what velocity-direction hue showed before.
//
// The sensitivity multiply happens HERE rather than in the compute shader, so
// dragging the slider re-colours the frame without re-running any physics.
// Only the magnitude of the swing is a display choice; what to swing on was
// decided upstream (cohort vs. brain output).

in vec2 uv;
in vec4 pos_vel;
flat in vec2 col_params;
out vec4 frag_out;

uniform float particle_alpha;
//: How hard col_params.x swings the hue. Per-config, handed over by the
//: Orchestrator -- Camera does not read the config buffer (rule 3).
uniform float color_sensitivity;

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

    // Hue is periodic, so no clamping or wrapping is needed -- a large signal
    // simply travels further around the wheel. Saturation and value are fixed,
    // matching the reference: only hue carries information, which keeps every
    // particle equally legible against the black background.
    float hue = color_sensitivity * col_params.x;

    frag_out = vec4(hsv2rgb(vec3(hue, 0.8, 1.0)) * kernel * particle_alpha, 1.0);
}
