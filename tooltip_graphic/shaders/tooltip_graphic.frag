#version 430

// The sensor diagram drawn in the Sensor Angle / Sensor Distance tooltips.
//
// A particle at the origin with its two sensors held out ahead of it, drawn as
// signed distance fields. This is a DIAGRAM, not a simulation readout: it shows
// what the two sliders mean geometrically, so the numbers on them stop being
// abstract. The reference implementation drew the whole physics model here --
// force arrows, trail persistence, drag, mutation wobble -- and gated each part
// behind its own MODE uniform. Only the two sensor modes survived the port,
// so everything those other uniforms fed has been removed rather than left
// switched off.
//
// WHICH SLIDER IS HOVERED drives the highlight: the hovered quantity animates
// and the diagram is drawn in full colour, so the eye is led to the thing the
// tooltip is explaining. Exactly one of these is true at a time -- the tooltip
// only opens for one setting.
uniform bool ANGLE_MODE;
uniform bool DISTANCE_MODE;

// Seconds since the tooltip machinery started, already scaled for animation
// speed. Only drives the oscillation of the hovered quantity.
uniform float time;

// Live slider values from the config being edited, in their real units:
// SENSOR_ANGLE in half-turns (-1..1), SENSOR_DISTANCE in the 0..5 the slider
// spans. The diagram tracks what the user has actually dialled in.
uniform float SENSOR_ANGLE;
uniform float SENSOR_DISTANCE;

in vec2 uv;
out vec4 fragColor;

//: Distance at which the diagram's sensors sit at the edge of the frame. The
//: slider's real range is 0..5, which would put the sensors far outside the
//: view; this maps that range onto something that reads at tooltip size.
#define DISTANCE_FULL_SCALE 3.0

float sdSegment(in vec2 p, in vec2 a, in vec2 b)
{
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
}

void pR(inout vec2 p, float a) {
    p = cos(a) * p + sin(a) * vec2(p.y, -p.x);
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
float sd_arrow(vec2 uv,vec2 end,float scale){
    scale*=2;
    vec2 tri_p = uv-end;
    pR(tri_p,-atan(end.x,end.y));
    tri_p.y+=scale*.1;
    return min(
    sdTriangle(tri_p,.1*scale),
    sdSegment(uv,vec2(0),end-normalize(end)*.1*scale)-scale*.03);
}
float sd_particle(vec2 p) {
    return length(p) - 0.1;
}

// One sensor plus the stalk connecting it to the particle. Mirrored in x by the
// caller's abs(), so a single evaluation draws both.
float sd_sensor(vec2 p, float dist, float theta) {
    p.x = abs(p.x);
    vec2 offset = vec2(0.0, dist);
    pR(offset, theta);
    float sensor = length(p - offset) - 0.08;
    float beam = sdSegment(p, offset, vec2(0.0)) - 0.0225;
    return min(beam, sensor);
}

void main() {
    vec2 p = (uv - 0.5) * 2.1;
    p.y = -p.y;

    // The hovered quantity oscillates around its current value so the tooltip
    // animates the thing it is describing. The other stays put.
    float angle = SENSOR_ANGLE ;
    float distance_norm = SENSOR_DISTANCE / DISTANCE_FULL_SCALE;

    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    vec3 trail_col = 2*vec3(1,.6,.2);
    fragColor.xyz += trail_col*.7*max(0,sign(-p.y)*max(0,1-8*abs(p.x)))*exp(p.y*2);
    // A negative angle swaps the sensors left for right, which is a real and
    // visible difference in behaviour. Fold the sign out of the rotation and
    // into which side is coloured, so the diagram shows the swap rather than
    // just mirroring into an identical picture.
    float theta = angle;
    float flipped = (fract(theta / 2.0) * 2.0 - 1.0) > 0.0 ? -1.0 : 1.0;
    theta *= flipped;
    flipped *= sign(p.x);
    vec3 sensor_col = flipped < 0.0 ? vec3(0.3, 0.3, 1.0) : vec3(1.0, 1.0, 0.0);

    float sensors = sd_sensor(p, distance_norm, 3.14159 * theta);
    fragColor.xyz = sensors < 0.0 ? sensor_col : fragColor.xyz;

    // The particle draws last so it sits on top of where the stalks meet.
    fragColor.xyz = sd_particle(p) < 0.0 ? vec3(1.0) : fragColor.xyz;
}
