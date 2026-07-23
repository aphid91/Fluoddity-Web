#version 430

layout(local_size_x = 256) in;


// Fourier Feature Network: 4D input -> 4D output
struct FourierCenter {
    vec4 frequency;  // 4D frequency vector
    vec4 amplitude;  // 4D amplitude/weight vector
};
//10 FourierCenters makes a Rule
struct Rule {
    FourierCenter centers[10];
};

//Rule coefficients loaded from config file. This governs how each particle responds to trails
uniform Rule config_rule;

//-------------Physics parameters from config file-----------------
struct ConfigData {
    int cohorts;
    float rule_seed;
    float sensor_gain;
    float sensor_angle;
    float sensor_distance;
    float mutation_scale;
    float global_force_mult;
    float drag;
    float strafe_power;
    float axial_force;
    float lateral_force;
    float hazard_rate;
    float trail_persistence;
    float trail_diffusion;
};
uniform ConfigData config;

#define PI 3.1415926
#define SQRT_WORLD_SIZE .5 //Scaling parameter that resizes distances to have a constant size in pixels

uniform sampler2D canvas_texture;
uniform int frame_count;

struct Entity {
    vec2 pos;
    vec2 vel;
    float size;
    float padding;
};  // Total: 24 bytes (6 floats)

layout(std430, binding = 0) buffer EntityBuffer {
    Entity entities[];
};
//=========================================================================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//====================================VVVVVVVVVVVVVVVVVVVVV================================

// PCG hash - bit-exact across all platforms
uint pcg_hash(uint seed) {
    uint state = seed * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

float hash(vec2 co){
    uvec2 u = uvec2(floatBitsToUint(co.x), floatBitsToUint(co.y));
    uint h = pcg_hash(u.x ^ pcg_hash(u.y));
    return float(h) / float(0xffffffffu);
}

vec4 hash4(vec2 co){
    return vec4(
        hash(co),
        hash(co*-1+5),
        hash(co.yx-100),
        hash(co.yx*-1 + 25)
    );
}

// Fourier basis evaluation
// This is how the entities evaluate their Rule
vec4 fourier_noise(FourierCenter[10] centers, vec4 signals) {
    vec4 result = vec4(0.0);

    for(int i = 0; i < 10; i++) {
        // Compute phase from dot product of input with frequency vector
        float phase = dot(signals, centers[i].frequency);

        // Add per-center phase offset to break degeneracy at origin
        // Use a deterministic offset based on center index and amplitude values
        float phase_offset =2*float(i) * 0.6283 + centers[i].amplitude.w * 3.14159;

        // Create basis functions from phase with offset
        // Using sin/cos pairs at fundamental and first harmonic for richer representation
        vec4 basis = vec4(
            sin(phase + phase_offset),
            cos(phase + phase_offset * 0.7),  // Different offsets for variety
            sin(phase * 2.0 + phase_offset * 1.3),
            cos(phase * 2.0 + phase_offset * 0.5)
        );

        // Weight and accumulate
        result += centers[i].amplitude * basis;
    }

    return result;
}

//Given a seed, return 10 random FoureierCenters: enough for a Rule.
FourierCenter[10] generate_random_centers(float seed) {
    FourierCenter[10] centers;

    for(int i = 0; i < 10; i++) {
        // Generate frequency vectors
        // Bias towards lower frequencies for smoother base behaviors
        // Range: [-2, 2] with bias towards [-1, 1]
        float freq_scale = 1.0 + 2.0 * pow(hash(vec2(seed, float(i * 8 + 0))), 2.0);
        centers[i].frequency.x = (hash(vec2(seed, float(i * 8 + 0))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.y = (hash(vec2(seed, float(i * 8 + 1))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.z = (hash(vec2(seed, float(i * 8 + 2))) * 2.0 - 1.0) * freq_scale;
        centers[i].frequency.w = (hash(vec2(seed, float(i * 8 + 3))) * 2.0 - 1.0) * freq_scale;

        // Generate amplitude vectors
        // Range: [-1, 1]
        centers[i].amplitude.x = hash(vec2(seed, float(i * 8 + 4))) * 2.0 - 1.0;
        centers[i].amplitude.y = hash(vec2(seed, float(i * 8 + 5))) * 2.0 - 1.0;
        centers[i].amplitude.z = hash(vec2(seed, float(i * 8 + 6))) * 2.0 - 1.0;
        centers[i].amplitude.w = hash(vec2(seed, float(i * 8 + 7))) * 2.0 - 1.0;
    }

    return centers;
}

vec4 random_fourier_noise(vec4 pos, float seed) {
    FourierCenter[10] centers = generate_random_centers(seed);
    return fourier_noise(centers, pos);
}

vec4 normalized_fourier_noise(vec4 pos, float seed) {
    vec4 noise = random_fourier_noise(pos, seed);
    return noise * 0.1 + 0.5;
}
//=====================================^^^^^^^^^^^^^^^^^^==================================
//------------------------------------RANDOM / HASH / NOISE--------------------------------
//=========================================================================================

//rotate p around origin by angle a
void pR(inout vec2 p, float a) {
	p = cos(a)*p + sin(a)*vec2(p.y, -p.x);
}

//convert p from worldspace to texture coords and retrieve canvas
vec4 get_can(vec2 p){
    vec2 res=textureSize(canvas_texture,0);
    vec2 aspect=vec2(1,res.x/res.y);
    vec2 uv = p/2*aspect+.5;
    return texture(canvas_texture, uv);
}

//normalize vector that tolerates vec2(0)
vec2 safenorm(vec2 p){
    return length(p)==0?vec2(0):normalize(p);
}

//simply assigns each to a cohort based on its index. 
//floor(get_cohort(index)) should be used for cohort equality tests
float get_cohort(uint index) {
    return float(config.cohorts) * float(index) / float(entities.length());
}

//Return all entities to their initialization state
void reset(uint index){

    float size=index<entities.length()?.0015/SQRT_WORLD_SIZE: 0;
    float cohort_val = get_cohort(index);

    //set pos and vel to random values on a across the canvas
    vec2 pos=.019*vec2(hash(vec2(cohort_val)),hash(vec2(cohort_val+index+2.142)));//vec2(hash(vec2(cohort_val, 1.0)), hash(vec2(cohort_val, 2.0))) * 2.0 - 1.0;
    vec2 vel=0.00005*(vec2(hash(vec2(cohort_val,index)),hash(vec2(cohort_val,pos.y)))*2-1);

    //store to persistent entity buffer
    entities[index]=Entity(pos,vel,size,0);
}

//randomly change noise function parameters, scaled by parameter 'amount'. 
//Each cohort gets a unique mutation for any given rule
void mutate_rule(inout Rule current_rule,float amount,float cohort){
    float seed = hash(current_rule.centers[4].frequency.xy+current_rule.centers[7].amplitude.yx+current_rule.centers[1].frequency.zw)+cohort;

    for(int i = 0; i < 10; i++) {
        vec4 amp_mutation = amount * (-1.0 + 2.0 * hash4(-.5+vec2(-i+seed,i)));
        current_rule.centers[i].amplitude += amp_mutation;
        current_rule.centers[i].frequency *= 1 + amount * 0.5 * (hash(vec2(seed,i))-.5);
    }
}


//Used to enforce left-right symmetry in the local coordinates vec2(forward, left)
vec2 y_reflect(vec2 p){
    return p*vec2(1,-1);
}

//Somewhat arbitrary generator of functions with 4 float inputs and 4 float outputs,
//varying rule should smoothly change the behavior of black box. Here, we use fourier noise
vec4 black_box(vec2 L,vec2 R,Rule rule){
    return (fourier_noise(rule.centers, vec4(L,R)));
}

//This function determines entity output by plugging sensor values into a noise function called black_box()
//The calculation is performed twice, once in mirrored coordinates, and the two values are averaged.
//This keeps entities from displaying clockwise/counterclockwise bias.
//PARAMETERS:
//--L and R: velocity field measurements from left sensor and right sensor.
//--axis: forward vector that defines our orientation.
//--rule: coefficients for the noise function that dictates entity behavior.
//RETURNS (via out parameters):
//--force: A "push" vector that will be added to entity.vel
//--strafe: A "hop" vector that will be added to entity.pos and have no effect on velocity
void calculate_entity_behavior( vec2 L,vec2 R, vec2 axis, Rule rule, out vec2 force, out vec2 strafe){

    //build a local coordinate frame where "axis" is forward.
    vec2 forward = safenorm(axis);
    vec2 left = vec2(forward.y,-forward.x);

    //Convert L and R to local coordinates.
    //Ie. decompose each into an axial component and a lateral component
    L = vec2(dot(L,forward),dot(L,left));
    R = vec2(dot(R,forward),dot(R,left));

    //calculate black box noise values
    vec4 baseterm = black_box(L,R,rule);
    vec4 mirrorterm = black_box(y_reflect(R),y_reflect(L),rule);

    //Combine base and mirror terms to cancel bias
    force = baseterm.xy + y_reflect(mirrorterm.xy);
    strafe = baseterm.zw + y_reflect(mirrorterm.zw);

    //Convert force and strafe back to world coordinates
    force = (forward * force.x * config.axial_force) + (left * force.y * config.lateral_force);
    strafe = (forward * strafe.x * config.axial_force) + (left * strafe.y * config.lateral_force);

    return;
}

void main() {
    uint index = gl_GlobalInvocationID.x;
    if (index >= entities.length()) return;

    Entity e=entities[index];
    float cohort = get_cohort(index);
    Rule rule = config_rule;
    //Hazard Rate == probability each frame to reset this particle
    bool hazard_reset = config.hazard_rate > hash(vec2(float(index)/float(entities.length()),frame_count));
    
    //frame_count == 0 signals a simulation reset
    if (frame_count==0||hazard_reset){reset(index);return;}

    //Calculate position offsets for the two sensors.
    float sample_dist = 1./SQRT_WORLD_SIZE*.005 * config.sensor_distance;
    vec2 orientation = safenorm(e.vel);//vector facing the same direction as velocity, with length==sample_dist

    vec2 left_sensor_offset = orientation*sample_dist;
    vec2 right_sensor_offset = orientation*sample_dist;
    pR(left_sensor_offset,config.sensor_angle*PI);//rotate them opposite directions
    pR(right_sensor_offset,-config.sensor_angle*PI);

    //read the trails from canvas
    vec4 ltap = get_can(e.pos+left_sensor_offset);
    vec4 rtap = get_can(e.pos+right_sensor_offset);

    //if a few arbitrary coefficients are exactly 0, then assume target_rule is all 0s (no target) and generate a random rule instead.
    if(rule.centers[0].frequency==vec4(0) && rule.centers[5].amplitude==vec4(0)){
        rule = Rule(generate_random_centers(config.rule_seed+floor(cohort)));
    }
    //Each cohort gets a random mutation
    mutate_rule(rule,config.mutation_scale,config.rule_seed+floor(cohort));

    //rescale sensor values
    float sensor_scaling = SQRT_WORLD_SIZE*38.855*config.sensor_gain;
    ltap *= sensor_scaling;
    rtap *= sensor_scaling;

    //compute entity action
    vec2 strafe =vec2(0);//set by calculate_...
    vec2 force = vec2(0);//set by calculate_...
    calculate_entity_behavior(ltap.xy,rtap.xy,orientation,rule,force,strafe);

    //rescale output forces
    force *= 1./SQRT_WORLD_SIZE*config.global_force_mult/400.;
    strafe *= 1./SQRT_WORLD_SIZE*config.global_force_mult/20.;



    //Accelerate: Apply drag and add force to e.vel,
    e.vel = e.vel*config.drag + force;
    
    //Move: add e.vel and strafe to e.pos
    e.pos += e.vel;
    e.pos += strafe*config.strafe_power;

    //wrap from from -1 to 1
    e.pos = 2*(fract(e.pos/2-.5)-.5);

    //Commit new entity state to buffers
    entities[index]=e;
}
