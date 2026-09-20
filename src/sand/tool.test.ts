import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRUSH_ERASE,
  BRUSH_SPAWN,
  TOOLS,
  actionFor,
  isFieldTool,
  supportsLineTool,
  usesStrength,
  usesSwatch,
} from './tool.ts';

// ---------------------------------------------------------------------------
// WHICH TOOLS TOUCH PARTICLES -- the rule behind "right-click erased under
// every tool".
//
// `actionFor` is the ONLY thing that decides whether a frame produces a
// particle command, so these are the whole contract. The bug it fixes was a
// default branch returning the pressed button unchanged for the field tools,
// which `passes.kill` then honoured: a right-drag with Walls or Shove armed
// deleted particles under the stroke while the user was drawing a wall.
// ---------------------------------------------------------------------------

test('no tool but Brush and Erase produces a particle command', () => {
  for (const tool of TOOLS) {
    if (tool === 'brush' || tool === 'erase') continue;
    assert.equal(actionFor(tool, BRUSH_SPAWN), null, `${tool} on left`);
    assert.equal(actionFor(tool, BRUSH_ERASE), null, `${tool} on right`);
  }
});

test('Brush spawns on left and erases on right', () => {
  assert.equal(actionFor('brush', BRUSH_SPAWN), BRUSH_SPAWN);
  assert.equal(actionFor('brush', BRUSH_ERASE), BRUSH_ERASE);
});

// The right button is the SUCK gesture, not an inverse that spawns -- see
// `actionFor`. An eraser that deposited particles from whatever swatch was
// selected is not something a user reaching for it ever means.
test('Erase erases on BOTH buttons', () => {
  assert.equal(actionFor('erase', BRUSH_SPAWN), BRUSH_ERASE);
  assert.equal(actionFor('erase', BRUSH_ERASE), BRUSH_ERASE);
});

test('no button pressed is no command, whatever is armed', () => {
  for (const tool of TOOLS) assert.equal(actionFor(tool, null), null, tool);
});

// ---------------------------------------------------------------------------
// The tool predicates
// ---------------------------------------------------------------------------

// Erase joins the field tools here because it erases WALLS as well as
// particles, and a straight run of wall is exactly what a line tool is for.
test('the line tool covers the field tools and Erase', () => {
  assert.equal(supportsLineTool('walls'), true);
  assert.equal(supportsLineTool('trails'), true);
  assert.equal(supportsLineTool('erase'), true);
  assert.equal(supportsLineTool('brush'), false);
  assert.equal(supportsLineTool('shove'), false);
});

// Erase has no gain term to scale -- the particle half is a hard radius kill
// and the wall half takes the default draw power. The UI greys the field out,
// so nothing may quietly read it.
test('Erase has no Strength', () => {
  assert.equal(usesStrength('erase'), false);
  for (const tool of TOOLS) {
    if (tool === 'erase') continue;
    assert.equal(usesStrength(tool), true, tool);
  }
});

test('only Brush reads the swatch', () => {
  assert.equal(usesSwatch('brush'), true);
  for (const tool of TOOLS) {
    if (tool === 'brush') continue;
    assert.equal(usesSwatch(tool), false, tool);
  }
});

// `isFieldTool` still means "paints a layer from the rail". Erase writes the
// wall layer too, but only ever subtracts, so it is deliberately NOT one of
// these -- `paintField` handles it as its own case.
test('isFieldTool is walls and trails only', () => {
  assert.equal(isFieldTool('walls'), true);
  assert.equal(isFieldTool('trails'), true);
  assert.equal(isFieldTool('erase'), false);
  assert.equal(isFieldTool('brush'), false);
  assert.equal(isFieldTool('shove'), false);
});
