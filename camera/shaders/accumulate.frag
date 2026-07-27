#version 430

// Add one temporal sample into the accumulation buffer.
//
// This is the whole of motion blur's math. The pass runs with ONE, ONE
// blending, so the accumulator receives a straight sum; weighting each sample
// by 1/N here rather than dividing the sum at the end is what makes that sum a
// box average.
//
// WHY BLENDING, RATHER THAN READ-MODIFY-WRITE. The obvious implementation
// binds the accumulator as a sampler and adds to what it reads -- which is
// what the reference does, and which is undefined behaviour: a texture must
// not be sampled while it is attached to the bound framebuffer. It happens to
// work there because sampling is 1:1 at the fragment's own uv. Letting the
// blend unit do the addition is both correct and cheaper, and it removes the
// reference's is_first_frame branch: clearing once per cycle IS the reset.

uniform sampler2D hdr;
//: 1.0 / sample count. The count is DERIVED from the cadence, not the target
//: the user asked for -- see orchestrator.blur_schedule(). Passed as a uniform
//: rather than baked in as a constant so changing the slider does not
//: recompile a shader mid-frame.
uniform float inv_samples;

in vec2 uv;
out vec4 fragColor;

void main() {
    fragColor = vec4(texture(hdr, uv).rgb * inv_samples, 1.0);
}
