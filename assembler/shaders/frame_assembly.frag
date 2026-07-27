#version 430

// Frame assembly: everything between the finished camera frame and the screen.
//
//   composite bloom  (linear)
//   brightness       (linear)
//   tone curve       linear -> display
//   field overlay    on top of the curve
//   brush reticle    on top of the curve
//
// ORDER MATTERS IN BOTH DIRECTIONS. Bloom and brightness go before the curve
// because they are physical quantities -- adding light, then exposing it. The
// overlays go after because they are not part of the image at all: they are
// annotations, and running them through a compressive curve would dim the
// reticle's white and make its apparent thickness depend on scene brightness.

#include "common.glsl"

uniform sampler2D source;        // the accumulated camera frame, linear HDR
uniform sampler2D bloom_tex;     // half-res bloom, linear. Unused when intensity is 0
uniform sampler2D strafe_field;  // RG32F painted vector field

uniform float bloom_intensity;   // 0 when bloom is off
uniform float brightness;
uniform float tonemap_softness;

// The view transform, so the overlays land on the world rather than the screen.
uniform vec2 canvas_resolution;
uniform vec2 window_resolution;
uniform vec2 cam_pan;
uniform float cam_zoom;

//: EXACTLY zero means off, and the field texture is not sampled at all.
uniform float field_opacity;
//: Cursor position in canvas uv. Radius is the brush's visible extent in the
//: aspect-corrected metric; zero means "no reticle" and skips the whole block.
uniform vec2 reticle_center;
uniform float reticle_radius;

in vec2 uv;
out vec4 fragColor;

// Turns the field's small magnitudes into visible grey. A default stroke peaks
// near 0.06 (0.01 * draw_power/5 / draw_size), so this puts a typical stroke
// high on the saturating curve without a heavy one clipping flat.
#define FIELD_OVERLAY_GAIN 40.0

// Reticle line width, in pixels. Converted to uv via fwidth, so the ring stays
// this thick on screen at any zoom.
#define RETICLE_WIDTH_PX 1.5

// World space is area-preserving, so a raw uv delta is anisotropic on a
// non-square canvas. This is the SAME correction strafe_draw.frag applies when
// it paints -- the ring must be measured in the metric the brush works in, or
// it would read as an oval exactly when the canvas is not square.
vec2 aspect_correct_uv(vec2 d) {
    float ca = canvas_resolution.x / canvas_resolution.y;
    return d * vec2(sqrt(ca), 1.0 / sqrt(ca));
}

void main() {
    vec3 color = texture(source, uv).rgb;

    // -- bloom, added in linear space where adding light is meaningful --
    if (bloom_intensity > 0.0) {
        color += texture(bloom_tex, uv).rgb * bloom_intensity;
    }

    // -- exposure, then tone --
    color *= brightness;

    // asinh, applied to the LENGTH of the colour rather than per channel, so
    // the direction of the vector -- hue and saturation -- survives untouched.
    // Dividing by softness keeps the curve tangent to the identity at the
    // origin for every setting, so dim regions stay put as the slider moves and
    // only the highlights compress. Unbounded: it never asymptotes to 1, so a
    // bright enough region still clips at the 8-bit present.
    float len = length(color);
    if (len > 0.0) {
        color *= asinh(len * tonemap_softness) / (len * tonemap_softness);
    }

    // ------------------------------------------------------------------
    // Overlays. Both walk the inverse view transform, so they pan and zoom
    // with the world rather than sitting on the glass.
    // ------------------------------------------------------------------
    if (field_opacity > 0.0 || reticle_radius > 0.0) {
        vec2 ndc = uv * 2.0 - 1.0;
        vec2 canvas_uv = screen_ndc_to_canvas_uv(ndc, canvas_resolution,
                                                 window_resolution,
                                                 cam_pan, cam_zoom);
        bool inside = all(greaterThanEqual(canvas_uv, vec2(0.0)))
                   && all(lessThanEqual(canvas_uv, vec2(1.0)));

        // The field is the same SHAPE as the canvas -- only its resolution is
        // capped -- so canvas uv indexes it directly with no correction.
        if (field_opacity > 0.0 && inside) {
            float m = length(texture(strafe_field, canvas_uv).rg);
            // Saturating rather than clamped: a faint field and a heavily
            // overpainted one both stay readable, and repainting the same spot
            // approaches white instead of flattening into a solid blob.
            float g = 1.0 - exp(-m * FIELD_OVERLAY_GAIN);
            color = mix(color, vec3(g), field_opacity * g);
        }

        // Drawn outside the canvas too: the brush paints right up to the edge,
        // so clipping the ring there would hide where the stroke lands.
        if (reticle_radius > 0.0) {
            float d = length(aspect_correct_uv(canvas_uv - reticle_center));
            float w = fwidth(d) * RETICLE_WIDTH_PX;
            float ring = 1.0 - smoothstep(0.0, w, abs(d - reticle_radius));
            color = mix(color, vec3(1.0), ring);
        }
    }

    fragColor = vec4(color, 1.0);
}
