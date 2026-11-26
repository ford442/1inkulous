/**
 * What a tribe's AI did on its last think. Mirrors inkulous::AiAction in
 * cpp/include/1inkulous/tribe_ai.hpp.
 */
export const AiAction = {
  wait: 0,
  cast: 1,
  toShore: 2,
  build: 3,
  flatten: 4,
  chop: 5,
  train: 6,
  attack: 7,
  settle: 8,
} as const
export type AiAction = (typeof AiAction)[keyof typeof AiAction]

/** How the HUD says it: "Red is training a warrior". */
export const AI_ACTION_TEXT: Readonly<Record<AiAction, string>> = {
  [AiAction.wait]: 'waiting',
  [AiAction.cast]: 'casting',
  [AiAction.toShore]: 'heading for the shore',
  [AiAction.build]: 'building',
  [AiAction.flatten]: 'flattening a pad',
  [AiAction.chop]: 'chopping',
  [AiAction.train]: 'training a warrior',
  [AiAction.attack]: 'attacking',
  [AiAction.settle]: 'settling braves to breed',
}

/**
 * The weights a tribe's AI plays by: inkulous::AiPersonality, field for
 * field, as `configureAi` hands them to the core.
 */
export type AiWeights = {
  /** Seconds between thinks. */
  readonly thinkSeconds: number
  /** Huts of either kind it stops building at. */
  readonly hutCap: number
  /** World units round home it builds within, and forages within. */
  readonly buildReach: number
  readonly forageReach: number
  /** Fewest enemies a Swamp or Blast must catch; 0 never casts either. */
  readonly patch: number
  /** Idle warriors it gathers at home before marching. */
  readonly muster: number
  /** Braves it keeps housed to breed. */
  readonly settle: number
  /** Whether it raises Land Bridges. */
  readonly bridges: boolean
}

/** The core's own defaults: the AI as it played before it had personalities. */
export const DEFAULT_AI_WEIGHTS: AiWeights = {
  thinkSeconds: 2,
  hutCap: 4,
  buildReach: 0.35,
  forageReach: 0.6,
  patch: 3,
  muster: 1,
  settle: 0,
  bridges: true,
}
