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
  MAX_DURATION,
  MAX_PHYSICS_STEPS,
  MIN_DURATION,
  MIN_PHYSICS_STEPS,
  MIN_RECORDING_DIM,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  type RecordingSettings,
  clampResolution,
  frameCount,
  loadRecordingSettings,
  physicsFrameCount,
  saveRecordingSettings,
  withDuration,
  withHeight,
  withMotionBlurSamples,
  withPhysicsSteps,
  withPhysicsStepsRaw,
  withQuality,
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
  // FROM STORAGE, not from the defaults -- these persist across sessions the way
  // `Preferences` does. See `loadRecordingSettings`, which never throws.
  //
  // Read on every build, and this section is rebuilt whenever a tier checkbox or
  // Export Video is toggled. That is harmless rather than wasteful: the value in
  // storage is the value this section last wrote, so a rebuild reloads its own
  // state and the read is one `JSON.parse` of a five-field record.
  let settings = loadRecordingSettings();

  /**
   * Persist the current settings.
   *
   * Called from every `change` handler rather than on export, because the
   * settings must outlive a session in which the user never pressed Begin
   * Recording -- setting up an export and coming back to it tomorrow is the
   * normal way this feature gets used.
   *
   * **UNCONDITIONAL, AND CHEAP ENOUGH TO BE.** Tweakpane fires `change`
   * throughout a slider drag, so this runs perhaps a hundred times across a
   * gesture. Each is a `JSON.stringify` of five fields into `localStorage`,
   * which is a synchronous write of ~120 bytes -- immaterial beside the DOM work
   * the same event already does. Debouncing it would buy nothing measurable and
   * would add a timer that could lose the last edit if the tab closed inside its
   * window.
   */
  function persist(): void {
    saveRecordingSettings(settings);
  }

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
      title: axis === 'width' ? 'Width' : 'Height',
      body: axis === 'width' ? 'Video X resolution' : 'Video Y resolution',
    });
    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      const win = opts.windowSize();
      settings = axis === 'width'
        ? withWidth(settings, ev.value as number, win)
        : withHeight(settings, ev.value as number, win);
      // The on-screen crop box is NOT pushed from here. `Panel.syncCropPreview`
      // reads this section's settings once per frame instead, because the box
      // must also follow things no slider reports -- switching tabs, hiding the
      // panels -- and one source of truth beats a push plus a poll that can
      // disagree. The next frame is imperceptible.
      updateSummary();
      persist();
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
    
    step: 1,
  });
  (durationBlade.element as HTMLElement).dataset['setting'] = 'recording.duration';
  ctx.tooltip.attach(durationBlade.element as HTMLElement, {
    title: 'Duration',
    body: 'Number of seconds before recording is automatically concluded',
  });
  durationBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    settings = withDuration(settings, ev.value);
    updateSummary();
    persist();
  });

  // --- quality -------------------------------------------------------------
  //
  // BESIDE THE OUTPUT SETTINGS, above the physics pair, because that is what it
  // is: size, length and quality describe the FILE, while the physics rate and
  // blur samples describe what is simulated to fill it. Grouping it with the
  // physics controls would put a decision about compression next to two that
  // change the picture itself.
  const qualityProxy = { value: settings.quality as string };
  const qualityBlade = folder.addBinding(qualityProxy, 'value', {
    label: 'Quality',
    // Label -> value, which is the direction Tweakpane's options map takes.
    // Built from `QUALITY_PRESETS` so the order here is the order there --
    // worst first, reading bottom-to-top like every other quality control.
    options: Object.fromEntries(QUALITY_PRESETS.map((q) => [QUALITY_LABELS[q], q])),
  });
  (qualityBlade.element as HTMLElement).dataset['setting'] = 'recording.quality';
  ctx.tooltip.attach(qualityBlade.element as HTMLElement, {
    title: 'Quality',
    body:
      'Lower quality yields faster renders and smaller files. Higher quality ' +
      'yields better compression',
  });
  qualityBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    settings = withQuality(settings, ev.value as string);
    persist();
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
    title: 'Physics Rate',
    body:
      'Determines how many physics substeps per frame of video. High values can ' +
      'result in long renders, but the video recorder is tolerant of ' +
      'non-realtime performance.',
  });
  stepsBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;

    // **THE BLUR COUNT IS NOT RESCALED HERE ANY MORE -- see `commitSteps`.**
    //
    // Tweakpane fires `change` continuously through a drag, and `rescaleSamples`
    // is lossy by design: it preserves the HANDLE POSITION and `floor`s the
    // value that falls out. Applying it per event compounded that floor once
    // per intermediate rate, so wiggling this slider walked the blur count
    // steadily downward and left it somewhere unrelated to where it started --
    // the drift `rescaleSamples`'s own `floor` was chosen to prevent across a
    // SINGLE change, defeated by being asked dozens of times.
    //
    // So the rate is written live (the summary and the readouts follow the
    // drag), and the rescale is deferred to release, where it runs exactly once
    // against the ceiling the user actually settled on.
    settings = withPhysicsStepsRaw(settings, ev.value);
    updateSummary();
    // Persisted from the LIVE write as well as from `commitSteps`, not only
    // from the latter. `commitSteps` early-returns when the ceiling ended where
    // it started, and a drag out and back is exactly that -- but it can still
    // have clamped `motionBlurSamples` down on the way through, which is a real
    // change to the record and would otherwise never be written.
    persist();
    scheduleStepsCommit();
  });

  /**
   * Rescale the blur count once the physics-rate gesture is over.
   *
   * ## Why release is detected with a CAPTURING window listener
   *
   * A Tweakpane slider is a composite of divs with its own pointer handling and
   * exposes no "drag ended" event -- only the continuous `change`. The gesture
   * genuinely ends on `pointerup`, and by then the pointer may be anywhere:
   * dragging past the end of the track and releasing over the canvas is the
   * normal way to reach the maximum. A listener on the blade would never see
   * that release, so it has to be higher up.
   *
   * **CAPTURE PHASE, so a `stopPropagation` between the slider and the window
   * cannot swallow it** -- `inputBinding.ts` handles pointer events on the
   * canvas, which is exactly where a released drag tends to land.
   *
   * `keyup` is the keyboard half: the slider is focusable and the arrow keys
   * step it, which produces the same `change` stream with no pointer involved.
   *
   * ## Why the pending flag is not just "did the value change"
   *
   * The commit has to run exactly once per gesture and only when one happened.
   * Every release in the app reaches this listener, so without the flag a click
   * anywhere would rescale the samples against an unchanged ceiling --
   * harmless arithmetic, but `rescaleSamples` at an unchanged ceiling is not
   * the identity (its `floor` can still move the value), so it would silently
   * edit a setting the user was not touching.
   */
  let stepsPending = false;
  /** The rate the blur count was last rescaled against. See `commitSteps`. */
  let committedSteps = settings.physicsSteps;

  function scheduleStepsCommit(): void {
    stepsPending = true;
  }

  function commitSteps(): void {
    if (!stepsPending) return;
    stepsPending = false;
    // NOTHING TO DO if the ceiling ended where it started -- a drag out and
    // back, or a click that moved nothing. Skipping keeps `rescaleSamples`'s
    // floor from nudging a value the user never asked to change.
    if (settings.physicsSteps === committedSteps) return;

    // Rescaled from the ceiling at the START of the gesture, not from the last
    // intermediate one: that is the whole point of deferring. `withPhysicsSteps`
    // reads `settings.physicsSteps` as the PREVIOUS ceiling, so it is restored
    // before the call and the real destination passed in.
    const target = settings.physicsSteps;
    settings = withPhysicsSteps(
      { ...settings, physicsSteps: committedSteps },
      target,
    );
    committedSteps = settings.physicsSteps;
    rebuildSamples();
    updateSummary();
    // The rescaled blur count is the value the user keeps, so it is the one
    // worth storing -- the live write above saved an intermediate.
    persist();
  }

  // CAPTURE PHASE -- see `commitSteps`. Removed in `dispose`, because this
  // section is rebuilt whenever a tier checkbox or Export Video is toggled and
  // window listeners would otherwise accumulate one set per rebuild.
  window.addEventListener('pointerup', commitSteps, true);
  window.addEventListener('keyup', commitSteps, true);

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
      title: 'Blur Samples',
      body:
        'Determines how many of the physics substeps are visually rendered and ' +
        'blended together each frame. Higher values result in smoother ' +
        'recordings',
    });
    blade.on('change', (ev) => {
      if (ctx.isRefreshing()) return;
      settings = withMotionBlurSamples(settings, ev.value as number);
      persist();
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
   * reset actually reaches it. That is a COMPARISON, which is why the two live
   * on one line and in the same units.
   *
   * **IT REPORTS, IT DOES NOT JUDGE.** An earlier version appended a verdict --
   * a tick for "reaches here", a cross and a shortfall otherwise. It was removed
   * deliberately: a red cross reads as SOMETHING IS WRONG, and nothing is. A
   * recording shorter than the current frame is a perfectly ordinary thing to
   * want (most exports are not trying to reproduce the state on screen), so
   * flagging it made the panel look broken during normal use. The two numbers
   * are the information; whether they matter is the user's call on any given
   * export, and they can do the subtraction on the occasions they care.
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
    // Two numbers, stated plainly. No verdict and no colour -- see the header
    // above for why the tick and cross were removed rather than reworded.
    const text =
      `physics frame ${group(currentFrame)} now · ` +
      `this video: ${group(physicsFrameCount(settings))}`;
    if (physics.textContent !== text) physics.textContent = text;
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
    //
    // **DELIBERATELY NOT PERSISTED.** This is the one write of `settings` that
    // is not the user's choice -- it is the window imposing its ceiling. Saving
    // it would let a session in a small window permanently shrink a size chosen
    // in a large one, and, worse, would burn the full-frame sentinel down to a
    // concrete number the first time this ran: everyone would come back cropped
    // to their last window rather than to full frame. The stored record keeps
    // what was ASKED for; `clampResolution` at each use site keeps what is
    // legal, which is the same division of labour the field comment describes.
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

  // "BEGIN RECORDING", not "Export Video". The old name described the OUTCOME
  // and the button does not produce it: pressing this opens a title dialog and
  // then records for the chosen duration, and the file arrives at the end. A
  // user who read "Export" reasonably expected a save dialog and a finished
  // video, not a recording that has to run first.
  const exportButton = folder.addButton({ title: 'Begin Recording' });
  (exportButton.element as HTMLElement).dataset['recording'] = 'export';
  ctx.tooltip.attach(exportButton.element as HTMLElement, {
    title: 'Begin Recording',
    body: 'Opens a dialog to title your video then initiates recording',
  });
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
    dispose: () => {
      // Same capture flag as the registration, or `removeEventListener` does
      // not match and the listener stays.
      window.removeEventListener('pointerup', commitSteps, true);
      window.removeEventListener('keyup', commitSteps, true);
    },
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

      // The button doubles as End Video while an export runs. One control rather
      // than two, because "start" and "stop" are never both available and a
      // permanently greyed second button is worse than a label that changes.
      //
      // **"END VIDEO", NOT "CANCEL", AND THE DIFFERENCE IS NOT COSMETIC.**
      // Pressing this keeps every frame encoded so far and writes them to a file
      // (`panel.ts`'s `onCancel`, and `VideoRecorder.cancel`) -- the recording
      // ENDS EARLY, it is not discarded. "Cancel" promises the opposite, and a
      // user who believed it would either press it expecting no file or, worse,
      // sit through an export they wanted to cut short because they thought
      // stopping meant losing the footage.
      const progress = opts.progress();
      const title = (exportButton as unknown as { title: string });
      if (progress === null) {
        title.title = 'Begin Recording';
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
        `End Video  (${percent}% — ${progress.framesDone}/${progress.framesTotal})${suspended}`;
    },
  };
}

const SUMMARY_CSS =
  'padding:6px 8px;font:10px system-ui,sans-serif;color:rgba(232,232,234,0.55);' +
  'line-height:1.5;';
