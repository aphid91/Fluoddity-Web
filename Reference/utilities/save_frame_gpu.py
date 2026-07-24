import moderngl
import numpy as np
from PIL import Image
import os
from utilities.paths import get_screenshots_dir

def create_supersample_shader(ctx, supersample_k):
    """Create a shader program for spatial supersampling only (NO temporal, NO gamma)."""

    vertex_shader = """
    #version 330 core
    in vec2 position;
    out vec2 uv;

    void main() {
        uv = position * 0.5 + 0.5;  // Convert from [-1,1] to [0,1]
        gl_Position = vec4(position, 0.0, 1.0);
    }
    """

    # Generate the fragment shader with unrolled loops for better compatibility
    sample_code = ""
    for y in range(supersample_k):
        for x in range(supersample_k):
            sample_code += f"""
        // Sample {x},{y}
        sub_pixel_offset = vec2({x}.5, {y}.5) / {supersample_k}.0;
        frag_shape = 1./input_size;
        sample_pos = uv - .5*frag_shape + (vec2({x}.5, {y}.5) / {supersample_k}.0)*frag_shape;

        sampcol = texture(input_frame, sample_pos).rgb;
        // NO GAMMA CORRECTION - input is already gamma-corrected from FrameAssembler
        total_color += sampcol;
"""

    fragment_shader = f"""
    #version 330 core
    uniform sampler2D input_frame;

    in vec2 uv;
    out vec4 fragColor;

    void main() {{
        vec3 total_color = vec3(0.0);
        vec2 input_size = vec2(textureSize(input_frame, 0));

        vec2 sub_pixel_offset, sample_pos, frag_shape;

        // Sample {supersample_k}^2 points within this region
        vec3 sampcol;
{sample_code}

        // Average the spatial samples only
        total_color /= {supersample_k * supersample_k}.0;

        // NO temporal averaging - that happens in FrameAssembler
        // NO gamma correction - input is already gamma-corrected

        fragColor = vec4(total_color, 1.0);
    }}
    """

    return ctx.program(vertex_shader=vertex_shader, fragment_shader=fragment_shader)


def setup_gpu_supersampling(ctx, input_width, input_height, supersample_k):
    """Set up GPU-based spatial supersampling system."""

    # Calculate output dimensions
    output_width = input_width // supersample_k
    output_height = input_height // supersample_k

    # Create output texture and framebuffer (no accumulation buffer needed)
    output_texture = ctx.texture((output_width, output_height), 4, dtype='f4')
    output_texture.filter = (moderngl.NEAREST, moderngl.NEAREST)

    output_fbo = ctx.framebuffer(color_attachments=[output_texture])

    # Create shader program
    shader = create_supersample_shader(ctx, supersample_k)

    # Create a fullscreen quad
    vertices = np.array([
        -1.0, -1.0,
         1.0, -1.0,
         1.0,  1.0,
        -1.0,  1.0,
    ], dtype=np.float32)

    indices = np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)

    vbo = ctx.buffer(vertices.tobytes())
    ibo = ctx.buffer(indices.tobytes())
    vao = ctx.vertex_array(shader, [(vbo, '2f', 'position')], ibo)

    return {
        'output_fbo': output_fbo,
        'output_texture': output_texture,
        'shader': shader,
        'vao': vao,
        'supersample_k': supersample_k,
        'output_counter': 0,
        'output_width': output_width,
        'output_height': output_height,
        'input_width': input_width,
        'input_height': input_height
    }


def save_frame_gpu(frame_data, ctx, supersample_k=1, return_array=False):
    """
    Save a moderngl texture using GPU-accelerated spatial supersampling.

    Args:
        frame_data: moderngl.Texture object (already gamma-corrected and temporally assembled)
        ctx: moderngl.Context
        supersample_k: Spatial supersampling factor (1 = no supersampling)
        return_array: If True, return numpy array instead of saving to file

    Returns:
        If return_array=True: numpy array (height, width, 3) of uint8 RGB data
        If return_array=False: str filename of saved image
    """

    # Get input dimensions
    input_width, input_height = frame_data.size

    # Initialize function attributes on first call or when settings change
    if not hasattr(save_frame_gpu, 'gpu_resources'):
        save_frame_gpu.gpu_resources = None

    # Check if we need to recreate resources
    recreate_resources = (
        save_frame_gpu.gpu_resources is None or
        save_frame_gpu.gpu_resources['supersample_k'] != supersample_k or
        save_frame_gpu.gpu_resources['input_width'] != input_width or
        save_frame_gpu.gpu_resources['input_height'] != input_height
    )

    if recreate_resources:
        # Clean up old resources if they exist
        if save_frame_gpu.gpu_resources is not None:
            old_resources = save_frame_gpu.gpu_resources
            old_resources['output_fbo'].release()
            old_resources['output_texture'].release()
            old_resources['shader'].release()
            old_resources['vao'].release()

        # Create new resources
        save_frame_gpu.gpu_resources = setup_gpu_supersampling(
            ctx, input_width, input_height, supersample_k
        )

    # Get resources
    gpu_resources = save_frame_gpu.gpu_resources
    output_fbo = gpu_resources['output_fbo']
    shader = gpu_resources['shader']
    vao = gpu_resources['vao']

    # Bind input texture
    frame_data.use(location=0)  # input_frame
    shader['input_frame'] = 0

    # Render to output buffer (single pass, no accumulation)
    output_fbo.use()
    output_fbo.clear()
    vao.render()

    # Read back the result
    data = gpu_resources['output_texture'].read()

    # Convert to numpy array
    width = gpu_resources['output_width']
    height = gpu_resources['output_height']
    pixels = np.frombuffer(data, dtype=np.float32)
    pixels = pixels.reshape((height, width, 4))

    # Convert to uint8 and drop alpha channel
    pixels = pixels[:, :, :3]
    pixels = np.clip(pixels * 255, 0, 255).astype(np.uint8)

    # Flip vertically (OpenGL convention)
    pixels = np.flipud(pixels)

    # Return array directly if requested
    if return_array:
        gpu_resources['output_counter'] += 1
        return pixels

    # Otherwise save as PNG (legacy behavior)
    img = Image.fromarray(pixels, 'RGB')

    # Create Screenshots directory if it doesn't exist
    screenshots_dir = get_screenshots_dir()
    screenshots_dir.mkdir(parents=True, exist_ok=True)

    # Increment output counter and save
    gpu_resources['output_counter'] += 1
    filename = screenshots_dir / f"frame_{gpu_resources['output_counter']:04d}.png"
    img.save(filename)

    return str(filename)


def reset_gpu_frame_counter():
    """Reset the output frame counter."""
    if hasattr(save_frame_gpu, 'gpu_resources') and save_frame_gpu.gpu_resources is not None:
        save_frame_gpu.gpu_resources['output_counter'] = 0


def cleanup_gpu_supersampling():
    """Clean up GPU resources. Call this when completely done with supersampling."""
    if hasattr(save_frame_gpu, 'gpu_resources') and save_frame_gpu.gpu_resources is not None:
        gpu_resources = save_frame_gpu.gpu_resources
        gpu_resources['output_fbo'].release()
        gpu_resources['output_texture'].release()
        gpu_resources['shader'].release()
        gpu_resources['vao'].release()
        save_frame_gpu.gpu_resources = None


# Example usage:
"""
import moderngl

# Setup your context
ctx = moderngl.create_context()

# That's it! Just call this in your render loop:
for i in range(25):
    # Your rendering code here
    texture = render_your_scene(ctx)  # Creates a 1000x1000 texture (already gamma-corrected)

    # Simple interface - handles spatial supersampling only
    result = save_frame_gpu(texture, ctx, supersample_k=2)
    if result:
        print(f"Saved: {result}")

# This outputs 25 frames at 500x500 resolution
# Each frame has 4x spatial supersampling
# Temporal accumulation and gamma correction happen BEFORE this function

# Optional: Reset for new animation sequence
reset_gpu_frame_counter()

# Optional: Clean up when completely done (releases GPU memory)
cleanup_gpu_supersampling()
"""
