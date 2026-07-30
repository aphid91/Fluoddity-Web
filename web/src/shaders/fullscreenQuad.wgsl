// The fullscreen quad, shared by every pass that covers the screen.
//
// The desktop's `shared/shaders/fullscreen_quad.vert` is shared across five
// consumers; this is that file. Consumers here:
//
//   camera/shaders/camera.wgsl              TRAIL present
//   camera/shaders/accumulate.wgsl          motion blur accumulation
//   assembler/shaders/bloomDownsample.wgsl  the mip chain, down
//   assembler/shaders/bloomUpsample.wgsl    the mip chain, up
//   assembler/shaders/frameAssembly.wgsl    bloom, tone curve, overlays
//
// NOT a consumer: `particleSystem/shaders/canvas.wgsl`. It needs the V FLIP
// (see its header) because it rasterizes into the canvas texture and every
// fragment must read the texel it is about to write; every consumer above needs
// NO flip. Merging the two behind a boolean parameter would put the single most
// dangerous decision in this port -- the one Step 4 lost the most time to --
// behind an argument that is easy to pass wrong and impossible to see in a
// diff. Two small definitions, each unconditionally correct, is the right shape.
//
// WHY NOT IN common.wgsl. That file declares no bindings and must stay
// stage-agnostic (its own editing rules 3 and 4), and a `@vertex` entry point
// is the opposite of stage-agnostic. It is also parsed by `common.wgsl.test.ts`
// against the generated layout descriptor, so unrelated additions there are
// noise in a file whose job is struct layout.
//
// NO VERTEX BUFFER. The quad comes from `@builtin(vertex_index)`, so there is
// nothing to allocate, bind or keep in sync. Drawn as `draw(4)` with
// `topology: 'triangle-strip'` -- TRIANGLE_FAN is not a WebGPU topology, which
// is why the corner order below is strip order rather than the desktop's fan.

struct FsQuadVsOut {
    @builtin(position) clip : vec4f,
    @location(0) uv : vec2f,
}

// Strip order: (-,-) (+,-) (-,+) (+,+). The same order `canvas.wgsl` and the
// deleted `debugPresent.wgsl` use, so all four agree by inspection.
fn fullscreen_corner(vi: u32) -> vec2f {
    var corners = array<vec2f, 4>(
        vec2f(-1.0, -1.0),
        vec2f( 1.0, -1.0),
        vec2f(-1.0,  1.0),
        vec2f( 1.0,  1.0),
    );
    return corners[vi];
}

// NO Y FLIP, for every consumer of this entry point.
//
// The canvas texture is stored TOP-LEFT-ORIGIN: `brush.wgsl` negates NDC y when
// it splats, precisely so that the stored image matches WebGPU's framebuffer
// convention. Sampling it straight therefore puts world +y at the top of the
// screen, matching the desktop. See `web/README.md`'s Y-flip section.
//
// The intermediate targets (hdr, accum, the bloom mips) are all WRITTEN by
// passes using this entry point and READ by passes using this entry point, so
// they are internally consistent whatever convention is chosen -- the only
// externally observable flips are `camera.wgsl` reading the canvas and
// `frameAssembly.wgsl` reading the strafe field, and both want none.
@vertex
fn fullscreen_vs(@builtin(vertex_index) vi : u32) -> FsQuadVsOut {
    let p = fullscreen_corner(vi);
    var out : FsQuadVsOut;
    out.clip = vec4f(p, 0.0, 1.0);
    out.uv = p * 0.5 + 0.5;
    return out;
}
