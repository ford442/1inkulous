// Trees, the same way as huts and followers: one placeholder mesh, one
// instance per tree straight out of the core's buffer, one draw. A tree being
// chopped leans over along its heading as the chop goes on, so the player can
// see which tree the braves are at before it falls.

#include "lib/lighting.wgsl"
#include "lib/surface.wgsl"

const PART_CANOPY: f32 = 1.0;
// How far over a tree leans, in radians, the moment before it falls.
const FELL_LEAN: f32 = 0.6;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) @interpolate(flat) part: f32,
  // Per tree, so a forest is not one flat green.
  @location(3) @interpolate(flat) shade: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) part: f32,
  @location(3) instancePosition: vec3f,
  @location(4) instanceHeading: vec3f,
  @location(5) instanceSize: f32,
  @location(6) instanceChopped: f32,
) -> VertexOutput {
  let basis = surfaceFrame(instancePosition, instanceHeading);

  // Lean about the foot of the trunk, towards the heading.
  let lean = clamp(instanceChopped, 0.0, 1.0) * FELL_LEAN;
  let c = cos(lean);
  let s = sin(lean);
  let p = position * instanceSize;
  let leaned = vec3f(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  let n = vec3f(normal.x, normal.y * c - normal.z * s, normal.y * s + normal.z * c);

  let world = instancePosition + toWorld(basis, leaned);

  var output: VertexOutput;
  output.clipPosition = frame.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = toWorld(basis, n);
  output.part = part;
  output.shade = fract(instanceSize * 7.31);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);

  // Bark, and a dark pine green kept well apart from the green tribe's.
  var albedo = vec3f(0.36, 0.24, 0.14);
  if (input.part == PART_CANOPY) {
    albedo = mix(vec3f(0.10, 0.30, 0.16), vec3f(0.18, 0.38, 0.14), input.shade);
  }

  var color = litSurface(albedo, normal, input.worldPosition, vec2f(16.0, 0.0));
  color += albedo * rimLight(normal, input.worldPosition, 2.5) * 0.15;
  return vec4f(color, 1.0);
}
