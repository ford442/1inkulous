// Spell effects on the GPU: spawning a burst and moving every particle, as two
// compute entry points over one storage buffer. The CPU only says where a
// spell landed (see SpellEffects in src/game/spellEffects.ts); how the debris
// flies is decided here.

#ifdef SHADER_F16
enable f16;
#endif

#include "lib/particle.wgsl"

// One burst: where, what, and which slots of the ring it fills.
struct Burst {
  // xyz: a surface point at the disc's centre, w: the disc's angular radius
  center: vec4f,
  // rgb: base colour, w: particle size (negative: it rises)
  color: vec4f,
  // x: first slot, y: count, z: launch speed, w: seconds it lives
  spawn: vec4f,
  // x: random seed, y: how much the colour varies, z: spread of launch
  // directions (0 straight up .. 1 any way out of the ground), w: unused
  shape: vec4f,
}

const MAX_BURSTS: u32 = 16u;

struct Step {
  // x: seconds since the last step, y: planet radius, z: gravity, w: bursts
  params: vec4f,
  // x: particle capacity, y: total particles spawned this frame
  counts: vec4u,
  bursts: array<Burst, MAX_BURSTS>,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> sim: Step;

fn hash(n: u32) -> u32 {
  var x = n;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

fn random(seed: ptr<function, u32>) -> f32 {
  *seed = hash(*seed + 0x9e3779b9u);
  return f32(*seed >> 8u) / 16777216.0;
}

// Any unit vector at right angles to `n`, and the one at right angles to both.
fn tangents(n: vec3f) -> mat2x3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  let t = normalize(cross(n, a));
  return mat2x3f(t, cross(n, t));
}

@compute @workgroup_size(64)
fn cs_spawn(@builtin(global_invocation_id) id: vec3u) {
  let total = sim.counts.y;
  if (id.x >= total) {
    return;
  }
  // Which burst this invocation belongs to: bursts are laid end to end.
  var index = id.x;
  var b = 0u;
  let bursts = u32(sim.params.w);
  loop {
    if (b + 1u >= bursts) { break; }
    let count = u32(sim.bursts[b].spawn.y);
    if (index < count) { break; }
    index -= count;
    b += 1u;
  }
  let burst = sim.bursts[b];
  let slot = (u32(burst.spawn.x) + index) % sim.counts.x;
  var seed = hash(u32(burst.shape.x) ^ (index * 747796405u));

  // A point on the disc, uniformly by area, on the ground it was cast on.
  let centre = normalize(burst.center.xyz);
  let ground = length(burst.center.xyz);
  let axes = tangents(centre);
  let r = burst.center.w * sqrt(random(&seed));
  let theta = random(&seed) * 6.2831853;
  let dir = normalize(centre + (axes[0] * cos(theta) + axes[1] * sin(theta)) * tan(r));

  // Out of the ground, leaning outwards from the centre by `spread`.
  let outward = normalize(dir - centre + vec3f(1e-6));
  let spread = burst.shape.z;
  let launch = normalize(dir + outward * spread * random(&seed) * 1.5);
  let speed = burst.spawn.z * (0.35 + 0.65 * random(&seed));
  let variation = burst.shape.y * (random(&seed) - 0.5);

  let life = burst.spawn.w * (0.6 + 0.4 * random(&seed));
  let size = burst.color.w * (0.7 + 0.6 * random(&seed));
  let color = clamp(burst.color.rgb * (1.0 + variation), vec3f(0.0), vec3f(8.0));
  particles[slot] = makeParticle(dir * ground, 0.0, launch * speed, life, color, size);
}

@compute @workgroup_size(64)
fn cs_step(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.counts.x) {
    return;
  }
  let p = particles[id.x];
  let life = particleLife(p);
  if (p.age >= life) {
    return;
  }
  let dt = sim.params.x;
  let up = normalize(p.position);
  let rises = particleSize(p) < 0.0;
  // Debris falls and is slowed by the air; a bubble drifts up and wobbles.
  var velocity = particleVelocity(p);
  if (rises) {
    velocity += up * sim.params.z * 0.15 * dt;
    velocity *= 1.0 - min(dt * 2.5, 1.0);
  } else {
    velocity -= up * sim.params.z * dt;
    velocity *= 1.0 - min(dt * 0.6, 1.0);
  }
  var position = p.position + velocity * dt;
  // The ground is somewhere under where it started; a falling speck that has
  // dropped below the sea's radius has gone into the ground and stops there.
  let seaLevel = sim.params.y;
  if (!rises && length(position) < seaLevel) {
    position = normalize(position) * seaLevel;
    velocity = vec3f(0.0);
  }
  particles[id.x] = makeParticle(
    position, p.age + dt, velocity, life, particleColor(p), particleSize(p));
}
