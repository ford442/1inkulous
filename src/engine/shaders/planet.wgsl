// The planet: one cube-sphere mesh, shaded by elevation. The sea is drawn over
// it by water.wgsl and the air by atmosphere.wgsl; what is under the water
// here is the sea bed.

#include "lib/lighting.wgsl"

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) elevation: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  var output: VertexOutput;
  output.clipPosition = frame.viewProj * vec4f(position, 1.0);
  output.worldPosition = position;
  output.worldNormal = normal;
  // 0 at sea level, 1 at the highest peaks. uv is unused for now, but stays in
  // the vertex layout for terrain patch texturing later.
  let height = length(position) - frame.params.x;
  output.elevation = clamp(height / max(frame.params.y, 1e-5), 0.0, 1.0);
  return output;
}

fn terrainColor(elevation: f32) -> vec3f {
  let shore = vec3f(0.76, 0.70, 0.48);
  let grass = vec3f(0.24, 0.46, 0.20);
  let forest = vec3f(0.16, 0.33, 0.16);
  let rock = vec3f(0.38, 0.35, 0.32);
  let snow = vec3f(0.92, 0.94, 0.96);

  var color = mix(shore, grass, smoothstep(0.0, 0.14, elevation));
  color = mix(color, forest, smoothstep(0.12, 0.45, elevation));
  color = mix(color, rock, smoothstep(0.45, 0.78, elevation));
  color = mix(color, snow, smoothstep(0.82, 1.0, elevation));
  return color;
}

// Brush cursor: a filled disc with a bright rim, drawn in angular distance from
// the picked direction so it wraps over terrain instead of floating above it.
fn cursorTint(worldPosition: vec3f) -> vec3f {
  let brushRadius = frame.brush.w;
  if (brushRadius <= 0.0) {
    return vec3f(0.0);
  }
  let surface = normalize(worldPosition);
  let angle = acos(clamp(dot(surface, frame.brush.xyz), -1.0, 1.0));
  // params.z carries the mode: +1 raising, -1 lowering, 2 flattening, 0
  // hovering. params.w replaces it while placing a hut or aiming a spell:
  // +1 the site is good, -1 it is not; 2 a spell being cast lands here.
  let mode = frame.params.z;
  var cursorColor = vec3f(0.85, 0.90, 1.00);
  if (mode > 1.5) {
    cursorColor = vec3f(0.80, 0.62, 1.00);
  } else if (mode > 0.0) {
    cursorColor = vec3f(1.00, 0.80, 0.35);
  } else if (mode < 0.0) {
    cursorColor = vec3f(0.30, 0.75, 1.00);
  }
  let site = frame.params.w;
  if (site > 1.5) {
    cursorColor = vec3f(1.00, 0.86, 0.45);
  } else if (site > 0.5) {
    cursorColor = vec3f(0.35, 0.95, 0.45);
  } else if (site < -0.5) {
    cursorColor = vec3f(1.00, 0.32, 0.25);
  }
  let fill = 1.0 - smoothstep(brushRadius * 0.75, brushRadius, angle);
  let ring = 1.0 - smoothstep(0.0, brushRadius * 0.18, abs(angle - brushRadius * 0.88));
  var tint = cursorColor * (fill * 0.22 + ring * 0.55);
  // While she casts, the disc throbs and a second ring closes in from the
  // rim, reaching the centre as the spell lands.
  let castProgress = frame.sunDir.w;
  if (castProgress > 0.0) {
    let throb = 0.65 + 0.35 * sin(castProgress * 6.2831853 * 3.0);
    let inner = brushRadius * 0.88 * (1.0 - castProgress);
    let closing = 1.0 - smoothstep(0.0, brushRadius * 0.12, abs(angle - inner));
    tint = cursorColor * ((fill * 0.3 + ring * 0.55) * throb + closing * 0.6);
  }
  return tint;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);

  // Under the water shell: a dark weedy bed, which only the shallows let
  // show. The shell itself carries the sea's colour, waves and glint.
  let isSeaBed = input.elevation <= 0.0005;
  let albedo = select(terrainColor(input.elevation), vec3f(0.16, 0.24, 0.22), isSeaBed);
  var color = litSurface(albedo, normal, input.worldPosition, vec2f(24.0, 0.06));
  // The cursor is light in its own right, so it reads on the night side too.
  color += cursorTint(input.worldPosition);
  return vec4f(color, 1.0);
}
