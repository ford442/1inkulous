import { screenRay, type RayCamera } from '../engine/picking'
import type { Vec3 } from '../engine/math'
import type { InputSnapshot } from '../input/input'
import type { Planet } from './planet'

/**
 * Terrain brush. Holding the sculpt modifier arms it: left button raises the
 * land under the cursor, right button lowers it, and the stroke is continuous —
 * holding still keeps piling earth up, as in Populous, rather than needing the
 * mouse to move.
 */

export type SculptMode = 'idle' | 'raise' | 'lower'

export type Sculptor = {
  /** True while the sculpt modifier is held, whether or not a button is down. */
  readonly armed: boolean
  readonly mode: SculptMode
  /** Unit direction of the terrain under the cursor, null when off the planet. */
  readonly hoverDirection: Vec3 | null
  /** Brush footprint as an angular radius on the sphere, in radians. */
  readonly brushRadius: number
  /** Height change per second at the centre of the brush, in world units. */
  readonly brushStrength: number
  update: (deltaMs: number, input: InputSnapshot, view: ViewContext) => void
}

export type ViewContext = {
  camera: RayCamera
  /** Viewport width / height. */
  aspect: number
}

/** Small enough for precise edits at the default mesh resolution. */
const DEFAULT_RADIUS = 0.1
const MIN_RADIUS = 0.03
const MAX_RADIUS = 0.4
const RADIUS_PER_NOTCH = 1.12

/** As a fraction of the planet's maximum terrain height, per second. */
const DEFAULT_STRENGTH_FRACTION = 0.8
const MIN_STRENGTH_FRACTION = 0.15
const MAX_STRENGTH_FRACTION = 3
const STRENGTH_STEP = 1.25

const SCULPT_KEYS = ['KeyC']

/**
 * Whether the brush is armed this frame. Exported so the camera can be told to
 * release drag and the wheel before either is read.
 */
export function isSculptModifierHeld(input: InputSnapshot): boolean {
  return isSculptModifierIn(input.keys)
}

/** Same test against a click's held-key snapshot, which can differ from now. */
export function isSculptModifierIn(codes: ReadonlySet<string>): boolean {
  return SCULPT_KEYS.some((code) => codes.has(code))
}

export function createSculptor(planet: Planet): Sculptor {
  let brushRadius = DEFAULT_RADIUS
  let strengthFraction = DEFAULT_STRENGTH_FRACTION
  let hoverDirection: Vec3 | null = null
  let mode: SculptMode = 'idle'
  let armed = false

  return {
    get armed() {
      return armed
    },
    get mode() {
      return mode
    },
    get hoverDirection() {
      return hoverDirection
    },
    get brushRadius() {
      return brushRadius
    },
    get brushStrength() {
      return strengthFraction * planet.maxHeight
    },

    update(deltaMs: number, input: InputSnapshot, view: ViewContext) {
      const { pointer, pressed } = input
      armed = isSculptModifierHeld(input)

      // Brush size follows the wheel while armed — the camera gives up zoom for
      // as long as the modifier is down.
      if (armed && pointer.wheel !== 0) {
        brushRadius = Math.min(
          MAX_RADIUS,
          Math.max(MIN_RADIUS, brushRadius * RADIUS_PER_NOTCH ** pointer.wheel),
        )
      }

      if (pressed.has('BracketLeft')) {
        strengthFraction = Math.max(MIN_STRENGTH_FRACTION, strengthFraction / STRENGTH_STEP)
      }
      if (pressed.has('BracketRight')) {
        strengthFraction = Math.min(MAX_STRENGTH_FRACTION, strengthFraction * STRENGTH_STEP)
      }

      if (!armed || !pointer.ndc) {
        hoverDirection = null
        mode = 'idle'
        return
      }

      const ray = screenRay(view.camera, pointer.ndc.x, pointer.ndc.y, view.aspect)
      hoverDirection = planet.pickDirection(ray)

      const raise = pointer.buttons.left
      const lower = pointer.buttons.right
      mode = raise ? 'raise' : lower ? 'lower' : 'idle'

      if (!hoverDirection || mode === 'idle') {
        return
      }

      // Clamp the step so one long frame cannot gouge the terrain.
      const dt = Math.min(deltaMs, 100) / 1000
      const delta = strengthFraction * planet.maxHeight * dt
      planet.sculpt(hoverDirection, brushRadius, mode === 'raise' ? delta : -delta)
    },
  }
}
