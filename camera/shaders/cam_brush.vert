#version 430

// Particle-cam: one instanced quad per entity, drawn straight to the screen.
//
// Unlike brush.vert (which splats into the canvas in canvas-ndc), this goes all
// the way to SCREEN ndc, so the camera transform is baked into the vertices
// here. The present pass must therefore NOT apply the camera again.
#include "common.glsl"

layout(std430, binding = 0) buffer EntityBuffer {
    Entity entities[];
};

uniform vec2 canvas_resolution;
uniform vec2 window_resolution;
uniform vec2 cam_pan;
uniform float cam_zoom;

// Quad size relative to the entity's own size. Matches the original's feel.
uniform float sprite_size;

out vec2 uv;
out vec4 pos_vel;
// The particle's raw colour signal, straight from the entity. `flat` because
// every vertex of a sprite reads the same entity, so the value is constant
// across the quad -- interpolating it would be four identical corners' worth
// of arithmetic for the same answer.
flat out vec2 col_params;

// Rotate a local offset into the entity's velocity frame, so the sprite is
// oriented along travel. Falls back to axis-aligned when nearly stationary
// (normalize(vec2(0)) is undefined).
vec2 to_velocity_frame(vec2 offset, vec2 vel) {
    if (dot(vel, vel) == 0.0) return offset;
    vec2 forward = normalize(vel);
    vec2 left = vec2(-forward.y, forward.x);
    return forward * offset.x + left * offset.y;
}

void main() {
    Entity e = entities[gl_InstanceID];
    vec2 entity_pos = e_pos(e);
    vec2 entity_vel = e_vel(e);
    float size = e_size(e) * sprite_size;

    vec2 offsets[4] = vec2[](
        vec2(-size, -size),
        vec2( size, -size),
        vec2( size,  size),
        vec2(-size,  size)
    );
    vec2 uv_coords[4] = vec2[](
        vec2(0, 0), vec2(1, 0), vec2(1, 1), vec2(0, 1)
    );

    // The offset is added in WORLD space, before the transform, which is what
    // makes particles world-sized: they grow as you zoom in, exactly as if you
    // were moving closer to a physical object.
    vec2 vertex_pos = entity_pos + to_velocity_frame(offsets[gl_VertexID], entity_vel);

    gl_Position = vec4(
        world_to_screen_ndc(vertex_pos, canvas_resolution, window_resolution,
                            cam_pan, cam_zoom),
        0.0, 1.0);

    uv = uv_coords[gl_VertexID];
    pos_vel = vec4(entity_pos, entity_vel);
    col_params = e_col_params(e);
}
