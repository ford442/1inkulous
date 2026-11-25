/**
 * Spell effects as GPU particles. The CPU's whole part is saying where a burst
 * goes and what it looks like (`ParticleBurst`), packed into one small uniform
 * block per frame; a compute pass writes the new particles into a ring buffer
 * and moves every live one, and the scene pass draws them straight from that
 * buffer. No particle ever crosses back to the CPU.
 *
 * Which spell makes which burst is `burstsForLanding`, the one place to tune
 * how a spell looks when it lands.
 */
import type { Vec3 } from './math'
import type { PipelineFactory } from './materials'
import { Spell } from '../sim/spell'
import particleDraw from './shaders/particle_draw.wgsl'
import particleStep from './shaders/particle_step.wgsl'

/** Ring capacity. A blast is ~800; the ring holds a few spells at once. */
export const PARTICLE_CAPACITY = 8192
/** Mirrors `struct Particle` in shaders/lib/particle.wgsl. */
export const PARTICLE_BYTES = { f32: 48, f16: 32 } as const
/** Mirrors MAX_BURSTS in particle_step.wgsl. */
export const MAX_BURSTS = 16
/** Mirrors `struct Step`: params(4) counts(4) then four vec4s per burst. */
export const STEP_FLOATS = 8 + MAX_BURSTS * 16
const WORKGROUP = 64

export type ParticleBurst = {
  /** A surface point at the burst's centre. */
  center: Vec3
  /** Angular radius of the disc particles start on. */
  radius: number
  color: Vec3
  /** World units across. Negative: the particle rises, like a bubble. */
  size: number
  count: number
  /** Launch speed, world units per second. */
  speed: number
  /** Seconds a particle lives, give or take 40%. */
  life: number
  /** 0 launches straight up, 1 leans well out from the centre. */
  spread: number
  /** How much each particle's colour varies, 0..1. */
  variation: number
}

export type PackedBursts = {
  data: Float32Array
  /** Particles spawned, across every burst kept. */
  total: number
  /** Where the next frame's first burst starts in the ring. */
  cursor: number
  /** Bursts kept: at most MAX_BURSTS, and only those with particles. */
  bursts: number
}

/**
 * Lays a frame's bursts out as the step's uniform block. Pure, so the ring
 * arithmetic can be checked without a GPU. Each burst takes the next `count`
 * slots of the ring from `cursor`, wrapping; past MAX_BURSTS the rest wait,
 * and no burst may take more than the whole ring.
 */
export function packBursts(
  bursts: readonly ParticleBurst[],
  cursor: number,
  options: { dt: number; planetRadius: number; gravity: number; capacity?: number; seed?: number },
): PackedBursts {
  const capacity = options.capacity ?? PARTICLE_CAPACITY
  const data = new Float32Array(STEP_FLOATS)
  const counts = new Uint32Array(data.buffer, 16, 4)
  let next = cursor % capacity
  let total = 0
  let kept = 0
  for (const burst of bursts) {
    if (kept >= MAX_BURSTS) {
      break
    }
    const count = Math.min(Math.max(0, Math.floor(burst.count)), capacity - total)
    if (count === 0) {
      continue
    }
    const base = 8 + kept * 16
    data.set([burst.center[0], burst.center[1], burst.center[2], burst.radius], base)
    data.set([burst.color[0], burst.color[1], burst.color[2], burst.size], base + 4)
    data.set([next, count, burst.speed, burst.life], base + 8)
    data.set([((options.seed ?? 0) + kept * 7919 + next) % 16777216, burst.variation, burst.spread, 0], base + 12)
    next = (next + count) % capacity
    total += count
    kept += 1
  }
  data[0] = options.dt
  data[1] = options.planetRadius
  data[2] = options.gravity
  data[3] = kept
  counts[0] = capacity
  counts[1] = total
  return { data, total, cursor: next, bursts: kept }
}

/**
 * How a spell looks when it lands. `center` is a unit direction (where the
 * core says the spell landed), `surface` the ground there now, `radius` the
 * disc it wrote. Sizes are in planet radii.
 */
export function burstsForLanding(
  landing: { spell: Spell; radius: number },
  surface: Vec3,
  planetRadius: number,
): ParticleBurst[] {
  const r = planetRadius
  const at = { center: surface, radius: landing.radius }
  switch (landing.spell) {
    case Spell.blast:
      // Rock and earth thrown out of the new hill, and a flash of sparks.
      return [
        { ...at, color: [0.42, 0.33, 0.24], size: 0.010 * r, count: 650, speed: 0.40 * r, life: 2.2, spread: 0.9, variation: 0.5 },
        { ...at, radius: landing.radius * 0.5, color: [3.2, 1.5, 0.45], size: 0.006 * r, count: 220, speed: 0.55 * r, life: 0.9, spread: 1.0, variation: 0.3 },
      ]
    case Spell.swamp:
      // Bubbles of marsh gas rising off the sunken ground for a while.
      return [
        { ...at, color: [0.30, 0.50, 0.22], size: -0.008 * r, count: 520, speed: 0.025 * r, life: 3.2, spread: 0.1, variation: 0.6 },
        { ...at, color: [0.18, 0.30, 0.14], size: 0.007 * r, count: 160, speed: 0.10 * r, life: 1.2, spread: 0.6, variation: 0.4 },
      ]
    case Spell.flatten:
      // A ring of dust pushed out as the ground is levelled.
      return [
        { ...at, color: [0.72, 0.64, 0.48], size: 0.014 * r, count: 420, speed: 0.12 * r, life: 1.7, spread: 1.0, variation: 0.3 },
      ]
    case Spell.landBridge:
      // Wet sand settling where the bridge rose.
      return [
        { ...at, color: [0.86, 0.78, 0.55], size: 0.009 * r, count: 320, speed: 0.16 * r, life: 1.5, spread: 0.5, variation: 0.3 },
      ]
    default:
      return []
  }
}

export type Particles = {
  readonly bytesPerParticle: number
  /** Queues bursts for the next step. */
  emit: (bursts: readonly ParticleBurst[]) => void
  /** Spawns what was emitted and moves every particle `dt` seconds. */
  step: (pass: GPUComputePassEncoder, dt: number) => void
  draw: (pass: GPURenderPassEncoder) => void
  /** True while anything might still be alive, so idle frames skip the work. */
  readonly active: boolean
}

export function createParticles(
  factory: PipelineFactory,
  options: { f16: boolean; planetRadius: number },
): Particles {
  const { device } = factory
  const bytesPerParticle = options.f16 ? PARTICLE_BYTES.f16 : PARTICLE_BYTES.f32
  const buffer = device.createBuffer({
    label: 'particles',
    // Zeroed: age 0 and life 0 is dead.
    size: PARTICLE_CAPACITY * bytesPerParticle,
    usage: GPUBufferUsage.STORAGE,
  })
  const stepBuffer = device.createBuffer({
    label: 'particle-step',
    size: STEP_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const stepGroups: GPUBindGroupLayoutEntry[][] = [
    [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  ]
  const spawn = factory.compute('particle-step', particleStep, 'cs_spawn', stepGroups)
  const move = factory.compute('particle-step', particleStep, 'cs_step', stepGroups)
  const stepBindGroup = (layout: GPUBindGroupLayout) =>
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: { buffer: stepBuffer } },
      ],
    })
  const spawnBindGroup = stepBindGroup(spawn.layouts[0]!)
  const moveBindGroup = stepBindGroup(move.layouts[0]!)

  const material = factory.material({
    label: 'particles',
    code: particleDraw,
    blend: 'premultiplied',
    cullMode: 'none',
    materialEntries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  })
  const drawBindGroup = device.createBindGroup({
    layout: material.materialLayout!,
    entries: [{ binding: 0, resource: { buffer } }],
  })

  let pending: ParticleBurst[] = []
  let cursor = 0
  let seed = 1
  // Seconds until the last particle spawned has certainly died.
  let liveFor = 0

  return {
    bytesPerParticle,
    get active() {
      return liveFor > 0 || pending.length > 0
    },
    emit(bursts) {
      pending.push(...bursts)
    },
    step(pass, dt) {
      const packed = packBursts(pending, cursor, {
        dt,
        planetRadius: options.planetRadius,
        gravity: 0.35 * options.planetRadius,
        seed,
      })
      pending = []
      cursor = packed.cursor
      seed = (seed * 1103515245 + 12345) % 2147483648
      for (let i = 0; i < packed.bursts; i += 1) {
        liveFor = Math.max(liveFor, packed.data[8 + i * 16 + 11]! * 1.4)
      }
      device.queue.writeBuffer(stepBuffer, 0, packed.data)
      if (packed.total > 0) {
        pass.setPipeline(spawn.pipeline)
        pass.setBindGroup(0, spawnBindGroup)
        pass.dispatchWorkgroups(Math.ceil(packed.total / WORKGROUP))
      }
      pass.setPipeline(move.pipeline)
      pass.setBindGroup(0, moveBindGroup)
      pass.dispatchWorkgroups(Math.ceil(PARTICLE_CAPACITY / WORKGROUP))
      liveFor = Math.max(0, liveFor - dt)
    },
    draw(pass) {
      pass.setPipeline(material.pipeline)
      pass.setBindGroup(1, drawBindGroup)
      pass.draw(6, PARTICLE_CAPACITY)
    },
  }
}
