import type { InputSnapshot } from '../input/input'
import { createCamera, type Camera } from './camera'
import { createPlanet, type Planet } from './planet'

export type Game = {
  clearColor: [number, number, number]
  planet: Planet
  camera: Camera
  update: (deltaMs: number, input: InputSnapshot) => void
}

export function createGame(): Game {
  const planet = createPlanet({ resolution: 8 })

  const camera = createCamera({
    planetRadius: planet.radius,
    maxTerrainHeight: planet.maxHeight,
  })

  const state = {
    clearColor: [0.04, 0.05, 0.09] as [number, number, number],
  }

  return {
    planet,
    camera,
    get clearColor() {
      return state.clearColor
    },
    update(deltaMs: number, input: InputSnapshot) {
      camera.update(deltaMs, input)
    },
  }
}
