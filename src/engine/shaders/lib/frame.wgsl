// The frame: what every material sees at @group(0). One uniform block, written
// once per frame by the renderer (FRAME_FLOATS in materials.ts mirrors it), and
// the sun's shadow map.
//
// The shadow pass binds a second copy of this group whose viewProj is the
// sun's, so the same vertex shaders draw the shadow casters; it binds a 1x1
// stand-in for the shadow map, which cannot be read while it is being drawn.

struct Frame {
  // Camera, or in the shadow pass the sun.
  viewProj: mat4x4f,
  // World to the shadow map's clip space, in every pass.
  lightViewProj: mat4x4f,
  // xyz: unit vector towards the sun. w: how far through a cast the cursor
  // disc is (0..1), 0 when it is not a cast.
  sunDir: vec4f,
  // xyz: the eye. w: how far between their two poses followers are drawn.
  cameraPos: vec4f,
  // x: planet radius, y: max land height, z: brush mode, w: hut site or spell
  params: vec4f,
  // xyz: unit direction under the cursor, w: brush angular radius (0 = hidden)
  brush: vec4f,
  // rgb: sunlight reaching the ground at noon. w: seconds since start, for
  // anything that moves on its own (waves, the shoreline's foam).
  sunColor: vec4f,
  // x: outer radius of the air, y: how much the shadow map darkens (0 = no
  // shadows), z: one shadow-map texel in uv, w: the water surface's radius.
  world: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
