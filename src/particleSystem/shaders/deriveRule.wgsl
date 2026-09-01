// ============================================================================
// deriveRule.wgsl -- run derive_entity_rule off the simulation, for the archive.
//
// WHY THIS EXISTS. A `selection` delta stores the COHORT NUMBER rather than the
// eighty floats a cohort commit produced, because the adopted rule is a pure
// function of the parent config and that number (`archive/delta.ts`). Rebuilding
// the state offline therefore means evaluating that function -- and there is
// exactly one correct implementation of it.
//
// `rule.wgsl`'s header is emphatic about why a host-side mirror is not an
// option: `pow(h, 2.0)` versus `h*h` differs by 1 ULP and the chaotic hash
// amplifies that into a COMPLETELY DIFFERENT RULE, and the generator leans on a
// fused multiply-add the GPU performs and a CPU generally will not. The desktop
// had such a mirror (`mutation.py`), the web port deleted it, and a wrong
// adopted rule looks exactly like a legitimate one. So the archive does not
// reimplement the maths -- it runs it, here, on a real device.
//
// This is the SAME `derive_entity_rule` the simulation and the picker call, from
// the same file. Not a copy: `#include "rule.wgsl"` is the whole point, and it
// is what makes a reconstructed rule bit-identical to the one the user adopted.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT NEED
// ---------------------------------------------------------------------------
// No entities, no world, no pick. `derive_entity_rule` reads only `config.rule`,
// `cfg_mutation_seed`, `cfg_mutation_scale` and a cohort -- so this binds one
// ConfigData and one float and writes one Rule. The entity buffer that
// `entityPick.wgsl` reduces over is not part of the question being asked here:
// WHICH particle won was decided when the user clicked, and the archive already
// recorded its cohort.
//
// **THE COHORT IS PASSED IN, NOT DERIVED.** `get_cohort` divides by
// `arrayLength(&entities)`, so reproducing it would need the entity count the
// session was running at -- a property of the machine, not of the project, and
// deliberately not in the archive. `entityPick.wgsl` already floors the cohort
// before reporting it (`result.cohort = floor(cohort)`), and `derive_entity_rule`
// floors it again for the rule seed, so the integer the archive stored is
// exactly what the shader needs. Passing it directly is not a shortcut around
// `get_cohort`; it is the value `get_cohort` produced.
//
// ONE INVOCATION, for `entityPick.wgsl`'s reason: several threads racing to
// write the same 320 bytes would probably even LOOK correct, since they all
// compute the same value.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES HERE AND NOT IN `archive/`
// ---------------------------------------------------------------------------
// It is a tool for the archive, so `src/archive/shaders/` is where it wants to
// be. `wgslInclude.ts` resolves an include as a SIBLING of the including file
// first and the shared directory second -- no project root and no include-path
// list (`:118-123`) -- and `rule.wgsl` is neither of those from `archive/`. So
// this sits beside the file it exists to run, which is also where the two other
// callers of `derive_entity_rule` sit. Moving `rule.wgsl` to `shaders/` to allow
// the tidier location would put a file two hot shaders include into the shared
// directory for the benefit of an offline tool, which is the wrong trade.
// ============================================================================

#include "common.wgsl"
#include "rule.wgsl"

// The parent config, packed by `pack.ts` exactly as the ConfigBuffer is -- so
// the bytes this reads are the bytes the simulation would have read.
@group(0) @binding(0) var<storage, read> config : ConfigData;

// x: the cohort, as an f32. Already floored by the picker when it was recorded;
// `derive_entity_rule` floors it again, so a stray fraction cannot change the
// answer. yzw reserved.
struct DeriveParams {
    params : vec4f,
}
@group(0) @binding(1) var<uniform> u : DeriveParams;

// The derived rule: 320 bytes, read back by the host.
@group(0) @binding(2) var<storage, read_write> result : Rule;

@compute @workgroup_size(1)
fn derive() {
    result = derive_entity_rule(config.rule, u.params.x, config);
}
