// PLACEHOLDER. Step 3 of docs/WEB_PORT_PLAN.md replaces this file wholesale
// with the real `common.wgsl`, translated from `shared/shaders/common.glsl`
// (425 lines: the Entity/ConfigData/WorldData/Rule structs and the coordinate
// math). Per invariant 8 that file is the single hand-authored source of truth
// for struct layout, and every shader that needs those structs includes it.
//
// It exists now only so Step 1 can prove the `#include` resolver works against
// a real GPU compile rather than only in a unit test.

const STUB_LEVEL: f32 = 0.0;

fn stub_background() -> vec4<f32> {
    return vec4<f32>(STUB_LEVEL, STUB_LEVEL, STUB_LEVEL, 1.0);
}
