#version 330

uniform sampler2D tex;

in vec2 uv;
out vec4 fragColor;
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
    
    vec4 canv = texture(tex, uv);
    fragColor = vec4(3*8*hsv2rgb(vec3(atan(canv.y,canv.x)/3.1415/2.,.75,length(canv.xy))),1);
    float len = length(fragColor.xyz);
    if (len > 0.0) {
        fragColor.xyz /= pow(len, 0.575);
    }
}
