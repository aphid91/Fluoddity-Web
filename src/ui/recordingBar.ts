/**
 * The recording progress bar.
 *
 * ## Why a surface of its own rather than the button's label
 *
 * The Export button already counts frames, and that is enough while the
 * Recording Controls tab is in front. It stops being enough the moment it is
 * not: the panels start hidden, `X` hides them, and switching to Preferences
 * mid-export hides the tab -- and an export that runs for twenty minutes is
 * precisely the thing a user walks away from a panel to watch. Without this,
 * every one of those states leaves a slow, heavy, unexplained simulation with no
 * visible reason for being slow.
 *
 * So this follows `Toast` and `MutationOverlay`: attached to `document.body`
 * rather than into a pane, so `setHidden` cannot take it off screen. It is
 * shown only while an export is in flight, which is the one state where a
 * permanent strip across the top would be justified.
 *
 * ## Why it is NOT the splash
 *
 * Calibration runs behind the splash, locked, because the numbers it is deriving
 * decide what the app can even allocate -- there is nothing useful to do until
 * it lands. A recording is the opposite: the user should keep panning, keep
 * painting, keep watching. Locking the interface for it would prevent exactly
 * the work the export exists to capture.
 *
 * ## `pointer-events`
 *
 * The strip itself is inert -- `inputBinding.ts` decides canvas capture by
 * `event.target !== canvas`, so a bar the pointer could hit would eat clicks
 * meant for the simulation. The Cancel button inside it is the one exception and
 * re-enables them on itself, because a button nobody can press is not a button.
 */

/** What the bar shows. Rebuilt from the recorder each frame it is visible. */
export interface RecordingBarState {
  readonly framesDone: number;
  readonly framesTotal: number;
  /** Suspended by the user pausing. See `main.ts`'s recording hand-off. */
  readonly paused: boolean;
}

export class RecordingBar {
  private root: HTMLElement | null = null;
  private fill: HTMLElement | null = null;
  private label: HTMLElement | null = null;
  private readonly onCancel: () => void;

  constructor(onCancel: () => void) {
    this.onCancel = onCancel;
  }

  /**
   * Show the bar with `state`, or hide it when `state` is null.
   *
   * Built LAZILY on first use, the `Toast`/`Tooltip` pattern: a session that
   * never records never creates the element, and the common case costs one
   * null check per frame.
   */
  update(state: RecordingBarState | null): void {
    if (state === null) {
      if (this.root !== null) this.root.style.display = 'none';
      return;
    }

    this.root ??= this.build();
    this.root.style.display = 'flex';

    const percent = state.framesTotal === 0
      ? 0
      : Math.min(100, (state.framesDone / state.framesTotal) * 100);

    // Written only on a real change: this runs every frame of an export that may
    // last twenty minutes, and assigning identical strings to `style.width` and
    // `textContent` is DOM work to change nothing. Same instinct as
    // `panel.ts`'s `setHidden` transition guard.
    const width = `${percent.toFixed(1)}%`;
    if (this.fill !== null && this.fill.style.width !== width) {
      this.fill.style.width = width;
    }

    const text = state.paused
      ? `Recording paused — ${state.framesDone}/${state.framesTotal} frames`
      : `Recording ${Math.floor(percent)}% — ${state.framesDone}/${state.framesTotal} frames`;
    if (this.label !== null && this.label.textContent !== text) {
      this.label.textContent = text;
    }
  }

  private build(): HTMLElement {
    const root = document.createElement('div');
    root.id = 'fluoddity-recording-bar';
    root.dataset['recording'] = 'bar';
    root.style.cssText = ROOT_CSS;

    const label = document.createElement('span');
    label.style.cssText = 'flex:0 0 auto;white-space:nowrap;';
    this.label = label;

    // The track, with the fill inside it. A `<progress>` element would be the
    // semantic choice and is not worth it here: it carries heavy per-browser
    // default styling that has to be unset before it can be made to match the
    // rest of this interface, and there is nothing to gain -- the text beside it
    // already states the value for anyone who cannot see the bar.
    const track = document.createElement('div');
    track.style.cssText = TRACK_CSS;
    const fill = document.createElement('div');
    fill.style.cssText = FILL_CSS;
    track.append(fill);
    this.fill = fill;

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.dataset['recording'] = 'bar-cancel';
    // Re-enables pointer events on itself: the strip is inert so it cannot eat
    // canvas input, and this is the one part that must be clickable.
    cancel.style.cssText = CANCEL_CSS;
    cancel.addEventListener('click', () => {
      this.onCancel();
    });

    root.append(label, track, cancel);
    document.body.append(root);
    return root;
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
    this.fill = null;
    this.label = null;
  }
}

// -- styling ----------------------------------------------------------------
// Mirrors `menuBar.ts`'s vocabulary so the two read as one interface.

/**
 * Bottom-centred, deliberately.
 *
 * The top is crowded: the menu bar is pinned top-left, the mutation overlay is
 * centred beneath it, and both side panels start at `PANEL_TOP_PX` to clear
 * them. The bottom edge is empty, and an export's progress is exactly the kind
 * of ambient status that belongs out of the way of the picture.
 */
const ROOT_CSS =
  'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);' +
  'display:none;align-items:center;gap:10px;z-index:40;pointer-events:none;' +
  'padding:8px 12px;border-radius:6px;' +
  'background:rgba(28,28,30,0.94);border:1px solid rgba(255,255,255,0.12);' +
  'box-shadow:0 6px 20px rgba(0,0,0,0.5);' +
  'font:11px system-ui,sans-serif;color:#e8e8ea;';

const TRACK_CSS =
  'flex:0 0 160px;height:4px;border-radius:2px;overflow:hidden;' +
  'background:rgba(255,255,255,0.14);';

// The same blue the active tab underlines with (`settingsSection.ts`).
const FILL_CSS = 'height:100%;width:0%;background:#8ab4f8;border-radius:2px;';

const CANCEL_CSS =
  'pointer-events:auto;background:transparent;border:1px solid rgba(255,255,255,0.2);' +
  'border-radius:4px;color:#e8e8ea;cursor:pointer;' +
  'font:11px system-ui,sans-serif;padding:3px 10px;';
