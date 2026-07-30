/// <reference types="vite/client" />

/**
 * `.wgsl` imports are turned into strings by the `wgslPlugin` in
 * `vite.config.ts`, with all `#include` directives already expanded.
 */
declare module '*.wgsl' {
  const source: string;
  export default source;
}
