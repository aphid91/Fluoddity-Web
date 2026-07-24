#version 330 core
        in vec2 texcoord;
        uniform sampler2D view_tex;
        out vec4 fragColor;


//#define KAL 1
#ifdef KAL
void pR(inout vec2 p, float a) {
	p = cos(a)*p + sin(a)*vec2(p.y, -p.x);
}
//space fold on the position
void kalTransform(inout vec2 pos,inout vec2 vel){
    float wedge = 3.1415926*2/3.;
    float old_angle = atan(pos.y,pos.x);
    float new_angle = mod(old_angle+wedge/2.,wedge)-wedge/2.;//new angle is restricted to -wedge/2, wedge/2
    pR(pos,old_angle-new_angle);
    pR(vel,old_angle-new_angle);
    if(pos.y<0){
        pos = reflect(pos,vec2(0,1));
        vel = reflect(vel,vec2(0,1));
    }
}
#endif

        void main() {
            vec2 uv = texcoord;
            #ifdef KAL
            uv=uv*2-1;
            vec2 dum=vec2(0);
            kalTransform(uv,dum);
            uv=(uv+1)/2.;
            #endif
            fragColor = texture(view_tex, uv);
        }