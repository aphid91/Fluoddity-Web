#version 430
        
        out vec2 texcoord;
        
        void main() {
            // Generate fullscreen quad vertices
            vec2 positions[4] = vec2[](
                vec2(-1.0, -1.0),  // bottom-left
                vec2( 1.0, -1.0),  // bottom-right
                vec2( 1.0,  1.0),  // top-right
                vec2(-1.0,  1.0)   // top-left
            );
            
            vec2 texcoords[4] = vec2[](
                vec2(0.0, 0.0),
                vec2(1.0, 0.0),
                vec2(1.0, 1.0),
                vec2(0.0, 1.0)
            );
            
            gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
            texcoord = texcoords[gl_VertexID];
        }