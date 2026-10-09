/**
 * The Camera tab: start and stop the camera, choose how its picture moves the
 * particles, and watch the field it produces.
 *
 * ONE BUILDER FOR BOTH APPS. `buildCameraControls` takes any Tweakpane
 * container -- the studio's tab folder or sand's tab page -- and a `Webcam`, and
 * owns nothing else; `buildCameraSection` adapts it to the studio's
 * `SectionHandle`, and `sandPrefs.ts` calls it directly. The two apps' Camera
 * tabs are therefore the same controls by construction, differing only in which
 * `Webcam` (and so which saved setup) they are pointed at.
 *
 * Rendered directly rather than through the settings registry, for the reason
 * `linkSection.ts` gives: these are not `Preferences` and there is no payload to
 * bind against. The `Webcam` is the source of truth; this is a view onto it,
 * re-read every frame so a change made elsewhere (a facing switch resetting the
 * mirror) shows up here.
 *
 * ## The camera outlives this tab
 *
 * Hiding the tab, or the panel rebuilding it, does not stop the camera -- the
 * `Webcam` belongs to `main.ts`, not to this section. Only Stop stops it.
 */

import type { FolderApi, TabPageApi } from 'tweakpane';
import type { Status } from '../../orchestrator/commands.ts';
import type { Webcam } from '../../webcam/webcam.ts';
import {
  type CameraDestination,
  type CameraDirection,
  type CameraFacing,
  type CameraMapping,
  CAMERA_DESTINATIONS,
  CAMERA_DESTINATION_HELP,
  CAMERA_DESTINATION_LABELS,
  CAMERA_DIRECTIONS,
  CAMERA_DIRECTION_LABELS,
  CAMERA_FACINGS,
  CAMERA_FACING_LABELS,
  CAMERA_MAPPINGS,
  CAMERA_MAPPING_HELP,
  CAMERA_MAPPING_LABELS,
  MAX_CAMERA_GAIN,
} from '../../webcam/webcamSettings.ts';
import type { SectionContext, SectionHandle } from './section.ts';

/** Attach a hover explanation to a control. Each app has its own mechanism. */
export type AttachHelp = (element: HTMLElement, title: string, body: string) => void;

export interface CameraControlsHandle {
  /** Re-read the `Webcam` into the controls. Call once per frame. */
  readonly refresh: () => void;
  /** Hand the preview canvas back. Call when the container is torn down. */
  readonly dispose: () => void;
}

/** `{label: value}`, the shape Tweakpane's list options take. */
function optionsOf<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const v of values) out[labels[v]] = v;
  return out;
}

/**
 * A clickable callout at the top of the tab. The studio's says what the camera
 * works best with and sets it up; sand has no Project panel to point at, and
 * passes none.
 */
export interface CameraNotice {
  /** Bold lead-in, e.g. "Attention!". */
  readonly lead: string;
  readonly text: string;
  /** The underlined call to action at the end. */
  readonly action: string;
  readonly onClick: () => void;
}

export function buildCameraControls(
  container: FolderApi | TabPageApi,
  webcam: Webcam,
  help: AttachHelp,
  notice?: CameraNotice,
): CameraControlsHandle {
  // Every binding reads from this one mirror, refreshed from the Webcam each
  // frame. `refreshing` is what tells a change event the USER made apart from
  // one `refresh()` caused by writing the mirror -- echoing the latter back
  // through `update` would be harmless but would rewrite storage every frame.
  const proxy = { ...webcam.settings };
  let refreshing = false;
  const tag = (el: HTMLElement, key: string): void => {
    el.dataset['setting'] = `camera.${key}`;
  };

  // --- start / stop ---------------------------------------------------------
  const startButton = container.addButton({ title: 'Start Camera' });
  tag(startButton.element, 'start');
  startButton.on('click', () => {
    webcam.toggle();
  });
  help(
    startButton.element,
    'Start / Stop Camera',
    'Turn the camera on or off. It is always off when the page opens, and ' +
      'stays on while this tab is hidden.',
  );

  // The status line: the error when there is one, otherwise what the camera is
  // doing. Created here, INSERTED below once every blade exists -- see there.
  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;line-height:1.4;padding:2px 8px 6px;opacity:0.75;';

  // --- the controls -----------------------------------------------------------
  type Key = keyof typeof proxy;
  const blades: { refresh(): void }[] = [];
  const bind = (
    key: Key,
    params: Record<string, unknown>,
    title: string,
    body: string,
    apply: (value: never) => void,
  ): HTMLElement => {
    const blade = container.addBinding(proxy, key, params);
    tag(blade.element, key);
    help(blade.element, title, body);
    blade.on('change', (ev) => {
      if (refreshing) return;
      apply(ev.value as never);
    });
    blades.push(blade);
    return blade.element;
  };

  bind(
    'facing',
    { label: 'Camera', options: optionsOf(CAMERA_FACINGS, CAMERA_FACING_LABELS) },
    'Camera',
    'Which camera to use on a phone or tablet. A computer with one webcam uses ' +
      'it either way.',
    (v: CameraFacing) => webcam.update({ facing: v }),
  );
  bind(
    'mirror',
    { label: 'Mirror' },
    'Mirror',
    'Flip the picture left to right. On by default for the front camera, so ' +
      'moving your right hand moves the particles on the right.',
    (v: boolean) => webcam.update({ mirror: v }),
  );
  bind(
    'mapping',
    { label: 'Mapping', options: optionsOf(CAMERA_MAPPINGS, CAMERA_MAPPING_LABELS) },
    'Mapping',
    CAMERA_MAPPINGS.map((m) => `${CAMERA_MAPPING_LABELS[m]}: ${CAMERA_MAPPING_HELP[m]}`).join(
      '\n\n',
    ),
    (v: CameraMapping) => webcam.update({ mapping: v }),
  );
  bind(
    'direction',
    { label: 'Direction', options: optionsOf(CAMERA_DIRECTIONS, CAMERA_DIRECTION_LABELS) },
    'Direction',
    'Toward follows the mapping; Away reverses it -- particles flee the bright ' +
      'side of edges, or motion, instead of seeking it, and run along outlines ' +
      'the other way.',
    (v: CameraDirection) => webcam.update({ direction: v }),
  );
  bind(
    'destination',
    {
      label: 'Destination',
      options: optionsOf(CAMERA_DESTINATIONS, CAMERA_DESTINATION_LABELS),
    },
    'Destination',
    CAMERA_DESTINATIONS.map(
      (d) => `${CAMERA_DESTINATION_LABELS[d]}: ${CAMERA_DESTINATION_HELP[d]}`,
    ).join('\n\n'),
    (v: CameraDestination) => webcam.update({ destination: v }),
  );
  bind(
    'gain',
    { label: 'Gain', min: 0, max: MAX_CAMERA_GAIN, step: 0.05 },
    'Gain',
    'How strongly the camera acts on every config at once.',
    (v: number) => webcam.update({ gain: v }),
  );
  bind(
    'blur',
    { label: 'Blur', min: 0, max: 1, step: 0.01 },
    'Blur',
    'Smooth the picture before reading it. Motion wants a wide ' +
      'blur, so a hand becomes one region rather than a ridge of noise; Edges ' +
      'want little.',
    (v: number) => webcam.update({ blur: v }),
  );
  const previewToggle = bind(
    'preview',
    { label: 'Show Field' },
    'Show Field',
    'Preview the field the particles read: direction as colour (the trail ' +
      'map’s colours), strength as brightness. Not the camera picture.',
    (v: boolean) => webcam.update({ preview: v }),
  );

  // --- the preview ------------------------------------------------------------
  //
  // A canvas the Webcam renders into with the app's own device, so it costs one
  // small render pass per camera frame and no readback. Its shape follows the
  // WORLD's aspect, because the field spans the world -- a 4:3 box over a 16:9
  // world would squash the picture the particles are actually reading.
  const frame = document.createElement('div');
  frame.style.cssText = 'position:relative;margin:4px 8px 8px;';
  const canvas = document.createElement('canvas');
  canvas.dataset['setting'] = 'camera.previewCanvas';
  canvas.style.cssText =
    'display:block;margin:0 auto;border-radius:4px;background:#000;' +
    'border:1px solid rgba(255,255,255,0.12);';
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'font-size:11px;opacity:0.6;pointer-events:none;';
  frame.append(canvas, overlay);

  // BOTH INSERTED LAST, after every blade exists. Tweakpane places each new
  // blade at an INDEX among the container's children, so an element inserted
  // while blades are still being added is pushed down past all the later ones
  // -- the status line ended up under the preview rather than under its
  // button. `linkSection.ts` inserts its prose last for the same reason.
  insertAfter(startButton.element, status);
  insertAfter(previewToggle, frame);
  if (notice !== undefined) {
    startButton.element.parentElement?.insertBefore(noticeElement(notice), startButton.element);
  }

  let attached = false;
  let shownAspect = 0;
  let shownWidth = 0;
  /**
   * The thumbnail's height cap, in CSS pixels. A square world at the panel's
   * full width is a 300px block that pushes everything else off a laptop
   * screen; capped, a tall world's preview narrows and centres instead.
   */
  const MAX_PREVIEW_HEIGHT = 180;

  function syncPreview(): void {
    const wanted = webcam.settings.preview;
    frame.style.display = wanted ? '' : 'none';
    if (!wanted) return;
    // Size the backing store to the box it occupies, in device pixels, so the
    // thumbnail is sharp; and only when either changed, since resizing a
    // canvas clears it.
    const aspect = webcam.worldAspect > 0 ? webcam.worldAspect : 1;
    const available = frame.clientWidth;
    if (available > 0 && (available !== shownWidth || aspect !== shownAspect)) {
      shownWidth = available;
      shownAspect = aspect;
      const cssHeight = Math.round(Math.min(available / aspect, MAX_PREVIEW_HEIGHT));
      const cssWidth = Math.round(cssHeight * aspect);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
      canvas.width = Math.max(1, Math.round(cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(cssHeight * dpr));
      webcam.invalidatePreview();
    }
    if (!attached && canvas.isConnected) {
      webcam.attachPreview(canvas);
      attached = true;
    }
    overlay.textContent = webcam.running ? '' : 'Camera off';
  }

  function refresh(): void {
    const s = webcam.settings;
    let moved = false;
    for (const key of Object.keys(proxy) as Key[]) {
      if (proxy[key] !== s[key]) {
        (proxy as Record<Key, unknown>)[key] = s[key];
        moved = true;
      }
    }
    if (moved) {
      refreshing = true;
      try {
        for (const blade of blades) blade.refresh();
      } finally {
        refreshing = false;
      }
    }

    const state = webcam.state;
    const title =
      state === 'on' ? 'Stop Camera' : state === 'starting' ? 'Cancel' : 'Start Camera';
    if (startButton.title !== title) startButton.title = title;
    const text =
      state === 'error'
        ? (webcam.error ?? 'The camera could not be opened.')
        : state === 'starting'
          ? 'Waiting for the camera — your browser may ask for permission.'
          : state === 'on'
            ? 'Camera on.'
            : 'Camera off. Nothing here is saved with projects.';
    if (status.textContent !== text) status.textContent = text;

    syncPreview();
  }
  refresh();

  return {
    refresh,
    dispose: () => {
      if (attached) webcam.attachPreview(null);
      attached = false;
    },
  };
}

/** What the studio's Camera tab is handed. */
export interface CameraSectionOptions {
  readonly webcam: Webcam;
  /**
   * The notice's action: set the project up for the camera and show where.
   * The Panel's, because it owns both panes, the tabs and the rebuild.
   */
  readonly onSetupForCamera: () => void;
}

/**
 * The studio's Camera tab. A thin adapter: the Panel refreshes every section
 * every frame and disposes them on rebuild, which is exactly the handle
 * `buildCameraControls` returns.
 */
export function buildCameraSection(
  folder: FolderApi,
  _status: Status,
  ctx: SectionContext,
  opts: CameraSectionOptions,
): SectionHandle {
  const controls = buildCameraControls(
    folder,
    opts.webcam,
    (element, title, body) => {
      ctx.tooltip.attach(element, { title, body });
    },
    {
      lead: 'Attention!',
      text: 'Camera input works best with random initial conditions and a high hazard rate.',
      action: 'Click here to enable them',
      onClick: opts.onSetupForCamera,
    },
  );
  return {
    bindings: [],
    refresh: () => controls.refresh(),
    dispose: () => controls.dispose(),
  };
}

/**
 * The callout: bold, in the tab strip's accent, and a button so it is
 * reachable by keyboard and reads as clickable to assistive tech.
 */
function noticeElement(notice: CameraNotice): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.dataset['setting'] = 'camera.notice';
  el.style.cssText =
    'display:block;width:calc(100% - 8px);margin:4px 4px 8px;padding:8px 10px;' +
    'text-align:left;cursor:pointer;font:600 12px/1.45 system-ui,sans-serif;' +
    'color:#e8e8ea;background:rgba(138,180,248,0.14);' +
    'border:1px solid rgba(138,180,248,0.55);border-radius:6px;';
  const lead = document.createElement('span');
  lead.textContent = `${notice.lead} `;
  lead.style.color = '#8ab4f8';
  const action = document.createElement('span');
  action.textContent = notice.action;
  action.style.textDecoration = 'underline';
  el.append(lead, `${notice.text} `, action);
  el.addEventListener('click', () => {
    notice.onClick();
  });
  return el;
}

/**
 * Place `el` directly after a blade.
 *
 * Anchored on the blade rather than appended to the container, for the reason
 * `linkSection.ts`'s `noteBefore` gives: Tweakpane keeps its blades in an inner
 * element, so appending to the container puts the element after EVERY blade no
 * matter when it is called.
 */
function insertAfter(anchor: HTMLElement, el: HTMLElement): void {
  anchor.parentElement?.insertBefore(el, anchor.nextSibling);
}
