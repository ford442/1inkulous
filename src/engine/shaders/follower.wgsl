// Followers are drawn with one instanced call: the core keeps a packed instance
// buffer in linear memory, the renderer uploads it whole and this vertex shader
// turns each instance into a frame on the sphere. Whether there are five units
// or a thousand, it stays one draw.
//
// Each instance carries two poses: the one the last fixed step left, and the
// one it began from. The simulation steps at 20Hz; the display may run at 144.
// So each frame draws every follower between the two, `cameraPos.w` of the
// way (the clock's leftover over the step length), and a walker glides rather
// than jumping once a step and standing still between.

#include "lib/lighting.wgsl"
#include "lib/surface.wgsl"

const FLAG_SELECTED: u32 = 1u;
const FLAG_SHAMAN: u32 = 4u;
// kFlagCasting in followers.hpp: a shaman standing to cast.
const FLAG_CASTING: u32 = 64u;
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

// Between the pose a follower began the step in and the one it ended it in.
// On the sphere: the unit directions are blended and renormalised, the radius
// (ground height) blended on its own, so the path bows with the planet instead
// of cutting the chord, and a climb does not drag the direction uphill. Over
// one step a walker turns through a few thousandths of a radian, where this
// and a true slerp differ by far less than a pixel. Mirrored by
// interpolatePose in src/game/followers.ts, which test:interpolation holds to.
fn interpolatePosition(previous: vec3f, current: vec3f, alpha: f32) -> vec3f {
  let fromRadius = length(previous);
  let toRadius = length(current);
  if (fromRadius < 1e-6 || toRadius < 1e-6) {
    return current;
  }
  let blended = mix(previous / fromRadius, current / toRadius, alpha);
  let len = length(blended);
  if (len < 1e-6) {
    return current;
  }
  return blended * (mix(fromRadius, toRadius, alpha) / len);
}

// Headings are unit tangents: blended and renormalised. One that turned right
// round in a step has no halfway, and is drawn facing its new way.
fn interpolateHeading(previous: vec3f, current: vec3f, alpha: f32) -> vec3f {
  let blended = mix(previous, current, alpha);
  if (length(blended) < 1e-4) {
    return current;
  }
  return normalize(blended);
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) part: f32,
  @location(3) currentPosition: vec3f,
  @location(4) currentHeading: vec3f,
  @location(5) instanceTribe: f32,
  @location(6) instanceFlags: f32,
  @location(7) previousPosition: vec3f,
  @location(8) previousHeading: vec3f,
) -> VertexOutput {
  var output: VertexOutput;

  let alpha = clamp(frame.cameraPos.w, 0.0, 1.0);
  let instancePosition = interpolatePosition(previousPosition, currentPosition, alpha);
  let instanceHeading = interpolateHeading(previousHeading, currentHeading, alpha);

  let flags = u32(instanceFlags);
  let selected = f32((flags & FLAG_SELECTED) != 0u);
  let shaman = f32((flags & FLAG_SHAMAN) != 0u);
  let casting = f32((flags & FLAG_CASTING) != 0u);
  let warrior = f32(((flags >> ROLE_SHIFT) & ROLE_MASK) == ROLE_WARRIOR);
  let gear = part == PART_BAND || part == PART_CLUB;

  // The selection ring only exists while the follower is selected, and a
  // warrior's band and club only on a warrior. Collapsing their triangles to
  // a point costs one vertex shader invocation and rasterises nothing —
  // cheaper than a second pipeline or a discard in the fragment stage.
  if ((part == PART_RING && selected < 0.5) || (gear && warrior < 0.5)) {
    output.clipPosition = frame.viewProj * vec4f(instancePosition, 1.0);
    output.worldPosition = instancePosition;
    output.worldNormal = vec3f(0.0, 1.0, 0.0);
    output.tint = vec3f(0.0);
    output.selected = 0.0;
    output.part = part;
    return output;
  }

  // Stand the model up on the sphere: y out of the surface, z along the heading.
  let basis = surfaceFrame(instancePosition, instanceHeading);

  // The shaman is the same pawn, taller and a little broader, so she reads
  // apart from her people at any zoom. Normals are left alone: the stretch is
  // mild enough that the faceting still lights right.
  // A warrior is a shade stockier as well as armed, so the two still read
  // apart when the club is edge-on to the camera.
  let girth = mix(mix(1.0, 1.12, warrior), 1.25, shaman);
  // The ring widens with her but stays on the ground.
  let stature = select(mix(1.0, 1.7, shaman), 1.0, part == PART_RING);
  let scaled = vec3f(position.x * girth, position.y * stature, position.z * girth);
  let world = instancePosition + toWorld(basis, scaled);
  let worldNormal = toWorld(basis, normal);

  output.clipPosition = frame.viewProj * vec4f(world, 1.0);
  output.worldPosition = world;
  output.worldNormal = worldNormal;
  // A pale robe over the tribe colour: still her tribe's, plainly not a brave.
  // A warrior's band is bone white and the club dark wood, whatever the tribe.
  var tint = mix(tribeColor(instanceTribe), vec3f(0.96, 0.92, 1.0), 0.45 * shaman);
  // Casting, her robe takes the gold of the disc pulsing where it will land.
  tint = mix(tint, vec3f(1.0, 0.82, 0.38), 0.6 * casting);
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

  if (input.part == PART_RING) {
    // Flat, bright and unlit, so a selection reads at a glance against any
    // terrain colour underneath it, by day or night.
    return vec4f(mix(input.tint, vec3f(1.0), 0.65), 1.0);
  }

  // Selected followers are lifted towards white so they stand out from their
  // tribe-mates without changing the tribe colour's meaning.
  let albedo = mix(input.tint, mix(input.tint, vec3f(1.0), 0.45), input.selected);

  var color = litSurface(albedo, normal, input.worldPosition, vec2f(32.0, 0.12));
  // A rim keeps a follower legible against terrain of a similar tone when the
  // camera is pulled back and the unit is only a few pixels across.
  color += albedo * rimLight(normal, input.worldPosition, 2.5) * (0.18 + 0.5 * input.selected);
  return vec4f(color, 1.0);
}
