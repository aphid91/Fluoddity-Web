#version 430

uniform bool WATERCOLOR_MODE;

in vec2 uv;
in vec4 pos_vel;
in vec4 view_col;
out vec4 cam_brush_out;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float gaussian(vec2 pos, float sigma) {
    float sigma2 = sigma * sigma;
    float norm = 1.0 / (2.0 * 3.14159265359 * sigma2);
    float exponent = -(dot(pos, pos)) / (2.0 * sigma2);
    return norm * exp(exponent);
}

void main() {
    vec2 scaluv = uv - .5;
    float kernel_func = .5 * gaussian(scaluv, .163);

    // Discard fragments outside circular particle boundary or with zero alpha
    if (length(uv - 0.5) > 0.5 || view_col.w == 0.0) {
        discard;
    }

    vec3 output_color;
    if (WATERCOLOR_MODE) {
        // Watercolor mode: accumulate optical density in log space
        // Get particle chroma (full brightness HSV -> RGB)
        vec3 particle_chroma = hsv2rgb(vec3(view_col.xy, 1.0));
        // Clamp to avoid log(0) and ensure some transmission
        particle_chroma = clamp(particle_chroma, 0.001, 0.9);
        // Output log-space optical density scaled by original intensity
        output_color = log(particle_chroma) * view_col.z;
    } else {
        // Normal mode: standard HSV to RGB
        output_color = hsv2rgb(view_col.xyz);
    }

    cam_brush_out = vec4(output_color, view_col.w * kernel_func);
}
