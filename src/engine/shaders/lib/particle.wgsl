// One spell-effect particle, as the simulation step writes it and the draw
// reads it. 48 bytes in f32; 32 with shader-f16, where velocity and colour
// drop to half precision (plenty for a speck of dust that lives two
// seconds) and the buffer the step walks every frame shrinks by a third.
// PARTICLE_BYTES in particles.ts mirrors both.
//
// `size` is world units across; a negative size marks a particle that rises
// (a bubble) instead of falling (debris), which saves a field.
// A particle with age >= life is dead and draws nothing.

#ifdef SHADER_F16
struct Particle {
  position: vec3f,
  age: f32,
  velocity: vec3h,
  life: f16,
  color: vec3h,
  size: f16,
}
#else
struct Particle {
  position: vec3f,
  age: f32,
  velocity: vec3f,
  life: f32,
  color: vec3f,
  size: f32,
}
#endif

#ifdef SHADER_F16
fn makeParticle(position: vec3f, age: f32, velocity: vec3f, life: f32, color: vec3f, size: f32) -> Particle {
  return Particle(position, age, vec3h(velocity), f16(life), vec3h(color), f16(size));
}
#else
fn makeParticle(position: vec3f, age: f32, velocity: vec3f, life: f32, color: vec3f, size: f32) -> Particle {
  return Particle(position, age, velocity, life, color, size);
}
#endif

fn particleVelocity(p: Particle) -> vec3f { return vec3f(p.velocity); }
fn particleLife(p: Particle) -> f32 { return f32(p.life); }
fn particleColor(p: Particle) -> vec3f { return vec3f(p.color); }
fn particleSize(p: Particle) -> f32 { return f32(p.size); }
