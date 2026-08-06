import type { InputSnapshot } from '../input/input'
import type { Simulation } from '../sim/simulation'
import { createCamera, type Camera } from './camera'
import { createFollowers, type Followers } from './followers'
import { createPlanet, type Planet } from './planet'
import { createSculptor, isSculptModifierHeld, type Sculptor } from './sculpt'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  camera: Camera
  sculptor: Sculptor
  followers: Followers
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
      // buffer before anything paths over it. Followers read the modifiers off
      // each click rather than off this frame's keyboard, so a sculpt stroke is
      // filtered out at the click, not by the `sculpting` flag above.
      followers.update(deltaMs, input, { camera, aspect })
    },
  }
}
