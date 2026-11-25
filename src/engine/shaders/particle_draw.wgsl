// Spell-effect particles as camera-facing quads: six vertices per particle,
// read straight from the storage buffer the compute step writes. A dead
// particle collapses to a point and rasterises nothing.

#ifdef SHADER_F16
enable f16;
#endif

#include "lib/frame.wgsl"
#include "lib/particle.wgsl"

@group(1) @binding(0) var<storage, read> particles: array<Particle>;

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) corner: vec2f,
  @location(1) color: vec3f,
  @location(2) fade: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) cornerIndex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
  var output: VertexOutput;
  let p = particles[instance];
  let life = particleLife(p);
  if (p.age >= life || life <= 0.0) {
    output.clipPosition = vec4f(0.0, 0.0, -1.0, 1.0);
    return output;
  }

  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0),
  );
  let corner = corners[cornerIndex];
  // Facing the eye, upright along the local surface where it can be.
  let toEye = normalize(frame.cameraPos.xyz - p.position);
  var right = cross(normalize(p.position), toEye);
  if (length(right) < 1e-4) {
    right = cross(vec3f(0.0, 1.0, 0.0), toEye);
  }
  right = normalize(right);
  let up = cross(toEye, right);
  let t = p.age / life;
  // Grows a little as it goes, then fades out over its last third.
  let size = abs(particleSize(p)) * (0.7 + 0.6 * t) * 0.5;
  let world = p.position + (right * corner.x + up * corner.y) * size;

  output.clipPosition = frame.viewProj * vec4f(world, 1.0);
  output.corner = corner;
  output.color = particleColor(p);
  output.fade = 1.0 - smoothstep(0.6, 1.0, t);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let d = dot(input.corner, input.corner);
  if (d > 1.0) {
    discard;
  }
  let alpha = (1.0 - d) * input.fade;
  return vec4f(input.color * alpha, alpha * 0.85);
}
