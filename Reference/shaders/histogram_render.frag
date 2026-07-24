#version 430

in vec2 texcoord;
out vec4 fragColor;

layout(std430, binding = 5) buffer ReportsBuffer {
    uvec4 reports[];
};

uniform uint accumulated_report_steps;
uniform uint bucket_count;
uniform vec4 height_scale;
uniform vec4 height_min;
uniform vec4 height_max;
uniform ivec4 axis_mode; // 0=Linear, 1=Log, 2=Log-Log

void main() {
    // Determine which channel (0-3) from vertical position
    // Channel 0 at top, channel 3 at bottom
    float y_flipped = 1.0 - texcoord.y;
    int channel = int(y_flipped * 4.0);
    channel = clamp(channel, 0, 3);

    // Local Y within this channel's band [0,1], 0=bottom 1=top
    float local_y = fract(y_flipped * 4.0);

    // Determine which bucket from horizontal position
    uint bucket = uint(texcoord.x * float(bucket_count));
    bucket = min(bucket, bucket_count - 1u);

    // Read raw count and promote to float
    float raw_count = float(reports[bucket][channel]);

    // Normalize by accumulated steps to get average per entity_update
    float avg = (accumulated_report_steps > 0u)
        ? raw_count / float(accumulated_report_steps)
        : 0.0;

    // Apply height_min / height_max windowing
    float lo = height_min[channel];
    float hi = height_max[channel];
    float bar_height;

    int mode = axis_mode[channel];

    if (mode == 0) {
        // Linear
        bar_height = (hi > lo) ? (avg - lo) / (hi - lo) : 0.0;
    } else if (mode == 1) {
        // Log (log Y axis, linear X buckets)
        float log_avg = (avg > 0.0) ? log(avg + 1.0) : 0.0;
        float log_lo = (lo > 0.0) ? log(lo + 1.0) : 0.0;
        float log_hi = (hi > 0.0) ? log(hi + 1.0) : 0.0;
        bar_height = (log_hi > log_lo) ? (log_avg - log_lo) / (log_hi - log_lo) : 0.0;
    } else {
        // Log-Log (log Y axis, log X — but X is bucket index, so just stronger log on Y)
        float log_avg = (avg > 0.0) ? log(log(avg + 1.0) + 1.0) : 0.0;
        float log_lo = (lo > 0.0) ? log(log(lo + 1.0) + 1.0) : 0.0;
        float log_hi = (hi > 0.0) ? log(log(hi + 1.0) + 1.0) : 0.0;
        bar_height = (log_hi > log_lo) ? (log_avg - log_lo) / (log_hi - log_lo) : 0.0;
    }

    // Apply height_scale
    bar_height *= height_scale[channel];
    bar_height = clamp(bar_height, 0.0, 1.0);

    // Draw white bar if local_y is below bar height, else black
    float brightness = (local_y <= bar_height) ? 1.0 : 0.0;
    fragColor = vec4(brightness, brightness, brightness, 1.0);
}
