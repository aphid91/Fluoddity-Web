/**
 * A `RuleDeriver` backed by a real WebGPU device.
 *
 * ## WHY THIS IS THE ONLY CORRECT IMPLEMENTATION
 *
 * `reconstruct.ts` needs `derive_entity_rule` to rebuild a cohort selection, and
 * `rule.wgsl`'s header sets out at length why that function must not be
 * reimplemented in another language: `pow(h, 2.0)` versus `h*h` differs by 1 ULP
 * and the chaotic hash amplifies it into a completely different rule; the
 * generator leans on a fused multiply-add the GPU performs and a host generally
 * will not. The desktop kept such a mirror in `mutation.py`, the web port
 * deleted it, and the failure mode is a rule that looks entirely legitimate and
 * is wrong.
 *
 * So this runs THE ACTUAL SHADER on a device, through the same `rule.wgsl` the
 * simulation and the picker call. A rule it returns is bit-identical to the one
 * the user adopted, because it is computed by the same code on the same kind of
 * hardware.
 *
 * ## THE CONFIG IS PACKED BY `pack.ts`
 *
 * Not hand-assembled here. `writeConfigRecord` is what fills the ConfigBuffer
 * the simulation reads, so reusing it means the bytes the deriver hands the GPU
 * are the bytes the GPU would have had -- including the int lanes written
 * through an `Int32Array` view, which a hand-rolled packer is exactly the place
 * to get subtly wrong.
 *
 * Only three fields actually matter to `derive_entity_rule` (`rule`,
 * `mutationSeed`, `mutationScale`), but a full record is packed anyway: a
 * partial one would depend on the shader continuing to ignore the rest, which is
 * not a property anything guarantees.
 *
 * ## LIFETIME
 *
 * `createGpuDeriver` builds the pipeline and buffers ONCE and returns a deriver
 * that reuses them. Reconstructing a thousand selections is a thousand small
 * dispatches, not a thousand pipeline compiles.
 *
 * The returned deriver is ASYNCHRONOUS, because a readback is. `reconstruct`
 * takes a synchronous `RuleDeriver`, so the intended pattern is `deriveAll` --
 * pre-derive every selection in one pass, then hand `reconstruct` a synchronous
 * lookup over the results. That is also the efficient shape: one submission per
 * rule rather than one per reconstruction attempt.
 */

import { RULE_FLOAT_COUNT, type SimulationConfig } from '../particleSystem/config.ts';
import { CONFIG_DATA_STRIDE, writeConfigRecord } from '../particleSystem/pack.ts';
import type { RuleDeriver } from './reconstruct.ts';

/** What `derive_entity_rule` is asked. Mirrors `RuleDeriver`'s input exactly. */
export interface DeriveRequest {
  readonly rule: readonly number[];
  readonly cohort: number;
  readonly mutationSeed: number;
  readonly mutationScale: number;
}

/** 320 bytes: 10 FourierCenters x (frequency vec4 + amplitude vec4). */
const RULE_BYTES = RULE_FLOAT_COUNT * 4;

/** A device-backed deriver, plus the resources it holds. */
export interface GpuDeriver {
  /** Derive one rule. Async because the readback is. */
  derive(request: DeriveRequest): Promise<readonly number[]>;
  /** Derive many, in order. One submission each; the pipeline is shared. */
  deriveAll(requests: readonly DeriveRequest[]): Promise<readonly (readonly number[])[]>;
  destroy(): void;
}

/**
 * Build a deriver on `device` from already-expanded WGSL.
 *
 * `source` is the EXPANDED `deriveRule.wgsl` -- includes resolved, the same text
 * the app's Vite plugin would produce. Taking it as a parameter rather than
 * importing it keeps this module usable from a plain browser page (where there
 * is no bundler to run the include plugin) as well as from the app.
 */
export async function createGpuDeriver(
  device: GPUDevice,
  source: string,
): Promise<GpuDeriver> {
  const module = device.createShaderModule({ code: source, label: 'deriveRule' });

  // Surfaced rather than left to fail at pipeline creation: a WGSL error here is
  // the single likeliest thing to go wrong, and the compiler's own message names
  // the line where a bare "pipeline failed" would not.
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    throw new Error(
      `deriveRule.wgsl failed to compile:\n${errors
        .map((m) => `  ${m.lineNum}:${m.linePos} ${m.message}`)
        .join('\n')}`,
    );
  }

  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'derive' },
  });

  const configBuffer = device.createBuffer({
    size: CONFIG_DATA_STRIDE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: 'deriveRule.config',
  });
  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: 'deriveRule.params',
  });
  const resultBuffer = device.createBuffer({
    size: RULE_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    label: 'deriveRule.result',
  });
  // A separate MAP_READ buffer, because a STORAGE buffer cannot be mapped.
  const readback = device.createBuffer({
    size: RULE_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    label: 'deriveRule.readback',
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: configBuffer } },
      { binding: 1, resource: { buffer: paramsBuffer } },
      { binding: 2, resource: { buffer: resultBuffer } },
    ],
  });

  /**
   * A full `SimulationConfig` carrying the three fields that matter.
   *
   * The rest are filled with values that pack cleanly rather than with anything
   * meaningful -- `derive_entity_rule` reads only the rule, the seed and the
   * scale. `cohorts` must be at least 1 because it is an int lane the packer
   * writes, not because the shader reads it here.
   */
  function configFor(request: DeriveRequest): SimulationConfig {
    return {
      cohorts: 1,
      mutationSeed: request.mutationSeed,
      sensorGain: 0,
      sensorAngle: 0,
      sensorDistance: 0,
      mutationScale: request.mutationScale,
      globalForceMult: 0,
      drag: 0,
      strafePower: 0,
      axialForce: 0,
      lateralForce: 0,
      hazardRate: 0,
      gravityForce: 0,
      gravityStrafe: 0,
      initialConditions: 0,
      cohortFences: false,
      colorSensitivity: 0,
      colorByCohort: false,
      sensorAngleJitter: 0,
      sensorDistanceJitter: 0,
      radialGravity: false,
      rule: request.rule,
    };
  }

  async function derive(request: DeriveRequest): Promise<readonly number[]> {
    if (request.rule.length !== RULE_FLOAT_COUNT) {
      throw new Error(
        `a rule must be ${RULE_FLOAT_COUNT} floats, got ${request.rule.length}`,
      );
    }

    const record = new ArrayBuffer(CONFIG_DATA_STRIDE);
    writeConfigRecord(configFor(request), record, 0);
    device.queue.writeBuffer(configBuffer, 0, record);

    // The cohort as f32. Already floored by the picker when it was recorded, and
    // floored again inside `derive_entity_rule` -- see the shader.
    device.queue.writeBuffer(
      paramsBuffer,
      0,
      new Float32Array([request.cohort, 0, 0, 0]),
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(resultBuffer, 0, readback, 0, RULE_BYTES);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(GPUMapMode.READ);
    // COPIED OUT BEFORE UNMAPPING. The mapped range is invalidated by `unmap`,
    // so a view onto it becomes a detached buffer -- reading it afterwards is
    // zeros rather than an error.
    const out = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
    readback.unmap();
    return out;
  }

  return {
    derive,
    async deriveAll(requests) {
      const out: (readonly number[])[] = [];
      // Sequential rather than parallel: the buffers are shared, so two
      // in-flight derivations would race over one config buffer and one
      // readback. The cost is a submission each, which for the handful of
      // selections in a real archive is nothing.
      for (const request of requests) out.push(await derive(request));
      return out;
    },
    destroy() {
      configBuffer.destroy();
      paramsBuffer.destroy();
      resultBuffer.destroy();
      readback.destroy();
    },
  };
}

/**
 * A synchronous `RuleDeriver` over already-computed rules.
 *
 * The bridge between an async GPU pass and `reconstruct`, which is synchronous
 * by design -- it is pure value-shuffling and should stay callable from a test.
 * Pre-derive with `deriveAll`, key the results, and hand the lookup in.
 *
 * Keyed on the REQUEST, not on a node hash, so one derivation serves every node
 * that happens to ask the same question -- and so the cache is meaningful across
 * archives.
 */
export function derivationKey(request: DeriveRequest): string {
  // The rule participates: two configs sharing a seed and cohort but differing
  // in their base rule mutate to different places. Joined with a separator that
  // cannot appear in a number's own text.
  return [
    request.cohort,
    request.mutationSeed,
    request.mutationScale,
    request.rule.join(','),
  ].join('|');
}

/** Wrap a precomputed table as the synchronous deriver `reconstruct` takes. */
export function tableDeriver(table: ReadonlyMap<string, readonly number[]>): RuleDeriver {
  return (request) => {
    const found = table.get(derivationKey(request));
    if (found === undefined) {
      // Louder than returning zeros, which would be a silent wrong answer -- the
      // exact failure this whole module exists to avoid.
      throw new Error(
        `no derived rule for cohort ${request.cohort} seed ${request.mutationSeed}`,
      );
    }
    return found;
  };
}
