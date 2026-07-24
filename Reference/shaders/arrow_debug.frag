#version 330 core
uniform sampler2D canvas_texture;
uniform vec2 cam_pos;
uniform float cam_zoom;
uniform vec2 canvas_resolution;
uniform vec2 window_size;
uniform float arrow_sensitivity;
uniform bool use_zw_channels; // When true, read velocity from .zw instead of .xy

in vec2 uv;
out vec4 fragColor;

// Arrow visualization parameters
const float GRID_COLS = 22.0;
const float GRID_ROWS = 22.0;
const float ARROW_THICKNESS = 0.08;
const float HEAD_LENGTH = 0.35;
const float HEAD_WIDTH = 0.25;
const vec3 ARROW_COLOR = vec3(0.2, 0.6, 1.0);

// Transform screen UV to world space coordinates using camera transform
vec2 screen_to_world(vec2 screen_uv) {
    // Convert from [0,1] to [-1,1]
    vec2 ndc = screen_uv * 2.0 - 1.0;

    // Account for aspect ratio
    float tex_aspect = canvas_resolution.x / canvas_resolution.y;
    float window_aspect = window_size.x / window_size.y;

    float scale_x, scale_y;
    if (tex_aspect > window_aspect) {
        scale_x = 1.0;
        scale_y = window_aspect / tex_aspect;
    } else {
        scale_x = tex_aspect / window_aspect;
        scale_y = 1.0;
    }

    scale_x /= cam_zoom;
    scale_y /= cam_zoom;

    // Apply camera transform (same as camera.py's screen_to_tex)
    // world = (ndc + offset) / scale
    vec2 world_pos;
    world_pos.x = (ndc.x + cam_pos.x / cam_zoom) / scale_x;
    world_pos.y = (ndc.y - cam_pos.y / cam_zoom) / scale_y;

    return world_pos;
}

// Sample the velocity field from canvas
vec2 get_velocity(vec2 world_pos) {
    // Convert world coords [-1,1] to texture coords [0,1]
    vec2 canvas_uv = (world_pos + 1.0) * 0.5;

    // Only sample if within valid canvas bounds
    if (canvas_uv.x < 0.0 || canvas_uv.x > 1.0 || canvas_uv.y < 0.0 || canvas_uv.y > 1.0) {
        return vec2(0.0);
    }

    vec4 canvas_sample = texture(canvas_texture, canvas_uv);
    vec2 raw = use_zw_channels ? canvas_sample.zw : canvas_sample.xy;
    return raw * pow(2.0, arrow_sensitivity);
}

// Signed distance to a line segment
float sd_segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// Signed distance to a triangle
float sd_triangle(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b - a, e1 = c - b, e2 = a - c;
    vec2 v0 = p - a, v1 = p - b, v2 = p - c;

    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);

    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(
        vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
        vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
        vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));

    return -sqrt(d.x) * sign(d.y);
}

// Map magnitude to [0, 1]
float safe_magnitude(vec2 v) {
    float len = length(v);
    return tanh(len);
}

// Render an arrow
// local_pos is in cell-local coords (roughly [-0.5, 0.5])
float render_arrow(vec2 local_pos, vec2 velocity) {
    float mag = safe_magnitude(velocity);

    // Skip if magnitude too small
    if (mag < 0.01) {
        return 0.0;
    }

    // Arrow length proportional to magnitude (max 0.5 to fit in cell)
    float arrow_length = mag * 0.5;

    // Normalize direction
    vec2 dir = normalize(velocity);

    // Arrow geometry in local space
    vec2 base = vec2(0.0);
    vec2 tip = dir * arrow_length;

    // Arrow head
    float head_len = arrow_length * HEAD_LENGTH;
    vec2 shaft_end = tip - dir * head_len;

    vec2 perp = vec2(-dir.y, dir.x);
    float head_half_width = HEAD_WIDTH * 0.5;

    vec2 head_left = shaft_end + perp * head_half_width;
    vec2 head_right = shaft_end - perp * head_half_width;

    // Distances
    float thickness = ARROW_THICKNESS * 0.5;
    float d_shaft = sd_segment(local_pos, base, shaft_end) - thickness;
    float d_head = sd_triangle(local_pos, tip, head_left, head_right);

    float d = min(d_shaft, d_head);

    // Anti-aliased edge
    float pixel_size = 2.0 / window_size.y / GRID_ROWS;
    float aa = smoothstep(pixel_size, -pixel_size, d);

    return aa;
}

void main() {
    // Calculate cell size in screen space
    vec2 screen_cell_size = vec2(1.0 / GRID_COLS, 1.0 / GRID_ROWS);

    // Determine grid cell
    vec2 cell_index = floor(uv / screen_cell_size);
    cell_index = clamp(cell_index, vec2(0.0), vec2(GRID_COLS - 1.0, GRID_ROWS - 1.0));

    // Cell center in screen space
    vec2 cell_center_screen = (cell_index + 0.5) * screen_cell_size;

    // Convert cell center to world space
    vec2 cell_center_world = screen_to_world(cell_center_screen);

    // Local position relative to cell center (in screen space)
    vec2 local_pos = (uv - cell_center_screen) / screen_cell_size;
    // Scale to maintain aspect ratio
    local_pos *= vec2(window_size.x / window_size.y, 1.0);

    // Sample velocity at cell center
    vec2 velocity = get_velocity(cell_center_world);

    // Render arrow (local_pos is already in cell-local coords)
    float arrow_mask = render_arrow(local_pos, velocity);

    // Output with alpha
    fragColor = vec4(ARROW_COLOR * arrow_mask, arrow_mask);
}
