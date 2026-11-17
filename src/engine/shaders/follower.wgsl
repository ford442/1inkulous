// Followers are drawn with one instanced call: the core keeps a packed instance
// buffer in linear memory, the renderer uploads it whole and this vertex shader
// turns each instance into a frame on the sphere. Whether there are five units
// or a thousand, it stays one draw.

struct Uniforms {
  viewProj: mat4x4f,
  model: mat4x4f,
  lightDir: vec4f,
  cameraPos: vec4f,
  params: vec4f,
  brush: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

const FLAG_SELECTED: u32 = 1u;
const FLAG_SHAMAN: u32 = 4u;
// The role sits above the flags: kRoleShift / kRoleMask in followers.hpp.
const ROLE_SHIFT: u32 = 3u;
const ROLE_MASK: u32 = 7u;
const ROLE_WARRIOR: u32 = 1u;
const PART_RING: f32 = 1.0;
const PART_BAND: f32 = 2.0;
const PART_CLUB: f32 = 3.0;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  // Per-instance, so interpolating them would only risk rounding an exact
  // comparison in the fragment stage.
  @location(2) @interpolate(flat) tint: vec3f,
  @location(3) @interpolate(flat) selected: f32,
  @location(4) @interpolate(flat) part: f32,
}

// Placeholder tribe colours, in the spirit of the four warring tribes. Real art
// replaces these later.
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
  @location(6) instanceFlags: f32,
) -> VertexOutput {
  var output: VertexOutput;

  let flags = u32(instanceFlags);
  let selected = f32((flags & FLAG_SELECTED) != 0u);
  let shaman = f32((flags & FLAG_SHAMAN) != 0u);
  let warrior = f32(((flags >> ROLE_SHIFT) & ROLE_MASK) == ROLE_WARRIOR);
  let gear = part == PART_BAND || part == PART_CLUB;

  // The selection ring only exists while the follower is selected, and a
  // warrior's band and club only on a warrior. Collapsing their triangles to
  // a point costs one vertex shader invocation and rasterises nothing —
  // cheaper than a second pipeline or a discard in the fragment stage.
  if ((part == PART_RING && selected < 0.5) || (gear && warrior < 0.5)) {
    output.clipPosition = uniforms.viewProj * vec4f(instancePosition, 1.0);
    output.worldPosition = instancePosition;
    output.worldNormal = vec3f(0.0, 1.0, 0.0);
    output.tint = vec3f(0.0);
    output.selected = 0.0;
    output.part = part;
    return output;
  }

  // Stand the model up on the sphere: y out of the surface, z along the heading.
  let up = normalize(instancePosition);
  var forward = instanceHeading - up * dot(up, instanceHeading);
  if (length(forward) < 1e-5) {
    // Heading parallel to up should not happen, but a degenerate frame would
    // collapse the model, so fall back to any tangent.
    forward = normalize(cross(up, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
  }
  forward = normalize(forward);
  let right = cross(up, forward);

  // The shaman is the same pawn, taller and a little broader, so she reads
  // apart from her people at any zoom. Normals are left alone: the stretch is
  // mild enough that the faceting still lights right.
  // A warrior is a shade stockier as well as armed, so the two still read
  // apart when the club is edge-on to the camera.
  let girth = mix(mix(1.0, 1.12, warrior), 1.25, shaman);
  // The ring widens with her but stays on the ground.
  let stature = select(mix(1.0, 1.7, shaman), 1.0, part == PART_RING);
  let scaled = vec3f(position.x * girth, position.y * stature, position.z * girth);
  let world = instancePosition + right * scaled.x + up * scaled.y + forward * scaled.z;
  let worldNormal = right * normal.x + up * normal.y + forward * normal.z;

  output.clipPosition = uniforms.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = worldNormal;
  // A pale robe over the tribe colour: still her tribe's, plainly not a brave.
  // A warrior's band is bone white and the club dark wood, whatever the tribe.
  var tint = mix(tribeColor(instanceTribe), vec3f(0.96, 0.92, 1.0), 0.45 * shaman);
  if (part == PART_BAND) {
    tint = vec3f(0.95, 0.92, 0.84);
  } else if (part == PART_CLUB) {
    tint = vec3f(0.30, 0.19, 0.10);
  }
  output.tint = tint;
  output.selected = selected;
  output.part = part;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  let lightDir = normalize(uniforms.lightDir.xyz);
  let viewDir = normalize(uniforms.cameraPos.xyz - input.worldPosition);

  if (input.part == PART_RING) {
    // Flat, bright and unlit, so a selection reads at a glance against any
    // terrain colour underneath it.
    return vec4f(mix(input.tint, vec3f(1.0), 0.65), 1.0);
  }

  let diffuse = max(dot(normal, lightDir), 0.0);
  let skyMix = normal.y * 0.5 + 0.5;
  let ambient = mix(vec3f(0.12, 0.13, 0.18), vec3f(0.30, 0.34, 0.42), skyMix);

  // Selected followers are lifted towards white so they stand out from their
  // tribe-mates without changing the tribe colour's meaning.
  let albedo = mix(input.tint, mix(input.tint, vec3f(1.0), 0.45), input.selected);

  let halfway = normalize(lightDir + viewDir);
  let specular = pow(max(dot(normal, halfway), 0.0), 32.0) * 0.12 * step(0.0, diffuse);

  // A rim keeps a follower legible against terrain of a similar tone when the
  // camera is pulled back and the unit is only a few pixels across.
  let rim = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5) * (0.18 + 0.5 * input.selected);

  var color = albedo * (ambient + vec3f(1.0, 0.97, 0.90) * diffuse);
  color += vec3f(specular) + albedo * rim;
  color = vec3f(1.0) - exp(-1.35 * color);

  return vec4f(color, 1.0);
}
