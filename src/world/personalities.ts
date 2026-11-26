import { DEFAULT_AI_WEIGHTS, type AiWeights } from '../sim/ai'
import type { AiSpec, PersonalityName } from './schema'

/**
 * How the core's AI can play a tribe, as data.
 *
 * Each personality is the eight weights of inkulous::AiPersonality. The core
 * decides nothing by name: a scenario names a personality (or one with a few
 * weights changed), `aiWeights` resolves it to numbers here, and the builder
 * hands those to `configureAi`. Tuning the opposition is editing this table or
 * a world file, never the C++.
 *
 * Roughly easiest to hardest:
 *
 *   gentle   slow to think, never casts at a crowd, never bridges, marches
 *            only once it has four warriors: a first opponent
 *   steady   the AI as it always played: quick to send each warrior
 *   builder  grows first — more huts, braves kept home breeding — and
 *            marches late in a body of five
 *   raider   thinks fast, small village, marches in pairs, casts at any two
 *   warlord  thinks fastest, breeds and builds big, casts at any two and
 *            marches in fours
 */
export const PERSONALITIES: Readonly<Record<PersonalityName, AiWeights>> = {
  gentle: { ...DEFAULT_AI_WEIGHTS, thinkSeconds: 4, hutCap: 3, patch: 0, muster: 4, settle: 0, bridges: false },
  steady: DEFAULT_AI_WEIGHTS,
  builder: { ...DEFAULT_AI_WEIGHTS, thinkSeconds: 2, hutCap: 6, patch: 4, muster: 5, settle: 3 },
  raider: { ...DEFAULT_AI_WEIGHTS, thinkSeconds: 1.5, hutCap: 3, buildReach: 0.3, patch: 2, muster: 2, settle: 2 },
  warlord: {
    ...DEFAULT_AI_WEIGHTS,
    thinkSeconds: 1,
    hutCap: 6,
    buildReach: 0.4,
    forageReach: 0.75,
    patch: 2,
    muster: 4,
    settle: 3,
  },
}

/** What a tribe's `ai` field comes to. Absent is `steady`. */
export function aiWeights(spec: AiSpec | undefined): AiWeights {
  if (spec === undefined) {
    return PERSONALITIES.steady
  }
  if (typeof spec === 'string') {
    return PERSONALITIES[spec]
  }
  const { personality, ...weights } = spec
  const base = PERSONALITIES[personality ?? 'steady']
  return {
    thinkSeconds: weights.thinkSeconds ?? base.thinkSeconds,
    hutCap: weights.hutCap ?? base.hutCap,
    buildReach: weights.buildReach ?? base.buildReach,
    forageReach: weights.forageReach ?? base.forageReach,
    patch: weights.patch ?? base.patch,
    muster: weights.muster ?? base.muster,
    settle: weights.settle ?? base.settle,
    bridges: weights.bridges ?? base.bridges,
  }
}

/** A personality's name for the HUD: "raider", or "raider (tuned)". */
export function personalityLabel(spec: AiSpec | undefined): string {
  if (spec === undefined) {
    return 'steady'
  }
  if (typeof spec === 'string') {
    return spec
  }
  const tuned = Object.keys(spec).some((key) => key !== 'personality')
  return `${spec.personality ?? 'steady'}${tuned ? ' (tuned)' : ''}`
}
