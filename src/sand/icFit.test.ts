import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canvasDimensions, sizingFor } from '../particleSystem/sizing.ts';
import { wholeWorldBox, pixelRectFor } from '../stamp/stampBox.ts';
import {
  STAMP_PARTICLE_STRIDE,
  STAMP_TEXEL_CHANNELS,
  type StampData,
  type StampLayer,
} from '../stamp/stampData.ts';
import {
  GROWTH_MAX,
  MIN_FILL,
  TRAIL_CUSHION_PX,
  activeRegion,
  placeScene,
  planFit,
  trimScene,
} from './icFit.ts';

function layer(width: number, height: number): StampLayer {
  return { width, height, data: new Float32Array(width * height * STAMP_TEXEL_CHANNELS) };
}

/**
 * A whole-world scene of `w` x `h` canvas pixels, with particles at pixels.
 * Rows count up from the world's bottom, as the textures store them.
 */
function scene(w: number, h: number, particles: [number, number][]): StampData {
  const box = wholeWorldBox([w, h]);
  const bw = box.max[0] - box.min[0];
  const bh = box.max[1] - box.min[1];
  const bytes = new ArrayBuffer(particles.length * STAMP_PARTICLE_STRIDE);
  const view = new DataView(bytes);
  particles.forEach(([px, py], i) => {
    const at = i * STAMP_PARTICLE_STRIDE;
    view.setFloat32(at, box.min[0] + ((px + 0.5) / w) * bw, true);
    view.setFloat32(at + 4, box.min[1] + ((py + 0.5) / h) * bh, true);
    view.setFloat32(at + 8, 0.001, true); // vel.x
    view.setFloat32(at + 16, 0.002, true); // size
    view.setUint32(at + 20, 3, true); // config index, as int bits
  });
  return { box, particles: bytes, canvas: layer(w, h), field: layer(w / 2, h / 2), palette: [] };
}

test('the active region is the particles plus the trail cushion', () => {
  const region = activeRegion(scene(400, 300, [[100, 200], [150, 220]]));
  assert.deepEqual(region, {
    x0: 100 - TRAIL_CUSHION_PX,
    y0: 200 - TRAIL_CUSHION_PX,
    x1: 151 + TRAIL_CUSHION_PX,
    y1: 221 + TRAIL_CUSHION_PX,
  });
});

test('walls count toward the region', () => {
  const s = scene(400, 300, []);
  // A wall texel at field (10, 20) covers canvas pixels 20..22, 40..42.
  s.field.data[(20 * s.field.width + 10) * STAMP_TEXEL_CHANNELS] = 1;
  const region = activeRegion(s);
  assert.deepEqual(region, {
    x0: 20 - TRAIL_CUSHION_PX,
    y0: 40 - TRAIL_CUSHION_PX,
    x1: 22 + TRAIL_CUSHION_PX,
    y1: 42 + TRAIL_CUSHION_PX,
  });
});

test('an empty scene has no region', () => {
  assert.equal(activeRegion(scene(400, 300, [])), null);
});

test('a region that fits uses the target as it is', () => {
  const plan = planFit(100, 100, 1.5, 0.15);
  assert.equal(plan.step, 'fits');
  assert.equal(plan.worldSize, 0.15);
});

test('a larger region grows the world, keeping the screen shape', () => {
  const base = canvasDimensions(1.5, sizingFor(0.15)[1]);
  const plan = planFit(base[0] + 100, 50, 1.5, 0.15);
  assert.equal(plan.step, 'grown');
  assert.equal(plan.aspect, 1.5);
  assert.ok(plan.canvas[0] >= base[0] + 100);
  assert.ok(plan.worldSize <= 0.15 * GROWTH_MAX);
});

test('past the growth cap, the world reshapes within the fill limit', () => {
  const most = canvasDimensions(0.6, sizingFor(0.15 * GROWTH_MAX)[1]);
  // Wider than the largest portrait world, but short enough to trade height.
  const plan = planFit(most[0] + 40, 100, 0.6, 0.15);
  assert.equal(plan.step, 'letterboxed');
  assert.ok(plan.canvas[0] >= most[0] + 40 && plan.canvas[1] >= 100);
  assert.ok(Math.min(plan.aspect / 0.6, 0.6 / plan.aspect) >= MIN_FILL - 1e-9);
});

test('past the fill limit, it crops', () => {
  const plan = planFit(5000, 100, 0.6, 0.15);
  assert.equal(plan.step, 'cropped');
  assert.ok(Math.abs(plan.aspect - 0.6 / MIN_FILL) < 1e-9);
});

test('placement keeps pixel size and the ratio of the gaps', () => {
  // Region on the floor of a 400x300 scene (rows 0..50), 100px from the left
  // and 200px from the right.
  const s = scene(400, 300, [[120, 5], [180, 45]]);
  const region = { x0: 100, y0: 0, x1: 200, y1: 50 };
  const dst: [number, number] = [700, 500];
  const { stamp, cropped } = placeScene(s, region, dst);
  assert.equal(cropped, false);

  const rect = pixelRectFor(stamp.box, dst);
  assert.equal(rect.width, 100, 'pixel for pixel');
  assert.equal(rect.height, 50);
  // Left:right gap 100:200 of the 600 free pixels -> 200 from the left.
  assert.equal(rect.x, 200);
  // Touching the floor stays on the floor.
  assert.equal(rect.y, 0);
  assert.equal(stamp.canvas.width, 100);
  assert.equal(stamp.canvas.height, 50);
});

test('placed particles keep their pixel offset from the placed layers', () => {
  // The particle and the layers must agree about where the region went: a
  // particle 25 rows up a region must land 25 rows up its placed rect.
  const s = scene(400, 300, [[150, 225]]);
  const region = { x0: 100, y0: 200, x1: 200, y1: 250 };
  const dst: [number, number] = [800, 600];
  const { stamp } = placeScene(s, region, dst);
  const view = new DataView(stamp.particles);
  const box = wholeWorldBox(dst);
  const px = ((view.getFloat32(0, true) - box.min[0]) / (box.max[0] - box.min[0])) * 800;
  const py = ((view.getFloat32(4, true) - box.min[1]) / (box.max[1] - box.min[1])) * 600;
  const rect = pixelRectFor(stamp.box, dst);
  assert.ok(Math.abs(px - (rect.x + 50.5)) < 1e-3, `landed at x ${px}`);
  assert.ok(Math.abs(py - (rect.y + 25.5)) < 1e-3, `landed at row ${py}`);
});

test('placed particles convert velocity and size to the new world units', () => {
  const s = scene(400, 300, [[150, 225]]);
  const region = { x0: 100, y0: 200, x1: 200, y1: 250 };
  const { stamp } = placeScene(s, region, [800, 600]);
  const view = new DataView(stamp.particles);
  // 800 px over the same world width as 400 px: half the world units per px.
  assert.ok(Math.abs(view.getFloat32(8, true) - 0.0005) < 1e-9);
  assert.ok(Math.abs(view.getFloat32(16, true) - 0.001) < 1e-9);
  assert.equal(view.getUint32(20, true), 3, 'the config index survives bit for bit');
});

test('a trimmed scene, placed with its frame, places exactly as the untrimmed one', () => {
  const s = scene(400, 300, [[120, 30], [180, 60]]);
  s.canvas.data[(40 * 400 + 150) * STAMP_TEXEL_CHANNELS] = 0.5; // a trail texel
  s.field.data[(10 * s.field.width + 70) * STAMP_TEXEL_CHANNELS] = 1; // a wall
  const trimmed = trimScene(s);
  assert.ok(trimmed !== null);
  assert.ok(trimmed.stamp.canvas.width < 400, 'the saved scene is smaller');

  const whole = activeRegion(s);
  const fromTrim = activeRegion(trimmed.stamp, trimmed.frame);
  assert.deepEqual(fromTrim, whole, 'the same region, in the same frame');

  const dst: [number, number] = [640, 480];
  const a = placeScene(s, whole!, dst);
  const b = placeScene(trimmed.stamp, fromTrim!, dst, trimmed.frame);
  assert.deepEqual(pixelRectFor(b.stamp.box, dst), pixelRectFor(a.stamp.box, dst));
  assert.deepEqual([...b.stamp.canvas.data], [...a.stamp.canvas.data], 'trails identical');
  assert.deepEqual(
    [...new Float32Array(b.stamp.particles)],
    [...new Float32Array(a.stamp.particles)],
    'particles identical',
  );
});

test('a trimmed scene with no frame would touch every edge -- the frame is what keeps its place', () => {
  const s = scene(400, 300, [[300, 250]]);
  const trimmed = trimScene(s)!;
  const withFrame = activeRegion(trimmed.stamp, trimmed.frame)!;
  assert.ok(withFrame.x0 > 0 && withFrame.y0 > 0, 'placed away from the origin');
  const without = activeRegion(trimmed.stamp)!;
  assert.equal(without.x0, 0);
});

test('a crop keeps the side that touches the world edge', () => {
  const s = scene(400, 300, [[5, 150], [395, 150]]);
  const region = { x0: 0, y0: 100, x1: 300, y1: 200 };
  const { stamp, cropped } = placeScene(s, region, [120, 400]);
  assert.equal(cropped, true);
  assert.equal(stamp.canvas.width, 120);
  // Touching the left edge only, so the left part is kept: the particle at
  // x=5 survives and the one at 395 (outside the region anyway) does not.
  assert.equal(stamp.particles.byteLength / STAMP_PARTICLE_STRIDE, 1);
});
