import { defineConfig } from 'vite';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { wgslPlugin } from './tools/wgslInclude.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    // Resolves `#include "..."` in every imported .wgsl file at build time, so
    // `common.wgsl` stays one hand-authored source of truth (invariant 8).
    //
    // `sharedDir` is the fallback for includes not found beside the including
    // file -- the analogue of the Python's `shared/shaders`. Note the port's
    // shared shaders live under `src/shaders`; when Steps 4-5 add per-module
    // shader directories, the resolver's sibling-first lookup handles them
    // with no change here.
    wgslPlugin({ sharedDir: path.join(here, 'src', 'shaders') }),
  ],
  server: { port: 5173 },
  build: { target: 'esnext' },
});
