import type { InputSnapshot } from '../input/input'
import { normalize, type Vec3 } from '../engine/math'

/**
 * Where the light comes from.
 *
 * - `follow` (the default): the sun rides with the camera as a three-quarter
 *   key light, up and to the right of the viewer. Whatever side of the planet
 *   the player orbits round to is lit, which is what play needs.
 * - `cycle`: the sun stays where it was and the planet turns under it. Half
 *   the planet is in night, the terminator sweeps round once a DAY_SECONDS,
 *   and dusk shows in the air. N toggles it.
 */
export type SunMode = 'follow' | 'cycle'

export const DAY_SECONDS = 120
/** The planet's axial tilt in `cycle`, so the day is not the same at every latitude. */
const TILT = (23 * Math.PI) / 180
const TOGGLE_KEYS = ['KeyN']

export type Sun = {
  readonly mode: SunMode
  /** Unit vector towards the sun. */
  readonly direction: Vec3
  /** 0..1 through the day since the cycle was turned on; null in `follow`. */
  readonly dayFraction: number | null
  update: (deltaMs: number, input: InputSnapshot, eye: Vec3) => void
}

/** The key light for a camera at `eye` looking at the planet's centre. Pure. */
export function followSunDirection(eye: Vec3): Vec3 {
  const forward = normalize([-eye[0], -eye[1], -eye[2]])
  // Camera right, from the world up axis. Falls back near the poles, where the
  // orbit pitch is clamped short of straight down anyway.
  const right = normalize([forward[2], 0, -forward[0]])
  const up: Vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]

  // Negated forward, so the light points from the viewer towards the planet.
  return normalize([
    -forward[0] * 0.6 + right[0] * 0.55 + up[0] * 0.5,
    -forward[1] * 0.6 + right[1] * 0.55 + up[1] * 0.5,
    -forward[2] * 0.6 + right[2] * 0.55 + up[2] * 0.5,
  ])
}

/** The axis the planet turns on in `cycle`: world y, tipped by the axial tilt. */
export const SPIN_AXIS: Vec3 = [Math.sin(TILT), Math.cos(TILT), 0]
/** How far from the equator the turning sun may sit, so every day has a night. */
const MAX_SUN_LATITUDE = (35 * Math.PI) / 180

/**
 * The sun `fraction` of a day after it stood at `start`: `start` turned about
 * SPIN_AXIS. Pure. A day later it is back where it began.
 */
export function turnSun(start: Vec3, fraction: number): Vec3 {
  const angle = fraction * Math.PI * 2
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const [kx, ky, kz] = SPIN_AXIS
  const along = kx * start[0] + ky * start[1] + kz * start[2]
  const cross: Vec3 = [
    ky * start[2] - kz * start[1],
    kz * start[0] - kx * start[2],
    kx * start[1] - ky * start[0],
  ]
  // Rodrigues' rotation.
  return normalize([
    start[0] * c + cross[0] * s + kx * along * (1 - c),
    start[1] * c + cross[1] * s + ky * along * (1 - c),
    start[2] * c + cross[2] * s + kz * along * (1 - c),
  ])
}

/**
 * Where the day starts from when the cycle is turned on: the sun as it is,
 * unless it is so near the pole that the day would hardly turn, in which case
 * it is brought down to MAX_SUN_LATITUDE. Pure.
 */
export function dayStart(direction: Vec3): Vec3 {
  const [kx, ky, kz] = SPIN_AXIS
  const along = kx * direction[0] + ky * direction[1] + kz * direction[2]
  const limit = Math.sin(MAX_SUN_LATITUDE)
  if (Math.abs(along) <= limit) {
    return direction
  }
  const flat: Vec3 = [direction[0] - kx * along, direction[1] - ky * along, direction[2] - kz * along]
  // Straight down the axis has no east or west; pick one.
  const across = Math.hypot(...flat) > 1e-6 ? normalize(flat) : normalize([-ky, kx, 0])
  const height = Math.sign(along) * limit
  const width = Math.sqrt(1 - limit * limit)
  return normalize([
    across[0] * width + kx * height,
    across[1] * width + ky * height,
    across[2] * width + kz * height,
  ])
}

export function createSun(): Sun {
  let mode: SunMode = 'follow'
  let direction: Vec3 = [0.4, 0.6, 0.7]
  let start: Vec3 = direction
  let fraction = 0

  return {
    get mode() {
      return mode
    },
    get direction() {
      return direction
    },
    get dayFraction() {
      return mode === 'cycle' ? fraction : null
    },
    update(deltaMs, input, eye) {
      if (TOGGLE_KEYS.some((code) => input.pressed.has(code))) {
        if (mode === 'follow') {
          mode = 'cycle'
          start = dayStart(direction)
          fraction = 0
        } else {
          mode = 'follow'
        }
      }
      if (mode === 'cycle') {
        fraction = (fraction + deltaMs / 1000 / DAY_SECONDS) % 1
        direction = turnSun(start, fraction)
      } else {
        direction = followSunDirection(eye)
      }
    },
  }
}
