// ============================================================================
// stampBox.wgsl -- the box test, and the uniform block every stamp pass shares.
//
// INCLUDED BY count, scatter, paste and clear. It exists so the predicate that
// decides "is this particle in the stamp" is written ONCE: the count pass and
// the scatter pass must agree about it exactly, or the scan produces offsets
// for one set of particles while the scatter writes a different set -- which
// packs particles on top of each other with no error anywhere.
//
// ---------------------------------------------------------------------------
// THE TEST IS HALF-OPEN, AND MIRRORS `boxContains` IN stampBox.ts
// ---------------------------------------------------------------------------
// `>= min` and `< max`, so two boxes sharing an edge partition the points on it
// rather than both claiming them. A cut-and-paste of two adjacent halves must
// not duplicate the particles along the seam.
//
// `stampBox.test.ts` asserts the host's version on these same edge cases. The
// two are a pair; changing one without the other means the host reports a
// different particle count than the GPU actually wrote.
// ============================================================================

struct StampUniforms {
    // The SOURCE box in world space: xy = min, zw = max.
    src_box    : vec4f,
    // The DESTINATION box in world space: xy = min, zw = max.
    //
    // Equal to `src_box` for a whole-scene restore, which is the case the host
    // short-circuits -- see `remap_point` below on why that matters.
    dst_box    : vec4f,
    // x: entity count        y: index of the grand-total slot in `offsets`
    // z: particle capacity of the destination block
    // w: reserved
    params     : vec4u,
}

fn stamp_src_min(u : StampUniforms) -> vec2f { return u.src_box.xy; }
fn stamp_src_max(u : StampUniforms) -> vec2f { return u.src_box.zw; }
fn stamp_dst_min(u : StampUniforms) -> vec2f { return u.dst_box.xy; }
fn stamp_dst_max(u : StampUniforms) -> vec2f { return u.dst_box.zw; }

// Half-open containment. See the header.
fn stamp_box_contains(lo : vec2f, hi : vec2f, p : vec2f) -> bool {
    return p.x >= lo.x && p.x < hi.x && p.y >= lo.y && p.y < hi.y;
}

// ---------------------------------------------------------------------------
// THE IDENTITY EARLY-OUT IS LOAD-BEARING, NOT AN OPTIMIZATION.
//
// `(p - src_min) / src_extent * dst_extent + dst_min` is algebraically the
// identity when the two boxes match, and is NOT the identity in f32: it
// round-trips through a divide and a multiply, so a coordinate comes back
// changed by an ulp.
//
// That drift is CUMULATIVE. A whole-scene restore is the common case -- every
// R press, every world load -- and an ulp per restore means a scene creeps
// across the world over a session of iterating on it. The host hit exactly this
// in `remapPoint` (stampBox.ts), where a unit test caught 0.3 coming back as
// 0.30000000000000004; this is the same guard on the GPU side, and the reason
// both exist is the same.
//
// Comparing the boxes for exact equality is the right test: the host passes the
// same f32s through the uniform in the restore case, so they compare equal
// bit-for-bit rather than approximately.
// ---------------------------------------------------------------------------
fn stamp_remap_point(u : StampUniforms, p : vec2f) -> vec2f {
    let src_lo = stamp_src_min(u);
    let src_hi = stamp_src_max(u);
    let dst_lo = stamp_dst_min(u);
    let dst_hi = stamp_dst_max(u);

    if (all(src_lo == dst_lo) && all(src_hi == dst_hi)) {
        return p;
    }

    let src_extent = src_hi - src_lo;
    let dst_extent = dst_hi - dst_lo;
    // A degenerate source box maps everything to the destination's min corner
    // rather than producing NaN. NaN in a position is invisible: the particle
    // simply vanishes and no error is raised anywhere.
    let frac = select(
        vec2f(0.0, 0.0),
        (p - src_lo) / src_extent,
        src_extent > vec2f(0.0, 0.0),
    );
    return dst_lo + frac * dst_extent;
}
