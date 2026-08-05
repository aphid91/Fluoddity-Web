/**
 * Writing to the system clipboard.
 *
 * The app's first contact with it. Note that `orchestrator/clipboardCommands.ts`
 * is NOT this: it is the config clipboard, an in-session stack of project
 * checkpoints that never leaves the page. The naming collision is the reason
 * `hotkeys.ts:105-109` moved those off Ctrl+C/V in the first place -- "on the
 * web there IS another clipboard" -- and this file is that other one.
 *
 * ## IT FAILS MORE OFTEN THAN IT LOOKS
 *
 * `navigator.clipboard.writeText` is not the reliable primitive its signature
 * suggests. It is absent entirely on a NON-SECURE ORIGIN, which is not an edge
 * case here: `vite --host` is reached at `http://192.168.x.x:5173`, so anyone
 * testing this app from a second machine on their LAN has no `navigator
 * .clipboard` at all. It also rejects when the document is not focused, and
 * under permission policies.
 *
 * So this returns a BOOLEAN rather than throwing. A share link that cannot be
 * copied is a thing to tell the user about, not an exception to propagate into
 * a keydown handler where nothing would catch it.
 *
 * ## WHY THE FALLBACK IS NOT `document.execCommand('copy')`
 *
 * That is the traditional answer and it does not work here. It is deprecated,
 * and more to the point it requires an unbroken synchronous user-gesture stack
 * -- this path has already `await`ed by the time it would run, so the gesture is
 * spent. It would fail in several of the same situations, just more quietly.
 *
 * The caller's fallback is to SHOW the user the link instead (see
 * `Panel.copyShareLink`), which needs no permission and works everywhere.
 */

/**
 * Copy `text`, reporting whether it landed.
 *
 * Never throws. `false` means the caller should show the text instead.
 */
export async function copyText(text: string): Promise<boolean> {
  // Genuinely undefined on a non-secure origin, so this is a real branch and
  // not defensive padding -- `.writeText` on `undefined` would be a TypeError
  // rather than a rejection, and would escape the `catch` below.
  if (navigator.clipboard === undefined) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
