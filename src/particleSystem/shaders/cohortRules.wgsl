// ============================================================================
// cohortRules.wgsl -- bake each config slot's cohort mutation into its rule.
//
// One invocation per slot of the config buffer (see configSlots.ts for what a
// slot is). Each replaces its slot's PARENT rule with the rule that slot's
// particles obey, so entityUpdate.wgsl reads a finished rule instead of deriving
// one per particle per step.
//
// THE SAME derive_entity_rule, FROM THE SAME FILE, that deriveRule.wgsl runs for
// the archive's offline rebuild of an adopted rule. That is what keeps the
// rebuild bit-identical to the rule the particle was running: there is still
// exactly one implementation, it has just moved from "every particle, every
// step" to "every slot, every upload".
//
// IN PLACE, AND THEREFORE NOT IDEMPOTENT. Running this twice over one upload
// would mutate the already-mutated rule. The host only dispatches it after
// `uploadConfigs` has rewritten the parent configs -- see `rulesDirty` in
// particleSystem.ts.
// ============================================================================

#include "common.wgsl"
#include "rule.wgsl"

@group(0) @binding(0) var<storage, read_write> configs : array<ConfigData>;

// Studio: slot i is cohort i. Sand: every slot is cohort 0 of its own config.
// Must match the same-named constant entityUpdate.wgsl is built with; both are
// set from one field in particleSystem.ts.
override CONFIG_PER_COHORT: bool = false;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let slot = gid.x;
    if (slot >= arrayLength(&configs)) { return; }
    let cohort = select(0.0, f32(slot), CONFIG_PER_COHORT);
    let config = configs[slot];
    configs[slot].rule = derive_entity_rule(config.rule, cohort, config);
}
