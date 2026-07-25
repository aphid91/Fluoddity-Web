#version 430

// Entity and the coordinate math come from common.glsl -- this shader used to
// carry its own copy of the struct, which had to be kept in sync by hand.
#include "common.glsl"

uniform vec2 canvas_resolution;

layout(std430, binding = 0) buffer EntityBuffer {
    Entity entities[];
};

out vec2 uv;
out vec4 pos_vel;

void main() {
    int instance_id = gl_InstanceID;
    int vertex_id = gl_VertexID;

    Entity e = entities[instance_id];
    vec2 entity_pos = e_pos(e);
    vec2 entity_vel = e_vel(e);
    float size = e_size(e);

    vec2 offsets[4] = vec2[](
        vec2(-size, -size),
        vec2( size, -size),
        vec2( size,  size),
        vec2(-size,  size)
    );
    vec2 uv_coords[4] = vec2[](
        vec2(0, 0),
        vec2(1, 0),
        vec2(1, 1),
        vec2(0, 1)
    );

    vec2 particle_uv = uv_coords[vertex_id];
    vec2 vertex_pos = entity_pos + offsets[vertex_id];

    gl_Position = vec4(world_to_ndc(vertex_pos, canvas_resolution), 0.0, 1.0);

    uv = particle_uv;
    pos_vel = vec4(entity_pos, entity_vel);
}
