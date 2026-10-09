// ============================================================================
// cameraPreview.wgsl -- the Camera tab's thumbnail: the field the particles
// read, NOT the camera picture.
//
// Direction as hue, strength as brightness -- the colouring camera.wgsl gives
// the trail canvas (`atan2(y, x)` around the wheel, saturation 0.75), so a
// camera vector and a trail pointing the same way are the same colour, and the
// thumbnail reads as "this is what the particles will be told". Raw RG would
// show two opposite vectors as much the same colour.
//
// THIS PASS DRAWS TO A SCREEN, so it uses fullscreenQuad's `uv` -- v = 1 at
// the top of the canvas -- to sample a texture whose v = 1 is the TOP of the
// world (see cameraIngest.wgsl). Up is up, with no flip, for the same reason
// sampling the trail canvas to the screen needs none.
// ============================================================================

#include "fullscreenQuad.wgsl"

@group(0) @binding(0) var field : texture_2d<f32>;
@group(0) @binding(1) var field_sampler : sampler;

fn hsv2rgb(c : vec3f) -> vec3f {
    let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn preview_fs(in : FsQuadVsOut) -> @location(0) vec4f {
    let v = textureSampleLevel(field, field_sampler, in.uv, 0.0).rg;
    let len = length(v);
    // Compressed, so a weak but real field is visible rather than black: the
    // map pass caps length at 1, and most of a picture sits far below that.
    let value = 1.0 - exp(-len * 4.0);
    var hue = 0.0;
    if (len > 1e-6) { hue = atan2(v.y, v.x) / 3.1415 / 2.0; }
    return vec4f(hsv2rgb(vec3f(hue, 0.75, value)), 1.0);
}
