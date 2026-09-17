// ============================================================================
// freeListOps.wgsl -- taking and returning free-list slots.
//
// INCLUDE THIS *AFTER* DECLARING THE BINDING. These functions name `freelist`
// directly, so the order is:
//
//     #include "freeList.wgsl"        // the struct
//     @group(0) @binding(N) var<storage, read_write> freelist : FreeList;
//     #include "freeListOps.wgsl"     // this file
//
// The split is forced by WGSL: the struct must precede the binding and these
// must follow it, and a pointer parameter (which would remove the ordering
// constraint) needs the `unrestricted_pointer_parameters` language feature that
// is not baseline WebGPU. See the long note in `freeList.wgsl`.
//
// The protocol these implement -- why creation and deletion are separate passes,
// and why exhaustion is normal rather than an error -- is documented there too.
// ============================================================================

// Reserve one index for a NEW particle. Returns the entity index to write, or
// `NO_SLOT` when the pool is empty.
//
// ONLY EVER DECREASES THE HEAD, which is what makes it safe to act on the
// reservation: within the creation pass nothing moves the head the other way, so
// no two invocations can be handed the same slot.
fn free_list_take() -> u32 {
    let prev = atomicSub(&freelist.head, 1u);
    // prev == 0 means the list was already empty and we have just wrapped it to
    // u32 max. prev > length means it was already corrupt or wrapped earlier.
    if (prev == 0u || prev > arrayLength(&freelist.slots)) {
        atomicAdd(&freelist.head, 1u);   // undo, so the head does not stay wrapped
        return NO_SLOT;
    }
    return freelist.slots[prev - 1u];
}

// Return a dead particle's index to the pool.
//
// ONLY EVER INCREASES THE HEAD. That is why the eraser pass and edge-death
// inside advance() can both call this without coordinating: they agree about
// direction, which is the whole invariant.
//
// The bounds test is not optional: without it a double-free (the eraser and
// edge-death claiming the same particle on the same frame) would push past the
// end of the array. The push is dropped in that case, which LEAKS the index --
// it stays dead and unreusable until the next reset. Leaking a slot is strictly
// better than handing the same slot to two brushes.
fn free_list_give(index: u32) {
    let slot = atomicAdd(&freelist.head, 1u);
    if (slot < arrayLength(&freelist.slots)) {
        freelist.slots[slot] = index;
    } else {
        atomicSub(&freelist.head, 1u);   // undo the overflow, drop the push
    }
}
