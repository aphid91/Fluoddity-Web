# Multi-shape initial conditions — brief for the next session

**Status:** deferred and unimplemented. Nothing in `src/` has been changed for
this. The comp at [`docs/comps/aspectShapes.html`](comps/aspectShapes.html)
and this note are the whole deliverable — a later session owns the decisions
and the code.

Open the comp in a browser. It is standalone (no build, no imports from
`src/`), draws the sand shell to scale from the real values in `sand.html`,
and lets you cycle each device through the three candidate shapes.

---

## What we want

Today the world is locked to one aspect: `main.ts` sets `SAND_CANVAS_ASPECT =
5/3` as a fresh-install default for `prefs.canvasAspect`. On a phone that
leaves the canvas claiming about a third of the space the shell gives it.

The goal is **three world shapes — wide, square, narrow — each with its own
initial conditions**, chosen to fit the window, with a dev-panel dropdown
(`auto / wide / square / narrow`) for authoring each one's scene. A world then
saves all three.

## Why this is not just a number change

`canvasAspect` is a **preference**, not a crop. From `sizing.ts`: world space
is area-preserving, so changing the aspect keeps the pixel count and the
particle density and makes the world *wider and shorter*. It reshapes the
simulated world.

Two consequences, both load-bearing:

1. **It reallocates.** `preferences.ts:requiresRestart` names world size and
   canvas aspect as the two settings that rebuild the entity buffer and both
   textures.
2. **It invalidates the scene.** `initialConditions.ts:353-356` is explicit:
   the capture *must* be invalidated when the aspect changes, because world
   extent follows aspect and a stamp captured at one shape describes a world
   that no longer exists.

So authoring three shapes is inherently three separate arranging sessions with
a full GPU rebuild between each. **This is expected and accepted** — the user
confirmed it is the intended behaviour, not a problem to design around.

## The numbers

Stage = what is left after the rail (140px) and the tray take their bite; at
two swatch rows the tray is 104px. Fill = the fraction of the stage the largest
box of that shape claims. Figures from the same arithmetic the comp runs.

| Device | Stage | Best | Fill | Runner-up |
|---|---|---|---|---|
| Desktop 16:9 (1920×1080) | 1780×976 (1.82:1) | wide 5:3 | 91.4% | square 54.8% |
| Laptop 16:10 (1440×900) | 1300×796 (1.63:1) | wide 5:3 | 98.0% | square 61.2% |
| iPad landscape (1180×820) | 1040×716 (1.45:1) | wide 5:3 | 87.2% | square 68.8% |
| iPad portrait (820×1180) | 820×999 (0.82:1) | **3:4** 91.4% | | square 82.1% |
| iPhone 15 Pro (393×852) | 393×671 (0.59:1) | **9:16** 96.0% | | 3:4 78.1% |
| iPhone SE (375×667) | 375×486 (0.77:1) | **3:4** 97.2% | | square 77.2% |

### The narrow shape is the real open question

I guessed 9:16 in the earlier discussion. The data says **it depends on the
device, and no single narrow aspect serves both**:

- **iPhone 15 Pro** wants 9:16 (96.0%). At 3:4 it drops to 78.1%.
- **iPhone SE and iPad portrait** want 3:4 (97.2%, 91.4%). At 9:16 they drop
  to 72.9% and 68.5%.

The cause is the **fixed 104px tray plus 77px rail**: on a tall phone that
chrome is a small fraction of 852px and the stage stays nearly as tall as the
screen (0.59:1), but on a 667px SE it eats enough that the stage is only
0.77:1. Modern phones are getting taller, older ones and tablets are not.

Three options, none obviously right — **this is the main thing to decide**:

1. **Narrow = 3:4.** Good on SE and iPad portrait, mediocre on tall phones.
   Safest if tablets matter.
2. **Narrow = 9:16.** Excellent on the flagship phone shape, poor on SE/iPad
   portrait — and those fall back to `square` (77–82%), which is not a
   disaster.
3. **Four shapes.** Rejected for now: it is a fourth scene to author per world,
   for a gap the square shape already half-covers.

My weak lean is **9:16 with square as the portrait fallback**, because the
phone is the case the narrow shape exists for and square already handles the
awkward middle. But this is a judgement call about which devices matter, which
is yours.

## Things that will bite

- **Auto-detection needs hysteresis.** Every threshold crossing destroys the
  ICs. A window dragged near a boundary would thrash and repeatedly wipe the
  scene. Pick by nearest-fit with a dead band, and — worth considering —
  **only re-evaluate on load, not on live resize**.
- **The portrait layout is not just an aspect.** The rail is a 140px *column*;
  on a 393px phone that is 36% of the width for five buttons. The comp models
  portrait with the rail moved to the bottom (`data-layout="stack"`), which is
  roughly what `theme.ts`'s `LAYOUT_DOCK` already does. The narrow shape
  probably needs that layout, so this is a UI change as much as a sizing one.
- **The world format.** `WorldDocument.preferences` holds a single
  `canvasAspect`, and `WorldRecord.scene` is one `ArrayBuffer`. Three scenes
  means three buffers plus three aspects. Per the user: **do not bump
  `WORLD_FORMAT_VERSION`** — nothing has shipped, existing saves are
  dev-testing artifacts, and the mechanics are still being shaped.
- **`visibleCount` interacts.** The tray height depends on how many swatch
  rows wrap, which changes the stage, which changes the best shape. The comp
  has a rows slider; it moves the answers by a few points, not enough to
  change any winner at 1–4 rows.
- **What does a world with only one shape authored do?** A world saved before
  this, or one whose author only did `wide`, needs an answer: fall back to the
  nearest authored shape, or start empty. Probably the former.

## Suggested shape of the work

1. Decide the narrow aspect (above).
2. `sizing.ts` / a new module: the three named shapes and a `pickShape(w, h)`
   with hysteresis. Pure, testable under `node --test`.
3. Dev-panel dropdown `auto / wide / square / narrow`; selecting a non-auto
   value applies that aspect (rebuilding, as any aspect change does) so the
   author can arrange that shape's scene.
4. World format: three scenes and three aspects, no version bump.
5. Portrait layout for the narrow shape.

## What was NOT touched

No source file was modified for this item. The four other items from the same
request — swatch-selection arming the brush, wheel cycling, dev-panel
persistence, and per-swatch colours with the Behavior/Cohort/Swatch mode — are
implemented and tested; see the git log. Trail-gravity invariance was
investigated and reported but deliberately left alone at the user's request.
