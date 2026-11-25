import type { Vec3 } from '../engine/math'
import { screenRay, worldToNdc, type Ray, type RayCamera } from '../engine/picking'
import type { DragRect, InputSnapshot } from '../input/input'
import { Role, roleOfFlags } from '../sim/role'
import type { SimulationClient } from '../sim/simulation'
import type { NavGraph } from './navGraph'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'
import { PLAYER_TRIBE } from './shaman'
import { MAX_WALKABLE_SLOPE, type Terrain } from './terrain'

/**
 * Followers — the first units on the planet.
 *
 * The units themselves live in the C++ core: it owns their positions, their
 * paths and the A* search over the walkable graph, which the terrain module
 * hands it. This module is the glue: it picks the starting village, turns
 * clicks into selections and orders, and hands the renderer the packed
 * instance buffer the core already maintains. Nothing about a follower — nor
 * the ground under one — is mirrored on the JS side.
 */

/** Mirrors kFlagSelected / kFlagWalking in cpp/include/1inkulous/followers.hpp. */
const FLAG_SELECTED = 1 << 0
const FLAG_WALKING = 1 << 1

/** Instance layout, in floats: position(3), heading(3), tribe, flags. */
const OFFSET_POSITION = 0
const OFFSET_TRIBE = 6
const OFFSET_FLAGS = 7

/**
 * Followers are people on a planet: tiny next to it, but the camera stops close
 * enough that a couple of percent of screen height still reads clearly.
 */
export const FOLLOWER_HEIGHT_FRACTION = 0.02
export const FOLLOWER_RADIUS_FRACTION = 0.008

/** Enough to fill a starting village and then some. Matches kMaxFollowers. */
const MAX_FOLLOWERS = 1024
const DEFAULT_SPAWN_COUNT = 60

/**
 * Where an instance's previous pose starts, in floats: kInstancePrevOffset in
 * cpp/include/1inkulous/followers.hpp. Position(3) then heading(3), as the
 * last step began.
 */
export const FOLLOWER_PREVIOUS_OFFSET = 8

/**
 * Where follower `id` is drawn `alpha` of the way through to the next step:
 * the vertex shader's interpolatePosition and interpolateHeading
 * (src/engine/shaders/follower.wgsl), here for picking and for the tests that
 * hold the shader's maths to account. Writes position(3) then heading(3).
 */
export function interpolatePose(
  instances: Float32Array,
  stride: number,
  id: number,
  alpha: number,
  out: Float32Array | number[] = new Float32Array(6),
): Float32Array | number[] {
  const base = id * stride
  const prev = base + FOLLOWER_PREVIOUS_OFFSET
  const a = Math.min(1, Math.max(0, alpha))
  const mix = (from: number, to: number) => from + (to - from) * a

  // Unit directions blended, radius (ground height) blended on its own.
  const from = Math.hypot(instances[prev], instances[prev + 1], instances[prev + 2])
  const to = Math.hypot(instances[base], instances[base + 1], instances[base + 2])
  const px = from > 1e-6 ? mix(instances[prev] / from, instances[base] / to) : 0
  const py = from > 1e-6 ? mix(instances[prev + 1] / from, instances[base + 1] / to) : 0
  const pz = from > 1e-6 ? mix(instances[prev + 2] / from, instances[base + 2] / to) : 0
  const blended = Math.hypot(px, py, pz)
  if (from < 1e-6 || to < 1e-6 || blended < 1e-6) {
    out[0] = instances[base]
    out[1] = instances[base + 1]
    out[2] = instances[base + 2]
  } else {
    const radius = mix(from, to)
    out[0] = (px / blended) * radius
    out[1] = (py / blended) * radius
    out[2] = (pz / blended) * radius
  }

  const hx = mix(instances[prev + 3], instances[base + 3])
  const hy = mix(instances[prev + 4], instances[base + 4])
  const hz = mix(instances[prev + 5], instances[base + 5])
  const turn = Math.hypot(hx, hy, hz)
  if (turn < 1e-4) {
    out[3] = instances[base + 3]
    out[4] = instances[base + 4]
    out[5] = instances[base + 5]
  } else {
    out[3] = hx / turn
    out[4] = hy / turn
    out[5] = hz / turn
  }
  return out
}

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
  /**
   * The tribe whose shaman stands at the heart of the village, on top of the
   * `spawnCount` ordinary followers. Null for no shaman. Defaults to tribe 0.
   */
  shamanTribe?: number | null
  /**
   * Only this tribe's followers can be clicked or boxed into the selection —
   * the player's, in a match. Omit to let any tribe be selected.
   */
  selectTribe?: number
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
  /** The player's tribe out walking; the counts below are of them too. */
  readonly count: number
  readonly selectedCount: number
  /** Live view of the core's instance buffer. Re-read every frame. */
  instances: () => Float32Array
  readonly instanceFloats: number
  /** How far between each follower's previous pose and current one to draw this frame, 0..1. */
  readonly stepAlpha: number
  /** How many followers are walking a path right now. */
  readonly walkingCount: number
  /** How many of them are warriors. */
  readonly warriorCount: number
  /**
   * The selection box currently on screen, or null when the player is not
   * dragging one — including while the sculpt modifier owns the gesture.
   */
  readonly selectionBand: DragRect | null
  update: (deltaMs: number, input: InputSnapshot, view: FollowerViewContext) => void
}

export function createFollowers(
  terrain: Terrain,
  simulation: SimulationClient,
  options: FollowersOptions = {},
): Followers {
  const { planet, graph } = terrain

  const shamanTribe = options.shamanTribe === undefined ? 0 : options.shamanTribe
  const wanted = Math.min(options.spawnCount ?? DEFAULT_SPAWN_COUNT, MAX_FOLLOWERS - 1)
  // Chosen before anyone spawns, so the heights view cannot go stale under it.
  const spawnNodes = findSpawnNodes(
    graph,
    terrain.heights(),
    planet.radius,
    wanted + (shamanTribe === null ? 0 : 1),
  )

  const nodeDirection = (node: number): Vec3 => [
    graph.directions[node * 3],
    graph.directions[node * 3 + 1],
    graph.directions[node * 3 + 2],
  ]

  let homeDirection: Vec3 | null = null
  // The shaman takes the first node, the flattest spot the spread grew from,
  // so she starts in the middle of her people.
  let first = 0
  if (shamanTribe !== null && spawnNodes.length > 0) {
    simulation.spawnShaman(nodeDirection(spawnNodes[0]), shamanTribe)
    first = 1
  }
  for (let i = first; i < spawnNodes.length; i += 1) {
    const tribe = options.tribe ?? (i - first) % 4
    simulation.spawnFollower(nodeDirection(spawnNodes[i]), tribe)
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
      if (options.selectTribe !== undefined && data[id * stride + OFFSET_TRIBE] !== options.selectTribe) {
        continue
      }
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

  let selectionBand: DragRect | null = null

  /** The player's tribe's followers whose flags pass `test`. */
  const countMine = (test: (flags: number) => boolean): number => {
    const data = simulation.followerInstances()
    const stride = simulation.followerInstanceFloats
    let total = 0
    for (let id = 0; id < data.length / stride; id += 1) {
      if (data[id * stride + OFFSET_TRIBE] === PLAYER_TRIBE && test(data[id * stride + OFFSET_FLAGS])) {
        total += 1
      }
    }
    return total
  }

  const applyDragSelection = (drag: DragRect, view: FollowerViewContext) => {
    // Sample positions before any selection write: the core refreshes the
    // instance buffer on each select, and the ids are all this pass needs.
    const ids = followerIdsInDragRect(
      simulation.followerInstances(),
      simulation.followerInstanceFloats,
      view.camera,
      view.aspect,
      drag.startNdc,
      drag.currentNdc,
    )

    // A plain box replaces. Shift adds the units inside and leaves the rest.
    if (!drag.shiftKey) {
      simulation.clearFollowerSelection()
    }
    const data = simulation.followerInstances()
    const stride = simulation.followerInstanceFloats
    for (const id of ids) {
      if (options.selectTribe !== undefined && data[id * stride + OFFSET_TRIBE] !== options.selectTribe) {
        continue
      }
      simulation.setFollowerSelected(id, true)
    }
  }

  return {
    homeDirection,
    get count() {
      return countMine(() => true)
    },
    get selectedCount() {
      return simulation.selectedFollowerCount
    },
    instances() {
      return simulation.followerInstances()
    },
    instanceFloats: simulation.followerInstanceFloats,
    get stepAlpha() {
      return simulation.stepAlpha
    },
    get selectionBand() {
      return selectionBand
    },
    get walkingCount() {
      return countMine((flags) => (flags & FLAG_WALKING) !== 0)
    },
    get warriorCount() {
      return countMine((flags) => roleOfFlags(flags) === Role.warrior)
    },

    update(_deltaMs: number, input: InputSnapshot, view: FollowerViewContext) {
      const live = input.pointer.dragRect
      const sculpting = isSculptModifierHeld(input)
      // Hide the band for the whole gesture once C has been involved, not only
      // on the frames where it is still down. `held` accumulates those keys.
      selectionBand =
        live && live.button === 'left' && !sculpting && !isSculptModifierIn(live.held)
          ? live
          : null

      for (const drag of input.pointer.drags) {
        if (drag.button !== 'left') {
          continue
        }
        // Hold-C sculpts. A box that started under C, or picked C up on the
        // way, must not also select — including when C is released before the
        // button, which is why the gesture's own key set is checked as well
        // as the keys that are down right now.
        if (sculpting || isSculptModifierIn(drag.held)) {
          continue
        }
        applyDragSelection(drag, view)
      }

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
export function findSpawnNodes(
  graph: NavGraph,
  heights: Float32Array,
  planetRadius: number,
  wanted: number,
  from: { start?: number; skip?: (node: number) => boolean } = {},
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
  // A village placed by a scenario grows from where it is told.
  if (from.start !== undefined) {
    start = from.start
  }

  if (start < 0) {
    // No land anywhere — an all-ocean world, which `terrain: 'flat'`
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
    // Skipped ground (a hut's pad) is still spread across, just not stood on.
    if (!from.skip?.(node)) {
      chosen.push(node)
    }

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

/**
 * Followers whose projected position lies inside a screen-space drag rectangle.
 *
 * A follower counts only when it is in front of the camera, on the near side of
 * the planet (the same horizon test as a click), and inside the viewport. The
 * far side of the sphere still projects onto the screen — the planet would be
 * transparent otherwise — so the horizon test is what keeps a box on the
 * village from selecting pawns the player cannot see.
 */
export function followerIdsInDragRect(
  instances: Float32Array,
  stride: number,
  camera: RayCamera,
  aspect: number,
  startNdc: { x: number; y: number },
  currentNdc: { x: number; y: number },
): number[] {
  const minX = Math.min(startNdc.x, currentNdc.x)
  const maxX = Math.max(startNdc.x, currentNdc.x)
  const minY = Math.min(startNdc.y, currentNdc.y)
  const maxY = Math.max(startNdc.y, currentNdc.y)

  const eye = camera.eye
  const count = stride > 0 ? Math.floor(instances.length / stride) : 0
  const ids: number[] = []

  for (let id = 0; id < count; id += 1) {
    const base = id * stride + OFFSET_POSITION
    const px = instances[base]
    const py = instances[base + 1]
    const pz = instances[base + 2]

    const ex = eye[0] - px
    const ey = eye[1] - py
    const ez = eye[2] - pz
    if (px * ex + py * ey + pz * ez <= 0) {
      continue
    }

    const ndc = worldToNdc(camera, [px, py, pz], aspect)
    if (!ndc) {
      continue
    }
    // On screen. A drag can run outside the canvas (pointer capture), but a
    // follower that is not drawn is not selected.
    if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) {
      continue
    }
    if (ndc.x < minX || ndc.x > maxX || ndc.y < minY || ndc.y > maxY) {
      continue
    }
    ids.push(id)
  }

  return ids
}
