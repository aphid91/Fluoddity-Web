// ============================================================================
// cameraIngest.wgsl -- the camera picture into the field's space, as two
// scalars: brightness (r) and motion (g).
//
// Runs once per CAMERA frame (not per rendered frame, not per sub-step) into
// one of two ping-ponged CAMERA_FIELD_DIM-square rg16float targets; `previous`
// is the other one, which is what Motion is measured against.
//
// ----------------------------------------------------------------------------
// COORDINATES -- the whole reason this file needs a header
// ----------------------------------------------------------------------------
// The target is indexed by `@builtin(position)`, NOT by fullscreenQuad's `uv`.
// So texel row 0 is field v = 0 here, which is the convention every READER of
// these textures uses too (textureSample's v = 0 is row 0). That is the same
// space `world_to_uv` produces in entityUpdate.wgsl, where v = 0 is the BOTTOM
// of the world. One convention from end to end: no pass in webcam/ flips v
// between textures, so none of them can disagree about it.
//
// The flip happens exactly once, HERE, reading the camera: an image copied in
// by `copyExternalImageToTexture` has its TOP row at row 0. Field v = 0 (world
// bottom) must read image v = 1 (picture bottom), hence `c.y = 1.0 - c.y`.
// Without it the picture is upside down on the particles AND in the preview --
// at least the two would agree, which is why it is worth saying here.
//
// The field is square but the world is not: the field is STRETCHED over the
// world (entityUpdate reads it with the canvas's aspect). So the crop below
// covers the WORLD's aspect, not the texture's, and the camera is cropped to
// fill it -- never squashed, never letterboxed.
// ============================================================================

#include "fullscreenQuad.wgsl"

struct IngestUniforms {
    // xy: camera-uv span per field-uv span (the cover crop; <= 1 on each axis)
    // z:  mirror left-right (1) or not (0)
    // w:  primed (1) -- `previous` holds a real frame of THIS stream
    params : vec4f,
}

@group(0) @binding(0) var<uniform> u : IngestUniforms;
@group(0) @binding(1) var camera_image : texture_2d<f32>;
@group(0) @binding(2) var image_sampler : sampler;
@group(0) @binding(3) var previous : texture_2d<f32>;

// Camera sensors are noisy: two frames of a still scene differ by a percent or
// two per pixel. Below this, a difference is noise and counts as no motion.
const MOTION_FLOOR : f32 = 0.04;
// A hand crossing a plain wall changes brightness by ~0.2-0.5; this brings that
// to the 0.5-1 range the mapping expects of a strong feature.
const MOTION_GAIN : f32 = 3.0;
// How much of last frame's motion survives into this one. A short tail, so a
// moving hand leaves a smear for a few frames rather than flickering in and
// out between camera frames where it happened to be caught mid-blur.
const MOTION_DECAY : f32 = 0.8;

@fragment
fn ingest_fs(in : FsQuadVsOut) -> @location(0) vec4f {
    let texel = vec2i(in.clip.xy);
    let f = in.clip.xy / vec2f(textureDimensions(previous));

    var c = (f - 0.5) * u.params.xy + 0.5;
    if (u.params.z > 0.5) { c.x = 1.0 - c.x; }
    c.y = 1.0 - c.y;

    let rgb = textureSampleLevel(camera_image, image_sampler, c, 0.0).rgb;
    let lum = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));

    // An unprimed `previous` is a different stream's last frame, or nothing --
    // differencing against it would light up the whole picture as "moved".
    var motion = 0.0;
    if (u.params.w > 0.5) {
        let prev = textureLoad(previous, texel, 0).rg;
        let fresh = max(abs(lum - prev.r) - MOTION_FLOOR, 0.0) * MOTION_GAIN;
        motion = min(max(fresh, prev.g * MOTION_DECAY), 1.0);
    }
    return vec4f(lum, motion, 0.0, 1.0);
}
