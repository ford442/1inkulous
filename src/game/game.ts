import type { InputSnapshot, PointerClick } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createBuildings, type Buildings } from './buildings'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createHuts, type Huts } from './huts'
import { createPlanet, type Planet } from './planet'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'
import { createShaman, type Shaman } from './shaman'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  camera: Camera
  sculptor: Sculptor
  followers: Followers
  huts: Huts
  buildings: Buildings
  shaman: Shaman
  /**
   * `aspect` is the viewport's width / height, needed to turn the cursor into a
   * world-space ray for terrain picking.
   */
  update: (deltaMs: number, input: InputSnapshot, aspect: number) => void
}

/**
 * `simulation` is the C++ core, taken at construction rather than reached for
 * later: the world it owns — the navigation graph and every follower standing
 * on it — has to exist before the first frame.
 */
export function createGame(simulation: Simulation): Game {
  const planet = createPlanet()

  const camera = createCamera({
    planetRadius: planet.radius,
    maxTerrainHeight: planet.maxHeight,
  })

  const sculptor = createSculptor(planet)
  const followers = createFollowers(planet, simulation)
  // B places a land-claim hut. The breeding huts keep their enter order, but
  // they no longer share the build key.
  const buildings = createBuildings(planet, simulation)
  const huts = createHuts(planet, simulation, { buildMode: false })
  const shaman = createShaman(planet, simulation, { syncTerrain: followers.syncTerrain })

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
    camera,
    sculptor,
    followers,
    huts,
    buildings,
    shaman,
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
      sculptor.update(deltaMs, input, { camera, aspect })
      // After the brush, so terrain edited this frame reaches the core's height
      // buffer before a hut site is judged or anything paths over it.
      followers.syncTerrain()

      // A spell being aimed sees the clicks first: a Land Bridge cast is not
      // also a hut, a selection or a move order. Then buildings, which own the
      // left button in build mode so no selection box starts while placing.
      // Breeding huts still claim a right-click on one of their own.
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
      const placed = buildings.update(deltaMs, without(aimed.consumed), { camera, aspect })
      const housed = huts.update(
        deltaMs,
        without(new Set([...aimed.consumed, ...placed.consumed])),
        { camera, aspect },
      )
      const claimed = new Set<PointerClick>([
        ...aimed.consumed,
        ...placed.consumed,
        ...housed.consumed,
      ])
      const placing = aimed.targeting || placed.building || housed.building
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
    },
  }
}
