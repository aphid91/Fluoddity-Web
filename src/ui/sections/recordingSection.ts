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
  RESOLUTIONS,
  type RecordingSettings,
  frameCount,
  withDuration,
  withMotionBlurSamples,
  withPhysicsSteps,
  withResolution,
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

  // --- resolution ----------------------------------------------------------
  const resolutionProxy = { value: settings.resolution.label };
  const resolutionBlade = folder.addBinding(resolutionProxy, 'value', {
    label: 'Resolution',
    options: Object.fromEntries(
      RESOLUTIONS.map((r) => [`${r.label}  (${r.width}x${r.height})`, r.label]),
    ),
  });
  (resolutionBlade.element as HTMLElement).dataset['setting'] = 'recording.resolution';
  ctx.tooltip.attach(resolutionBlade.element as HTMLElement, {
    title: 'Resolution',
    body:
      'The exported video size, independent of your window.\n\n' +
      'Detail is currently limited by your window size: the frame is composed ' +
      'for the recording size, but is sourced at window resolution. For the ' +
      'sharpest export, make the window as large as you can before recording.',
  });
  resolutionBlade.on('change', (ev) => {
    if (ctx.isRefreshing()) return;
    settings = withResolution(settings, ev.value);
  });

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
  (folder.element as HTMLElement).append(summary);

  function updateSummary(): void {
    const frames = frameCount(settings);
    summary.textContent =
      `${frames} frames · ${settings.resolution.width}x${settings.resolution.height} · ` +
      `${settings.physicsSteps} steps/frame`;
  }
  updateSummary();

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
    refresh: () => {
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
      title.title =
        `Cancel  (${percent}% — ${progress.framesDone}/${progress.framesTotal})`;
    },
  };
}

const SUMMARY_CSS =
  'padding:6px 8px;font:10px system-ui,sans-serif;color:rgba(232,232,234,0.55);' +
  'line-height:1.5;';
