// Sunlight, sky light and the sun's shadow, shared by every lit surface.
//
// Values here are linear and unbounded: the scene is drawn into a float
// target and the exposure curve (tonemap.wgsl) is applied once, at the end.

#include "frame.wgsl"

// How much of the sun reaches a point on the planet, from the angle of the
// sun over its local horizon: 1 by day, 0 at night, a soft band at dusk so the
// terminator is a gradient and not a line.
fn daylight(up: vec3f) -> f32 {
  return smoothstep(-0.18, 0.22, dot(up, frame.sunDir.xyz));
}

// Sky light from above, ground bounce from below, relative to the planet's
// local up rather than world y: on a sphere every way is up somewhere. At
// night only a dim blue moonlight is left.
fn ambientLight(normal: vec3f, up: vec3f) -> vec3f {
  let skyMix = dot(normal, up) * 0.5 + 0.5;
  let day = mix(vec3f(0.10, 0.11, 0.16), vec3f(0.26, 0.30, 0.38), skyMix);
  let night = mix(vec3f(0.015, 0.02, 0.04), vec3f(0.04, 0.05, 0.09), skyMix);
  return mix(night, day, daylight(up));
}

// 1 in sunlight, down to 1 - strength in the sun's shadow. Nine taps of a
// hardware 2x2 comparison filter make a soft edge a few texels wide.
//
// The lookup point is pushed out along the normal by a texel or so, which
// with the pipelines' slope-scaled depth bias keeps a curved planet from
// shadowing itself in stripes ("acne").
fn sunShadow(worldPosition: vec3f, normal: vec3f) -> f32 {
  let strength = frame.world.y;
  if (strength <= 0.0) {
    return 1.0;
  }
  let texel = frame.world.z;
  let offset = worldPosition + normal * (texel * 2.5 * frame.params.x);
  let clip = frame.lightViewProj * vec4f(offset, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || ndc.z > 1.0) {
    return 1.0;
  }
  var lit = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      lit += textureSampleCompareLevel(
        shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, ndc.z - 0.0015);
    }
  }
  return 1.0 - strength * (1.0 - lit / 9.0);
}

// Diffuse and specular light on a surface: sun (shadowed) plus sky.
// `specular` is (power, strength).
fn litSurface(albedo: vec3f, normal: vec3f, worldPosition: vec3f, specular: vec2f) -> vec3f {
  let up = normalize(worldPosition);
  let lightDir = frame.sunDir.xyz;
  let viewDir = normalize(frame.cameraPos.xyz - worldPosition);
  // The sun only lights the side of the planet facing it, whatever the
  // surface's own slope says.
  let sun = frame.sunColor.rgb * daylight(up) * sunShadow(worldPosition, normal);
  let diffuse = max(dot(normal, lightDir), 0.0);
  let halfway = normalize(lightDir + viewDir);
  let shine = pow(max(dot(normal, halfway), 0.0), specular.x) * specular.y * step(0.0, diffuse);
  return albedo * (ambientLight(normal, up) + sun * diffuse) + sun * shine;
}

// A rim of extra light where a surface turns away from the eye, so small
// objects keep their outline against ground of a similar tone.
fn rimLight(normal: vec3f, worldPosition: vec3f, power: f32) -> f32 {
  let viewDir = normalize(frame.cameraPos.xyz - worldPosition);
  return pow(1.0 - max(dot(normal, viewDir), 0.0), power);
}
