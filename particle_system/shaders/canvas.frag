#version 430

struct ConfigData {
    int cohorts;
    float rule_seed;
    float sensor_gain;
    float sensor_angle;
    float sensor_distance;
    float mutation_scale;
    float global_force_mult;
    float drag;
    float strafe_power;
    float axial_force;
    float lateral_force;
    float hazard_rate;
    float trail_persistence;
    float trail_diffusion;
};
uniform ConfigData config;

uniform sampler2D canvas_texture;
uniform int frame_count;

in vec2 uv;
out vec4 canvas_out;
vec4 getCan(vec2 p, sampler2D sam) {
    vec2 uv = fract(p);
    return texture(sam, uv);
}

vec4 getBlur(vec2 pos, sampler2D sam,float diffusion_constant) {
    ivec2 imsz = textureSize(sam, 0);
    vec3 off = vec3(1. / vec2(imsz), 0);
    vec2 np = pos + off.zy;
    vec2 sp = pos - off.zy;
    vec2 wp = pos - off.xz;
    vec2 ep = pos + off.xz;
    vec4 nc = getCan(np, sam);
    vec4 sc = getCan(sp, sam);
    vec4 wc = getCan(wp, sam);
    vec4 ec = getCan(ep, sam);
    float K = diffusion_constant;
    return (getCan(pos, sam) * K + nc + sc + wc + ec) / (4. + K);
}
void main() {
    if(frame_count==0){canvas_out=vec4(0,0,0,0);return;}
    vec4 canvas_color;
    float TRAIL_DIFFUSION = clamp(config.trail_diffusion,0.001,1.0);
    float TRAIL_PERSISTENCE = clamp(config.trail_persistence,1e-4,0.999);
    if(TRAIL_DIFFUSION>0){
        TRAIL_DIFFUSION= TRAIL_DIFFUSION*TRAIL_DIFFUSION;//better scaling for slider
        TRAIL_DIFFUSION = 4./(pow(5,(TRAIL_DIFFUSION))-1);//better scaling for slider
        canvas_color = getBlur(uv, canvas_texture,TRAIL_DIFFUSION);
    }
    else{
        canvas_color = texture(canvas_texture,uv);
    }
    // Brush splats are already mixed into the canvas; just decay by persistence.
    canvas_out = canvas_color * TRAIL_PERSISTENCE;
}
