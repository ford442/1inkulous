// Standing things up on the sphere, and the colours that mark whose they are.

struct SurfaceFrame {
  right: vec3f,
  up: vec3f,
  forward: vec3f,
}

// y out of the surface, z along the heading, at a point on the planet.
fn surfaceFrame(position: vec3f, heading: vec3f) -> SurfaceFrame {
  let up = normalize(position);
  var forward = heading - up * dot(up, heading);
  if (length(forward) < 1e-5) {
    // Heading parallel to up should not happen, but a degenerate frame would
    // collapse the model, so fall back to any tangent.
    forward = normalize(cross(up, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
  }
  forward = normalize(forward);
  return SurfaceFrame(cross(up, forward), up, forward);
}

fn toWorld(f: SurfaceFrame, v: vec3f) -> vec3f {
  return f.right * v.x + f.up * v.y + f.forward * v.z;
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
