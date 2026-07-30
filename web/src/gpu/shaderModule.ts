/**
 * Shader compilation -- the WebGPU analogue of `reload_program` /
 * `reload_compute` in `shared/gl_utils.py:134-178`.
 *
 * Invariant 5 says shader setup is isolated in a helper and compile failure is
 * **logged, not fatal**: the program is left as it was, which at startup means
 * null, and callers guard on null. The reload *triggers* are gone (they have no
 * browser meaning), but that shape survives, and it is what this module keeps.
 *
 * ## The one real translation
 *
 * GLSL compile errors are synchronous -- moderngl raises and the Python catches.
 * WGSL errors surface **asynchronously** via `compilationInfo()`, and
 * `createShaderModule` returns a `GPUShaderModule` object even for source that
 * failed to compile. So failure is not detected by catching: it is decided by
 * inspecting the messages for `type === 'error'`.
 *
 * There is no analogue of `gl_utils.py`'s `tryset()` here. It exists because
 * GLSL drivers strip unused uniforms and ModernGL raises on assigning a missing
 * one; WebGPU validates against an explicit bind group layout instead, so there
 * is nothing to tolerate. Recorded so a later step does not go looking for it.
 */

/**
 * Compile a WGSL module. Never throws.
 *
 * Returns null on failure, having logged the diagnostics. `label` is used both
 * in the log line and as the module's debug label.
 */
export async function compileModule(
  device: GPUDevice,
  label: string,
  code: string,
): Promise<GPUShaderModule | null> {
  let module: GPUShaderModule;
  try {
    // Errors here are pushed to the error scope / uncapturederror rather than
    // thrown, but a malformed call can still throw -- hence the guard.
    module = device.createShaderModule({ label, code });
  } catch (err) {
    console.error(`Failed to compile ${label}: ${String(err)}`);
    return null;
  }

  let info: GPUCompilationInfo;
  try {
    info = await module.getCompilationInfo();
  } catch (err) {
    console.error(`Failed to read compilation info for ${label}: ${String(err)}`);
    return null;
  }

  const errors = info.messages.filter((m) => m.type === 'error');
  const warnings = info.messages.filter((m) => m.type === 'warning');

  for (const w of warnings) {
    console.warn(`${label}:${w.lineNum}:${w.linePos}: ${w.message}`);
  }

  if (errors.length > 0) {
    // Line numbers refer to the EXPANDED source, since neither GLSL nor WGSL
    // has a usable `#line`. The `// ==== begin include: name ====` banners the
    // resolver emits are what maps a line number back to its origin file.
    console.error(`Failed to compile ${label}:`);
    for (const e of errors) {
      console.error(`  ${label}:${e.lineNum}:${e.linePos}: ${e.message}`);
    }
    return null;
  }

  console.log(`${label} compiled successfully`);
  return module;
}
