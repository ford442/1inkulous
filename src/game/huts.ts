import type { Vec3 } from '../engine/math'
import { screenRay, type Ray, type RayCamera } from '../engine/picking'
import type { InputSnapshot, PointerClick } from '../input/input'
import { HutSite } from '../sim/hutSite'
import type { Simulation } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'

/**
 * Huts — the first buildings, and the loop they start: flatten a pad, drop a
 * hut, send followers in, and the hut breeds more.
 *
 * As with followers, the huts themselves live in the C++ core: it decides
 * where one may stand, who goes inside, and when a hut breeds. This module is
 * the player's side of it — build mode and its ghost, picking a hut under the
 * cursor, and turning a right-click on one into an enter order.
 */

/** Overall height of the placeholder hut, as a multiple of its footprint radius. */
export const HUT_HEIGHT_RATIO = 1.0

/** Instance layout, in floats: position(3), heading(3), tribe, occupants. */
const OFFSET_POSITION = 0

/** A ghost instance's occupants slot: the hut shader tints by these. */
export const GHOST_VALID = -1
export const GHOST_INVALID = -2

/** How long a one-line notice (hut full, nobody fits) stays on the HUD. */
const NOTICE_MS = 2500

const BUILD_KEYS = ['KeyB']
const CANCEL_KEYS = ['Escape']

export type HutViewContext = {
  camera: RayCamera
  /** Viewport width / height. */
  aspect: number
}

/** Where build mode would put a hut, and whether the core would allow it. */
export type HutGhost = {
  readonly direction: Vec3
  readonly heading: Vec3
  readonly site: HutSite
}

export type HutUpdate = {
  /** Clicks this frame that were a build or an enter order, not a selection. */
  consumed: ReadonlySet<PointerClick>
  /** True while build mode owns the left button, so no box selection starts. */
  building: boolean
}

export type HutOptions = {
  /**
   * When false, B does not toggle build mode. Land-claim buildings own that
   * key; a right-click on one of these huts is still an enter order.
   */
  buildMode?: boolean
}

export type Huts = {
  /** False when another system owns the B key, so the HUD does not offer it here. */
  readonly ownsBuildKey: boolean
  readonly building: boolean
  /** Null outside build mode, while sculpting, or with the cursor off the planet. */
  readonly ghost: HutGhost | null
  readonly count: number
  readonly housedCount: number
  readonly capacity: number
  /** Footprint radius in world units. */
  readonly radius: number
  /** Everyone in the world: out walking and inside huts. */
  readonly population: number
  /** A short message about the last order, or null once it has aged out. */
  readonly notice: string | null
  /** Live view of the core's hut instance buffer. Re-read every frame. */
  instances: () => Float32Array
  readonly instanceFloats: number
  /** The ghost as one more instance for the hut pipeline, or null. */
  ghostInstance: () => Float32Array | null
  update: (deltaMs: number, input: InputSnapshot, view: HutViewContext) => HutUpdate
}

export function createHuts(planet: Planet, simulation: Simulation, options: HutOptions = {}): Huts {
  const buildMode = options.buildMode !== false
  const radius = simulation.hutRadius
  const height = radius * HUT_HEIGHT_RATIO
  const instanceFloats = simulation.hutInstanceFloats

  let building = false
  let ghost: HutGhost | null = null
  let notice: string | null = null
  let noticeMs = 0
  const ghostData = new Float32Array(instanceFloats)

  const say = (message: string) => {
    notice = message
    noticeMs = NOTICE_MS
  }

  const ghostAt = (ray: Ray, eye: Vec3): HutGhost | null => {
    const direction = planet.pickDirection(ray)
    if (!direction) {
      return null
    }
    return {
      direction,
      heading: doorTowards(direction, eye),
      site: simulation.hutSite(direction),
    }
  }

  return {
    ownsBuildKey: buildMode,
    get building() {
      return building
    },
    get ghost() {
      return ghost
    },
    get count() {
      return simulation.hutCount
    },
    get housedCount() {
      return simulation.housedCount
    },
    capacity: simulation.hutCapacity,
    radius,
    get population() {
      return simulation.followerCount + simulation.housedCount
    },
    get notice() {
      return notice
    },
    instances() {
      return simulation.hutInstances()
    },
    instanceFloats,

    ghostInstance() {
      if (!ghost) {
        return null
      }
      const point = planet.surfacePointAt(ghost.direction)
      ghostData[0] = point[0]
      ghostData[1] = point[1]
      ghostData[2] = point[2]
      ghostData[3] = ghost.heading[0]
      ghostData[4] = ghost.heading[1]
      ghostData[5] = ghost.heading[2]
      ghostData[6] = -1
      ghostData[7] = ghost.site === HutSite.ok ? GHOST_VALID : GHOST_INVALID
      return ghostData
    },

    update(deltaMs: number, input: InputSnapshot, view: HutViewContext) {
      const consumed = new Set<PointerClick>()

      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      if (buildMode && BUILD_KEYS.some((code) => input.pressed.has(code))) {
        building = !building
      }
      if (CANCEL_KEYS.some((code) => input.pressed.has(code))) {
        building = false
      }

      // The brush has first claim on the mouse while C is down, so the ghost
      // steps aside and the player can see the ground they are levelling.
      const sculpting = isSculptModifierHeld(input)
      const pointer = input.pointer
      ghost =
        building && !sculpting && pointer.ndc
          ? ghostAt(screenRay(view.camera, pointer.ndc.x, pointer.ndc.y, view.aspect), view.camera.eye)
          : null

      for (const click of pointer.clicks) {
        if (click.button === 'middle' || isSculptModifierIn(click.held)) {
          continue
        }
        const ray = screenRay(view.camera, click.ndc.x, click.ndc.y, view.aspect)

        if (building) {
          consumed.add(click)
          if (click.button === 'right') {
            building = false
            continue
          }
          // Judged where the click landed, not where the ghost was drawn: the
          // two differ when the pointer moved between the event and the frame.
          const site = ghostAt(ray, view.camera.eye)
          if (!site) {
            continue
          }
          if (site.site !== HutSite.ok) {
            say(siteProblem(site.site))
            continue
          }
          if (simulation.placeHut(site.direction, site.heading) >= 0) {
            // Shift keeps placing, the usual RTS binding for queued builds.
            building = click.shiftKey
          }
          continue
        }

        if (click.button !== 'right' || simulation.selectedFollowerCount === 0) {
          continue
        }
        const id = hutIdUnderRay(
          simulation.hutInstances(),
          instanceFloats,
          ray,
          view.camera.eye,
          radius,
          height,
        )
        if (id < 0) {
          continue
        }
        // A right-click on a hut is always an enter order, even one nobody can
        // follow: walking the selection into the wall instead would surprise.
        consumed.add(click)
        const sent = simulation.orderEnterHut(id)
        say(
          sent > 0
            ? `${sent} going in`
            : simulation.hutOccupants(id) >= simulation.hutCapacity
              ? 'that hut is full'
              : 'nobody selected can go in there',
        )
      }

      return { consumed, building }
    },
  }
}

/** What the HUD says about a site the core turned down. */
export function siteProblem(site: HutSite): string {
  switch (site) {
    case HutSite.ok:
      return 'site is clear'
    case HutSite.water:
      return 'needs dry land all round'
    case HutSite.uneven:
      return 'too uneven — flatten it (hold C, Shift + left-drag)'
    case HutSite.crowded:
      return 'too close to another hut'
    case HutSite.full:
      return 'no room for more huts'
    default:
      return 'the world is not ready'
  }
}

/**
 * A door facing the camera: the tangent at `direction` that points towards the
 * eye. Falls back to any tangent when the eye is straight overhead.
 */
export function doorTowards(direction: Vec3, eye: Vec3): Vec3 {
  const [nx, ny, nz] = direction
  let tx = eye[0]
  let ty = eye[1]
  let tz = eye[2]
  const along = tx * nx + ty * ny + tz * nz
  tx -= nx * along
  ty -= ny * along
  tz -= nz * along
  let length = Math.hypot(tx, ty, tz)
  if (length < 1e-9) {
    // Straight down at the site: face the door east-ish, like a fresh spawn.
    tx = -nz
    ty = 0
    tz = nx
    length = Math.hypot(tx, ty, tz)
    if (length < 1e-9) {
      return [1, 0, 0]
    }
  }
  return [tx / length, ty / length, tz / length]
}

/**
 * The hut a ray hits, or -1. Each hut is a sphere of its footprint radius
 * centred halfway up, which is close enough to the placeholder's shape that a
 * click on the walls or the roof lands. Huts on the far side of the planet are
 * skipped with the same horizon test followers use.
 */
export function hutIdUnderRay(
  instances: Float32Array,
  stride: number,
  ray: Ray,
  eye: Vec3,
  radius: number,
  height: number,
): number {
  const count = stride > 0 ? Math.floor(instances.length / stride) : 0
  let best = -1
  let bestDistance = Infinity

  for (let id = 0; id < count; id += 1) {
    const base = id * stride + OFFSET_POSITION
    const px = instances[base]
    const py = instances[base + 1]
    const pz = instances[base + 2]

    if (px * (eye[0] - px) + py * (eye[1] - py) + pz * (eye[2] - pz) <= 0) {
      continue
    }

    const r = Math.hypot(px, py, pz)
    if (r === 0) {
      continue
    }
    const lift = height * 0.5
    const cx = px + (px / r) * lift - ray.origin[0]
    const cy = py + (py / r) * lift - ray.origin[1]
    const cz = pz + (pz / r) * lift - ray.origin[2]
    const along = cx * ray.direction[0] + cy * ray.direction[1] + cz * ray.direction[2]
    if (along <= 0 || along >= bestDistance) {
      continue
    }
    const perpendicular = cx * cx + cy * cy + cz * cz - along * along
    if (perpendicular > radius * radius) {
      continue
    }
    best = id
    bestDistance = along
  }

  return best
}
