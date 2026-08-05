import type { InputSnapshot } from '../input/input'
import { createPlanet, type Planet } from './planet'

export type Camera = {
  /** Orbit angle around the planet's polar axis, radians. */
  yaw: number
  /** Orbit angle above/below the equator, radians. */
  pitch: number
  /** Distance from the planet centre, in world units. */
  distance: number
  fovY: number
}

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  camera: Camera
  /** Planet self-rotation, radians. */
  spin: number
  update: (deltaMs: number, input: InputSnapshot) => void
}

const ORBIT_SPEED = 1.2 // radians / second
const ZOOM_SPEED = 1.4 // world units / second
const AUTO_SPIN = 0.06 // radians / second
const PITCH_LIMIT = Math.PI / 2 - 0.05

export function createGame(): Game {
  const planet = createPlanet({ resolution: 8 })

  // Close enough that the whole tribe ecosystem is visible at once, which is how
  // the original game framed its planets.
  const camera: Camera = {
    yaw: 0.6,
    pitch: 0.45,
    distance: planet.radius * 3,
    fovY: (45 * Math.PI) / 180,
  }

  const state = {
    clearColor: [0.04, 0.05, 0.09] as [number, number, number],
    spin: 0,
  }

  // Closest zoom still shows the curve of the limb rather than a flat wall of terrain.
  const minDistance = planet.radius * 1.9
  const maxDistance = planet.radius * 8

  return {
    planet,
    camera,
    get clearColor() {
      return state.clearColor
    },
    get spin() {
      return state.spin
    },
    update(deltaMs: number, input: InputSnapshot) {
      const dt = Math.min(deltaMs, 100) / 1000
      const held = (...codes: string[]) => codes.some((code) => input.keys.has(code))

      if (held('ArrowLeft', 'KeyA')) camera.yaw -= ORBIT_SPEED * dt
      if (held('ArrowRight', 'KeyD')) camera.yaw += ORBIT_SPEED * dt
      if (held('ArrowUp', 'KeyW')) camera.pitch += ORBIT_SPEED * dt
      if (held('ArrowDown', 'KeyS')) camera.pitch -= ORBIT_SPEED * dt
      if (held('KeyQ', 'Equal')) camera.distance -= ZOOM_SPEED * dt
      if (held('KeyE', 'Minus')) camera.distance += ZOOM_SPEED * dt

      camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch))
      camera.distance = Math.max(minDistance, Math.min(maxDistance, camera.distance))

      // Hold Space to hold the globe still.
      if (!input.keys.has('Space')) {
        state.spin += AUTO_SPIN * dt
      }
    },
  }
}
