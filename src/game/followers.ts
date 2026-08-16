import type { Vec3 } from '../engine/math'
import { screenRay, type Ray, type RayCamera } from '../engine/picking'
import type { InputSnapshot } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { buildNavGraph, type NavGraph } from './navGraph'
import type { Planet } from './planet'
import { isSculptModifierIn } from './sculpt'

/**
 * Followers — the first units on the planet.
 *
 * The units themselves live in the C++ core: it owns their positions, their
 * paths and the A* search over the walkable graph. This module is the glue.
 * It builds that graph out of the planet mesh, keeps the core's copy of the
 * terrain heights current as the player sculpts, turns clicks into selections
 * and orders, and hands the renderer the packed instance buffer the core
 * already maintains. Nothing about a follower is mirrored on the JS side.
 */

/** Mirrors kFlagSelected / kFlagWalking in cpp/include/1inkulous/followers.hpp. */
const FLAG_SELECTED = 1 << 0
const FLAG_WALKING = 1 << 1

/** Instance layout, in floats: position(3), heading(3), tribe, flags. */
const OFFSET_POSITION = 0
const OFFSET_FLAGS = 7

/**
 * Steepest ground a follower will cross, as height over run. Terrain runs from
 * sea level to `planet.maxHeight` over a handful of cells, so this turns a
 * sculpted mound into a wall while leaving rolling country walkable.
 */
const MAX_WALKABLE_SLOPE = 0.55

/**
 * Followers are people on a planet: tiny next to it, but the camera stops close
 * enough that a couple of percent of screen height still reads clearly.
 */
export const FOLLOWER_HEIGHT_FRACTION = 0.02
export const FOLLOWER_RADIUS_FRACTION = 0.008

/** Enough to fill a starting village and then some. Matches kMaxFollowers. */
const MAX_FOLLOWERS = 1024
const DEFAULT_SPAWN_COUNT = 60

/** Pick radius around a follower, as a fraction of the viewport's half-height. */
const PICK_SCREEN_FRACTION = 0.025

export type FollowersOptions = {
  /** How many to place at game start. Clamped to the core's ceiling. */
  spawnCount?: number
  /**
   * When set, every spawn is this tribe. Omit to cycle the four placeholder
   * colours (blue, red, yellow, green) so they all show at game start.
   */
  tribe?: number
}

export type FollowerViewContext = {
  camera: RayCamera
  /** Viewport width / height. */
  aspect: number
}

export type Followers = {
  /**
   * Where the tribe started, as a unit direction — the opening view should look
   * at it. Null when the planet offered nowhere to stand.
   */
  readonly homeDirection: Vec3 | null
  readonly count: number
  readonly selectedCount: number
  /** Live view of the core's instance buffer. Re-read every frame. */
  instances: () => Float32Array
  readonly instanceFloats: number
  /** How many followers are walking a path right now. */
  readonly walkingCount: number
  update: (deltaMs: number, input: InputSnapshot, view: FollowerViewContext) => void
}

export function createFollowers(
  planet: Planet,
  simulation: Simulation,
  options: FollowersOptions = {},
): Followers {
  const graph = buildNavGraph(planet.mesh)
  const heights = new Float32Array(graph.nodeCount)

  simulation.uploadNavGraph(graph, {
    planetRadius: planet.radius,
    maxSlope: MAX_WALKABLE_SLOPE,
  })

  // The core's heights start at zero — every node reads as ocean — so they have
  // to be pushed before the first spawn or path search.
  let uploadedRevision = -1
  const syncHeights = () => {
    if (planet.mesh.revision === uploadedRevision) {
      return
    }
    for (let node = 0; node < graph.nodeCount; node += 1) {
      heights[node] = planet.mesh.heights[graph.nodeVertex[node]]
    }
    simulation.writeNavHeights(heights)
    uploadedRevision = planet.mesh.revision
  }

  syncHeights()

  const wanted = Math.min(options.spawnCount ?? DEFAULT_SPAWN_COUNT, MAX_FOLLOWERS)
  const spawnNodes = findSpawnNodes(graph, heights, planet.radius, wanted)

  let homeDirection: Vec3 | null = null
  for (let i = 0; i < spawnNodes.length; i += 1) {
    const node = spawnNodes[i]
    const tribe = options.tribe ?? i % 4
    simulation.spawnFollower(
      [
        graph.directions[node * 3],
        graph.directions[node * 3 + 1],
        graph.directions[node * 3 + 2],
      ],
      tribe,
    )
  }

  if (spawnNodes.length > 0) {
    // Mean of the group's directions, renormalised — the patch is small enough
    // that averaging the vectors lands where it should.
    let hx = 0
    let hy = 0
    let hz = 0
    for (const node of spawnNodes) {
      hx += graph.directions[node * 3]
      hy += graph.directions[node * 3 + 1]
      hz += graph.directions[node * 3 + 2]
    }
    const length = Math.hypot(hx, hy, hz)
    if (length > 0) {
      homeDirection = [hx / length, hy / length, hz / length]
    }
  }

  const pickFollower = (ray: Ray, eye: Vec3, fovY: number): number => {
    const data = simulation.followerInstances()
    const stride = simulation.followerInstanceFloats
    const count = data.length / stride

    // Pick radius grows with distance so the target stays the same size on
    // screen however far out the camera is.
    const tanHalf = Math.tan(fovY / 2)

    let best = -1
    let bestDistance = Infinity

    for (let id = 0; id < count; id += 1) {
      const base = id * stride + OFFSET_POSITION
      const px = data[base]
      const py = data[base + 1]
      const pz = data[base + 2]

      // Horizon test: on a sphere, a point is visible exactly when it faces the
      // eye. Cheaper and sharper than intersecting the terrain again.
      const ex = eye[0] - px
      const ey = eye[1] - py
      const ez = eye[2] - pz
      if (px * ex + py * ey + pz * ez <= 0) {
        continue
      }

      const vx = px - ray.origin[0]
      const vy = py - ray.origin[1]
      const vz = pz - ray.origin[2]
      const along = vx * ray.direction[0] + vy * ray.direction[1] + vz * ray.direction[2]
      if (along <= 0 || along >= bestDistance) {
        continue
      }

      const perpendicular = vx * vx + vy * vy + vz * vz - along * along
      const reach = Math.max(
        planet.radius * FOLLOWER_RADIUS_FRACTION * 1.5,
        along * tanHalf * PICK_SCREEN_FRACTION,
      )
      if (perpendicular > reach * reach) {
        continue
      }

      best = id
      bestDistance = along
    }

    return best
  }

  return {
    homeDirection,
    get count() {
      return simulation.followerCount
    },
    get selectedCount() {
      return simulation.selectedFollowerCount
    },
    instances() {
      return simulation.followerInstances()
    },
    instanceFloats: simulation.followerInstanceFloats,
    get walkingCount() {
      const data = simulation.followerInstances()
      const stride = simulation.followerInstanceFloats
      let walking = 0
      for (let id = 0; id < data.length / stride; id += 1) {
        if ((data[id * stride + OFFSET_FLAGS] & FLAG_WALKING) !== 0) {
          walking += 1
        }
      }
      return walking
    },

    update(_deltaMs: number, input: InputSnapshot, view: FollowerViewContext) {
      // Terrain the player just reshaped has to reach the core before any path
      // is searched over it.
      syncHeights()

      for (const click of input.pointer.clicks) {
        if (click.button === 'middle') {
          continue
        }

        // C arms the brush, so that press was shaping the ground, not picking.
        if (isSculptModifierIn(click.held)) {
          continue
        }

        // Shift adds to the selection, the usual RTS binding. Taken from the
        // click itself: the player may well have let go before this frame ran.
        const additive = click.shiftKey

        const ray = screenRay(view.camera, click.ndc.x, click.ndc.y, view.aspect)

        if (click.button === 'right') {
          if (simulation.selectedFollowerCount === 0) {
            continue
          }
          const target = planet.pickDirection(ray)
          if (target) {
            simulation.orderFollowerMove(target)
          }
          continue
        }

        const id = pickFollower(ray, view.camera.eye, view.camera.fovY)

        if (id < 0) {
          // A click on bare ground drops the selection, the way it does in
          // every RTS — unless the player is deliberately adding to it.
          if (!additive) {
            simulation.clearFollowerSelection()
          }
          continue
        }

        if (!additive) {
          simulation.clearFollowerSelection()
          simulation.setFollowerSelected(id, true)
          continue
        }

        const data = simulation.followerInstances()
        const flags = data[id * simulation.followerInstanceFloats + OFFSET_FLAGS]
        simulation.setFollowerSelected(id, (flags & FLAG_SELECTED) === 0)
      }
    },
  }
}

/**
 * Picks a starting village site: the flattest patch of land on the planet, then
 * the nodes reachable from it, so the group begins together on walkable ground.
 *
 * Runs once at startup over a few thousand nodes, so a plain scan and a
 * breadth-first spread are more than quick enough.
 */
function findSpawnNodes(
  graph: NavGraph,
  heights: Float32Array,
  planetRadius: number,
  wanted: number,
): number[] {
  const { nodeCount, neighborOffsets, neighbors, directions } = graph

  const arcLength = (a: number, b: number) => {
    const dx = directions[a * 3] - directions[b * 3]
    const dy = directions[a * 3 + 1] - directions[b * 3 + 1]
    const dz = directions[a * 3 + 2] - directions[b * 3 + 2]
    const chord = Math.hypot(dx, dy, dz)
    return 2 * Math.asin(Math.min(1, chord / 2)) * planetRadius
  }

  const steepestAround = (node: number): number => {
    let steepest = 0
    for (let link = neighborOffsets[node]; link < neighborOffsets[node + 1]; link += 1) {
      const neighbor = neighbors[link]
      // A shoreline node has ocean next door: not flat land, whatever its own
      // slope says.
      if (heights[neighbor] <= 0) {
        return Infinity
      }
      const run = arcLength(node, neighbor)
      if (run > 0) {
        steepest = Math.max(steepest, Math.abs(heights[neighbor] - heights[node]) / run)
      }
    }
    return steepest
  }

  let start = -1
  let bestSlope = Infinity
  // Every node on a chain of islands is a shoreline node, and `steepestAround`
  // scores all of those Infinity. Without a fallback the whole scan would come
  // up empty and the tribe would never be placed.
  let shoreline = -1

  for (let node = 0; node < nodeCount; node += 1) {
    if (heights[node] <= 0) {
      continue
    }
    if (shoreline < 0) {
      shoreline = node
    }
    const slope = steepestAround(node)
    if (slope < bestSlope) {
      bestSlope = slope
      start = node
      if (slope === 0) {
        break
      }
    }
  }

  if (start < 0) {
    start = shoreline
  }

  if (start < 0) {
    // No land anywhere — an all-ocean world, which `generateTerrain('flat')`
    // produces. Say so rather than starting an empty match in silence.
    console.warn('[followers] no walkable land on the planet; nobody was spawned')
    return []
  }

  // Spread outwards over ground a follower could actually walk, one node per
  // follower so nobody starts inside anybody else.
  const chosen: number[] = []
  const queued = new Uint8Array(nodeCount)
  const queue = [start]
  queued[start] = 1

  while (queue.length > 0 && chosen.length < wanted) {
    const node = queue.shift() as number
    chosen.push(node)

    for (let link = neighborOffsets[node]; link < neighborOffsets[node + 1]; link += 1) {
      const neighbor = neighbors[link]
      if (queued[neighbor] || heights[neighbor] <= 0) {
        continue
      }
      const run = arcLength(node, neighbor)
      if (run > 0 && Math.abs(heights[neighbor] - heights[node]) / run > MAX_WALKABLE_SLOPE) {
        continue
      }
      queued[neighbor] = 1
      queue.push(neighbor)
    }
  }

  return chosen
}
