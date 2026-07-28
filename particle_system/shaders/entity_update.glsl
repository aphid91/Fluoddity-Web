#version 430

layout(local_size_x = 256) in;

// Structs (Entity, ConfigData, WorldData, Rule), their accessors, and all
// coordinate math live in common.glsl -- the single source of truth for layout.
#include "common.glsl"

// Per-particle-population settings: behavior (Rule) + physics parameters.
// Each entity selects its own slot via config_index, so different particles
// can obey entirely different configs.
layout(std430, binding = 1) buffer ConfigBuffer {
    ConfigData configs[];
};

// Settings that are properties of the world rather than of any particle.
uniform WorldData world;

uniform sampler2D canvas_texture;
uniform int frame_count;

// The painted Strafe Field (see strafe_field/). Displaces particles directly,
// bypassing velocity. Inactive until the module binds a texture, so the sample
// is skipped entirely rather than reading an unbound sampler.
uniform sampler2D strafe_field_texture;
uniform bool strafe_field_active;

// --- the Shove tool -------------------------------------------------------
// Cursor in WORLD space, and how hard to push away from it. Zero strength is
// the off switch, which is every frame the button is not held.
//
// Held FIXED across the whole sub-step loop. The cursor does move within a
// frame, but interpolating along its path would need the sub-step index as a
// second uniform for a difference only visible on a very fast drag -- and the
// painted field is hoisted out of the same loop for the same reason.
uniform vec2 shove_center;
uniform float shove_strength;   // signed: positive pushes away, negative pulls in
// Gaussian sigma in WORLD units. The brush stores its size in aspect-corrected
// canvas uv; the host converts once (coords.uv_radius_to_world) rather than
// this shader mixing two metrics. World space is already area-preserving, so a
// circle here is a circle on screen with no correction of its own -- which is
// what lets the same reticle serve both tools.
uniform float shove_size;

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

//convert p from worldspace to texture coords and retrieve canvas.
//The boundary mode decides what a sensor reaching past the edge sees: in
//BC_WRAP the sampler repeats and it reads the far side; otherwise it clamps
//and reads the edge, because in those modes the far side is not adjacent.
vec4 get_can(vec2 p, int bc){
    vec2 res = vec2(textureSize(canvas_texture, 0));
    return texture(canvas_texture, world_to_uv_bc(p, res, bc));
}

//Read the painted strafe field at a world position, honoring the boundary mode
//for the same reason get_can does: past the edge, wrap reads the far side and
//every other mode reads the edge.
vec2 get_strafe_field(vec2 p, int bc){
    if(!strafe_field_active) return vec2(0);
    vec2 res = vec2(textureSize(strafe_field_texture, 0));
    return texture(strafe_field_texture, world_to_uv_bc(p, res, bc)).rg;
}

//The Shove tool: a displacement away from (or toward) the cursor while the
//mouse is held. Unlike the painted field this leaves NOTHING behind -- it acts
//only on the frames the button is down, which is what makes it feel like
//pushing the particles rather than painting something that pushes them.
//
//Measured in world space directly. That space is area-preserving, so a circle
//in it is a circle on screen and no aspect correction is needed here (see the
//coordinate convention in common.glsl).
//
//Deliberately NOT boundary-aware, unlike the two readers above. Those sample a
//texture, where past the edge has to mean something; this is a distance to a
//point the user is pointing at. In BC_WRAP a shove near the edge does not
//reach around to the far side, because the cursor is not there.
vec2 get_shove(vec2 p){
    if(shove_strength == 0.0) return vec2(0);
    #define SHOVE_MULTIPLIER 8.0
    vec2 away = p - shove_center;
    float d = length(away);
    //Exactly on the cursor the direction is undefined. Contributing nothing is
    //also what keeps ATTRACT stable: the kernel peaks here, so without this
    //guard the strongest pull would be the one with no direction to pull in.
    if(d <= 0.0) return vec2(0);

    //Same gaussian the brush paints with, so the reticle shows the real reach
    //of both tools. No cutoff radius: a distant particle gets a denormal rather
    //than a branch, and every invocation pays for the exp() either way.
    float kernel = exp(-d * d / (2.0 * shove_size * shove_size));
    return SHOVE_MULTIPLIER*(away / d) * shove_strength * kernel;
}

//normalize vector that tolerates vec2(0)
vec2 safenorm(vec2 p){
    return length(p)==0?vec2(0):normalize(p);
}

//simply assigns each to a cohort based on its index.
//floor(get_cohort(index)) should be used for cohort equality tests
float get_cohort(uint index, ConfigData config) {
    return float(cfg_cohorts(config)) * float(index) / float(entities.length());
}

//Decide which ConfigData slot an entity uses. Phase 1 puts everyone on slot 0,
//which is behavior-identical to the old single-uniform setup. To split the
//population across configs, this is the one place to change: assign by index
//(cohort-style), by position, or however the feature calls for.
int assign_config_index(uint index){
    return 0;
}

//Where an entity starts, per the config's initial-conditions mode.
//
//PURE, and deliberately so: Cohort Fences needs to know where a particle's
//home is on every frame, and recomputing it here is cheaper than widening
//Entity to store it. Because both the fence and reset() call this, they can
//never disagree about where home is.
//
//Every mode starts from the same small per-cohort jitter, then places it.
//Grid and Ring are expressed in world extent rather than the reference's
//inline aspect fudge, so they stay correct on a non-square canvas.
vec2 initial_position(uint index, ConfigData config){
    float cohort_val = get_cohort(index, config);
    vec2 extent = world_half_extent_from_res(vec2(textureSize(canvas_texture, 0)));

    vec2 pos = .019*vec2(hash(vec2(cohort_val)),hash(vec2(cohort_val+index+2.142)));

    int mode = cfg_initial_conditions(config);
    int cohorts = max(1, cfg_cohorts(config));

    if(mode == IC_GRID){
        //One cell per cohort, laid out so the cells come out roughly SQUARE:
        //for n cohorts in a box of aspect a, that wants sqrt(n*a) columns.
        //(Using n*a rather than sqrt(n)*a is the difference between a grid and
        //a single wide strip on a wide canvas.)
        float cols = max(1.0, round(sqrt(float(cohorts) * extent.x/extent.y)));
        vec2 cells = vec2(cols, ceil(float(cohorts)/cols));
        vec2 cell = vec2(mod(floor(cohort_val),cols), floor(floor(cohort_val)/cols));
        pos += (cell + 0.5)/cells * 2.0*extent - extent;
    }
    else if(mode == IC_RANDOM){
        //scattered across the whole world
        pos = (vec2(hash(vec2(cohort_val,1.0)),hash(vec2(cohort_val,2.0)))*2.0-1.0)*extent;
    }
    else if(mode == IC_RING){
        float angle = cohort_val/float(cohorts) * 2.0*PI;
        pos += vec2(cos(angle),sin(angle)) * 0.5*min(extent.x,extent.y);
    }
    //IC_CENTER: the bare jitter, which is what this app did before the mode
    //was selectable. Kept as a real mode so that look stays reachable.

    return pos;
}

//Return all entities to their initialization state.
//
//NOTE: this writes the entity buffer ITSELF, so every caller must return
//immediately after -- a later `entities[index]=...` would clobber it.
void reset(uint index, ConfigData config){

    float size=index<entities.length()?.0015/world_sqrt_world_size(world): 0;
    float cohort_val = get_cohort(index, config);

    vec2 pos = initial_position(index, config);
    vec2 vel=0.00005*(vec2(hash(vec2(cohort_val,index)),hash(vec2(cohort_val,pos.y)))*2-1);

    //store to persistent entity buffer
    entities[index]=make_entity(pos,vel,size,assign_config_index(index));
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


// Gravity-like force expansion: maps a linear -1..1 slider (gravity_force /
// gravity_strafe) to a logarithmic physical force, so a small knob covers a
// wide range. Odd-symmetric, with a linear dead-zone near centre so it reaches
// exactly 0.
//
//   physical = sign(c) * MAXV * 10^(DECADES*(|c|-1))   for |c| > KNEE
//   physical = sign(c) * V_KNEE * (|c|/KNEE)           for |c| <= KNEE
//
// The two pieces meet at |c| == KNEE, so the curve is continuous there.
#define GRAVITY_MAXV    0.5   // physical value at |control| = 1
#define GRAVITY_DECADES 4.0   // log span: MAXV .. MAXV/10^DECADES
#define GRAVITY_KNEE    0.05  // |control| below this ramps linearly to 0
float gravity_expand(float c){
    float a = abs(c);
    float s = sign(c);
    float v_knee = GRAVITY_MAXV * pow(10.0, GRAVITY_DECADES*(GRAVITY_KNEE - 1.0));
    if (a <= GRAVITY_KNEE) {
        return s * v_knee * (a / GRAVITY_KNEE);
    }
    return s * GRAVITY_MAXV * pow(10.0, GRAVITY_DECADES*(a - 1.0));
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
//--color: raw signal kept for rendering only -- never fed back into the physics
void calculate_entity_behavior( vec2 L,vec2 R, vec2 axis, Rule rule, ConfigData config, out vec2 force, out vec2 strafe, out vec2 color){

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
    force = (forward * force.x * cfg_axial_force(config)) + (left * force.y * cfg_lateral_force(config));
    strafe = (forward * strafe.x * cfg_axial_force(config)) + (left * strafe.y * cfg_lateral_force(config));

    //An arbitrary function of the black box output, reusing the force terms.
    //NOT y_reflect'd, unlike force above: cancelling the mirror bias is what
    //keeps motion free of a clockwise preference, but colour WANTS that
    //asymmetry -- it is what makes the signal something other than a recoloured
    //copy of where the particle is already going.
    //
    //Stays in local coordinates. Nothing downstream treats it as a direction.
    color = baseterm.xy + mirrorterm.xy;

    return;
}

void main() {
    uint index = gl_GlobalInvocationID.x;
    if (index >= entities.length()) return;

    Entity e=entities[index];

    //Select this entity's config. On a reset frame the entity's stored
    //config_index is not yet meaningful (nothing has been written), so ask
    //assign_config_index() directly rather than reading it back.
    int config_index = frame_count==0 ? assign_config_index(index) : e_config_index(e);
    ConfigData config = configs[clamp(config_index, 0, world_config_count(world)-1)];

    float sqrt_world_size = world_sqrt_world_size(world);
    vec2 canvas_res = vec2(textureSize(canvas_texture, 0));

    float cohort = get_cohort(index, config);
    Rule rule = config.rule;
    //Hazard Rate == probability each frame to reset this particle
    bool hazard_reset = cfg_hazard_rate(config) > hash(vec2(float(index)/float(entities.length()),frame_count));

    //frame_count == 0 signals a simulation reset
    if (frame_count==0||hazard_reset){reset(index, config);return;}

    vec2 pos = e_pos(e);
    vec2 vel = e_vel(e);

    //Calculate position offsets for the two sensors.
    float sample_dist = 1./sqrt_world_size*.005 * cfg_sensor_distance(config);
    vec2 orientation = safenorm(vel);//vector facing the same direction as velocity, with length==sample_dist

    vec2 left_sensor_offset = orientation*sample_dist;
    vec2 right_sensor_offset = orientation*sample_dist;
    pR(left_sensor_offset,cfg_sensor_angle(config)*PI);//rotate them opposite directions
    pR(right_sensor_offset,-cfg_sensor_angle(config)*PI);

    //read the trails from canvas
    int bc = world_boundary_conditions(world);
    vec4 ltap = get_can(pos+left_sensor_offset, bc);
    vec4 rtap = get_can(pos+right_sensor_offset, bc);

    //if a few arbitrary coefficients are exactly 0, then assume target_rule is all 0s (no target) and generate a random rule instead.
    float rule_seed = cfg_mutation_seed(config)+floor(cohort);
    if(rule.centers[0].frequency==vec4(0) && rule.centers[5].amplitude==vec4(0)){
        //A GENERATED RULE IS ALREADY RANDOM, so it is NOT mutated on top.
        //The seed alone decides it, and rerolling the seed rerolls the whole
        //rule -- there is nothing for Mutation Scale to add that the seed does
        //not already do, and mutating here would mean Mutation Scale silently
        //changed a rule the user never authored.
        //
        //It also keeps the rule REPRODUCIBLE ON THE HOST. mutate_rule derives
        //its own seed by hashing the rule's coefficients, and hash() is
        //chaotic, so a 1-ULP difference in a generated coefficient (the GPU
        //fuses a multiply-add here that numpy cannot) would send the mutation
        //somewhere else entirely. Skipping it means particle selection can
        //reproduce exactly what a particle obeys -- see particle_system/mutation.py.
        rule = Rule(generate_random_centers(rule_seed));
    }
    else {
        //Each cohort gets a random mutation
        mutate_rule(rule,cfg_mutation_scale(config),rule_seed);
    }

    //rescale sensor values
    float sensor_scaling = sqrt_world_size*38.855*cfg_sensor_gain(config);
    ltap *= sensor_scaling;
    rtap *= sensor_scaling;

    //compute entity action
    vec2 strafe =vec2(0);//set by calculate_...
    vec2 force = vec2(0);//set by calculate_...
    vec2 col_params = vec2(0);//set by calculate_... -- rendering only
    calculate_entity_behavior(ltap.xy,rtap.xy,orientation,rule,config,force,strafe,col_params);

    //The particle's cohort, carried alongside the brain's signal so the
    //RENDERER can choose between them. This shader transmits both and decides
    //nothing: Color By Cohort is a display choice, and deciding it here would
    //mean the checkbox did nothing until the next physics step -- so it would
    //appear broken while paused, which is exactly when you want to compare.
    //
    //Sent raw. What a cohort index looks like as a colour is the renderer's
    //business (see cam_brush.frag).
    col_params.y = floor(cohort);

    //rescale output forces
    force *= 1./sqrt_world_size*cfg_global_force_mult(config)/400.;
    strafe *= 1./sqrt_world_size*cfg_global_force_mult(config)/20.;



    //Accelerate: Apply drag and add force to e.vel,
    vel = vel*cfg_drag(config) + force;

    //Uniform pull on the whole population, in the same two channels: _force
    //feeds velocity (after drag, so drag does not damp it away the same frame),
    //_strafe displaces position directly. Negated so a positive slider pulls
    //DOWN the screen. Scaled by 1/sqrt_world_size like every other force here,
    //so the feel survives a World Size change.
    vel.y += .01/sqrt_world_size * -gravity_expand(cfg_gravity_force(config));

    //Move: add vel and strafe to pos
    pos += vel;
    pos += strafe*cfg_strafe_power(config);
    pos.y += .01/sqrt_world_size * -gravity_expand(cfg_gravity_strafe(config));

    //The painted Strafe Field, in the strafe channel: a displacement, not a
    //force, so no rule can resist it and drag never damps it. Applied before
    //the fence and the boundary so containment still gets the last word --
    //you can paint a particle against a wall, not through it.
    //
    //Deliberately NOT scaled by 1/sqrt_world_size, unlike every force above
    //it. Those are tuned in world units and must shrink as the world grows;
    //this is painted in uv space and read in uv space, so it already tracks
    //canvas size. Dividing again would make an identical stroke weaker in a
    //bigger world for no reason the user could see.
    pos += STRAFE_FIELD_GAIN * get_strafe_field(pos, bc);

    //The Shove tool, in the same channel and for the same reasons: a
    //displacement, so drag cannot damp it and no rule can resist a direct push.
    //Also before the fence and the boundary, so containment still gets the last
    //word -- you can shove a particle against a wall, not through it.
    //
    //Already divided by the physics rate on the host, so holding the button for
    //one frame moves a particle the same distance at 30 sub-steps as at 120.
    //Without that, the Physics Rate slider would silently be a strength slider
    //too -- the trap the Draw brush's once-per-frame cadence exists to avoid.
    pos += get_shove(pos);

    //Cohort Fences: hold each particle near its own spawn point, so cohorts
    //stay legible instead of dispersing into each other. A soft wall -- it
    //pushes back in both motion channels rather than hard-clamping, so a
    //particle can still lean on the fence and be shaped by it.
    //Slider is 0=off .. 1=tightest; the radius mapping is here, not in the UI.
    float fences = cfg_cohort_fences(config);
    if(fences > 0.0){
        float radius = mix(0.5, 0.02, fences);
        vec2 to_home = initial_position(index, config) - pos;
        float excess = length(to_home) - radius;
        if(excess > 0.0){
            vec2 dir = safenorm(to_home);
            //#define HARD_FENCE 1
            #ifdef HARD_FENCE
            //Hard version: leaving the fence is fatal. Kept because it is a
            //genuinely different look, not because it is a fallback.
            reset(index, config);
            return;//reset writes the entity buffer itself
            #else
            vel += .001*excess*dir;   //force: accelerate toward home
            pos += .51*excess*dir;    //strafe: hop most of the way back
            #endif
        }
    }

    //Boundary conditions, applied last: after every force, both integrations,
    //and the fence. A world property, so it comes from WorldData.
    if(bc == BC_WRAP){
        pos = world_wrap(pos, canvas_res);
    }
    else if(bc == BC_BOUNCE){
        world_bounce(pos, vel, canvas_res);
    }
    else if(bc == BC_RESET){
        if(any(greaterThan(abs(pos), world_half_extent_from_res(canvas_res)))){
            reset(index, config);
            return;//reset writes the entity buffer itself
        }
    }

    //Commit new entity state to buffers
    entities[index]=make_entity(pos,vel,e_size(e),config_index,col_params);
}
