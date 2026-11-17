import type { InputSnapshot, PointerClick } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createHuts, type Huts } from './huts'
import { createPlanet, type Planet } from './planet'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'
import { createShaman, type Shaman } from './shaman'
import { createTerrain, type Terrain } from './terrain'
import { createTrees, type Trees } from './trees'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  /** The ground, owned by the core; the planet mesh is redrawn from it. */
  terrain: Terrain
  camera: Camera
  sculptor: Sculptor
  followers: Followers
  huts: Huts
  shaman: Shaman
  trees: Trees
  /**
   * `aspect` is the viewport's width / height, needed to turn the cursor into a
   * world-space ray for terrain picking.
   */
  update: (deltaMs: number, input: InputSnapshot, aspect: number) => void
}

/**
 * `simulation` is the C++ core, taken at construction rather than reached for
 * later: the world it owns — the terrain, the navigation graph over it and
 * every follower standing on it — has to exist before the first frame.
 */
export function createGame(simulation: Simulation): Game {
  const planet = createPlanet()
  // The planet generated the land; from here on the core owns it.
  const terrain = createTerrain(planet, simulation)

  const camera = createCamera({
    planetRadius: planet.radius,
    maxTerrainHeight: planet.maxHeight,
  })

  const sculptor = createSculptor(terrain)
  const followers = createFollowers(terrain, simulation)
  const huts = createHuts(planet, simulation)
  const shaman = createShaman(planet, simulation)
  // Once, from the heights the core now owns: the forest the match starts with.
  const trees = createTrees(planet, simulation)

  // Open on the tribe. The starting village is wherever the flattest land
  // turned out to be, which is as likely to be behind the planet as in front.
  if (followers.homeDirection) {
    camera.focusOn(followers.homeDirection, true)
  }

  const state = {
    clearColor: [0.04, 0.05, 0.09] as [number, number, number],
  }

  return {
    planet,
    terrain,
    camera,
    sculptor,
    followers,
    huts,
    shaman,
    trees,
    get clearColor() {
      return state.clearColor
    },
    update(deltaMs: number, input: InputSnapshot, aspect: number) {
      // While the brush is armed it owns drag and the wheel, so an edit never
      // swings the camera at the same time.
      const sculpting = isSculptModifierHeld(input)
      camera.update(deltaMs, input, {
        allowPointerOrbit: !sculpting,
        allowPointerZoom: !sculpting,
      })

      // After the camera, so picking uses the view that is about to be drawn.
      // The stroke edits the core directly, so a hut site judged or a path
      // searched later this frame already sees it.
      sculptor.update(deltaMs, input, { camera, aspect })

      // A spell being aimed sees the clicks first: a cast is not
      // also a hut, a selection or a move order. Then huts, which own the left
      // button in build mode so no selection box starts while placing, and a
      // right-click on a hut as an enter or eject order. Then trees, which
      // take a right-click on one as a chop order.
      const pointer = input.pointer
      const without = (taken: ReadonlySet<PointerClick>): InputSnapshot =>
        taken.size === 0
          ? input
          : {
              ...input,
              pointer: {
                ...pointer,
                clicks: pointer.clicks.filter((click) => !taken.has(click)),
              },
            }
      const aimed = shaman.update(deltaMs, input, { camera, aspect })
      const housed = huts.update(deltaMs, without(aimed.consumed), { camera, aspect })
      const chopped = trees.update(
        deltaMs,
        without(new Set([...aimed.consumed, ...housed.consumed])),
        { camera, aspect },
      )
      const claimed = new Set<PointerClick>([
        ...aimed.consumed,
        ...housed.consumed,
        ...chopped.consumed,
      ])
      const placing = aimed.targeting || housed.building
      const forFollowers: InputSnapshot =
        claimed.size === 0 && !placing
          ? input
          : {
              ...input,
              pointer: {
                ...pointer,
                clicks: pointer.clicks.filter((click) => !claimed.has(click)),
                drags: placing ? [] : pointer.drags,
                dragRect: placing ? null : pointer.dragRect,
              },
            }

      // Followers ignore clicks and selection drags that overlapped C, so a
      // sculpt stroke is filtered out on the gesture itself, not only by the
      // `sculpting` flag above.
      followers.update(deltaMs, forFollowers, { camera, aspect })

      // Last: whatever moved the ground this frame — the brush, a spell, the
      // core's own steps before this update — reaches the mesh before drawing.
      terrain.syncMesh()
    },
  }
}
