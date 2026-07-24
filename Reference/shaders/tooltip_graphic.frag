#version 150
in vec2 texcoord;

out vec4 fragColor;

// Time for animations
uniform float time;

// Sensor angle (raw slider value)
uniform float SENSOR_ANGLE;

// Highlight modes
uniform bool AXIAL_MODE;
uniform bool LATERAL_MODE;
uniform bool SENSOR_MODE;
uniform bool DRAG_MODE;
uniform bool ANGLE_MODE;
uniform bool DISTANCE_MODE;
uniform bool TRAIL_MODE;
uniform bool DIFFUSION_MODE;
uniform bool GLOBAL_MODE;
uniform bool STRAFE_MODE;
uniform bool MUTATION_MODE;
float sdSegment( in vec2 p, in vec2 a, in vec2 b )
{
    vec2 pa = p-a, ba = b-a;
    float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
    return length( pa - ba*h );
}
void pR(inout vec2 p, float a) {
    p = cos(a)*p + sin(a)*vec2(p.y, -p.x);
}
float sdTriangle( in vec2 p, in float r )
{
    const float k = sqrt(3.0);
    p.x = abs(p.x) - r;
    p.y = p.y + r/k;
    if( p.x+k*p.y>0.0 ) p = vec2(p.x-k*p.y,-k*p.x-p.y)/2.0;
    p.x -= clamp( p.x, -2.0*r, 0.0 );
    return -length(p)*sign(p.y);
}

float sd_particle(vec2 uv){
    return length(uv)-.1;
}
float sd_arrow(vec2 uv,vec2 end,float scale){
    scale*=2;
    vec2 tri_p = uv-end;
    pR(tri_p,-atan(end.x,end.y));
    tri_p.y+=scale*.1;
    return min(
    sdTriangle(tri_p,.1*scale),
    sdSegment(uv,vec2(0),end-normalize(end)*.1*scale)-scale*.03);
}

float sd_sensor(vec2 uv, float dist,float theta, float power){
uv.x=abs(uv.x);
vec2 offset =vec2(0,dist);
pR(offset,theta);
float sensor = length(uv-offset)-.08*2*power;
float beam = sdSegment(uv,offset,vec2(0))-.045*.5;
return min(beam,sensor);
}
void main() {
    vec2 uv = (texcoord - .5)*2.1;
    uv.y = -uv.y;

    // Apply circular motion when strafe power is hovered
    if (STRAFE_MODE) {
        uv += 0.1 * vec2(cos(time), sin(time));
    }

    // Hardcoded middling values with oscillation when hovered
    float AXIAL_SLIDER = 0.3 + (AXIAL_MODE||GLOBAL_MODE ? 0.1*sin(time) : 0.0);
    float LATERAL_SLIDER = 0.75 + (LATERAL_MODE||GLOBAL_MODE ? 0.1*sin(time) : 0.0);
    float SENSOR_GAIN_SLIDER = 0.5 + (SENSOR_MODE ? 0.2*sin(time) : 0.0);
    float DRAG_SLIDER = 0.4 + (DRAG_MODE ? 0.081*sin(time) : 0.0);
    float SENSOR_DISTANCE_SLIDER = 0.6 + (DISTANCE_MODE ? 0.1*sin(time) : 0.0);
    float TRAIL_PERSISTENCE_SLIDER = 0.99 + (TRAIL_MODE ? 0.1*sin(time) : 0.0);
    float GLOBAL_FORCE_MULT_SLIDER = 0.5 + (GLOBAL_MODE ? 0.1*sin(time) : 0.0);

    float scale = GLOBAL_MODE ? GLOBAL_FORCE_MULT_SLIDER : 0.5;

    fragColor = vec4(0,0,0,1);
    
    //trail indicator
    vec2 tuv = uv;
    vec3 trail_col = 2*vec3(1,.6,.2);
    if(DIFFUSION_MODE){
    tuv.x=mix(tuv.x,tuv.x*(1.-.8*sqrt(abs(tuv.y))),.5+.5*sin(time));
    trail_col*=1.-.8*abs(tuv.y)*(.5+.5*sin(time));
    }
    //pR(tuv,-length(tuv*.61)*LATERAL_SLIDER/(1+1*abs(AXIAL_SLIDER)));
    
    if(!TRAIL_MODE&&!DIFFUSION_MODE)trail_col = mix(trail_col,vec3(.5),.75);

    fragColor.xyz += trail_col*.7*max(0,sign(-tuv.y)*max(0,1-8*abs(tuv.x)))*exp(tuv.y*10*(1-TRAIL_PERSISTENCE_SLIDER)/TRAIL_PERSISTENCE_SLIDER);
    
    //center particle
    fragColor.xyz = sd_particle(uv)<0? vec3(1):fragColor.xyz;
    
    //wiggle stuff around if mutation mode
    vec2 mutation_noise0 = vec2(0);
    vec2 mutation_noise1 = vec2(0);
    if(MUTATION_MODE){
        mutation_noise0 = .1*vec2(cos(time*1.4),sin(time*.75));
        mutation_noise1 = .1*vec2(sin(time*1.3+.1),sin(time*.5));
    }

    //sensor indicator(on bottom)
    float theta = SENSOR_ANGLE;
    float flipped = (fract(theta/2.)*2.-1.)>0?-1:1;
    theta*=flipped;
    flipped *= sign(uv.x);
    vec3 sensor_col =flipped<0? vec3(.3,.3,1):vec3(1,1,0);
    if(!SENSOR_MODE && !ANGLE_MODE && !DISTANCE_MODE) {
        sensor_col = mix(sensor_col, vec3(.5), .75);
        fragColor.xyz = sd_sensor(uv, SENSOR_DISTANCE_SLIDER, 3.14159*theta, abs(SENSOR_GAIN_SLIDER)) < 0 ? sensor_col : fragColor.xyz;
    }
       
    //axial indicator
    vec3 axial_col = vec3(1,0,0);
    if(!(GLOBAL_MODE||AXIAL_MODE||MUTATION_MODE)) axial_col = mix(axial_col, vec3(.5), .75);
    fragColor.xyz = sd_arrow(uv, mutation_noise0+vec2(0, .15 + .85 * abs(AXIAL_SLIDER)), scale) < 0 ? axial_col : fragColor.xyz;

    //lateral indicator
    vec3 lateral_col = vec3(0,1,0);
    if(!(GLOBAL_MODE||LATERAL_MODE||MUTATION_MODE)) lateral_col = mix(lateral_col, vec3(.5), .75);
    fragColor.xyz = sd_arrow(uv, mutation_noise1+vec2(-LATERAL_SLIDER*.85 - .15*sign(LATERAL_SLIDER), 0), scale) < 0 ? lateral_col : fragColor.xyz;
    
    //drag indicator
    if(DRAG_MODE)
    fragColor.xyz = sd_arrow(uv,vec2(0,-DRAG_SLIDER),.51)<.01?vec3(0,0,1):fragColor.xyz;
    
    //sensor indicator (on top)

    if(!SENSOR_MODE && !ANGLE_MODE && !DISTANCE_MODE) return;
    fragColor.xyz = sd_sensor(uv, SENSOR_DISTANCE_SLIDER, 3.14159*theta, abs(SENSOR_GAIN_SLIDER)) < 0 ? sensor_col : fragColor.xyz;
        
    }