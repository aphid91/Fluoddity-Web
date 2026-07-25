#version 430

// Structs come from common.glsl. This shader used to carry a full duplicate of
// ConfigData purely to reach trail_persistence -- which is a world property,
// not a per-particle one, and now lives in WorldData.
#include "common.glsl"

uniform WorldData world;

in vec2 uv;
in vec4 pos_vel;
out vec4 brush_out;
uniform int frame_count;

float gaussian(vec2 pos, float sigma) {
    float sigma2 = sigma * sigma;
    float norm = 1.0 / (2.0 * 3.14159265359 * sigma2);
    float exponent = -(dot(pos, pos)) / (2.0 * sigma2);
    return norm * exp(exponent);
}

void main() {
    float kernel_func = gaussian(uv - 0.5, 0.163);
    if (length(uv - 0.5) > 0.5 || frame_count == 0) {
        discard;
    }
    // Splat directly into the canvas, premultiplied by (1-P)/P so that after the
    // canvas pass's P decay the steady contribution matches the old (1-P)*brush mix.
    // kernel_func*kernel_func reproduces the old SRC_ALPHA blend's quadratic weighting.
    float P = clamp(world_trail_persistence(world), 1e-4, 0.999);
    float premult = (1.0 - P) / P;
    vec2 vel = pos_vel.zw;
    brush_out = vec4(vel * kernel_func * kernel_func * premult, 0.0, 0.0);
}
