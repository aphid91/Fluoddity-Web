// The Step 1 deliverable: a shader that #includes another and calls into it,
// proving the resolver works end to end on a real device compile.
//
// The fullscreen triangle is built from `vertex_index` with no vertex buffer,
// the same technique `brush.vert` and `cam_brush.vert` use on the desktop
// (their VAOs are created with `vbo=None` precisely because they generate
// geometry from the vertex ID).

#include "common_stub.wgsl"

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    // One oversized triangle covering the viewport: (-1,-1), (3,-1), (-1,3).
    let x = f32(i32(vertex_index) / 2) * 4.0 - 1.0;
    let y = f32(i32(vertex_index) & 1) * 4.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    // The call across the include boundary. If the resolver failed to splice
    // common_stub.wgsl in, this is an "unresolved identifier" compile error.
    return stub_background();
}
