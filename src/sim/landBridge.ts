/**
 * Why a Land Bridge will or will not go ahead. Mirrors inkulous::LandBridge in
 * cpp/include/1inkulous/shaman.hpp. Kept apart from the bridge so game code
 * and tests can name a result without loading the WebAssembly module.
 */
export const LandBridge = {
  ok: 0,
  noGrid: 1,
  noShaman: 2,
  outOfRange: 3,
  noShore: 4,
  dry: 5,
  noMana: 6,
} as const
export type LandBridge = (typeof LandBridge)[keyof typeof LandBridge]
