#version 430

// Particle-cam fragment: a soft gaussian disc per entity, colored by the
// particle's own brain -- or by its cohort.
//
// entity_update transmits BOTH signals and chooses neither: col_params.x is a
// raw output of the black box the particle evaluates each step, col_params.y is
// its cohort index. Everything about turning those into a colour happens here.
//
// THAT SPLIT IS THE POINT. Colour is a display decision, so deciding it in the
// compute shader would mean a checkbox that does nothing until the next physics
// step -- appearing broken exactly while paused, which is when you most want to
// flip between the two and compare. Here, both toggles are immediate.
//
// By brain: two particles running the same rule agree, and mutated ones drift
// apart, so the image shows the POPULATION'S STRUCTURE rather than just where
// things are heading (which is what velocity-direction hue showed before).
// By cohort: each population reads as one flat colour.

in vec2 uv;
in vec4 pos_vel;
flat in vec2 col_params;
out vec4 frag_out;

uniform float particle_alpha;
//: How hard the colour signal swings the hue. Per-config, handed over by the
//: Orchestrator -- Camera does not read the config buffer (rule 3).
uniform float color_sensitivity;
//: Swap the brain's signal for the cohort index. Same route, same reason.
uniform bool color_by_cohort;

// How far apart consecutive cohorts land on the hue wheel. Three quarters of a
// turn separates neighbours without the arbitrary jumble a hash gives, and hue
// is periodic so it wraps on its own -- no normalizing by the cohort count.
#define COHORT_COLOR_CONSTANT 0.75

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
    //
    // Sensitivity scales BOTH signals, so it stays meaningful in either mode:
    // by cohort it sets how far apart the populations sit on the wheel.
    float signal = color_by_cohort
        ? col_params.y * COHORT_COLOR_CONSTANT
        : col_params.x;
    float hue = color_sensitivity * signal;

    frag_out = vec4(hsv2rgb(vec3(hue, 0.8, 1.0)) * kernel * particle_alpha, 1.0);
}
