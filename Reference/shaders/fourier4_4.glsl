// Fourier Feature Network: 4D input -> 4D output
struct FourierCenter {
    vec4 frequency;  // 4D frequency vector
    vec4 amplitude;  // 4D amplitude/weight vector
};


// Fourier basis evaluation
vec4 fourier_noise(FourierCenter[10] centers, vec4 pos) {
    vec4 result = vec4(0.0);

    for(int i = 0; i < 10; i++) {
        // Compute phase from dot product of input with frequency vector
        float phase = dot(pos, centers[i].frequency);

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
