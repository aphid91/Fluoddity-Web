#version 430

// Find the entity nearest a target world position.
//
// GPU-side reduction into a tiny result buffer, rather than reading the whole
// entity buffer back to the host. The reference did the latter: ~19 MB copied
// and a full pipeline stall on every click. This dispatches over the entities
// and returns 4 bytes.
//
// THE ATOMIC TRICK
// GLSL has no atomicMin for floats, so distance is packed into the high bits of
// a uint and the entity index into the low bits:
//
//     key = (quantized_distance << INDEX_BITS) | entity_index
//
// A single atomicMin over that key minimizes distance first and breaks ties by
// lowest index -- deterministic, which matters because otherwise the same click
// could select different particles on different frames.
//
// WHERE THE 32 BITS GO: 24 to the index, 8 to the distance. The index is the
// part that must not overflow -- an entity past INDEX_MASK cannot be encoded,
// so it silently stops being pickable, which reads as "the last cohorts don't
// respond to clicks" rather than as a bug. 24 bits covers 16.7M entities, well
// past any world size the UI offers.
//
// The distance gets what is left because its precision barely matters here:
// 256 buckets across the radius only decides which of two near-equidistant
// particles wins, and particles travel in dense clumps where clicking one
// specific member is not a thing the user can do anyway. Coarser quantization
// means more exact ties, and a tie is broken by lowest index -- still
// deterministic, which is the property that actually matters (otherwise the
// same click could select different particles on different frames).

layout(local_size_x = 256) in;

#include "common.glsl"

layout(std430, binding = 0) buffer EntityBuffer {
    Entity entities[];
};

// Single-element result buffer. binding 2 (0 = entities, 1 = configs).
//
// Only the key is stored. The winner's position is NOT written here: a thread
// that loses the atomicMin could still write its position afterwards, and
// guarding that correctly needs a second pass or a lock. The index inside the
// key is authoritative, so the host looks the position up from it instead.
layout(std430, binding = 2) buffer PickResultBuffer {
    uint best_key;      // packed (distance, index); UINT_MAX means "no hit"
};

uniform vec2 target;            // world position being picked at
uniform float max_dist;         // search radius in WORLD units; beyond this, miss
// No canvas_resolution here: distance is straight-line (see below), so nothing
// in this shader needs to know the world's shape.

// MUST MATCH picker.py. The two are checked against each other by
// tests/test_async_pick.py, which parses this file.
#define INDEX_BITS 24u          // up to ~16.7M entities
#define INDEX_MASK ((1u << INDEX_BITS) - 1u)
#define DIST_BITS  8u           // 256 distance buckets across the radius
#define DIST_MAX   ((1u << DIST_BITS) - 1u)

void main() {
    uint index = gl_GlobalInvocationID.x;
    if (index >= entities.length()) return;
    if (index > INDEX_MASK) return;   // beyond what the key can encode

    Entity e = entities[index];
    vec2 pos = e_pos(e);

    // Straight-line, deliberately NOT toroidal. Picking is a UI affordance, and
    // the wrap only changes the answer for a click within a particle radius of
    // the seam -- not worth threading the boundary mode down here, and wrong in
    // every mode but BC_WRAP anyway.
    vec2 d = target - pos;
    float dist_sq = dot(d, d);
    if (dist_sq > max_dist * max_dist) return;   // outside the radius: not a candidate

    // Quantize distance into the high bits. Using the actual distance (not the
    // square) spreads the buckets evenly in the units the user perceives.
    float dist_norm = sqrt(dist_sq) / max_dist;          // [0,1]
    uint dist_q = uint(clamp(dist_norm, 0.0, 1.0) * float(DIST_MAX));

    uint key = (dist_q << INDEX_BITS) | index;
    atomicMin(best_key, key);
}
