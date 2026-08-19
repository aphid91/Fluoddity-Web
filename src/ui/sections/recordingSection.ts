/**
 * Recording Controls: the Export Video tab.
 *
 * Rendered directly rather than through the settings registry, for the reason
 * `drawingSection.ts` gives: "the registry exists to drive the Project and
 * Preferences windows, where dozens of controls need consistent tiering,
 * grouping and tooltips; [a handful of] widgets in a dedicated window are not
 * that shape, and routing them through it would mean fabricating `Setting`
 * objects to satisfy a signature." That applies doubly here -- these values are
 * not `Preferences` at all, so there is no `editPrefs` payload to bind against.
 *
 * ## Why this section holds its own state
 *
 * Every other section is a view onto `Status`: it writes through a command and
 * reads the value back on the next frame, so the panel never holds a second
 * copy. This one keeps a `RecordingSettings` locally instead, because the
 * recorder that consumes it does not exist yet -- the whole module is lazily
 * imported and is not constructed until Export is pressed. Routing these through
 * the command bus would mean the Orchestrator carrying recording state for a
 * feature most sessions never touch, which is exactly what the lazy loading is
 * there to avoid.
 *
 * The state is therefore owned here and handed over WHOLE when recording
 * starts. That is a narrower interface than a live binding, not a wider one.
 *
 * ## The blur slider's ceiling
 *
 * Motion Blur Samples ranges over `[1, physicsSteps]` and moves its CEILING with
 * the physics rate. Tweakpane cannot retune a binding's `max` in place, so the
 * blade is disposed and rebuilt when the ceiling changes -- see `rebuildSamples`.
 * The value that survives that rebuild comes from `rescaleSamples`, which keeps
 * the HANDLE where it was and changes the NUMBER under it.
 */

import type { BladeApi, FolderApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import {
  DEFAULT_RECORDING_SETTINGS,
  MAX_DURATION,
  MAX_PHYSICS_STEPS,
  MIN_DURATION,
  MIN_PHYSICS_STEPS,
  MIN_RECORDING_DIM,
  type RecordingSettings,
  type Resolution,
  clampResolution,
  frameCount,
  physicsFrameCount,
  withDuration,
  withHeight,
  withMotionBlurSamples,
  withPhysicsSteps,
  withWidth,
} from '../../recorder/recordingSettings.ts';
import { type SectionContext, type SectionHandle } from './section.ts';

/** What the tab reports upward. The panel owns the recorder's lifecycle. */
export interface RecordingSectionOptions {
  /** Begin an export with these settings. */
  readonly onExport: (settings: RecordingSettings) => void;
  /** Abandon an export in flight, keeping the frames already encoded. */
  readonly onCancel: () => void;
  /**
   * Progress of the in-flight export, or null when idle. Polled per frame from
   * `refresh` rather than pushed, matching how every other section reads state.
   */
  readonly progress: () => { framesDone: number; framesTotal: number } | null;
  /**
   * The window size in device pixels, read fresh each time.
   *
   * A function rather than a value, because it is the sliders' CEILING and the
   * window changes under them -- a captured size would let the user ask for a
   * recording larger than the window they now have.
   */
  readonly windowSize: () => readonly [number, number];
  /**
   * The crop box has moved. Drives the on-screen box while the user is choosing
   * a size, which is before any recorder exists -- see `Orchestrator.
   * setCropPreview`. Null hides it.
   */
  readonly onCropChange: (resolution: Resolution | null) => void;
}

/** A recording section, plus the settings the panel hands to the recorder. */
export interface RecordingSectionHandle extends SectionHandle {
  readonly settings: () => RecordingSettings;
}

export function buildRecordingSection(
  folder: FolderApi,
  _status: Status,
  ctx: SectionContext,
  opts: RecordingSectionOptions,
): RecordingSectionHandle {
  let settings = DEFAULT_RECORDING_SETTINGS;

  // --- resolution: two sliders, capped at the window ------------------------
  //
  // Rebuilt when the WINDOW changes, for the same reason the blur slider is
  // rebuilt when its ceiling moves: Tweakpane cannot retune a binding's `max` in
  // place, and these two maxima are the window's dimensions -- which change
  // whenever the user drags the browser edge. See `syncWindow`.
  let widthBlade: BladeApi | null = null;
  let heightBlade: BladeApi | null = null;
  /** The window size the two sliders were last built against. */
  let builtFor: readonly [number, number] = [0, 0];

  function buildDimension(
    axis: 'width' | 'height',
    max: number,
    before: HTMLElement | null,
  ): BladeApi {
    const proxy = { value: clampResolution(settings.resolution, opts.windowSize())[axis] };
    const blade = folder.addBinding(proxy, 'value', {
      label: axis === 'width' ? 'Width' : 'Height',
      min: MIN_RECORDING_DIM,
      max: Math.max(MIN_RECORDING_DIM, max),
      step: 2, // Even, for H.264's 4:2:0 chroma. `evenDim` enforces it anyway.
    });
    (blade.element as HTMLElement).dataset['setting'] = `recording.${axis}`;
    ctx.tooltip.attach(blade.element as HTMLElement, {
      title: axis === 'width' ? 'Recording Width' : 'Recording Height',
      body:
        'The exported video size in pixels, capped at your window. Reduce it ' +
        'and a white box appears on screen showing exactly what will be ' +
        'recorded -- the area outside is dimmed.\n\nEvery exported pixel is a ' +
        'real rendered pixel, so cropping never softens the image. For a ' +
        'larger export, make the window larger.',
    });
    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      const win = opts.windowSize();
      settings = axis === 'width'
        ? withWidth(settings, ev.value as number, win)
        : withHeight(settings, ev.value as number, win);
      opts.onCropChange(settings.resolution);
      updateSummary();
    });
    if (before !== null) {
      const el = blade.element as HTMLElement;
      el.parentElement?.insertBefore(el, before);
    }
    return blade;
  }

  // --- duration ------------------------------------------------------------
  const durationProxy = { value: settings.duration };
  const durationBlade = folder.addBinding(durationProxy, 'value', {
    label: 'Duration (s)',
    min: MIN_DURATION,
    max: MAX_DURATION,
    step: 1,
  });
  (durationBlade.element as HTMLElement).dataset['setting'] = 'recording.duration';
  ctx.tooltip.attach(durationBlade.element as HTMLElement, {
    title: 'Duration',
    body:
      'Length of the exported clip in seconds, at 60fps. This is video time, ' +
      'not how long the export takes -- at high physics rates and sample ' +
      'counts a five-second clip can take many minutes to render.',
  });
  durationBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    settings = withDuration(settings, ev.value);
    updateSummary();
  });

  // --- physics rate --------------------------------------------------------
  const stepsProxy = { value: settings.physicsSteps };
  const stepsBlade = folder.addBinding(stepsProxy, 'value', {
    label: 'Physics Rate',
    min: MIN_PHYSICS_STEPS,
    max: MAX_PHYSICS_STEPS,
    step: 1,
  });
  (stepsBlade.element as HTMLElement).dataset['setting'] = 'recording.physicsSteps';
  ctx.tooltip.attach(stepsBlade.element as HTMLElement, {
    title: 'Video Physics Rate',
    body:
      'Physics sub-steps per recorded frame -- how fast simulation time runs ' +
      'in the export. Independent of the editor\'s own rate, so you can render ' +
      'far above what your machine can play back live.\n\nThis is also the ' +
      'ceiling for Motion Blur Samples.',
  });
  stepsBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    const before = settings.physicsSteps;
    settings = withPhysicsSteps(settings, ev.value);
    // ONLY when the ceiling actually moved. `rebuildSamples` disposes a blade
    // and builds another, and doing that on every drag event of this slider
    // would replace the samples widget dozens of times per second.
    if (settings.physicsSteps !== before) rebuildSamples();
    updateSummary();
  });

  // --- motion blur samples -------------------------------------------------
  // Rebuilt rather than retuned. See the file header.
  let samplesBlade: BladeApi | null = null;

  function rebuildSamples(): void {
    samplesBlade?.dispose();

    const proxy = { value: settings.motionBlurSamples };
    const blade = folder.addBinding(proxy, 'value', {
      label: 'Blur Samples',
      min: 1,
      max: settings.physicsSteps,
      step: 1,
    });
    (blade.element as HTMLElement).dataset['setting'] = 'recording.motionBlurSamples';
    ctx.tooltip.attach(blade.element as HTMLElement, {
      title: 'Motion Blur Samples',
      body:
        'Temporal supersamples averaged into each recorded frame. Higher is ' +
        'smoother motion and a slower render.\n\nThe top of this slider is ' +
        'always the Video Physics Rate, so raising that rate keeps the handle ' +
        'where it is and raises the number instead.',
    });
    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      settings = withMotionBlurSamples(settings, ev.value as number);
    });

    samplesBlade = blade;
    // MOVED BACK INTO PLACE. Tweakpane appends, so a rebuilt blade lands at the
    // bottom of the folder -- under the export button -- rather than in the
    // slot it occupied. Re-anchoring on the element after it is added is what
    // keeps the control order stable as the ceiling moves.
    const el = blade.element as HTMLElement;
    el.parentElement?.insertBefore(el, summary);
  }

  // --- the summary line, the button, and the progress readout --------------
  // Plain DOM rather than a Tweakpane monitor: this is a sentence that changes,
  // not a value to bind, and a monitor blade would render it as a labelled
  // readout box -- which is a row of chrome around one line of text.
  const summary = document.createElement('div');
  summary.style.cssText = SUMMARY_CSS;
  summary.dataset['recording'] = 'summary';

  // **INTO THE BLADE CONTAINER, NOT `folder.element`.** This is the bug that
  // made the recording controls spill out of their tab and appear at the bottom
  // of the Preferences panel, taking the blur slider with them (it anchors on
  // `summary`).
  //
  // A Tweakpane folder's `element` is the OUTER wrapper -- title button plus a
  // separate contents div -- so appending to it puts the node as a SIBLING of
  // the contents rather than inside them. That escapes the container the tab
  // switch shows and hides via `display`, so the node stayed visible whichever
  // tab was selected and un-ticking Export Video could not remove it.
  //
  // Anchoring on a blade that Tweakpane itself placed cannot drift: whatever
  // element it chose as the contents parent is by definition the right one. The
  // fallback is the folder element, which is only reached if no blade exists --
  // impossible here, since several are built above.
  const bladeParent =
    (durationBlade.element as HTMLElement).parentElement ??
    (folder.element as HTMLElement);
  bladeParent.append(summary);

  /**
   * The physics-frame readout: where the simulation is NOW, and how far this
   * recording would travel.
   *
   * ## Why these two numbers sit together
   *
   * The workflow they serve: park on an interesting structure, note the physics
   * frame it formed at, then set duration and rate so a recording started from a
   * reset actually reaches it. That is a COMPARISON, and it is unreadable if the
   * two quantities live in different places -- so they are one line, in the same
   * units, with the verdict spelled out rather than left as arithmetic.
   *
   * `Status.frameCount` counts physics sub-steps, not rendered frames
   * (`particleSystem.ts` advances it by `steps` per frame), which is what makes
   * it directly comparable to `physicsFrameCount`. If it counted rendered frames
   * this whole readout would be off by the physics rate and would look plausible
   * while being useless.
   */
  const physics = document.createElement('div');
  physics.style.cssText = SUMMARY_CSS;
  physics.dataset['recording'] = 'physics';
  bladeParent.append(physics);

  /** `50000` -> `50,000`. Six-digit frame counts are unreadable unseparated. */
  const group = (n: number): string => n.toLocaleString('en-US');

  function updateSummary(): void {
    const frames = frameCount(settings);
    const res = clampResolution(settings.resolution, opts.windowSize());
    const text =
      `${frames} frames · ${res.width}×${res.height} · ` +
      `${settings.physicsSteps} steps/frame`;
    // Guarded: this runs from `refresh` every frame, and writing an identical
    // string is DOM work to change nothing.
    if (summary.textContent !== text) summary.textContent = text;
  }

  function updatePhysics(currentFrame: number): void {
    const total = physicsFrameCount(settings);
    // THE VERDICT, not just the numbers. "72,000 vs 50,000" still leaves the
    // user comparing digit counts; saying whether it reaches is the answer they
    // came for, and it is one subtraction away.
    const reaches = total >= currentFrame;
    const verdict = currentFrame === 0
      ? '' // Nothing to compare against from a cold start.
      : reaches
        ? '  ✓ reaches here'
        : `  ✗ ${group(currentFrame - total)} short`;

    const text =
      `physics frame ${group(currentFrame)} now · ` +
      `this video: ${group(total)}${verdict}`;
    if (physics.textContent !== text) physics.textContent = text;

    // Colour carries the same verdict for a glance, and is never the ONLY
    // carrier -- the text says it too, so this reads correctly without colour
    // vision and in a screenshot.
    const colour = currentFrame === 0 || reaches ? '' : '#e0a0a0';
    if (physics.style.color !== colour) physics.style.color = colour;
  }
  updateSummary();

  /**
   * Rebuild the two dimension sliders when the window has changed size.
   *
   * The window is these sliders' ceiling and it moves whenever the user drags
   * the browser edge. Tweakpane cannot retune `max` in place, so this disposes
   * and rebuilds -- the same trick `rebuildSamples` uses, and guarded the same
   * way, on an ACTUAL change. Rebuilding per frame would replace both widgets
   * sixty times a second and make them impossible to drag.
   */
  function syncWindow(): void {
    const win = opts.windowSize();
    if (win[0] === builtFor[0] && win[1] === builtFor[1]) return;
    builtFor = win;

    // Re-clamp first: the window may have shrunk below the chosen size, and the
    // sliders must be rebuilt around the value they will actually hold.
    settings = { ...settings, resolution: clampResolution(settings.resolution, win) };

    widthBlade?.dispose();
    heightBlade?.dispose();
    // Anchored before the duration blade so the two land back at the top of the
    // folder rather than at the bottom, where Tweakpane appends them.
    const anchor = durationBlade.element as HTMLElement;
    widthBlade = buildDimension('width', win[0], anchor);
    heightBlade = buildDimension('height', win[1], anchor);
    updateSummary();
  }
  syncWindow();

  const exportButton = folder.addButton({ title: 'Export Video' });
  (exportButton.element as HTMLElement).dataset['recording'] = 'export';
  exportButton.on('click', () => {
    // The button is the ONE place recording is entered from, which is what makes
    // the lazy import a single, obvious cost rather than something that could
    // fire from several paths at once.
    if (opts.progress() === null) opts.onExport(settings);
    else opts.onCancel();
  });

  // Built AFTER the settings blades so it renders below them, and rebuilt into
  // its slot by `rebuildSamples` -- which is why `summary` is the anchor.
  rebuildSamples();

  return {
    bindings: [],
    settings: () => settings,
    refresh: (s) => {
      // The window is the dimension sliders' ceiling, so it is followed per
      // frame -- `syncWindow` early-returns unless it actually moved.
      syncWindow();

      // The live physics frame. Per frame BY NECESSITY rather than by choice:
      // this is the one readout here whose left-hand number changes without any
      // control being touched, and watching it climb toward the target is how
      // the user knows when to pause. Both writes are guarded on an actual
      // change, so a paused simulation costs nothing.
      updatePhysics(s.frameCount);

      // The button doubles as Cancel while an export runs. One control rather
      // than two, because "start" and "stop" are never both available and a
      // permanently greyed second button is worse than a label that changes.
      const progress = opts.progress();
      const title = (exportButton as unknown as { title: string });
      if (progress === null) {
        title.title = 'Export Video';
        return;
      }
      const percent = progress.framesTotal === 0
        ? 0
        : Math.floor((progress.framesDone / progress.framesTotal) * 100);
      // SAYS SO WHEN PAUSED. Pausing suspends the recording by design -- no
      // frames are encoded, so the counter stops -- and a progress readout that
      // simply froze would be indistinguishable from a hung export. Naming the
      // pause is what turns "it stopped" into "you stopped it".
      const suspended = s.paused ? ' — PAUSED' : '';
      title.title =
        `Cancel  (${percent}% — ${progress.framesDone}/${progress.framesTotal})${suspended}`;
    },
  };
}

const SUMMARY_CSS =
  'padding:6px 8px;font:10px system-ui,sans-serif;color:rgba(232,232,234,0.55);' +
  'line-height:1.5;';
