#version 430

uniform vec2 canvas_resolution;

struct Entity {
    vec2 pos;
    vec2 vel;
    float size;
    float padding;
};  // Total: 24 bytes (6 floats)

layout(std430, binding = 0) buffer EntityBuffer {
    Entity entities[];
};

out vec2 uv;
out vec4 pos_vel;

void main() {
    int instance_id = gl_InstanceID;
    int vertex_id = gl_VertexID;

    vec2 entity_pos = entities[instance_id].pos;
    vec2 entity_vel = entities[instance_id].vel;
    float size = entities[instance_id].size;

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

    gl_Position = vec4(vertex_pos, 0.0, 1.0) * vec4(1, canvas_resolution.x / canvas_resolution.y, 1, 1);

    uv = particle_uv;
    pos_vel = vec4(entity_pos, entity_vel);
}
