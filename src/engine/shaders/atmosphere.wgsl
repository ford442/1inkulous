// The air: a shell around the planet, drawn from the inside out (front faces
// culled) so every pixel the shell covers is shaded once, whether it looks past
// the limb or down through the haze onto the ground. Each pixel marches its
// view ray through the shell and adds up sunlit air, blue where the sun is
// high and warmer where its light has come a long way through the air: the
// sunset band along the terminator when the sun turns.
//
// The planet is taken as a plain sphere here; terrain is a few percent of the
// radius and the haze over it is too thin for the difference to show.

#include "lib/lighting.wgsl"

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
) -> VertexOutput {
  let shell = normalize(position) * frame.world.x;
  var output: VertexOutput;
  output.clipPosition = frame.viewProj * vec4f(shell, 1.0);
  output.worldPosition = shell;
  return output;
}

// Distances along a ray to where it enters and leaves a sphere at the origin;
// x > y when it misses.
fn sphereHits(origin: vec3f, direction: vec3f, radius: f32) -> vec2f {
  let b = dot(origin, direction);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    return vec2f(1.0, -1.0);
  }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

const SAMPLES: i32 = 10;
const RAYLEIGH = vec3f(0.30, 0.62, 1.30);
const SUNSET = vec3f(0.95, 0.45, 0.22);

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let planetRadius = frame.params.x;
  let airRadius = frame.world.x;
  let thickness = airRadius - planetRadius;
  let eye = frame.cameraPos.xyz;
  let direction = normalize(input.worldPosition - eye);

  let air = sphereHits(eye, direction, airRadius);
  if (air.x > air.y) {
    return vec4f(0.0);
  }
  let start = max(air.x, 0.0);
  var end = air.y;
  let ground = sphereHits(eye, direction, planetRadius);
  let hitsGround = ground.x <= ground.y && ground.x > 0.0;
  if (hitsGround) {
    end = min(end, ground.x);
  }

  let stride = (end - start) / f32(SAMPLES);
  let scaleHeight = thickness * 0.28;
  let sun = frame.sunDir.xyz;
  var light = vec3f(0.0);
  var opticalDepth = 0.0;
  for (var i = 0; i < SAMPLES; i += 1) {
    let p = eye + direction * (start + stride * (f32(i) + 0.5));
    let r = length(p);
    let density = exp(-max(r - planetRadius, 0.0) / scaleHeight) * stride / thickness;
    opticalDepth += density;
    let up = p / r;
    let sunHeight = dot(up, sun);
    // Lit air: on the day side, fading through dusk into the planet's shadow.
    let lit = smoothstep(-0.25, 0.15, sunHeight);
    // Light that skimmed through a lot of air on its way in has lost its blue.
    let reddening = 1.0 - smoothstep(-0.12, 0.3, sunHeight);
    let tint = mix(RAYLEIGH, SUNSET, reddening);
    light += tint * density * lit * exp(-opticalDepth * 0.6);
  }

  // A little forward scattering towards the sun.
  let mu = dot(direction, sun);
  let phase = 0.75 * (1.0 + mu * mu) + 0.25 * pow(max(mu, 0.0), 8.0);
  // Looking down through it the haze is a light veil; past the limb it is
  // the whole of the glow.
  let veil = select(1.0, 0.45, hitsGround);
  let color = light * phase * frame.sunColor.rgb * 0.55 * veil;
  // Over the ground the haze also hides a little of what is under it.
  let cover = select(0.0, clamp(opticalDepth * 0.1, 0.0, 0.18), hitsGround);
  return vec4f(color, cover);
}
