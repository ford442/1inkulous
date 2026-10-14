import type { Vec3 } from '../engine/math'
import { screenRay, type Ray, type RayCamera } from '../engine/picking'
import type { InputSnapshot, PointerClick } from '../input/input'
import { BuildingKind, BuildingSite } from '../sim/buildingSite'
import type { Simulation } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'

/**
 * Buildings — a hut claims the nav node under the cursor, when that node's
 * neighbourhood is dry land and flat enough to be a pad.
 *
 * The buildings live in the C++ core. This module is the player's side: build
 * mode, the ghost, and turning a left click into `placeBuilding`. Sculpt is
 * how a pad gets made; placing does not flatten.
 */

/** Overall height of the placeholder, as a multiple of its footprint radius. */
export const BUILDING_HEIGHT_RATIO = 1.0

/** First huts belong to the player's tribe and cost nothing. */
const PLAYER_TRIBE = 0

/** Instance layout, in floats: position(3), tribe, kind, occupants, flags, reserved. */
const OFFSET_POSITION = 0
const OFFSET_TRIBE = 3
const OFFSET_KIND = 4
const OFFSET_OCCUPANTS = 5

/** A ghost instance's occupants slot: the shader tints by these. */
const GHOST_VALID = -1
const GHOST_INVALID = -2

const NOTICE_MS = 2500

const BUILD_KEYS = ['KeyB']
const CANCEL_KEYS = ['Escape']

export type BuildingViewContext = {
  camera: RayCamera
  aspect: number
}

export type BuildingGhost = {
  readonly direction: Vec3
  readonly site: BuildingSite
}

export type BuildingUpdate = {
  consumed: ReadonlySet<PointerClick>
  building: boolean
}

export type Buildings = {
  readonly building: boolean
  readonly ghost: BuildingGhost | null
  readonly count: number
  readonly radius: number
  readonly notice: string | null
  /** Short label for the ghost, or null when build mode has nothing under the cursor. */
  readonly siteLabel: string | null
  instances: () => Float32Array
  readonly instanceFloats: number
  ghostInstance: () => Float32Array | null
  update: (deltaMs: number, input: InputSnapshot, view: BuildingViewContext) => BuildingUpdate
}

export function createBuildings(planet: Planet, simulation: Simulation): Buildings {
  const radius = simulation.buildingRadius
  const instanceFloats = simulation.buildingInstanceFloats

  let building = false
  let ghost: BuildingGhost | null = null
  let notice: string | null = null
  let noticeMs = 0
  const ghostData = new Float32Array(instanceFloats)

  const say = (message: string) => {
    notice = message
    noticeMs = NOTICE_MS
  }

  const ghostAt = (ray: Ray): BuildingGhost | null => {
    const direction = planet.pickDirection(ray)
    if (!direction) {
      return null
    }
    return { direction, site: simulation.buildingSite(direction) }
  }

  return {
    get building() {
      return building
    },
    get ghost() {
      return ghost
    },
    get count() {
      return simulation.buildingCount
    },
    radius,
    get notice() {
      return notice
    },
    get siteLabel() {
      if (!building) {
        return null
      }
      if (!ghost) {
        return 'point at the ground'
      }
      return ghost.site === BuildingSite.ok ? 'click to place' : siteProblem(ghost.site)
    },
    instances() {
      return simulation.buildingInstances()
    },
    instanceFloats,

    ghostInstance() {
      if (!ghost) {
        return null
      }
      const point = planet.surfacePointAt(ghost.direction)
      ghostData[OFFSET_POSITION] = point[0]
      ghostData[OFFSET_POSITION + 1] = point[1]
      ghostData[OFFSET_POSITION + 2] = point[2]
      ghostData[OFFSET_TRIBE] = -1
      ghostData[OFFSET_KIND] = BuildingKind.hut
      ghostData[OFFSET_OCCUPANTS] = ghost.site === BuildingSite.ok ? GHOST_VALID : GHOST_INVALID
      ghostData[OFFSET_OCCUPANTS + 1] = 0
      ghostData[OFFSET_OCCUPANTS + 2] = 0
      return ghostData
    },

    update(deltaMs: number, input: InputSnapshot, view: BuildingViewContext) {
      const consumed = new Set<PointerClick>()

      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      if (BUILD_KEYS.some((code) => input.pressed.has(code))) {
        building = !building
      }
      if (CANCEL_KEYS.some((code) => input.pressed.has(code))) {
        building = false
      }

      const sculpting = isSculptModifierHeld(input)
      const pointer = input.pointer
      ghost =
        building && !sculpting && pointer.ndc
          ? ghostAt(screenRay(view.camera, pointer.ndc.x, pointer.ndc.y, view.aspect))
          : null

      for (const click of pointer.clicks) {
        if (click.button === 'middle' || isSculptModifierIn(click.held)) {
          continue
        }
        if (!building) {
          continue
        }
        consumed.add(click)
        if (click.button === 'right') {
          building = false
          continue
        }
        const site = ghostAt(screenRay(view.camera, click.ndc.x, click.ndc.y, view.aspect))
        if (!site) {
          continue
        }
        if (site.site !== BuildingSite.ok) {
          say(siteProblem(site.site))
          continue
        }
        if (simulation.placeBuilding(site.direction, PLAYER_TRIBE, BuildingKind.hut) >= 0) {
          notice = null
          noticeMs = 0
          building = click.shiftKey
        }
      }

      return { consumed, building }
    },
  }
}

/** What the HUD says about a site the core turned down. */
export function siteProblem(site: BuildingSite): string {
  switch (site) {
    case BuildingSite.ok:
      return 'site is clear'
    case BuildingSite.water:
      return 'needs dry land'
    case BuildingSite.steep:
      return 'too steep — flatten a pad (hold C, Shift + left-drag)'
    case BuildingSite.occupied:
      return 'a hut already stands there'
    case BuildingSite.full:
      return 'no room for more huts'
    default:
      return 'the world is not ready'
  }
}
