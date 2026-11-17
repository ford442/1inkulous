// Trees, the same way as huts and followers: one placeholder mesh, one
// instance per tree straight out of the core's buffer, one draw. A tree being
// chopped leans over along its heading as the chop goes on, so the player can
// see which tree the braves are at before it falls.

struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  lightDir: vec4f,
  cameraPos: vec4f,
  params: vec4f,
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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
  let up = normalize(instancePosition);
  var forward = instanceHeading - up * dot(up, instanceHeading);
  if (length(forward) < 1e-5) {
    forward = normalize(cross(up, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
  }
  forward = normalize(forward);
  let right = cross(up, forward);

  // Lean about the foot of the trunk, towards the heading.
  let lean = clamp(instanceChopped, 0.0, 1.0) * FELL_LEAN;
  let c = cos(lean);
  let s = sin(lean);
  let p = position * instanceSize;
  let leaned = vec3f(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
  let n = vec3f(normal.x, normal.y * c - normal.z * s, normal.y * s + normal.z * c);

  let world = instancePosition + right * leaned.x + up * leaned.y + forward * leaned.z;

  var output: VertexOutput;
  output.clipPosition = uniforms.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = right * n.x + up * n.y + forward * n.z;
  output.part = part;
  output.shade = fract(instanceSize * 7.31);
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

  // Bark, and a dark pine green kept well apart from the green tribe's.
  var albedo = vec3f(0.36, 0.24, 0.14);
  if (input.part == PART_CANOPY) {
    albedo = mix(vec3f(0.10, 0.30, 0.16), vec3f(0.18, 0.38, 0.14), input.shade);
  }

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5) * 0.15;
  color += albedo * rim;
  color = vec3f(1.0) - exp(-1.35 * color);
  return vec4f(color, 1.0);
}
