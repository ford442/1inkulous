import type { InputSnapshot } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createHuts, type Huts } from './huts'
import { createPlanet, type Planet } from './planet'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  camera: Camera
  sculptor: Sculptor
  followers: Followers
  huts: Huts
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
  const huts = createHuts(planet, simulation)

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

      // Huts see the clicks first: one that built a hut or sent people inside
      // is not also a selection or a move order. Build mode owns the left
      // button outright, so no selection box starts while placing.
      const claimed = huts.update(deltaMs, input, { camera, aspect })
      const pointer = input.pointer
      const forFollowers: InputSnapshot =
        claimed.consumed.size === 0 && !claimed.building
          ? input
          : {
              ...input,
              pointer: {
                ...pointer,
                clicks: pointer.clicks.filter((click) => !claimed.consumed.has(click)),
                drags: claimed.building ? [] : pointer.drags,
                dragRect: claimed.building ? null : pointer.dragRect,
              },
            }

      // Followers ignore clicks and selection drags that overlapped C, so a
      // sculpt stroke is filtered out on the gesture itself, not only by the
      // `sculpting` flag above.
      followers.update(deltaMs, forFollowers, { camera, aspect })
    },
  }
}
