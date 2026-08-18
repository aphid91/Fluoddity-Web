/**
 * What the always-visible overlay needs from `Status`, and who has to supply it.
 *
 * ## The bug this pins
 *
 * `X` hides the PANELS. It deliberately does not hide `mutationOverlay` -- that
 * bar is the picture's own controls, and pressing `X` for a clean view must not
 * take away the one slider worth reaching for while watching. So the overlay
 * keeps rendering, and keeps reading `status.editConfig['mutationScale']` every
 * frame.
 *
 * `Orchestrator.settingsSources` used to return a shared EMPTY payload whenever
 * `panelOpen` was false, on the reasonable-sounding argument that a closed panel
 * has no readers. The overlay is the reader it missed. With the panels hidden,
 * `refresh` found no number, kept whatever the slider last showed, and the bar
 * silently disagreed with the config -- most visibly right after loading a save.
 *
 * WHAT MADE IT HARD TO SEE is that it is invisible unless you hide the panels
 * first, so the same action (load a config) either updated the slider or did not
 * depending on state nobody would connect to it. It reported as "the mutation
 * slider seems to be stale after loading a save sometimes".
 *
 * `panel.ts` had already been bitten by the same asymmetry from the other side
 * and refreshes the overlay ABOVE its own hidden check. That fixed the call; the
 * payload was the other half.
 *
 * ## Why the assertions look like this
 *
 * The Orchestrator needs a GPU device and the overlay needs a DOM, so neither
 * can be constructed under `node --test`. What CAN be checked is that the two
 * files still agree -- that every payload key the overlay reads is one the
 * closed-panel branch actually populates. Reading the sources is the only seam
 * available, and it is the same trick `shaders.test.ts` uses for WGSL rules a
 * compiler will not catch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Source with line endings normalized to `\n`.
 *
 * These files are checked out CRLF on Windows (`.gitattributes` leaves it to
 * core.autocrlf), so every pattern here that spans a line break would otherwise
 * match on one developer's machine and not another's -- a test that passes or
 * fails by platform rather than by behaviour.
 */
function read(...parts: string[]): string {
  return fs.readFileSync(path.join(here, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/** The settings payloads, by the names they carry in `Status`. */
const PAYLOADS = ['editConfig', 'editWorld', 'editPrefs'] as const;

/** `settingsSources`, from its signature to the end of the method. */
function settingsSources(): string {
  const source = read('..', 'orchestrator', 'orchestrator.ts');
  const start = source.indexOf('private settingsSources(');
  assert.ok(start > 0, 'settingsSources has been renamed; this test needs updating');
  // To the next method at the same indentation -- the closing `  }` of this one.
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, 'could not find the end of settingsSources');
  return source.slice(start, end);
}

test('the overlay reads only editConfig, of the three settings payloads', () => {
  // The premise of the test below. If the overlay ever starts reading
  // `editPrefs` (a drawing preference, say), the closed-panel branch has to
  // start populating that too -- and this is what will say so.
  const overlay = read('mutationOverlay.ts');
  const used = PAYLOADS.filter((name) => overlay.includes(`status.${name}`));
  assert.deepEqual(
    used,
    ['editConfig'],
    'mutationOverlay reads a settings payload that this test does not account for',
  );
});

test('the closed-panel payload still carries what the always-visible overlay reads', () => {
  // THE REGRESSION. `X` does not hide the overlay, so the branch taken while the
  // panels are hidden must not hand it an empty `editConfig` -- that is exactly
  // the freeze described in this file's header.
  const method = settingsSources();

  const guard = method.indexOf('if (!this.panelOpen)');
  assert.ok(guard > 0, 'the closed-panel branch has moved; re-check this test');

  // ONLY THE BRANCH BODY. Slicing to the end of the method instead would let the
  // OPEN-panel branch's `editConfig: asRecord(...)` satisfy this -- the
  // assertion would pass against the exact bug it exists to catch, which is
  // how the first version of this test was wrong.
  const bodyStart = method.indexOf('{', guard);
  const bodyEnd = method.indexOf('\n    }', bodyStart);
  assert.ok(bodyEnd > bodyStart, 'could not delimit the closed-panel branch');
  const closed = method.slice(bodyStart, bodyEnd);

  assert.match(
    closed,
    /editConfig:\s*asRecord\(/,
    'the closed-panel branch must still build editConfig -- the mutation overlay ' +
      'stays visible when X hides the panels and reads mutationScale from it',
  );
  // And the two that genuinely have no reader outside the panel stay empty, so
  // the fix does not quietly become "build everything, always" and give back the
  // per-frame cost the early-out exists to avoid.
  assert.match(closed, /editWorld:\s*NO_SETTINGS\./, 'editWorld should stay empty');
  assert.match(closed, /editPrefs:\s*NO_SETTINGS\./, 'editPrefs should stay empty');
});

test('mutationOverlay is exempt from the X hide, which is why the above matters', () => {
  // The premise, stated where it can be checked. If `setHidden` ever became a
  // real hide, the overlay would stop rendering with the panels and the
  // closed-panel payload could go back to being empty -- so this failing is the
  // signal to revisit the test above rather than to force it green.
  const overlay = read('mutationOverlay.ts');
  // The PARAMETER NAME carries it: `_hidden` is how this codebase spells "this
  // argument is deliberately unused", and it is what tsc's unused-parameter rule
  // is being told to allow. A real hide would have to read the flag, so the
  // underscore going away is the signal to revisit the test above. Matching the
  // body instead would break on the explanatory comment inside it.
  assert.match(
    overlay,
    /setHidden\(_hidden:\s*boolean\):\s*void/,
    'mutationOverlay.setHidden is expected to ignore its argument (a deliberate no-op)',
  );
});

test('panel.ts refreshes the overlay above its hidden early-out', () => {
  // The other half of the same fix, and the half that was already in place. Both
  // are required: the call has to happen AND the payload has to be populated.
  // Either one alone leaves the slider stale.
  const panel = read('panel.ts');
  const call = panel.indexOf('this.overlay.refresh(status)');
  const earlyOut = panel.indexOf('if (this.hiddenFlag) return;');

  assert.ok(call > 0, 'panel.ts no longer refreshes the overlay');
  assert.ok(earlyOut > 0, 'panel.ts no longer has the hidden early-out');
  assert.ok(
    call < earlyOut,
    'the overlay refresh must come BEFORE the hidden early-out, or it freezes ' +
      'whenever the panels are hidden',
  );
});

/**
 * Toggling `display` must not erase a `display` that came from `cssText`.
 *
 * THE BUG. `style.display = ''` REMOVES the property rather than reverting it to
 * a stylesheet value -- and this project styles everything through inline
 * `cssText`, so there is no stylesheet to revert to. An element whose layout
 * came from its own `cssText` therefore falls back to the tag's default.
 *
 * The cohort stepper is a `<span>` carrying `display:inline-flex`. Showing it
 * with `''` dropped that to a span's default `inline`, its three children laid
 * out as inline boxes, and the two arrows wrapped ABOVE AND BELOW the number
 * instead of sitting either side of it. It looks like a CSS mistake in the
 * stepper, which is where two attempts to fix it went first; the fault is in the
 * line that shows it.
 *
 * Checked at the source level because there is no DOM under `node --test` -- the
 * same seam `overlayPayload`'s other tests use, and the reason this lives here
 * rather than in `mutationOverlay.test.ts` with the pure `hintFor` cases.
 */
test('elements whose cssText sets display are re-shown with that display', () => {
  const overlay = read('mutationOverlay.ts');

  // Which style constants declare a `display`, and are therefore unsafe to
  // re-show with `''`. Parsed rather than listed, so a constant that GAINS a
  // display later is covered without anyone remembering to update this.
  const declaresDisplay = new Set<string>();
  for (const m of overlay.matchAll(/^const (\w+_CSS) =([\s\S]*?);$/gm)) {
    if (/display:/.test(m[2]!)) declaresDisplay.add(m[1]!);
  }
  assert.ok(
    declaresDisplay.has('STEPPER_CSS'),
    'STEPPER_CSS is expected to set display -- if it stopped, re-check this test',
  );

  // Which elements were styled from one of those constants.
  const unsafe = new Set<string>();
  for (const m of overlay.matchAll(/this\.(\w+)\.style\.cssText = (\w+_CSS)/g)) {
    if (declaresDisplay.has(m[2]!)) unsafe.add(m[1]!);
  }
  assert.ok(unsafe.has('stepper'), 'the stepper should be styled from STEPPER_CSS');

  // None of them may be re-shown with the empty string.
  for (const m of overlay.matchAll(
    /this\.(\w+)\.style\.display = ([^;]+);/g,
  )) {
    const [, name, expression] = m;
    if (!unsafe.has(name!)) continue;
    assert.ok(
      !/(^|[^'"\w])''/.test(expression!),
      `this.${name!}.style.display is set to '' somewhere, which REMOVES the ` +
        'display its cssText declared and drops it to the tag default -- state ' +
        'the intended display explicitly instead',
    );
  }
});
