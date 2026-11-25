// The last pass: the resolved linear frame through the exposure curve onto the
// canvas. A single triangle that covers the screen; no vertex buffer.

#include "lib/tonemap.wgsl"

@group(0) @binding(0) var scene: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let color = textureLoad(scene, vec2i(position.xy), 0).rgb;
  return vec4f(exposure(max(color, vec3f(0.0))), 1.0);
}
