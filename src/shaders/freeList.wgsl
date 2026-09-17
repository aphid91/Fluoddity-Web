// ============================================================================
// freeList.wgsl -- the pool of dead particle indices.
//
// A stack of available entity indices with an atomic head. `head` is the COUNT
// of available slots, so the valid entries are `slots[0 .. head)` and the top of
// the stack is `slots[head - 1]`.
//
// ---------------------------------------------------------------------------
// WHY CREATION AND DELETION ARE SEPARATE PASSES
// ---------------------------------------------------------------------------
// Within a single pass the head moves MONOTONICALLY -- creation only ever
// decreases it, deletion only ever increases it. That is what makes an atomic
// reservation safe to act on:
//
//   * creation does atomicSub and then writes `entities[slots[prev-1]]`
//   * deletion does atomicAdd and then writes `slots[prev]`
//
// If the two ran in one pass the head could move both ways while an invocation
// held a reserved index, and two particles could be handed the same slot. This
// is the same hazard `entityPick.wgsl` documents at its head: a thread that
// loses an atomic still executes its writes, so the atomic alone is not a lock.
// Splitting the passes is what removes the interleaving, not the atomic.
//
// THE ONE PERMITTED OVERLAP is edge-death inside `advance()`, which pushes with
// atomicAdd while the deletion pass would also push. Both only ever INCREASE the
// head, so they compose -- the invariant is direction, not exclusivity. Nothing
// may atomicSub during advance(), which is precisely why spawning is hoisted out
// to once per frame.
//
// ---------------------------------------------------------------------------
// EXHAUSTION IS NORMAL, NOT AN ERROR
// ---------------------------------------------------------------------------
// A full world has an empty free list and a brush that keeps painting will hit
// it every frame. Both guards below therefore FAIL QUIETLY and put the
// reservation back, rather than clamping -- a clamped index would be a real,
// live particle that the brush then overwrites.
//
// The counter is u32, so an unguarded atomicSub at zero wraps to 4294967295 and
// indexes wildly out of range. `prev > arrayLength(&slots)` catches both that
// wrap and any genuine corruption.
// ============================================================================

struct FreeList {
    // Count of available slots. Valid entries are slots[0 .. head).
    head  : atomic<u32>,
    // Dead entity indices. Sized to the entity count -- every particle can be
    // dead at once, which is exactly the state a fresh sand world starts in.
    slots : array<u32>,
}

// Reserve one index for a NEW particle. Returns the entity index to write, or
// `NO_SLOT` when the pool is empty.
//
// Callers must test the result. Writing to NO_SLOT would index past the entity
// buffer; in WGSL that is a clamped or dropped access rather than a crash, which
// would present as one particle at index 0 behaving strangely.
const NO_SLOT: u32 = 0xffffffffu;

// ---------------------------------------------------------------------------
// THE OPERATIONS LIVE IN `freeListOps.wgsl`, NOT HERE, AND THE SPLIT IS FORCED.
//
// They name the `freelist` binding directly rather than taking a pointer to it.
// The natural signature -- `fn take(fl: ptr<storage, FreeList, read_write>)` --
// is deliberately NOT used: a pointer parameter in the `storage` address space
// requires the `unrestricted_pointer_parameters` language feature, which is not
// baseline WebGPU. A shader using one compiles on some implementations and
// fails on others, which is exactly the device-matrix narrowing that the
// texture-format rule in common.wgsl exists to avoid.
//
// Naming the binding means the functions must be declared AFTER it, and the
// struct must be declared BEFORE it. One file cannot be both, hence two:
//
//     #include "freeList.wgsl"        // the struct
//     @group(0) @binding(N) var<storage, read_write> freelist : FreeList;
//     #include "freeListOps.wgsl"     // the operations
//
// Every including shader must declare a binding named exactly `freelist`. That
// is a real coupling, stated here so a shader adding these includes knows what
// it owes; a missing or misnamed binding is a compile error naming `freelist`,
// which is loud rather than silent.
// ---------------------------------------------------------------------------
