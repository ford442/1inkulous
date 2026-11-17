// Huts, the same way as followers: one placeholder mesh, one instance per hut
// straight out of the core's buffer. The build ghost is one more instance on
// the end, drawn by a second, blended pipeline over the same shader.

struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  lightDir: vec4f,
  cameraPos: vec4f,
  params: vec4f,
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

const PART_DOOR: f32 = 1.0;
const PART_ROOF: f32 = 2.0;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) @interpolate(flat) tribe: f32,
  // Occupants, or a negative ghost code: -1 a good site, -2 a bad one.
  @location(3) @interpolate(flat) occupants: f32,
  @location(4) @interpolate(flat) part: f32,
}

fn tribeColor(tribe: f32) -> vec3f {
  let index = i32(round(tribe)) % 4;
  if (index == 1) { return vec3f(0.78, 0.20, 0.18); }
  if (index == 2) { return vec3f(0.86, 0.74, 0.20); }
  if (index == 3) { return vec3f(0.24, 0.62, 0.28); }
  return vec3f(0.24, 0.44, 0.82);
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
) -> VertexOutput {
  let up = normalize(instancePosition);
  var forward = instanceHeading - up * dot(up, instanceHeading);
  if (length(forward) < 1e-5) {
    forward = normalize(cross(up, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
  }
  forward = normalize(forward);
  let right = cross(up, forward);

  let world = instancePosition + right * position.x + up * position.y + forward * position.z;

  var output: VertexOutput;
  output.clipPosition = uniforms.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = right * normal.x + up * normal.y + forward * normal.z;
  output.tribe = instanceTribe;
  output.occupants = instanceOccupants;
  output.part = part;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let lightDir = normalize(uniforms.lightDir.xyz);
  let viewDir = normalize(uniforms.cameraPos.xyz - input.worldPosition);
  let diffuse = max(dot(normal, lightDir), 0.0);
  let skyMix = normal.y * 0.5 + 0.5;
  let ambient = mix(vec3f(0.12, 0.13, 0.18), vec3f(0.30, 0.34, 0.42), skyMix);

  if (input.occupants < -0.5) {
    // Build ghost: green where the core would build, red where it would not.
    let tint = select(vec3f(1.00, 0.32, 0.25), vec3f(0.35, 0.95, 0.45), input.occupants > -1.5);
    let lit = tint * (0.55 + 0.45 * diffuse);
    return vec4f(lit, 0.5);
  }

  // Mud walls and straw thatch; a claimed hut's roof takes its tribe colour.
  var albedo = vec3f(0.56, 0.42, 0.28);
  if (input.part == PART_ROOF) {
    let thatch = vec3f(0.66, 0.55, 0.30);
    albedo = select(thatch, mix(thatch, tribeColor(input.tribe), 0.55), input.tribe > -0.5);
  }

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  if (input.part == PART_DOOR) {
    // Dark while empty; firelight inside once someone lives there, brighter
    // with each occupant, so a working hut reads from orbit.
    let glow = clamp(input.occupants / 3.0, 0.0, 1.0);
    color = select(vec3f(0.05, 0.035, 0.025),
                   vec3f(1.00, 0.68, 0.30) * (0.55 + 0.6 * glow),
                   input.occupants > 0.5);
  }

  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5) * 0.15;
  color += albedo * rim;
  color = vec3f(1.0) - exp(-1.35 * color);
  return vec4f(color, 1.0);
}
