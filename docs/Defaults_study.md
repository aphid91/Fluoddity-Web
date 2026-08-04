1. Default settings — yes, centralized (one object)
All Preferences defaults live in a single frozen object: preferences.ts:142-162


export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  brightness: 1.0,
  physicsSteps: 30,
  tonemapSoftness: 2.5,
  motionBlurSamples: 1,
  bloomEnabled: false,
  ...
  worldSize: 1.0,
  canvasAspect: 1.0,
  ...
});
To change what a new user sees, edit that object and nothing else. It's the only source of defaults — loadPreferences() seeds its result from it (preferences.ts:301) and returns it wholesale on every failure path (no storage, unreadable, unparseable, non-object).

Two nearby things that are not the defaults, so you don't edit the wrong one:

SETTINGS in settingsSpec.ts:198 defines each control's range (lo/hi), label, tier, and help — e.g. World Size lo: 0.05, hi: 4.0 at settingsSpec.ts:636-642, Brightness lo: 0.1, hi: 4.0 at settingsSpec.ts:681-692. No default values here.
Config/World values (particle behavior, trail decay) come from the loaded preset — Starcrossedv8 by default (configStore.ts:54) — not from Preferences. Loading someone's config deliberately never touches your brightness or canvas size.
One caveat when you edit defaults: existing users won't see the change, because their stored blob already has every key. Only genuinely-new browsers get the new defaults. If you want a change to reach everyone, bump the storage key (see below).

2. Persistence — two separate stores, so yes, you can reset independently
Preferences	Saved configs
Where	localStorage	IndexedDB
Key	fluoddity.preferences (preferences.ts:234)	DB fluoddity, store configs (idb.ts:29-31)
Written by	savePreferences(), on any pref change	ConfigStore.write(), only when you save
They share nothing but the origin. To reset preferences without touching saved configs, in the browser console:


localStorage.removeItem('fluoddity.preferences');  // then reload
Your Custom configs are untouched — they're in IndexedDB. (Note the browser's "Clear site data" button does wipe both; use the console line, not that.)

Writes are guarded: withValue returns the receiver unchanged when the value didn't actually move (preferences.ts:351-361), and the orchestrator's === check means an unmoved slider doesn't write every frame.

Two things worth knowing:

There is currently no in-app "Reset preferences" button — the console line is the only way. That's a natural small feature if you want it.
The orchestrator comment at orchestrator.ts:114 claims prefs are "Overridden by tests and by ?prefs=default", but main.ts never reads a prefs param — it only handles preset, camera, zoom, pan, bus, debug (main.ts:79-120). The preferences option exists on OrchestratorOptions and works, but nothing wires the URL to it. Either the comment is stale or the wiring got dropped; wiring it would give you a one-URL reset for free.
3. Slider ranges — yes, our code clamps, and it's two different mechanisms
Your Google result is right about Tweakpane: with min/max set, v4 does let you type past the range in the number box and it accepts the value (the slider track stays pinned, but the value goes through). So the block is ours.

For SLIDER controls (Brightness, etc.) — Tweakpane's own constraint, from controls.ts:648-652:


case SLIDER:
case GATED:
default:
  return { min: setting.lo, max: setting.hi };
Passing min/max installs a RangeConstraint. Dropping them removes the slider track entirely (you'd get a bare number field), so the usual fix is to keep the widget and widen lo/hi in the registry.

For INPUT controls (World Size, Canvas Aspect) — an explicit hard clamp in formatValue.ts:57-63:


export function parseInput(setting: Setting, text: string): number | null {
  ...
  return Math.max(setting.lo, Math.min(setting.hi, parsed));
}
Typing 10 into World Size silently becomes 4.0. Nothing downstream re-clamps — applySettingEdit (settingsCommands.ts:94-96) and withValue only coerce type (float/int/bool, reject non-finite), never range. So parseInput and Tweakpane's constraint are the entire enforcement.

Your options, in order of how much I'd recommend them:

Widen lo/hi in SETTINGS. One-line edits, keeps the slider usable, keeps the guardrails. The registry comment at settingsSpec.ts:192-194 explicitly endorses this: "Bounds are fixed and generous… Where a preset value approaches a bound, the bound is widened." Note decimalsFor derives readout precision from hi - lo, so widening a range coarsens its displayed decimals.
Let INPUT controls exceed their range — change parseInput's clamp to a rejection (return null when out of bounds) or drop it. Cheap, and World Size is the one you named. But it's the disruptive setting: a stray 100 reallocates GPU buffers at 100× and will likely hang the tab. If you do this, add a separate hard ceiling.
Add a per-setting softRange flag that omits min/max from paramsFor — a real escape hatch, but a new registry field plus a fallback for the now-trackless slider.