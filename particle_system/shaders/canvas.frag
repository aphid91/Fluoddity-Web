#version 430

// Structs come from common.glsl. This shader used to carry a full duplicate of
// ConfigData purely to reach the two trail settings, which are world
// properties rather than per-particle ones and now live in WorldData.
#include "common.glsl"

uniform WorldData world;

uniform sampler2D canvas_texture;
uniform int frame_count;

in vec2 uv;
out vec4 canvas_out;
// The diffusion stencil reaches one texel past the edge, so it has to obey the
// same boundary the particles do: wrap across the seam only in BC_WRAP,
// otherwise clamp so trails stop at the wall instead of bleeding through it.
vec4 getCan(vec2 p, sampler2D sam) {
    vec2 uv = world_boundary_conditions(world) == BC_WRAP ? fract(p)
                                                          : clamp(p, 0.0, 1.0);
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
    float TRAIL_DIFFUSION = clamp(world_trail_diffusion(world),0.001,1.0);
    float TRAIL_PERSISTENCE = clamp(world_trail_persistence(world),1e-4,0.999);
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
