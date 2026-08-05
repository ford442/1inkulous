import { mat4LookAt, type Mat4, type Vec3 } from '../engine/math'
import type { InputSnapshot } from '../input/input'

/**
 * Orbit camera for the planet: the eye sits on a sphere around a target (the
 * planet centre for now, a tribe or spell site later) and the player swings it
 * around by dragging. Every control writes to a *desired* yaw/pitch/distance,
 * and the live values chase those exponentially, so drags feel direct but stop
 * without a jolt.
 */

export type CameraOptions = {
  planetRadius: number
  /** Highest terrain above sea level, so zooming in cannot enter a mountain. */
  maxTerrainHeight?: number
  target?: Vec3
}

export type CameraUpdateOptions = {
  /** Set false to let another tool (the terrain brush) own drag and the wheel. */
  allowPointerOrbit?: boolean
  allowPointerZoom?: boolean
}

export type Camera = {
  readonly eye: Vec3
  readonly target: Vec3
  readonly viewMatrix: Mat4
  readonly fovY: number
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
  readonly minDistance: number
  readonly maxDistance: number
  update: (
    deltaMs: number,
    input: InputSnapshot,
    options?: CameraUpdateOptions,
  ) => void
  /** Swing to one of the four cardinal headings, keeping the default tilt. */
  snapToCardinal: (quarterTurns: number) => void
  reset: () => void
}

/** Populous framed its worlds from above the horizon, not straight down a pole. */
const DEFAULT_PITCH = 0.42
const DEFAULT_YAW = 0.6
/** Short of the pole, so the world-up axis stays a usable view reference. */
const PITCH_LIMIT = (80 * Math.PI) / 180

const FOV_Y = (45 * Math.PI) / 180

const ORBIT_RADIANS_PER_PIXEL = 0.006
const KEY_ORBIT_SPEED = 1.2 // radians / second
const KEY_ZOOM_SPEED = 2.0 // world units / second
const ZOOM_PER_NOTCH = 1.12 // multiplicative, so each notch feels the same
/**
 * Exponential chase rate: ~44% of the remaining distance in the first 60fps
 * frame and ~97% within 100ms. Enough to take the edge off without the camera
 * feeling like it lags behind the cursor.
 */
const SMOOTHING = 35

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function createCamera(options: CameraOptions): Camera {
  const radius = options.planetRadius
  const maxTerrainHeight = options.maxTerrainHeight ?? 0

  // Closest zoom still shows the curve of the limb rather than a flat wall of
  // terrain, and clears the tallest peak by a wide margin.
  const minDistance = Math.max(radius * 1.9, radius + maxTerrainHeight + radius * 0.15)
  // Furthest zoom keeps the planet a readable disc instead of a distant speck.
  const maxDistance = radius * 8
  const defaultDistance = radius * 3

  const target: Vec3 = options.target ? [...options.target] : [0, 0, 0]
  const eye: Vec3 = [0, 0, 0]
  const viewMatrix = new Float32Array(16)

  let yaw = DEFAULT_YAW
  let pitch = DEFAULT_PITCH
  let distance = defaultDistance
  let desiredYaw = yaw
  let desiredPitch = pitch
  let desiredDistance = distance
  let middleWasDown = false

  const refresh = () => {
    const cosPitch = Math.cos(pitch)
    eye[0] = target[0] + distance * cosPitch * Math.sin(yaw)
    eye[1] = target[1] + distance * Math.sin(pitch)
    eye[2] = target[2] + distance * cosPitch * Math.cos(yaw)
    mat4LookAt(eye, target, [0, 1, 0], viewMatrix)
  }

  refresh()

  const setDesiredYaw = (value: number) => {
    // Take the short way round rather than unwinding a full turn.
    desiredYaw = value + Math.PI * 2 * Math.round((yaw - value) / (Math.PI * 2))
  }

  const camera: Camera = {
    eye,
    target,
    viewMatrix,
    fovY: FOV_Y,
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
    get distance() {
      return distance
    },
    minDistance,
    maxDistance,

    update(deltaMs: number, input: InputSnapshot, options: CameraUpdateOptions = {}) {
      // Clamp the step so a backgrounded tab does not resume with a huge jump.
      const dt = clamp(deltaMs, 0, 100) / 1000
      const { pointer, keys, pressed } = input
      const allowPointerOrbit = options.allowPointerOrbit ?? true
      const allowPointerZoom = options.allowPointerZoom ?? true

      // Left-drag grabs the globe: the surface follows the cursor, as in Google
      // Earth. That means dragging right swings the eye the other way, hence the
      // negated yaw. (The keys below are the other convention — they move the
      // camera, so Right sends the eye right and the world slides left.)
      // Sensitivity shrinks as you zoom in, so a pixel of drag moves roughly the
      // same amount of surface at every distance.
      if (allowPointerOrbit && pointer.dragging && pointer.buttons.left) {
        const scale =
          ORBIT_RADIANS_PER_PIXEL * clamp(distance / defaultDistance, 0.35, 1.25)
        desiredYaw -= pointer.delta.x * scale
        desiredPitch += pointer.delta.y * scale
      }

      // Middle-click snaps back to the opening view.
      if (pointer.buttons.middle && !middleWasDown) {
        camera.reset()
      }
      middleWasDown = pointer.buttons.middle

      if (allowPointerZoom && pointer.wheel !== 0) {
        desiredDistance *= ZOOM_PER_NOTCH ** pointer.wheel
      }

      const held = (...codes: string[]) => codes.some((code) => keys.has(code))
      if (held('ArrowLeft', 'KeyA')) desiredYaw -= KEY_ORBIT_SPEED * dt
      if (held('ArrowRight', 'KeyD')) desiredYaw += KEY_ORBIT_SPEED * dt
      if (held('ArrowUp', 'KeyW')) desiredPitch += KEY_ORBIT_SPEED * dt
      if (held('ArrowDown', 'KeyS')) desiredPitch -= KEY_ORBIT_SPEED * dt
      if (held('KeyQ', 'Equal')) desiredDistance -= KEY_ZOOM_SPEED * dt
      if (held('KeyE', 'Minus')) desiredDistance += KEY_ZOOM_SPEED * dt

      if (pressed.has('Digit1')) camera.snapToCardinal(0)
      if (pressed.has('Digit2')) camera.snapToCardinal(1)
      if (pressed.has('Digit3')) camera.snapToCardinal(2)
      if (pressed.has('Digit4')) camera.snapToCardinal(3)
      if (pressed.has('Digit0') || pressed.has('Home')) camera.reset()

      desiredPitch = clamp(desiredPitch, -PITCH_LIMIT, PITCH_LIMIT)
      desiredDistance = clamp(desiredDistance, minDistance, maxDistance)

      // Frame-rate independent exponential chase.
      const t = 1 - Math.exp(-SMOOTHING * dt)
      yaw += (desiredYaw - yaw) * t
      pitch += (desiredPitch - pitch) * t
      distance += (desiredDistance - distance) * t

      // The chase only ever approaches its target, but clamp anyway so no
      // rounding can put the eye inside the planet.
      distance = clamp(distance, minDistance, maxDistance)
      pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT)

      refresh()
    },

    snapToCardinal(quarterTurns: number) {
      setDesiredYaw((Math.PI / 2) * quarterTurns)
      desiredPitch = DEFAULT_PITCH
    },

    reset() {
      setDesiredYaw(DEFAULT_YAW)
      desiredPitch = DEFAULT_PITCH
      desiredDistance = defaultDistance
    },
  }

  return camera
}
