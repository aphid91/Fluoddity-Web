import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRUSH_ERASE,
  BRUSH_SPAWN,
  DEFAULT_ERASE_MODE,
  ERASE_MODES,
  type SandTool,
  TOOLS,
  actionFor,
  asEraseMode,
  cycleTool,
  erasesParticles,
  erasesWalls,
  nextEraseMode,
  isFieldTool,
  supportsLineTool,
  usesStrength,
  usesSwatch,
} from './tool.ts';

// ---------------------------------------------------------------------------
// Shift-scroll cycling along the rail
// ---------------------------------------------------------------------------

test('cycleTool steps along the rail in both directions', () => {
  const [first, second] = TOOLS;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(cycleTool(first, 1), second);
  assert.equal(cycleTool(second, -1), first);
});

test('cycleTool wraps at both ends', () => {
  const first = TOOLS[0];
  const last = TOOLS[TOOLS.length - 1];
  assert.ok(first !== undefined && last !== undefined);
  assert.equal(cycleTool(last, 1), first, 'past the last tool');
  assert.equal(cycleTool(first, -1), last, 'back past the first');
});

// STAMP IS IN THE CYCLE although `isImplemented` says it does nothing. The
// button is visible and clickable, so a scroll that jumped over it would be the
// odd one out -- see `cycleTool`.
test('cycleTool includes every tool the rail shows, Stamp included', () => {
  const seen = new Set<string>();
  // Annotated, not inferred: `TOOLS[0]` narrows to the literal `'brush'`, and
  // the loop reassigns it to every other tool in the rail.
  let tool: SandTool | undefined = TOOLS[0];
  assert.ok(tool !== undefined);
  for (let i = 0; i < TOOLS.length; i++) {
    seen.add(tool);
    tool = cycleTool(tool, 1);
  }
  assert.equal(seen.size, TOOLS.length, 'every tool reached');
  assert.ok(seen.has('stamp'), 'Stamp is not skipped');
});

// A full lap returns to where it started, which is what makes the cycle a cycle.
test('cycleTool returns to the start after a full lap', () => {
  for (const tool of TOOLS) {
    assert.equal(cycleTool(tool, TOOLS.length), tool, `${tool} round trip`);
    assert.equal(cycleTool(tool, -TOOLS.length), tool, `${tool} reverse lap`);
  }
});

// A stored session from a build whose rail listed something else must rejoin
// the cycle rather than freezing the scroll.
test('cycleTool rejoins the rail from a tool it does not list', () => {
  // `trails` is a real SandTool but is not in TOOLS -- exactly the case.
  assert.equal(cycleTool('trails', 1), TOOLS[0]);
});

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

// ---------------------------------------------------------------------------
// The eraser's Mode
// ---------------------------------------------------------------------------

test('nextEraseMode cycles through every mode and back', () => {
  let mode = DEFAULT_ERASE_MODE;
  const seen = new Set<string>();
  for (let i = 0; i < ERASE_MODES.length; i++) {
    seen.add(mode);
    mode = nextEraseMode(mode);
  }
  assert.equal(seen.size, ERASE_MODES.length);
  assert.equal(mode, DEFAULT_ERASE_MODE);
});

test('each erase mode takes what its name says', () => {
  assert.ok(erasesWalls('walls+particles') && erasesParticles('walls+particles'));
  assert.ok(erasesWalls('walls') && !erasesParticles('walls'));
  assert.ok(!erasesWalls('particles') && erasesParticles('particles'));
});

test('asEraseMode falls back to the default for anything unrecognised', () => {
  assert.equal(asEraseMode('walls'), 'walls');
  assert.equal(asEraseMode('everything'), DEFAULT_ERASE_MODE);
  assert.equal(asEraseMode(3), DEFAULT_ERASE_MODE);
  assert.equal(asEraseMode(undefined), DEFAULT_ERASE_MODE);
});
