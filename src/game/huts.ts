import type { Vec3 } from '../engine/math'
import { screenRay, type Ray, type RayCamera } from '../engine/picking'
import type { InputSnapshot, PointerClick } from '../input/input'
import { HutKind, HutSite } from '../sim/hutSite'
import type { Simulation } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'

/**
 * Huts — the buildings, and the loop they start: flatten a pad, drop a hut,
 * send braves in, and the hut breeds more; or drop a training hut, and the
 * braves sent in come out as warriors.
 *
 * As with followers, the huts themselves live in the C++ core: it decides
 * where one may stand, what it costs, which nav nodes it blocks, who goes
 * inside, and when a hut breeds or trains. This module is the player's side
 * of it — build mode (B for a hut, T for a training hut) and its ghost,
 * picking a hut under the cursor, and turning a right-click on one into an
 * enter order, or with nobody selected into an eject. Placing does not
 * sculpt; the flatten brush makes the pad.
 */

/** Overall height of the placeholder hut, as a multiple of its footprint radius. */
export const HUT_HEIGHT_RATIO = 1.0

/** The player's tribe. Huts it builds are its own from the start. */
const PLAYER_TRIBE = 0

/** Instance layout, in floats: position(3), heading(3), tribe, occupants, kind. */
const OFFSET_POSITION = 0
const OFFSET_KIND = 8

/** A ghost instance's occupants slot: the hut shader tints by these. */
export const GHOST_VALID = -1
export const GHOST_INVALID = -2

/** How long a one-line notice (hut full, nobody fits) stays on the HUD. */
const NOTICE_MS = 2500

/** One key per kind of building; pressing it again leaves build mode. */
const BUILD_KEYS: ReadonlyArray<readonly [string, HutKind]> = [
  ['KeyB', HutKind.dwelling],
  ['KeyT', HutKind.training],
]
const CANCEL_KEYS = ['Escape']

export type HutViewContext = {
  camera: RayCamera
  /** Viewport width / height. */
  aspect: number
}

/** Where build mode would put a hut, and whether the core would allow it. */
export type HutGhost = {
  readonly kind: HutKind
  /** The anchor node the hut would stand on — the cursor, snapped. */
  readonly direction: Vec3
  readonly heading: Vec3
  readonly site: HutSite
  /** Angle in radians to the edge of the footprint the hut would block. */
  readonly footprint: number
}

export type HutUpdate = {
  /** Clicks this frame that were a build or an enter order, not a selection. */
  consumed: ReadonlySet<PointerClick>
  /** True while build mode owns the left button, so no box selection starts. */
  building: boolean
}

export type Huts = {
  readonly building: boolean
  /** What build mode is placing, or null outside it. */
  readonly buildKind: HutKind | null
  /** Wood the player's next dwelling and training hut cost. */
  readonly dwellingCost: number
  readonly trainingCost: number
  readonly wood: number
  /** Null outside build mode, while sculpting, or with the cursor off the planet. */
  readonly ghost: HutGhost | null
  readonly count: number
  readonly housedCount: number
  readonly capacity: number
  /** Radius of the placeholder mesh in world units. */
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

export function createHuts(planet: Planet, simulation: Simulation): Huts {
  const radius = simulation.hutRadius
  const height = radius * HUT_HEIGHT_RATIO
  const instanceFloats = simulation.hutInstanceFloats

  let buildKind: HutKind | null = null
  let ghost: HutGhost | null = null
  let notice: string | null = null
  let noticeMs = 0
  const ghostData = new Float32Array(instanceFloats)

  const say = (message: string) => {
    notice = message
    noticeMs = NOTICE_MS
  }

  const ghostAt = (ray: Ray, eye: Vec3, kind: HutKind): HutGhost | null => {
    const direction = planet.pickDirection(ray)
    if (!direction) {
      return null
    }
    // Judged for the player's tribe, so a site the ground would take but the
    // stockpile cannot pay for shows red, with the price on the HUD.
    const report = simulation.hutSite(direction, kind, PLAYER_TRIBE)
    const centre = report.centre ?? direction
    return {
      kind,
      direction: centre,
      heading: doorTowards(centre, eye),
      site: report.site,
      footprint: report.footprint,
    }
  }

  return {
    get building() {
      return buildKind !== null
    },
    get buildKind() {
      return buildKind
    },
    get dwellingCost() {
      return simulation.hutCost(HutKind.dwelling, PLAYER_TRIBE)
    },
    get trainingCost() {
      return simulation.hutCost(HutKind.training, PLAYER_TRIBE)
    },
    get wood() {
      return simulation.wood(PLAYER_TRIBE)
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
      ghostData[OFFSET_KIND] = ghost.kind
      return ghostData
    },

    update(deltaMs: number, input: InputSnapshot, view: HutViewContext) {
      const consumed = new Set<PointerClick>()

      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      for (const [code, kind] of BUILD_KEYS) {
        if (input.pressed.has(code)) {
          // The same key again leaves; the other key switches what is placed.
          buildKind = buildKind === kind ? null : kind
        }
      }
      if (CANCEL_KEYS.some((code) => input.pressed.has(code))) {
        buildKind = null
      }

      // The brush has first claim on the mouse while C is down, so the ghost
      // steps aside and the player can see the ground they are levelling.
      const sculpting = isSculptModifierHeld(input)
      const pointer = input.pointer
      ghost =
        buildKind !== null && !sculpting && pointer.ndc
          ? ghostAt(
              screenRay(view.camera, pointer.ndc.x, pointer.ndc.y, view.aspect),
              view.camera.eye,
              buildKind,
            )
          : null

      for (const click of pointer.clicks) {
        if (click.button === 'middle' || isSculptModifierIn(click.held)) {
          continue
        }
        const ray = screenRay(view.camera, click.ndc.x, click.ndc.y, view.aspect)

        if (buildKind !== null) {
          consumed.add(click)
          if (click.button === 'right') {
            buildKind = null
            continue
          }
          // Judged where the click landed, not where the ghost was drawn: the
          // two differ when the pointer moved between the event and the frame.
          const site = ghostAt(ray, view.camera.eye, buildKind)
          if (!site) {
            continue
          }
          if (site.site !== HutSite.ok) {
            say(siteProblem(site.site, simulation.hutCost(buildKind, PLAYER_TRIBE)))
            continue
          }
          if (simulation.placeHut(site.direction, site.heading, PLAYER_TRIBE, buildKind) >= 0) {
            notice = null
            noticeMs = 0
            // Shift keeps placing, the usual RTS binding for queued builds.
            if (!click.shiftKey) {
              buildKind = null
            }
          }
          continue
        }

        if (click.button !== 'right') {
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

        if (simulation.selectedFollowerCount === 0) {
          // Nobody to send in: the player's own hut empties instead, the
          // reverse of going in. Anyone else's is left alone.
          if (simulation.hutTribe(id) !== PLAYER_TRIBE) {
            continue
          }
          consumed.add(click)
          const out = simulation.ejectHut(id)
          say(out > 0 ? `${out} came out` : 'nobody inside')
          continue
        }

        // A right-click on a hut is always an enter order, even one nobody can
        // follow: walking the selection into the wall instead would surprise.
        consumed.add(click)
        const sent = simulation.orderEnterHut(id)
        say(sent > 0 ? `${sent} going in` : enterProblem(simulation, id))
      }

      return { consumed, building: buildKind !== null }
    },
  }
}

/** Why an enter order sent nobody, as the HUD says it. */
function enterProblem(simulation: Simulation, id: number): string {
  const training = simulation.hutKind(id) === HutKind.training
  const capacity = training ? simulation.trainingCapacity : simulation.hutCapacity
  if (simulation.hutOccupants(id) >= capacity) {
    return training ? 'that training hut is busy' : 'that hut is full'
  }
  if (training && simulation.wood(PLAYER_TRIBE) < simulation.warriorCost) {
    return `training a warrior needs ${simulation.warriorCost} wood`
  }
  return 'nobody selected can go in there — only braves do'
}

/** "free", or "10 wood". */
export function woodCost(wood: number): string {
  return wood > 0 ? `${wood} wood` : 'free'
}

/** What a kind of hut is called on the HUD. */
export function kindName(kind: HutKind): string {
  return kind === HutKind.training ? 'training hut' : 'hut'
}

/**
 * What the HUD says about a site the core turned down. `cost` is the wood the
 * building would have cost, for a site refused for want of it.
 */
export function siteProblem(site: HutSite, cost = 0): string {
  switch (site) {
    case HutSite.ok:
      return 'site is clear'
    case HutSite.water:
      return 'needs dry land all round'
    case HutSite.uneven:
      return 'too uneven — flatten a pad (hold C, Shift + left-drag)'
    case HutSite.occupied:
      return 'too close to another hut'
    case HutSite.full:
      return 'no room for more huts'
    case HutSite.noWood:
      return `not enough wood (${cost} needed) — send braves to chop trees`
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
