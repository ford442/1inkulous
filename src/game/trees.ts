import type { Vec3 } from '../engine/math'
import { screenRay, type Ray, type RayCamera } from '../engine/picking'
import type { InputSnapshot, PointerClick } from '../input/input'
import { settle, type SimulationClient } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierIn } from './sculpt'

/**
 * Trees — where wood comes from.
 *
 * The core scatters them over dry land above the shore once, at match start,
 * from the heights it owns; it keeps them, decides who is chopping which, and
 * pays the wood out when one falls. This module plants them, picks one under
 * the cursor, and turns a right-click on one into a chop order for the
 * selected braves.
 */

/** Overall height and canopy radius, as fractions of the planet radius. */
export const TREE_HEIGHT_FRACTION = 0.045
export const TREE_RADIUS_FRACTION = 0.016

/** Mirrors kMaxTrees in cpp/include/1inkulous/trees.hpp. */
export const MAX_TREES = 512

/**
 * Two thirds of the room: with a node kept clear round each, the default
 * planet has inland space for about 216.
 */
const DEFAULT_TREE_COUNT = 140
const DEFAULT_SEED = 1

/** Instance layout, in floats: position(3), heading(3), size, chop progress. */
const OFFSET_POSITION = 0
const OFFSET_SIZE = 6

const NOTICE_MS = 2500

export type TreesOptions = {
  /** How many to plant at match start. */
  count?: number
  /** Seeds the core's scatter: the same seed plants the same forest. */
  seed?: number
}

export type TreeViewContext = {
  camera: RayCamera
  /** Viewport width / height. */
  aspect: number
}

export type TreeUpdate = {
  /** Right-clicks this frame that were a chop order, not a move. */
  consumed: ReadonlySet<PointerClick>
}

export type Trees = {
  readonly count: number
  /** Height of the placeholder tree at size 1, in world units. */
  readonly height: number
  /** Canopy radius at size 1, in world units. */
  readonly radius: number
  /** A short message about the last order, or null once it has aged out. */
  readonly notice: string | null
  /** Live view of the core's tree instance buffer. Re-read every frame. */
  instances: () => Float32Array
  readonly instanceFloats: number
  update: (deltaMs: number, input: InputSnapshot, view: TreeViewContext) => TreeUpdate
}

export function createTrees(planet: Planet, simulation: SimulationClient, options: TreesOptions = {}): Trees {
  simulation.spawnTrees(Math.min(options.count ?? DEFAULT_TREE_COUNT, MAX_TREES), options.seed ?? DEFAULT_SEED)

  const height = planet.radius * TREE_HEIGHT_FRACTION
  const radius = planet.radius * TREE_RADIUS_FRACTION
  const instanceFloats = simulation.treeInstanceFloats
  let notice: string | null = null
  let noticeMs = 0

  return {
    get count() {
      return simulation.treeCount
    },
    height,
    radius,
    get notice() {
      return notice
    },
    instances() {
      return simulation.treeInstances()
    },
    instanceFloats,

    update(deltaMs: number, input: InputSnapshot, view: TreeViewContext) {
      const consumed = new Set<PointerClick>()
      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      for (const click of input.pointer.clicks) {
        if (click.button !== 'right' || isSculptModifierIn(click.held)) {
          continue
        }
        if (simulation.selectedFollowerCount === 0) {
          continue
        }
        const ray = screenRay(view.camera, click.ndc.x, click.ndc.y, view.aspect)
        const id = treeIdUnderRay(simulation.treeInstances(), instanceFloats, ray, view.camera.eye, radius, height)
        if (id < 0) {
          continue
        }
        // Like a hut, a tree under the cursor takes the order even when nobody
        // can carry it out, rather than walking the selection to its foot.
        consumed.add(click)
        settle(simulation.orderChop(id), (sent) => {
          notice = sent > 0 ? `${sent} chopping` : 'only braves chop — and three to a tree'
          noticeMs = NOTICE_MS
        })
      }

      return { consumed }
    },
  }
}

/**
 * The tree a ray hits, or -1. Each tree is a sphere round its canopy, scaled
 * by its size and lifted to the middle of the tree, so a click on the trunk or
 * the crown lands. Trees on the far side of the planet are skipped with the
 * horizon test followers and huts use.
 */
export function treeIdUnderRay(
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
    if (px! * (eye[0] - px!) + py! * (eye[1] - py!) + pz! * (eye[2] - pz!) <= 0) {
      continue
    }
    const r = Math.hypot(px!, py!, pz!)
    if (r === 0) {
      continue
    }
    const size = instances[id * stride + OFFSET_SIZE] || 1
    // A little generous: a tree is thin, and a click that just misses the
    // canopy is still meant for it.
    const reach = Math.max(radius * 1.5, height * 0.5) * size
    const lift = height * 0.5 * size
    const cx = px! + (px! / r) * lift - ray.origin[0]
    const cy = py! + (py! / r) * lift - ray.origin[1]
    const cz = pz! + (pz! / r) * lift - ray.origin[2]
    const along = cx * ray.direction[0] + cy * ray.direction[1] + cz * ray.direction[2]
    if (along <= 0 || along >= bestDistance) {
      continue
    }
    const perpendicular = cx * cx + cy * cy + cz * cz - along * along
    if (perpendicular > reach * reach) {
      continue
    }
    best = id
    bestDistance = along
  }

  return best
}
