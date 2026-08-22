/**
 * Moving user saves between IndexedDB and a folder of `.json` files.
 *
 * ## THERE IS NO CONVERSION HERE, AND THAT IS THE WHOLE POINT
 *
 * A save in IndexedDB already IS a v8 document: `idb.ts` stores what
 * `toDocument` produced, byte for byte, unparsed (`idb.ts:8-15` says why). So
 * export is a copy and import is a copy. Nothing in this file rewrites a
 * document, adds a field, or bumps a version -- if it did, `persistence.ts`
 * would no longer be the single interpreter of these bytes, which is the
 * invariant that lets a save written today survive a future format change.
 *
 * What this file actually does is the part that is NOT a copy: deciding what a
 * file is called, deciding whether an incoming file is allowed to land, and
 * saying what happened to the ones that did not.
 *
 * ## PURE, for the same reason `persistence.ts` is
 *
 * No `window`, no `showDirectoryPicker`, no IndexedDB. The DOM half lives in
 * `ui/saveFolder.ts` and the storage half is `ConfigStore`; this is the decision
 * layer between them, which is the only part with rules worth asserting. That
 * split is what lets the collision and validation logic be tested under
 * `node --test` with no browser and no fake picker.
 *
 * ## Import is VALIDATED, not trusted
 *
 * Every incoming document goes through `fromDocument` before it is offered for
 * writing. The file is not stored parsed -- the original bytes are what land in
 * IndexedDB, exactly as with any other save -- but a file that cannot be read is
 * rejected HERE, where the report can name it. Skipping this would move the
 * failure to whenever the user next clicked that config, with a
 * `ConfigFormatError` naming a category and a name rather than a file.
 */

import { CUSTOM_CATEGORY } from './configStore.ts';
import { type SavedConfig, fromDocument, sanitizeName } from './persistence.ts';

/** The extension exported files carry, and the one import looks for. */
export const SAVE_EXTENSION = '.json';

/** One file on the way out: a filename and the bytes to put in it. */
export interface ExportFile {
  readonly filename: string;
  readonly text: string;
}

/** One file on the way in, already read off disk. */
export interface ImportFile {
  readonly filename: string;
  readonly text: string;
}

/** A save that survived validation and collision checks, ready for the store. */
export interface ImportCandidate {
  readonly name: string;
  readonly document: unknown;
}

/** Why a file was not imported. Each maps to one line in the summary. */
export type SkipReason = 'exists' | 'unreadable' | 'unnamed';

export interface SkippedFile {
  readonly filename: string;
  readonly reason: SkipReason;
  /** The parser's complaint, for `unreadable`. Empty otherwise. */
  readonly detail: string;
}

export interface ImportPlan {
  readonly accepted: readonly ImportCandidate[];
  readonly skipped: readonly SkippedFile[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Turn saved records into named files.
 *
 * PRETTY-PRINTED with two spaces, matching what `tools/syncConfigs.ts` leaves in
 * `configs/`. These files are meant to be droppable into that directory as
 * presets, and a preset that arrives as one long line would be the only
 * unreadable file in a directory of readable ones.
 *
 * THE NAME IS RE-SANITIZED on the way out even though it was sanitized on the
 * way in. `sanitizeName` is what a name passed through to become a key, but the
 * rules have changed before -- and a record written by an older build could
 * carry something this build would not accept. Re-running it costs nothing and
 * means a filename is legal by TODAY's rules, which are the ones the filesystem
 * receiving it will enforce.
 *
 * COLLISIONS ARE NOT POSSIBLE HERE and so are not handled: the records come from
 * a store keyed by `(category, name)` and every one of them is `Custom`, so two
 * records cannot share a name. A `sanitizeName` that mapped two distinct stored
 * names onto one file would be the exception, and it cannot happen either --
 * those names were themselves produced by `sanitizeName`, which is idempotent.
 */
export function exportFiles(
  records: readonly { readonly name: string; readonly document: unknown }[],
): readonly ExportFile[] {
  const files: ExportFile[] = [];
  for (const record of records) {
    const safe = sanitizeName(record.name);
    // A record whose name sanitizes to nothing cannot be given a filename. It
    // should not exist -- `saveConfig` refuses to write one -- but a file called
    // `.json` would be a puzzle rather than a save, so it is dropped here too.
    if (safe === '') continue;
    files.push({
      filename: `${safe}${SAVE_EXTENSION}`,
      text: `${JSON.stringify(record.document, null, 2)}\n`,
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * The config name a file claims, from its filename.
 *
 * The name is taken from the FILENAME rather than from anything inside the
 * document, because a v8 document has nowhere to put one -- `SavedConfig` is
 * configs, world and notes, and `projectName` is not part of the format. That is
 * also why export writes the name into the filename: it is the only channel the
 * format leaves for it.
 */
function nameFromFilename(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const stem = base.toLowerCase().endsWith(SAVE_EXTENSION)
    ? base.slice(0, -SAVE_EXTENSION.length)
    : base;
  return sanitizeName(stem);
}

/**
 * Decide what to do with a folder full of files.
 *
 * `existing` is the names ALREADY IN `Custom` -- user saves only. A file
 * colliding with a shipped Core preset is NOT skipped, deliberately: the two
 * live in different categories, so nothing is overwritten, and forking a preset,
 * tweaking it and keeping its name is a thing people do. `entryByName` resolves
 * Core first on a tie, so the shipped one still wins the `?preset=` lookup and
 * the arrow-key cycle; the imported one stays reachable under Custom in the Load
 * menu. Blocking it would refuse a legal save to prevent an ambiguity that the
 * catalog already resolves.
 *
 * DUPLICATES WITHIN THE SAME IMPORT collide too. Two files whose names sanitize
 * to one name -- `a:b.json` and `ab.json` -- would otherwise both be accepted,
 * and the second write would silently replace the first. The first one wins and
 * the second is reported as `exists`, which is the same rule and the same
 * message as colliding with a save that was already there.
 *
 * ORDER IS PRESERVED so that "the first one wins" is a statement the caller can
 * act on: the file list comes from the picker in the folder's own order, so the
 * winner is predictable rather than whichever the filesystem happened to yield.
 */
export function planImport(
  files: readonly ImportFile[],
  existing: readonly string[],
): ImportPlan {
  // Sanitized, because that is the form the incoming names will be compared in.
  // A stored name that predates a `sanitizeName` change would otherwise fail to
  // match the file exported from it, and the save would import as a duplicate.
  const taken = new Set(existing.map((n) => sanitizeName(n)));
  const accepted: ImportCandidate[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of files) {
    const name = nameFromFilename(file.filename);
    if (name === '') {
      skipped.push({ filename: file.filename, reason: 'unnamed', detail: '' });
      continue;
    }
    if (taken.has(name)) {
      skipped.push({ filename: file.filename, reason: 'exists', detail: '' });
      continue;
    }

    // Parsed to VALIDATE and the result is then discarded -- what gets stored is
    // `document`, the original bytes. See the file header.
    let document: unknown;
    try {
      document = JSON.parse(file.text);
      readDocument(document, file.filename);
    } catch (e: unknown) {
      skipped.push({
        filename: file.filename,
        reason: 'unreadable',
        detail: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // Claimed before the next file is considered, so two files in one batch
    // cannot both take the same name.
    taken.add(name);
    accepted.push({ name, document });
  }

  return { accepted, skipped };
}

/** `fromDocument` under a name that says what it is for. Result is discarded. */
function readDocument(document: unknown, where: string): SavedConfig {
  return fromDocument(document, where);
}

/** Where imported saves land. Named so callers do not repeat the constant. */
export const IMPORT_CATEGORY = CUSTOM_CATEGORY;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * One line describing an import, for the toast.
 *
 * THE SKIPS ARE COUNTED SEPARATELY BY REASON, because they are not the same
 * event. "Already have it" is the expected outcome of re-importing a folder and
 * needs no attention; "could not be read" is a broken file the user may want to
 * look at. Merging them into one "12 skipped" would bury the second in the
 * first, which is the case where a number is worth reading.
 *
 * The user asked for collisions to be skipped SILENTLY, and they are -- silent
 * meaning no prompt and no interruption, not that the count is withheld. A
 * summary that said "imported 3" while quietly dropping 9 would leave the folder
 * and the save list disagreeing with no way to find out why.
 */
export function describeImport(plan: ImportPlan): string {
  const n = plan.accepted.length;
  const parts = [`Imported ${n} ${n === 1 ? 'save' : 'saves'}`];

  const existing = plan.skipped.filter((s) => s.reason === 'exists').length;
  const unreadable = plan.skipped.filter((s) => s.reason === 'unreadable').length;
  const unnamed = plan.skipped.filter((s) => s.reason === 'unnamed').length;

  if (existing > 0) parts.push(`${existing} already saved`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable`);
  if (unnamed > 0) parts.push(`${unnamed} unnamed`);

  return `${parts.join(' — ')}.`;
}
