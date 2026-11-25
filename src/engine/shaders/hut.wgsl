// Huts, the same way as followers: one placeholder mesh, one instance per hut
// straight out of the core's buffer. The build ghost is one more instance on
// the end, drawn by a second, blended pipeline over the same shader.

#include "lib/lighting.wgsl"
#include "lib/surface.wgsl"

const PART_DOOR: f32 = 1.0;
const PART_ROOF: f32 = 2.0;
// HutKind in huts.hpp.
const KIND_TRAINING: f32 = 1.0;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) @interpolate(flat) tribe: f32,
  // Occupants, or a negative ghost code: -1 a good site, -2 a bad one.
  @location(3) @interpolate(flat) occupants: f32,
  @location(4) @interpolate(flat) part: f32,
  @location(5) @interpolate(flat) training: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) part: f32,
  @location(3) instancePosition: vec3f,
  @location(4) instanceHeading: vec3f,
  @location(5) instanceTribe: f32,
  @location(6) instanceOccupants: f32,
  @location(7) instanceKind: f32,
) -> VertexOutput {
  let training = f32(abs(instanceKind - KIND_TRAINING) < 0.5);
  let basis = surfaceFrame(instancePosition, instanceHeading);

  // A training hut is the same mesh drawn taller and a little narrower, so
  // its silhouette is a tower against a dwelling's dome. The faceted normals
  // are left alone: the stretch is mild enough to light right.
  let shaped = vec3f(position.x * mix(1.0, 0.9, training),
                     position.y * mix(1.0, 1.45, training),
                     position.z * mix(1.0, 0.9, training));
  let world = instancePosition + toWorld(basis, shaped);

  var output: VertexOutput;
  output.clipPosition = frame.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = toWorld(basis, normal);
  output.tribe = instanceTribe;
  output.occupants = instanceOccupants;
  output.part = part;
  output.training = training;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);

  if (input.occupants < -0.5) {
    // Build ghost: green where the core would build, red where it would not.
    // Lit only from the sky and the sun's angle, never shadowed: it has to
    // read wherever the cursor is.
    let tint = select(vec3f(1.00, 0.32, 0.25), vec3f(0.35, 0.95, 0.45), input.occupants > -1.5);
    let diffuse = max(dot(normal, frame.sunDir.xyz), 0.0);
    let lit = tint * (0.55 + 0.45 * diffuse);
    return vec4f(lit * 0.5, 0.5);
  }

  // Mud walls and straw thatch; a claimed hut's roof takes its tribe colour.
  // A training hut is dark timber under slate, its roof more its tribe's.
  var albedo = mix(vec3f(0.56, 0.42, 0.28), vec3f(0.30, 0.21, 0.14), input.training);
  if (input.part == PART_ROOF) {
    let thatch = mix(vec3f(0.66, 0.55, 0.30), vec3f(0.30, 0.31, 0.34), input.training);
    let claim = mix(0.55, 0.7, input.training);
    albedo = select(thatch, mix(thatch, tribeColor(input.tribe), claim), input.tribe > -0.5);
  }

  var color = litSurface(albedo, normal, input.worldPosition, vec2f(16.0, 0.0));
  if (input.part == PART_DOOR) {
    // Dark while empty; firelight inside once someone lives there, brighter
    // with each occupant, so a working hut reads from orbit — and at night,
    // where it is most of what there is to see.
    let glow = clamp(input.occupants / 3.0, 0.0, 1.0);
    color = select(vec3f(0.05, 0.035, 0.025),
                   vec3f(1.00, 0.68, 0.30) * (0.55 + 0.6 * glow) * 1.6,
                   input.occupants > 0.5);
  }

  color += albedo * rimLight(normal, input.worldPosition, 2.5) * 0.15;
  return vec4f(color, 1.0);
}
