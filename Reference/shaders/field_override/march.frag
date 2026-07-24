#version 150

uniform int frame_count;
uniform vec2 canvas_resolution;

uniform vec3 camera_pos;
uniform vec3 camera_dir;
#define MAX_STEPS 10000
#define HIT_DISTANCE 1e-3
#define MAX_DISTANCE 100

#define FOCAL_LENGTH 1.

#define PI 3.1415926
in vec2 texcoord;

struct Ray 
{
    vec3 ori;
    vec3 dir;
    float extent;
    vec3 norm;
    
};
struct MR 
{
    float dts;
    vec4 mat;
};
void pR(inout vec2 p, float a) {
    p = cos(a)*p + sin(a)*vec2(p.y, -p.x);
}
float pMod1(inout float p, float size) {
    float halfsize = size*0.5;
    float c = floor((p + halfsize)/size);
    p = mod(p + halfsize, size) - halfsize;
    return c;
}
// Repeat in two dimensions
vec2 pMod2(inout vec2 p, vec2 size) {
    vec2 c = floor((p + size*0.5)/size);
    p = mod(p + size*0.5,size) - size*0.5;
    return c;
}
// Repeat in three dimensions
vec3 pMod3(inout vec3 p, vec3 size) {
    vec3 c = floor((p + size*0.5)/size);
    p = mod(p + size*0.5, size) - size*0.5;
    return c;
}
float sdLink( vec3 p, float le, float r1, float r2 )
{
  vec3 q = vec3( p.x, max(abs(p.y)-le,0.0), p.z );
  return length(vec2(length(q.xy)-r1,q.z)) - r2;
}

float sdBox( vec3 p, vec3 b )
{
  vec3 q = abs(p) - b;
  return length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0);
}

float chain(vec3 p){
pR(p.xz,p.y/1.8+frame_count/600./12.*3.1415+.32);
float ex=.25;
float r1 = .5;
float r2 = .25;
vec3 p2 = p;
pMod1(p.y,2.2*(ex+r1+r2));
float dts = sdLink(p,ex,r1,r2);
pR(p2.xz,PI/2);
p2.y+=1.1*(ex+r1+r2);
pMod1(p2.y,2.2*(ex+r1+r2));
dts = min(dts,sdLink(p2,ex,r1,r2));
return dts;
}
float sdCyl( vec3 p, float ra, float rb, float h )
{
  vec2 d = vec2( length(p.xz)-ra+rb, abs(p.y) - h + rb );
  return min(max(d.x,d.y),0.0) + length(max(d,0.0)) - rb;
}
MR map(vec3 p){p.z+=frame_count/1600.;//pR(p.xz,frame_count/10500.);
//pR(p.xz,log(length(p.xz)));
float ang = atan(p.z,p.x);
float dts= MAX_DISTANCE;
pMod1(p.z,12);
dts = min(dts,chain(p.yxz-vec3(-1,0,0)));
//p.y+=length(p.xz)/4*sin(3*ang);
//float dts = p.y/2.;
//dts = max(dts, length(p)-1.5);

float channel = 8-length(p.xy-vec2(0,4));
channel = max(channel,-sdCyl(p.yzx-vec3(4,0,0),9.5,.2,2));
dts = min(dts,max(p.y,channel));

//dts = sdCyl(p.yzx,.5,.1,1);

vec4 mat = vec4(1);
return MR(dts,mat);
}

vec3 safenorm(vec3 p){
    float lp = length(p);
    return lp>.00001? normalize(p):vec3(0);
}
vec3 calcNorm( in vec3 p ) // for function f(p)
{
    const float h = 0.0001;      // replace by an appropriate value
    #define ZERO (min(frame_count,0)) // non-constant zero
    vec3 n = vec3(0.0);
    for( int i=ZERO; i<4; i++ )
    {
        vec3 e = 0.5773*(2.0*vec3((((i+3)>>1)&1),((i>>1)&1),(i&1))-1.0);
        n += e*map(p+e*h).dts;
    }
    return safenorm(n);
}
int steps;
MR march(inout Ray r){
    MR result = MR(MAX_DISTANCE,vec4(-1));
    for(int i = 0; i< MAX_STEPS && r.extent<MAX_DISTANCE; i++){
        vec3 pos = r.ori + r.dir * r.extent;
        result = map(pos);
        float dts = result.dts;
        vec4 mat = result.mat;
        if(dts < HIT_DISTANCE){
            r.norm = calcNorm(pos);
            return result;
        }
        r.extent += result.dts;
        steps = i+1;
    }
    //r.norm = vec3(0,0,1);
    return result;
}
vec3 forward;
vec3 right;
vec3 up;
Ray getCam(vec2 uv){
    uv.y*=canvas_resolution.y/canvas_resolution.x;
    vec3 dir = normalize(vec3(uv,FOCAL_LENGTH));
    
    forward = camera_dir;
    up = vec3(0,1,0);
    right = normalize(cross(forward,up));
    up = normalize(cross(right,forward));
    dir= mat3(-right,up,forward)*dir;
    return Ray (camera_pos,dir,0,vec3(0));
}
out vec4 fragColor;
void main(void)
{
    vec2 uv = -1. + 2. * texcoord;
    Ray cam_ray = getCam(uv);
    MR hit = march(cam_ray);
    //vec2 field0 = vec2(cam_ray.extent/30.);
    vec3 N = cam_ray.norm;
    vec3 D = vec3(0,1,0);//down
    vec3 S = safenorm(cross(cross(N,D),N));//unit vector perpendicular to N in the same plane as N,D
    S *= dot(D,S); //Proportional to its alignment with down
    vec2 field0 = vec2(dot(right,S),dot(-up,S));

    //vec2 field0 = vec2(dot(right,cam_ray.norm*vec3(1,1,1)),dot(up,cam_ray.norm*vec3(1,1,1)));//vec3(cam_ray.extent/10);
    if(isnan(field0.x+field0.y)||!(length(field0)<2.)){field0=vec2(0);}
    fragColor = vec4(-field0,-field0);
    //fragColor = vec4(cam_ray.extent)/20;
    //fragColor.xyz = N;
}