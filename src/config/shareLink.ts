/**
 * The share link: a whole v8 document packed into a URL fragment.
 *
 * PURE, exactly as `persistence.ts` is pure -- no DOM, no fetch, no `window`.
 * `buildShareUrl` takes the pieces of a location rather than reading one, which
 * is what lets every case below run under `node --test` with no browser.
 *
 * ## A FOURTH TRANSPORT, NOT A FOURTH FORMAT
 *
 * `persistence.ts` says there is "exactly one interpreter of these bytes,
 * whether they came off the network or out of a database". A link is the third
 * place bytes can come from, and it changes nothing about that claim: this file
 * compresses and decompresses, and `fromDocument` remains the only thing that
 * decides what a document MEANS. So a link made by a future version fails in
 * `fromDocument` with its version message, not here with a vaguer one -- and
 * `decodeShareLink` deliberately returns `unknown` to keep it that way.
 *
 * ## WHY THE FRAGMENT AND NOT THE QUERY
 *
 * A fragment is never sent to the server. This app is a static deploy with no
 * backend to store anything, so the entire project has to ride in the URL, and
 * putting a couple of kilobytes of it in the query string would put it in every
 * access log and referrer header for nothing in return.
 *
 * ## TWO TRAPS THAT DICTATE THE CODE BELOW
 *
 * Both were confirmed by experiment against lz-string 1.5.0 and the real
 * `configs/`, and both fail SILENTLY, which is why each has a test of its own.
 *
 * 1. **`URLSearchParams` CORRUPTS THE PAYLOAD.** `compressToEncodedURIComponent`
 *    emits an alphabet that includes `+`, and `URLSearchParams` decodes `+` as a
 *    space -- so a payload routed through it comes back UNEQUAL to the input.
 *    The app parses its query string with that class (`main.ts:79`), so reaching
 *    for it here is the natural move and it is wrong. The fragment is parsed by
 *    `startsWith`/`slice` below, and must stay that way.
 *
 *    For the same reason the payload is NOT wrapped in `encodeURIComponent` on
 *    the way out: the compressor's alphabet is already URI-component-safe by
 *    construction -- that is the entire difference between it and plain
 *    `compress` -- and double-encoding would break the round trip.
 *
 * 2. **A TRUNCATED PAYLOAD RETURNS `''`, IT DOES NOT THROW.** Decompressing half
 *    a payload yields an empty string rather than raising. Truncation is the
 *    single likeliest thing to happen to a long link in the wild -- chat clients
 *    that linkify only part of it, mail clients that hard-wrap -- so a bare
 *    `try`/`catch` would let the commonest real failure through as a silent
 *    no-op. The empty result is checked for explicitly.
 */

// ## THE IMPORT IS AWKWARD ON PURPOSE
//
// lz-string 1.5.0 is CommonJS (`main: libs/lz-string.js`, no `exports` field)
// and its `.d.ts` declares NAMED exports the package cannot actually provide
// through Node's ESM loader. Three forms were tried, and the first two are the
// obvious ones:
//
//   - `import { compressToEncodedURIComponent } from 'lz-string'` type-checks
//     and then throws "does not provide an export named" under `node --test`.
//   - `import LZString from 'lz-string'` works at runtime but is a type error
//     here: `verbatimModuleSyntax` is on and `esModuleInterop` is not.
//   - `import * as LZString` resolves, but Node puts the functions on
//     `.default` -- the namespace's own keys are literally `default` and
//     `module.exports`, so reading them off the namespace gets `undefined`.
//
// Vite's interop resolves all three in the browser, which is what makes this
// worth a comment rather than a shrug: the tempting form is GREEN IN THE APP
// AND RED IN THE TESTS, and the failure is a `TypeError` at the moment someone
// tries to share a link rather than anything the compiler will point at.
//
// So the namespace is unwrapped once, tolerating both shapes, and every use
// below goes through the two consts.
import * as LZStringNS from 'lz-string';

type LZStringApi = {
  compressToEncodedURIComponent(input: string): string;
  decompressFromEncodedURIComponent(compressed: string): string | null;
};

// `.default` under Node's CJS-to-ESM interop; the namespace itself under a
// bundler that has already unwrapped it. Neither is wrong, so accept both.
const LZString: LZStringApi =
  (LZStringNS as unknown as { default?: LZStringApi }).default ??
  (LZStringNS as unknown as LZStringApi);

const { compressToEncodedURIComponent, decompressFromEncodedURIComponent } = LZString;

/**
 * What a project opened from a link is called.
 *
 * NOT `Untitled`, which means "nothing has been loaded"; something has. And not
 * the sender's name for it, which the v8 format does not carry -- there is no
 * name field in a document, only a filename on whatever held it.
 *
 * It reads correctly as the save dialog's default filename too: a recipient who
 * hits Save gets a sensible-if-generic name pre-filled and types over it.
 *
 * Lives HERE rather than in `main.ts` because both arrival paths need it -- a
 * link in the URL at startup, and one pasted mid-session -- and the two must
 * agree, or the same link would name its project differently depending on how
 * it got there.
 */
export const SHARED_LINK_NAME = 'Shared Link';

/**
 * The fragment key this feature owns.
 *
 * KEYED (`#c=...`) RATHER THAN BARE (`#...`), which costs a few characters and
 * buys two things. The fragment stays a namespace, so a later `#about` or a v2
 * payload does not have to break every link already in circulation -- the query
 * string already has seven keys in it (`?debug`, `?preset`, `?camera`, ...) and
 * there is no reason to think the fragment will stay a one-tenant space.
 *
 * And it makes "not ours" a real answer. A bare fragment would feed any stray
 * `#section-2` from a copied anchor straight into the decompressor, turning
 * someone else's link into OUR corrupt-link error. With a key, a fragment
 * without it is simply not addressed to us and is ignored in silence.
 */
export const SHARE_HASH_KEY = 'c';

/** The literal prefix, assembled once so encode and decode cannot disagree. */
const PREFIX = `${SHARE_HASH_KEY}=`;

/**
 * Above this, warn -- never refuse.
 *
 * NOT A BROWSER LIMIT. Chrome's omnibox handles ~32k and Firefox more, so the
 * browser is not what breaks. What breaks is everything BETWEEN two people:
 * chat clients that auto-linkify only the first N characters, mail clients that
 * hard-wrap at 78 columns, forum software that truncates. 8000 sits well under
 * where any of those start biting.
 *
 * Measured, so the number is not a guess: one config encodes to ~1800
 * characters and every one of the 175 shipped presets holds exactly one, so a
 * project has to reach roughly seven configs before this triggers at all.
 *
 * A WARNING, because the link is still perfectly valid and still works when
 * pasted whole. A user who knows their channel is fine should not be stopped by
 * our guess about it.
 */
export const SHARE_LINK_WARN_LENGTH = 8000;

/** Thrown for a fragment that IS ours but will not yield a document. */
export class ShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkError';
  }
}

/**
 * A document as a URL fragment, INCLUDING the leading `#`.
 *
 * The `#` is included so callers concatenate rather than remember to add it;
 * `decodeShareLink` accepts it either way, so nothing has to strip it back off.
 */
export function encodeShareLink(document: unknown): string {
  // No `encodeURIComponent` here. See trap 1 in the file header.
  return `#${PREFIX}${compressToEncodedURIComponent(JSON.stringify(document))}`;
}

/**
 * The document a fragment carries, or `null` when the fragment is not ours.
 *
 * THREE OUTCOMES, and they are deliberately distinct -- collapsing any two
 * would either swallow a broken link or blame us for someone else's anchor:
 *
 *   - `null`   -- no `c=` key. Not ours; the caller starts up normally and says
 *                 nothing, because nothing was asked of it.
 *   - throws   -- our key, but the payload will not decompress or parse. The
 *                 caller should tell the user their link is damaged.
 *   - a value  -- UNVALIDATED JSON. `fromDocument` is still the only reader; see
 *                 the header on why this returns `unknown`.
 *
 * Takes the fragment with or without its leading `#`, so `location.hash` can be
 * passed straight in.
 */
export function decodeShareLink(hash: string): unknown | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  // `startsWith`/`slice`, NEVER `URLSearchParams`. See trap 1 in the header.
  if (!body.startsWith(PREFIX)) return null;
  const payload = body.slice(PREFIX.length);
  if (payload === '') {
    throw new ShareLinkError('the share link carries no data');
  }

  // Returns `null` for input it cannot make sense of, and `''` for a payload
  // that was cut short -- see trap 2. Neither is an exception, so neither would
  // be caught by wrapping this call in a `try`.
  let json: string | null;
  try {
    json = decompressFromEncodedURIComponent(payload);
  } catch {
    // Not documented as throwing, but it indexes into a lookup table and this
    // is a hostile input path. Treated as the damage it is rather than trusted.
    json = null;
  }
  if (json === null || json === '') {
    throw new ShareLinkError(
      'the share link is damaged or incomplete -- it was most likely truncated ' +
        'somewhere between being copied and being opened',
    );
  }

  try {
    return JSON.parse(json);
  } catch {
    // Decompressed to SOMETHING, but not to JSON. Distinguished from the case
    // above because it means the payload survived intact and is simply not a
    // share link -- a different thing to have gone wrong, even if the user's
    // remedy is the same.
    throw new ShareLinkError('the share link did not contain a readable config');
  }
}

/**
 * The document inside whatever the user had on their clipboard.
 *
 * `decodeShareLink` takes a FRAGMENT; this takes anything and finds the
 * fragment in it, because what is actually on a clipboard is rarely as tidy as
 * `location.hash`. All of these are things people really paste:
 *
 *   - a whole URL, which is the normal case
 *   - a bare `#c=...`, from someone who selected only the fragment
 *   - a bare `c=...`, from a selection that missed the `#` too
 *   - any of the above wrapped in whitespace or newlines, which is what a
 *     mail client that hard-wrapped the link leaves behind
 *
 * Splits on the FIRST `#`, so a URL whose query somehow contains one still
 * yields the right tail, and returns `null` when there is no `c=` anywhere --
 * "this is not a share link" being a different answer from "it is damaged", the
 * same three-way distinction `decodeShareLink` draws and for the same reason.
 *
 * Throws `ShareLinkError` for text that IS a share link and will not decode.
 */
export function decodeShareText(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Everything after the first `#`, or the whole string when there is none --
  // which is what makes a bare `c=...` work without a special case.
  const hashAt = trimmed.indexOf('#');
  const fragment = hashAt === -1 ? trimmed : trimmed.slice(hashAt + 1);

  // Whitespace INSIDE the payload, not just around it: a link that survived a
  // hard-wrapping mail client comes back with a newline in the middle of it,
  // and the compressor's alphabet contains no whitespace at all, so anything
  // matching this cannot be payload and can only be damage from transit.
  return decodeShareLink(fragment.replace(/\s+/g, ''));
}

/**
 * A whole shareable URL for a document.
 *
 * Takes the location's PIECES rather than a `Location`, which keeps this pure
 * and testable -- and keeps the GitHub Pages subpath honest: `vite.config.ts`
 * sets `base: './'` precisely so the app does not care where it is served from,
 * and a hardcoded origin here would quietly undo that.
 *
 * THE QUERY STRING IS PRESERVED. Dropping it is the obvious instinct and it is
 * wrong: someone sharing from `?debug` or `?nopanel` would hand out a link that
 * shows the recipient something different from what they were looking at.
 */
export function buildShareUrl(
  loc: { readonly origin: string; readonly pathname: string; readonly search: string },
  document: unknown,
): string {
  return `${loc.origin}${loc.pathname}${loc.search}${encodeShareLink(document)}`;
}
