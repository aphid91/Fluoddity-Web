/**
 * WGSL `#include` resolution -- the TypeScript port of `shared/gl_utils.py:22-70`.
 *
 * WGSL, like GLSL, has no preprocessor include. Without this, shared structs
 * would have to be copy-pasted into every shader that uses them -- which is
 * exactly how the reference implementation's struct definitions drifted out of
 * sync. Per ARCHITECTURE.md invariant 8, `common.wgsl` is the single
 * hand-authored source of truth for struct layout, and every shader that needs
 * those structs `#include`s it.
 *
 * This runs at BUILD time (see `wgslPlugin` below), not per frame. That is the
 * one deliberate difference from the Python original -- see `resolveIncludes`.
 *
 * The resolver is kept free of any Vite import so it can be unit-tested as a
 * plain function; `wgslPlugin` is the thin wrapper that hooks it into the build.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Matches `#include "name"`, anchored and strict: leading and trailing
 * whitespace are allowed but nothing else may share the line, and only the
 * double-quoted form exists (there is no `<...>` form).
 *
 * Copied verbatim from `gl_utils.py:19`. Note that, as in the Python, there is
 * no comment stripping -- a `//`-commented `#include` still resolves. No shader
 * relies on that either way; it is recorded so the behaviours stay identical.
 */
const INCLUDE_RE = /^\s*#include\s+"([^"]+)"\s*$/;

export interface ResolveOptions {
  /**
   * Fallback directory for includes not found beside the including file.
   * The analogue of `gl_utils.py`'s `_SHARED_SHADER_DIR`.
   */
  sharedDir: string;
  /**
   * Called once per successfully resolved include, with its absolute path.
   * Used by the Vite plugin to register watch files so that editing
   * `common.wgsl` invalidates every shader that includes it.
   */
  onDependency?: (absolutePath: string) => void;
}

/**
 * Read a shader, resolving `#include "file.wgsl"` directives.
 *
 * Each file is included at most once per compilation unit (include-guard
 * semantics), so a diamond include does not produce duplicate definitions.
 * The guard set is created fresh per call, which is what makes "compilation
 * unit" mean "one entry file" -- a vertex and a fragment shader that both
 * include `common.wgsl` each correctly get their own copy.
 *
 * ## Divergence from the Python original, and why
 *
 * In the desktop app a missing include raises `FileNotFoundError`, which
 * `reload_program`'s bare `except` catches and downgrades to a printed message
 * (invariant 5: compile failure is logged, not fatal).
 *
 * Here the resolver runs at BUILD time, where there is no frame to degrade
 * into and no previous program to fall back to -- a missing include is simply
 * a broken build, so this throws and stops the build. Invariant 5's non-fatal
 * rule still applies to the port, but to the *compilation* stage, which on the
 * web is separate: see `compileModule` in `src/gpu/shaderModule.ts`.
 *
 * Do not "fix" this back to a warning.
 */
export function resolveIncludes(entryPath: string, opts: ResolveOptions): string {
  return readWithIncludes(path.resolve(entryPath), opts, new Set<string>());
}

function readWithIncludes(
  filePath: string,
  opts: ResolveOptions,
  alreadyIncluded: Set<string>,
): string {
  const source = fs.readFileSync(filePath, 'utf8');
  const outLines: string[] = [];

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = INCLUDE_RE.exec(line);
    if (match === null) {
      outLines.push(line);
      continue;
    }

    const target = resolveInclude(match[1]!, filePath, i + 1, opts.sharedDir);
    if (alreadyIncluded.has(target)) {
      // Already pulled in by another include; emit nothing.
      continue;
    }

    // Marked BEFORE recursing, exactly as in the Python. This ordering is what
    // makes a cycle (A -> B -> A) terminate instead of recursing forever; if
    // the add moved below the recursive call, a cycle would blow the stack.
    alreadyIncluded.add(target);
    opts.onDependency?.(target);

    // WGSL has no `#line` directive at all, so error offsets from
    // `compilationInfo()` refer to the expanded text. These banners are the
    // only thing that maps an offset back to the file it came from -- the same
    // reasoning as the Python's comment, which rejected GLSL's `#line` for
    // being driver-inconsistent.
    const name = path.basename(target);
    outLines.push(`// ==== begin include: ${name} ====`);
    outLines.push(readWithIncludes(target, opts, alreadyIncluded));
    outLines.push(`// ==== end include: ${name} ====`);
  }

  // Joining with '\n' also normalizes CRLF, which matters on Windows: a stray
  // '\r' inside a WGSL token is a compile error in some implementations.
  return outLines.join('\n');
}

/**
 * Find an included file: sibling of the includer first, then the shared dir.
 *
 * Exactly two search paths, in that order -- no project root, no upward search,
 * no configurable include-path list. Sibling-first is what will let each module
 * keep its own `shaders/` directory (invariant 6) as the port grows.
 */
function resolveInclude(
  name: string,
  includingFile: string,
  lineNo: number,
  sharedDir: string,
): string {
  const includingDir = path.dirname(includingFile);
  for (const candidate of [path.join(includingDir, name), path.join(sharedDir, name)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    `${includingFile}:${lineNo}: #include "${name}" not found ` +
      `(looked in ${includingDir} and ${sharedDir})`,
  );
}

/**
 * Minimal shape of the Vite plugin object we produce. Declared structurally so
 * this module stays importable by the test file without pulling in Vite.
 */
interface WgslPlugin {
  name: string;
  transform(
    this: { addWatchFile(id: string): void },
    code: string,
    id: string,
  ): { code: string; map: null } | undefined;
}

/**
 * Vite plugin: turns any imported `.wgsl` file into a default-exported string
 * with its `#include`s already expanded.
 *
 * Registering each resolved dependency via `addWatchFile` means editing
 * `common.wgsl` invalidates every shader that includes it, so the dev server
 * reflects the edit. That is build tooling, not the runtime shader hot-reload
 * affordance -- invariant 5 notes that the reload *triggers* (the `U` key, the
 * menu item, the Debug panel button) have no browser meaning and are gone.
 */
export function wgslPlugin(opts: ResolveOptions): WgslPlugin {
  return {
    name: 'fluoddity-wgsl-include',
    transform(this: { addWatchFile(id: string): void }, _code: string, id: string) {
      if (!id.endsWith('.wgsl')) return undefined;

      // Strip any Vite query suffix (e.g. `?used`, `?t=123`) before touching disk.
      const filePath = id.split('?')[0]!;
      const source = resolveIncludes(filePath, {
        ...opts,
        onDependency: (dep) => {
          this.addWatchFile(dep);
          opts.onDependency?.(dep);
        },
      });

      return { code: `export default ${JSON.stringify(source)};`, map: null };
    },
  };
}
