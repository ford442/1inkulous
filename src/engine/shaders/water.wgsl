// The sea: a second sphere just above sea level, drawn from the planet's own
// vertex and index buffers. Each vertex reads the ground beneath it from the
// planet vertex it is built on, so the shoreline follows every edit the brush
// or a spell makes, with no buffer of its own to keep in step.
//
// The planet's water is flat at sea level, so the depth that matters is how far
// the ground under a point of the sea rises towards the surface: zero in open
// water, climbing through the waterline at the coast. Interpolated across the
// coastal triangles it gives the shallows and a band of foam exactly where
// Swamp or Flatten has just put a new shore.

#include "lib/lighting.wgsl"

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  // Ground height over the sea bed, in units of the max land height: 0 under
  // open water, 1 at the peaks.
  @location(1) ground: f32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let direction = normalize(position);
  let surface = direction * frame.world.w;
  var output: VertexOutput;
  output.clipPosition = frame.viewProj * vec4f(surface, 1.0);
  output.worldPosition = surface;
  output.ground = (length(position) - frame.params.x) / max(frame.params.y, 1e-5);
  return output;
}

// Gentle swell: a few travelling sine waves over the sphere's 3D position, as
// a slope to tilt the normal by. No texture, no seams.
fn swell(p: vec3f, t: f32) -> vec3f {
  var slope = vec3f(0.0);
  slope += cos(dot(p, vec3f(41.0, 17.0, -23.0)) + t * 1.1) * vec3f(41.0, 17.0, -23.0);
  slope += cos(dot(p, vec3f(-29.0, 37.0, 19.0)) + t * 1.4) * vec3f(-29.0, 37.0, 19.0);
  slope += cos(dot(p, vec3f(13.0, -31.0, 47.0)) + t * 0.8) * vec3f(13.0, -31.0, 47.0);
  slope += cos(dot(p, vec3f(97.0, 61.0, 83.0)) + t * 2.3) * vec3f(97.0, 61.0, 83.0) * 0.35;
  return slope * 0.00035;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let up = normalize(input.worldPosition);
  let t = frame.sunColor.w;
  let tilt = swell(input.worldPosition, t);
  let normal = normalize(up - (tilt - up * dot(tilt, up)));

  // Where the sea is above the ground: 0 at the waterline, 1 well offshore.
  let lift = (frame.world.w - frame.params.x) / max(frame.params.y, 1e-5);
  let depth = clamp((lift - input.ground) / max(lift, 1e-5), 0.0, 1.0);
  let deep = vec3f(0.025, 0.10, 0.24);
  let shallow = vec3f(0.06, 0.27, 0.37);
  let albedo = mix(shallow, deep, smoothstep(0.2, 1.0, depth));

  var color = litSurface(albedo, normal, input.worldPosition, vec2f(220.0, 0.6));

  // Sky reflected at grazing angles.
  let viewDir = normalize(frame.cameraPos.xyz - input.worldPosition);
  let fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 5.0);
  color += vec3f(0.22, 0.34, 0.52) * fresnel * daylight(up) * 0.8;

  // Foam on the waterline, broken up and moving so it reads as surf. The band
  // is the last stretch of shallows before the ground breaks the surface.
  let shoreline = 1.0 - smoothstep(0.0, 0.55, depth);
  let breakup = 0.5 + 0.5 * sin(dot(input.worldPosition, vec3f(173.0, 211.0, 157.0)) + t * 2.0);
  let foam = shoreline * shoreline * (0.55 + 0.45 * breakup);
  let foamLight = ambientLight(up, up) + frame.sunColor.rgb * daylight(up) * max(dot(up, frame.sunDir.xyz), 0.0);
  color = mix(color, vec3f(0.92, 0.95, 0.97) * foamLight, foam * 0.85);

  // Mostly opaque: the sea bed only shows through in the shallows.
  let alpha = mix(0.72, 0.94, smoothstep(0.0, 0.5, depth)) + fresnel * 0.05;
  return vec4f(color * alpha, alpha);
}
