import type { InputSnapshot } from '../input/input'

export type Game = {
  clearColor: [number, number, number]
  update: (deltaMs: number, input: InputSnapshot) => void
}

export function createGame(): Game {
  const state = {
    clearColor: [0.04, 0.05, 0.09] as [number, number, number],
  }

  return {
    get clearColor() {
      return state.clearColor
    },
    update(_deltaMs: number, input: InputSnapshot) {
      if (input.keys.has(' ')) {
        state.clearColor = [0.08, 0.1, 0.16]
      } else {
        state.clearColor = [0.04, 0.05, 0.09]
      }
    },
  }
}
