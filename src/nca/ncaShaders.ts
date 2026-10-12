/**
 * WGSL for the NCA, GENERATED per architecture.
 *
 * Why generated rather than a `.wgsl` file with `override` constants: the
 * step kernel keeps its perception features and its output in function-scope
 * arrays, and WGSL sizes those only with CONST expressions -- an `override`
 * cannot size them. So the architecture is baked into a prelude of `const`s and
 * a change of architecture recompiles (cheap: these are small shaders).
 *
 * A PURE LEAF: string building only, no GPU and no `.wgsl` import, so tests can
 * inspect the source under `node --test`. Everything here implements
 * `cpuStep.ts` -- that file is the spec; keep the two in step.
 *
 * ## Conventions
 *
 *  - State: `array<f32>`, `state[(y * W + x) * C + c]`, grid y DOWN.
 *  - The display texture is written FLIPPED (row `H - 1 - y`), because world +y
 *    is up and uv v grows with world y (see `coords.ts`): cell (x, y) is drawn
 *    at uv `((x + .5) / W, 1 - (y + .5) / H)`. The brush and the host pick use
 *    the same mapping (`gridUv.ts`).
 */

import { MAX_SEED_RADIUS, TANH_CLAMP, UNBOUNDED_LIMIT } from './cpuStep.ts';
import { type NcaArch, PERCEPTION, archOf } from './ncaConfig.ts';
import { paramLayout } from './paramLayout.ts';
import { SALT } from './rng.ts';

export const WORKGROUP = 8;

/**
 * The one uniform struct every NCA pass reads. 9 x vec4 = 144 bytes, written
 * into 256-byte slots selected by dynamic offset (slot 0: the frame's init /
 * display; then one per brush stroke; then one per step).
 */
export const PARAMS_SIZE = 144;

export const PARAMS_STRUCT = /* wgsl */ `
struct Params {
    grid  : vec4u,  // x W   y H   z cohorts   w step counter
    flags : vec4u,  // x fences   y wrap   z seed   w alive mask
    modes : vec4u,  // x activation   y state bound   z ic mode   w highlighted cohort + 1 (0 = none)
    dyn   : vec4f,  // x dt   y fire rate   z gain   w leak
    dyn2  : vec4f,  // x noise   y alive threshold   z ic amplitude   w ic density
    disp  : vec4f,  // x seed radius   y display gain   z display mode   w display channel
    brushA: vec4f,  // xy segment start (uv)   zw segment end (uv)
    brushB: vec4f,  // x radius (aspect-corrected uv)   y paint value   z brush mode   w show borders
    scroll: vec4f,  // xy view scroll, grid cells per step (grid y down)   z steps since the frame's base offset
}
`;

/**
 * ROLLING TORI: the view of each cohort rectangle scrolls at a constant
 * velocity, so a soliton moving at that velocity stands still on screen. A
 * VIEW transform only -- the simulation never moves.
 *
 * `scroll_base[k]` is cohort k's accumulated offset at the start of the frame,
 * already wrapped to its rectangle on the host (exact, however long the run);
 * `u.scroll.xy * u.scroll.z` adds the sub-steps taken since, so motion-blur
 * samples between steps see their own step's offset. Rounded to whole cells:
 * the picture shifts by cells, it is never resampled.
 *
 * Display cell `d` (local to the rectangle) shows state cell
 * `wrap(d + shift)`; the brush inverts it.
 */
const SCROLL = /* wgsl */ `
fn wrapi2(a: vec2i, m: vec2i) -> vec2i { return ((a % m) + m) % m; }
fn scroll_shift(k: u32) -> vec2i {
    return vec2i(floor(scroll_base[k] + u.scroll.xy * u.scroll.z + 0.5));
}
`;

const HASH = /* wgsl */ `
fn pcg_hash(seed: u32) -> u32 {
    let state = seed * 747796405u + 2891336453u;
    let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}
fn hash3(a: u32, b: u32, c: u32) -> u32 {
    return pcg_hash(a ^ pcg_hash(b ^ pcg_hash(c)));
}
fn unit(h: u32) -> f32 {
    return min(f32(h) / 4294967296.0, 0.99999994);
}
`;

const GRID = /* wgsl */ `
fn wrapi(a: i32, m: i32) -> i32 { return ((a % m) + m) % m; }

// The cell a neighbour offset reaches, or -1 for "outside, reads zero".
// Mirrors cohortLayout.ts's neighbourIndex.
fn neighbour(x: i32, y: i32, dx: i32, dy: i32, rect: vec4i) -> i32 {
    let W = i32(u.grid.x);
    let H = i32(u.grid.y);
    if (u.flags.x != 0u) {
        let nx = rect.x + wrapi(x - rect.x + dx, rect.z);
        let ny = rect.y + wrapi(y - rect.y + dy, rect.w);
        return ny * W + nx;
    }
    let nx = x + dx;
    let ny = y + dy;
    if (u.flags.y != 0u) { return wrapi(ny, H) * W + wrapi(nx, W); }
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) { return -1; }
    return ny * W + nx;
}
`;

/** The architecture constants every kernel shares. */
export function archPrelude(arch: NcaArch): string {
  const a = archOf(arch);
  const L = paramLayout(a);
  const off = (name: string): number => L.tensors.find((t) => t.name === name)?.offset ?? 0;
  return [
    `const C: u32 = ${L.channels}u;`,
    `const HID: u32 = ${L.hidden}u;`,
    `const NK: u32 = ${L.kinds.length}u;`,
    `const P: u32 = ${L.features}u;`,
    `const STRIDE: u32 = ${L.count}u;`,
    `const LEARNED: bool = ${a.perception === PERCEPTION.LEARNED};`,
    `const LAPLACIAN: bool = ${a.perception === PERCEPTION.FIXED && a.laplacian};`,
    `const OFF_PERC: u32 = ${off('perc')}u;`,
    `const OFF_W0: u32 = ${L.hidden > 0 ? off('fc0.w') : off('fc.w')}u;`,
    `const OFF_B0: u32 = ${L.hidden > 0 ? off('fc0.b') : off('fc.b')}u;`,
    `const OFF_W1: u32 = ${off('fc1.w')}u;`,
    `const OFF_B1: u32 = ${off('fc1.b')}u;`,
    `const ALIVE_CH: u32 = ${Math.min(3, L.channels - 1)}u;`,
    `const SALT_FIRE: u32 = ${SALT.fire}u;`,
    `const SALT_NOISE: u32 = ${SALT.noise}u;`,
    `const SALT_IC: u32 = ${SALT.ic}u;`,
    `const SALT_SPARSE: u32 = ${SALT.icSparse}u;`,
    `const MAX_SEED_RADIUS: i32 = ${MAX_SEED_RADIUS};`,
    `const TANH_CLAMP: f32 = ${TANH_CLAMP.toFixed(1)};`,
    `const UNBOUNDED: f32 = ${UNBOUNDED_LIMIT.toFixed(1)};`,
  ].join('\n');
}

/** The step kernel: perception, MLP, stochastic residual update. */
export function stepShader(arch: NcaArch): string {
  return /* wgsl */ `
${archPrelude(arch)}
${PARAMS_STRUCT}
@group(0) @binding(0) var<uniform> u : Params;
@group(0) @binding(1) var<storage, read> src : array<f32>;
@group(0) @binding(2) var<storage, read_write> dst : array<f32>;
@group(0) @binding(3) var<storage, read> weights : array<f32>;
@group(0) @binding(4) var<storage, read> cmap : array<u32>;
@group(0) @binding(5) var<storage, read> rects : array<vec4u>;
@group(0) @binding(6) var<storage, read> walls : array<u32>;
${HASH}
${GRID}
fn load_state(n: i32, c: u32) -> f32 {
    if (n < 0) { return 0.0; }
    return src[u32(n) * C + c];
}

fn act(x: f32) -> f32 {
    switch (u.modes.x) {
        case 1u: { return tanh(clamp(x, -TANH_CLAMP, TANH_CLAMP)); }
        case 2u: { return sin(x); }
        default: { return max(x, 0.0); }
    }
}

fn bound(v: f32) -> f32 {
    if (v != v) { return 0.0; } // NaN
    switch (u.modes.y) {
        case 1u: { return clamp(v, -1.0, 1.0); }
        case 2u: { return clamp(v, 0.0, 1.0); }
        case 3u: { return tanh(clamp(v, -TANH_CLAMP, TANH_CLAMP)); }
        default: { return clamp(v, -UNBOUNDED, UNBOUNDED); }
    }
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let W = u.grid.x;
    let H = u.grid.y;
    if (gid.x >= W || gid.y >= H) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let idx = gid.y * W + gid.x;

    if (walls[idx] != 0u) {
        for (var c = 0u; c < C; c++) { dst[idx * C + c] = 0.0; }
        return;
    }

    let k = cmap[idx];
    let rect = vec4i(rects[k]);
    let wb = k * STRIDE;

    var nb: array<i32, 9>;
    for (var t = 0; t < 9; t++) {
        nb[t] = neighbour(x, y, t % 3 - 1, t / 3 - 1, rect);
    }

    // --- perception: feature f = kind * C + c ---
    var feats: array<f32, P>;
    var taps: array<f32, 9>;
    for (var c = 0u; c < C; c++) {
        for (var t = 0; t < 9; t++) { taps[t] = load_state(nb[t], c); }
        feats[c] = taps[4];
        if (LEARNED) {
            for (var kk = 0u; kk < NK - 1u; kk++) {
                let base = wb + OFF_PERC + (kk * C + c) * 9u;
                var v = 0.0;
                for (var t = 0u; t < 9u; t++) { v += weights[base + t] * taps[t]; }
                feats[(kk + 1u) * C + c] = v;
            }
        } else {
            feats[C + c] = (taps[2] + 2.0 * taps[5] + taps[8] - taps[0] - 2.0 * taps[3] - taps[6]) / 8.0;
            feats[2u * C + c] = (taps[6] + 2.0 * taps[7] + taps[8] - taps[0] - 2.0 * taps[1] - taps[2]) / 8.0;
            if (LAPLACIAN) {
                feats[3u * C + c] = (taps[0] + 2.0 * taps[1] + taps[2] + 2.0 * taps[3] - 12.0 * taps[4]
                                   + 2.0 * taps[5] + taps[6] + 2.0 * taps[7] + taps[8]) / 16.0;
            }
        }
    }

    // --- update network ---
    var delta: array<f32, C>;
    let gain = u.dyn.z;
    if (HID > 0u) {
        for (var h = 0u; h < HID; h++) {
            var acc = weights[wb + OFF_B0 + h];
            let row = wb + OFF_W0 + h * P;
            for (var f = 0u; f < P; f++) { acc += weights[row + f] * feats[f]; }
            let a = act(gain * acc);
            for (var c = 0u; c < C; c++) { delta[c] += weights[wb + OFF_W1 + c * HID + h] * a; }
        }
        for (var c = 0u; c < C; c++) { delta[c] += weights[wb + OFF_B1 + c]; }
    } else {
        for (var c = 0u; c < C; c++) {
            var acc = weights[wb + OFF_B0 + c];
            let row = wb + OFF_W0 + c * P;
            for (var f = 0u; f < P; f++) { acc += weights[row + f] * feats[f]; }
            delta[c] = act(gain * acc);
        }
    }

    // --- stochastic residual update ---
    let stepn = u.grid.w;
    let seed = u.flags.z;
    let fire = unit(hash3(idx, stepn, seed ^ SALT_FIRE)) < u.dyn.y;

    var alive = true;
    if (u.flags.w != 0u) {
        var m = -3.0e38;
        for (var t = 0; t < 9; t++) { m = max(m, load_state(nb[t], ALIVE_CH)); }
        alive = m > u.dyn2.y;
    }

    for (var c = 0u; c < C; c++) {
        var v = src[idx * C + c];
        if (fire) { v += u.dyn.x * delta[c]; }
        v *= 1.0 - u.dyn.w;
        if (u.dyn2.x != 0.0) {
            let r = unit(hash3(idx * C + c, stepn, seed ^ SALT_NOISE));
            v += u.dyn2.x * (2.0 * r - 1.0);
        }
        v = bound(v);
        dst[idx * C + c] = select(0.0, v, alive);
    }
}
`;
}

/** Initial conditions into `dst`. Mirrors `cpuInit`. */
export function initShader(arch: NcaArch): string {
  return /* wgsl */ `
${archPrelude(arch)}
${PARAMS_STRUCT}
@group(0) @binding(0) var<uniform> u : Params;
@group(0) @binding(1) var<storage, read> src : array<f32>;
@group(0) @binding(2) var<storage, read_write> dst : array<f32>;
@group(0) @binding(3) var<storage, read> weights : array<f32>;
@group(0) @binding(4) var<storage, read> cmap : array<u32>;
@group(0) @binding(5) var<storage, read> rects : array<vec4u>;
@group(0) @binding(6) var<storage, read> walls : array<u32>;
${HASH}
${GRID}
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let W = u.grid.x;
    let H = u.grid.y;
    if (gid.x >= W || gid.y >= H) { return; }
    let x = i32(gid.x);
    let y = i32(gid.y);
    let idx = gid.y * W + gid.x;
    for (var c = 0u; c < C; c++) { dst[idx * C + c] = 0.0; }
    if (walls[idx] != 0u) { return; }

    let seed = u.flags.z;
    let amp = u.dyn2.z;
    let r = clamp(i32(round(u.disp.x)), 0, MAX_SEED_RADIUS);
    let r2 = r * r;
    let rect = vec4i(rects[cmap[idx]]);
    var lit = false;
    switch (u.modes.z) {
        case 0u: {
            let cx = rect.x + rect.z / 2;
            let cy = rect.y + rect.w / 2;
            lit = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2;
        }
        case 1u: {
            for (var c = 0u; c < C; c++) {
                let h = unit(hash3(idx * C + c, 0u, seed ^ SALT_IC));
                dst[idx * C + c] = amp * (2.0 * h - 1.0);
            }
        }
        case 2u: {
            for (var dy = -r; dy <= r; dy++) {
                for (var dx = -r; dx <= r; dx++) {
                    if (dx * dx + dy * dy > r2) { continue; }
                    let n = neighbour(x, y, dx, dy, rect);
                    if (n < 0) { continue; }
                    if (unit(hash3(u32(n), 0u, seed ^ SALT_SPARSE)) < u.dyn2.w) { lit = true; }
                }
            }
        }
        default: {}
    }
    if (lit) {
        for (var c = 0u; c < C; c++) { dst[idx * C + c] = amp; }
    }
}
`;
}

/** Brush modes: what a stroke does to the cells under it. */
export const BRUSH = { ERASE: 0, PAINT: 1, WALL: 2, UNWALL: 3 } as const;

/** One brush stroke segment, in place on the current state. */
export function brushShader(arch: NcaArch): string {
  return /* wgsl */ `
${archPrelude(arch)}
${PARAMS_STRUCT}
@group(0) @binding(0) var<uniform> u : Params;
@group(0) @binding(1) var<storage, read_write> state : array<f32>;
@group(0) @binding(2) var<storage, read_write> walls : array<u32>;
@group(0) @binding(3) var<storage, read> cmap : array<u32>;
@group(0) @binding(4) var<storage, read> rects : array<vec4u>;
@group(0) @binding(5) var<storage, read> scroll_base : array<vec2f>;
${SCROLL}

// Distance from p to segment ab, in the ASPECT-CORRECTED uv metric the reticle
// is drawn in (uv delta * world half extent), so the brush matches the ring.
fn seg_dist(p: vec2f, a: vec2f, b: vec2f, ext: vec2f) -> f32 {
    let pa = (p - a) * ext;
    let ba = (b - a) * ext;
    let len2 = dot(ba, ba);
    let h = select(0.0, clamp(dot(pa, ba) / len2, 0.0, 1.0), len2 > 0.0);
    return length(pa - ba * h);
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let W = u.grid.x;
    let H = u.grid.y;
    if (gid.x >= W || gid.y >= H) { return; }
    let idx = gid.y * W + gid.x;
    // Where this cell is DRAWN under the rolling-tori scroll, so the brush
    // lands on the cell under the cursor.
    let k = cmap[idx];
    let rect = vec4i(rects[k]);
    let shown = rect.xy + wrapi2(vec2i(gid.xy) - rect.xy - scroll_shift(k), rect.zw);
    let uv = vec2f((f32(shown.x) + 0.5) / f32(W), 1.0 - (f32(shown.y) + 0.5) / f32(H));
    let s = sqrt(f32(W) / f32(H));
    let ext = vec2f(s, 1.0 / s);
    if (seg_dist(uv, u.brushA.xy, u.brushA.zw, ext) > u.brushB.x) { return; }

    let mode = u32(u.brushB.z);
    switch (mode) {
        case 1u: {
            if (walls[idx] == 0u) {
                for (var c = 0u; c < C; c++) { state[idx * C + c] = u.brushB.y; }
            }
        }
        case 2u: {
            walls[idx] = 1u;
            for (var c = 0u; c < C; c++) { state[idx * C + c] = 0.0; }
        }
        case 3u: { walls[idx] = 0u; }
        default: {
            for (var c = 0u; c < C; c++) { state[idx * C + c] = 0.0; }
        }
    }
}
`;
}

/** State -> the rgba16float texture the camera samples. */
export function displayShader(arch: NcaArch): string {
  return /* wgsl */ `
${archPrelude(arch)}
${PARAMS_STRUCT}
@group(0) @binding(0) var<uniform> u : Params;
@group(0) @binding(1) var<storage, read> state : array<f32>;
@group(0) @binding(2) var<storage, read> cmap : array<u32>;
@group(0) @binding(3) var<storage, read> rects : array<vec4u>;
@group(0) @binding(4) var<storage, read> walls : array<u32>;
@group(0) @binding(5) var out_tex : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<storage, read> scroll_base : array<vec2f>;
${SCROLL}

fn ch(idx: u32, c: u32) -> f32 {
    if (c >= C) { return 0.0; }
    return state[idx * C + c];
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let W = u.grid.x;
    let H = u.grid.y;
    if (gid.x >= W || gid.y >= H) { return; }
    // The rectangle is the DISPLAY position's; the state shown comes from the
    // scrolled cell inside it (rolling tori).
    let k = cmap[gid.y * W + gid.x];
    let rect = vec4i(rects[k]);
    let src = rect.xy + wrapi2(vec2i(gid.xy) - rect.xy + scroll_shift(k), rect.zw);
    let idx = u32(src.y) * W + u32(src.x);
    let c0 = u32(u.disp.w);
    let gain = u.disp.y;
    let v = vec4f(ch(idx, c0), ch(idx, c0 + 1u), ch(idx, c0 + 2u), ch(idx, c0 + 3u));

    var col: vec3f;
    switch (u32(u.disp.z)) {
        case 1u: {
            // The classic Growing-NCA look: premultiplied RGBA on white.
            let a = clamp(v.w * gain, 0.0, 1.0);
            col = 1.0 - a + clamp(v.xyz * gain, vec3f(0.0), vec3f(1.0));
        }
        case 2u: {
            col = clamp(0.5 + 0.5 * gain * v.xyz, vec3f(0.0), vec3f(1.0));
        }
        case 3u: {
            let s = gain * v.x;
            col = select(-s * vec3f(0.15, 0.5, 1.0), s * vec3f(1.0, 0.55, 0.15), s > 0.0);
        }
        default: {
            col = max(v.xyz * gain, vec3f(0.0));
        }
    }

    if (walls[idx] != 0u) { col = vec3f(0.32, 0.27, 0.22); }

    if (u.modes.w != 0u && k + 1u != u.modes.w) { col *= 0.3; }

    if (u.brushB.w != 0.0 && u.grid.z > 1u) {
        let g = vec2i(gid.xy);
        let edge = (g.x == rect.x && rect.x > 0) || (g.y == rect.y && rect.y > 0);
        if (edge) { col = col * 0.35 + vec3f(0.08); }
    }

    textureStore(out_tex, vec2u(gid.x, H - 1u - gid.y), vec4f(col, 1.0));
}
`;
}
