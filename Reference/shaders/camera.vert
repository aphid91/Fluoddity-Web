#version 330 core
        in vec2 in_position;
        in vec2 in_texcoord;
        out vec2 texcoord;
        
        uniform vec2 cam_pos;
        uniform float cam_zoom;
        uniform vec2 tex_size;
        uniform vec2 window_size;
        
        void main() {
            // Calculate texture aspect ratio
            float tex_aspect = tex_size.x / tex_size.y;
            float window_aspect = window_size.x / window_size.y;
            
            // Calculate scale to fit texture in window
            vec2 scale;
            if (tex_aspect > window_aspect) {
                // Texture is wider than window - fit by width
                scale.x = 1.0;
                scale.y = window_aspect / tex_aspect;
            } else {
                // Texture is taller than window - fit by height  
                scale.x = tex_aspect / window_aspect;
                scale.y = 1.0;
            }
            
            // Apply zoom
            scale /= cam_zoom;
            
            // Transform position
            vec2 pos = in_position * scale;
            
            // Apply camera position (flip Y for screen space)
            pos -= cam_pos * vec2(1.0, -1.0) / cam_zoom;
            
            gl_Position = vec4(pos, 0.0, 1.0);
            texcoord = in_texcoord;
        }