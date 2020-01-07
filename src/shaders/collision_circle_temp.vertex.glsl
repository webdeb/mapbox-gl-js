attribute vec2 a_pos;
attribute vec2 a_reserved;

uniform mat4 u_matrix;
uniform mat4 u_toWorld;
uniform mat4 u_fromWorld;
uniform vec2 u_viewport_size;

void main() {
    // 100 = hard-coded padding used in collision logic
    vec4 clipPos = u_matrix * vec4(a_pos - vec2(100), 0.0, 1.0);

    vec4 rayStart = u_toWorld * vec4(clipPos.xy / clipPos.w, -1.0, 1.0);
    vec4 rayEnd   = u_toWorld * vec4(clipPos.xy / clipPos.w,  1.0, 1.0);

    rayStart.xyz /= rayStart.w;
    rayEnd.xyz   /= rayEnd.w;

    float t = (0.0 - rayStart.z) / (rayEnd.z - rayStart.z);
    vec3 tilePos = mix(rayStart.xyz, rayEnd.xyz, t);

    clipPos = u_fromWorld * vec4(tilePos, 1.0);

    gl_Position = vec4(clipPos.xyz / clipPos.w, 1.0) + vec4(a_reserved / u_viewport_size * 2.0, 0.0, 0.0);
}
