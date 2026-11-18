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
}
