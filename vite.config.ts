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
  // RELATIVE asset URLs, not absolute ones.
  //
  // The default (`/`) emits `/assets/index-HASH.js`, which only resolves when
  // the app is served from a domain root. GitHub Pages serves this project at
  // `<user>.github.io/Fluoddity2/`, so every one of those would 404 -- and the
  // failure is a blank page with no console error worth reading.
  //
  // `'./'` is preferred over the conventional `'/Fluoddity2/'` because it does
  // not hardcode the repo name: the same build works at a subpath, at a custom
  // domain, and from `npm run preview`. That also matches how the app already
  // fetches its presets -- `MANIFEST_URL` in `src/config/manifest.ts` is
  // relative for the same reason, so the whole app is location-independent.
  base: './',
  server: { port: 5173 },
  build: { target: 'esnext' },
});
