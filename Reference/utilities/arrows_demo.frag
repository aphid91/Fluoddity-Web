#version 150

uniform float time;
uniform vec2 resolution;

in VertexData
{
    vec4 v_position;
    vec3 v_normal;
    vec2 v_texcoord;
} inData;

out vec4 fragColor;

// ============== CUSTOMIZABLE PARAMETERS ==============
const float GRID_COLS = 16.0;        // Number of columns in the grid
const float GRID_ROWS = 16.0;        // Number of rows in the grid
const float ARROW_THICKNESS = 0.038;  // Thickness of arrow shaft (relative to cell size)
const float HEAD_LENGTH = 0.35;      // Arrow head length (relative to arrow length)
const float HEAD_WIDTH = 0.15;       // Arrow head width (relative to cell size)
const vec3 ARROW_COLOR = vec3(0.2, 0.6, 1.0);
const vec3 BG_COLOR = vec3(0.05, 0.05, 0.1);
// =====================================================

// Sample the vector field at given texture coordinates
vec2 get_field(vec2 tex_coords) {
    return (tex_coords*2-1)+sin(time);
}

// Signed distance to a line segment from point p, segment from a to b
float sd_segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

// Signed distance to a triangle (for arrow head)
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

// Map vector field magnitude to [0, 1] using smooth saturation
float safe_magnitude(vec2 v) {
    float len = length(v);
    // Using tanh for smooth mapping: large values -> 1, small values -> proportional
    return tanh(len);
}

// Render an arrow given local coordinates (relative to cell center)
// Returns anti-aliased mask
float render_arrow(vec2 local_pos, vec2 field_vec, vec2 cell_size) {
    float mag = safe_magnitude(field_vec);
    
    // Skip rendering if magnitude is too small
    if (mag < 0.01) {
        return 0.0;
    }
    
    // Calculate arrow length: magnitude 1 -> half the minimum cell dimension
    float max_arrow_length = 0.5 * min(cell_size.x, cell_size.y);
    float arrow_length = mag * max_arrow_length;
    
    // Get normalized direction
    vec2 dir = normalize(field_vec);
    
    // Arrow geometry points (base at origin, tip along direction)
    vec2 base = vec2(0.0);
    vec2 tip = dir * arrow_length;
    
    // Arrow shaft end (where head begins)
    float head_len = arrow_length * HEAD_LENGTH;
    vec2 shaft_end = tip - dir * head_len;
    
    // Perpendicular direction for arrow head width
    vec2 perp = vec2(-dir.y, dir.x);
    float head_half_width = min(cell_size.x, cell_size.y) * HEAD_WIDTH * 0.5;
    
    // Arrow head triangle vertices
    vec2 head_left = shaft_end + perp * head_half_width;
    vec2 head_right = shaft_end - perp * head_half_width;
    
    // Calculate distances
    float thickness = min(cell_size.x, cell_size.y) * ARROW_THICKNESS * 0.5;
    
    // Distance to shaft (line segment)
    float d_shaft = sd_segment(local_pos, base, shaft_end) - thickness;
    
    // Distance to head (triangle)
    float d_head = sd_triangle(local_pos, tip, head_left, head_right);
    
    // Combine shaft and head
    float d = min(d_shaft, d_head);
    
    // Anti-aliased edge
    float pixel_size = 2.0 / resolution.y / GRID_ROWS;
    float aa = smoothstep(pixel_size, -pixel_size, d);
    
    return aa;
}

void main(void)
{
    vec2 uv = inData.v_texcoord;  // [0, 1] range
    
    // Calculate cell size in UV space
    vec2 cell_size = vec2(1.0 / GRID_COLS, 1.0 / GRID_ROWS);
    
    // Determine which grid cell we're in
    vec2 cell_index = floor(uv / cell_size);
    
    // Clamp to valid range
    cell_index = clamp(cell_index, vec2(0.0), vec2(GRID_COLS - 1.0, GRID_ROWS - 1.0));
    
    // Calculate cell center in UV space
    vec2 cell_center = (cell_index + 0.5) * cell_size;
    
    // Get local position relative to cell center
    vec2 local_pos = uv - cell_center;
    
    // Sample the vector field at cell center
    vec2 field_vec = get_field(cell_center);
    
    // Render the arrow
    float arrow_mask = render_arrow(local_pos, field_vec, cell_size);
    
    // Color based on field direction and magnitude
    float mag = safe_magnitude(field_vec);
    float angle = atan(field_vec.y, field_vec.x);
    
    // Create a color that varies with direction
    vec3 dir_color = 0.5 + 0.5 * vec3(
        cos(angle),
        cos(angle + 2.094),  // 2π/3
        cos(angle + 4.189)   // 4π/3
    );
    
    // Blend arrow color with direction-based color
    vec3 final_arrow_color = mix(ARROW_COLOR, dir_color, 0.5) * (0.5 + 0.5 * mag);
    
    // Optional: draw subtle grid lines
    vec2 grid_uv = fract(uv / cell_size);
    float grid_line = 1.0 - smoothstep(0.0, 0.02, min(grid_uv.x, grid_uv.y));
    grid_line = max(grid_line, 1.0 - smoothstep(0.98, 1.0, max(grid_uv.x, grid_uv.y)));
    vec3 bg_with_grid = mix(BG_COLOR, BG_COLOR * 1.5, grid_line * 0.3);
    
    // Final composition
    vec3 final_color = mix(bg_with_grid, final_arrow_color, arrow_mask);
    
    fragColor = vec4(final_color, 1.0);
}
