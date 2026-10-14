/**
 * Why a building will or will not fit on a site. Mirrors inkulous::BuildingSite
 * in cpp/include/1inkulous/buildings.hpp. Kept apart from the bridge so game
 * code and tests can name a site without loading the WebAssembly module.
 */
export const BuildingSite = {
  ok: 0,
  noGrid: 1,
  water: 2,
  steep: 3,
  occupied: 4,
  full: 5,
} as const
export type BuildingSite = (typeof BuildingSite)[keyof typeof BuildingSite]

/** Mirrors kBuildingKindHut. The first huts are this kind. */
export const BuildingKind = {
  hut: 0,
} as const
