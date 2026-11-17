/**
 * Why a hut will or will not fit on a site. Mirrors inkulous::HutSite in
 * cpp/include/1inkulous/huts.hpp. Kept apart from the bridge so game code and
 * tests can name a site without loading the WebAssembly module.
 */
export const HutSite = {
  ok: 0,
  noGrid: 1,
  water: 2,
  uneven: 3,
  occupied: 4,
  full: 5,
  noWood: 6,
} as const
export type HutSite = (typeof HutSite)[keyof typeof HutSite]

/** What a building is for. Mirrors inkulous::HutKind. */
export const HutKind = {
  /** Houses three and breeds. */
  dwelling: 0,
  /** Turns one brave and some wood into a warrior. */
  training: 1,
} as const
export type HutKind = (typeof HutKind)[keyof typeof HutKind]
