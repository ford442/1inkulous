import type { Vec3 } from '../engine/math'
import type { AiAction } from '../sim/ai'
import type { Simulation, SimulationClient } from '../sim/simulation'
import type { BuiltTribe, World } from './build'
import type { VictorySpec } from './schema'

/**
 * The match a world is played as: who the player is, who they are up
 * against, and how it is going.
 *
 * Losing is always the same: the player's shaman falls. Winning is any of the
 * world's `rules.victory`:
 *
 *   conquest    every rival shaman fallen — the core's own end of the match,
 *               so it always wins, listed or not
 *   survive     the player's shaman still standing that many seconds in
 *   population  the player's tribe grown to that many
 *
 * All of it is read off the core — shamans, the clock, populations — so the
 * outcome is the same on every machine at the same step, which is what
 * lockstep will need of it.
 */

export type MatchOutcome = 'playing' | 'won' | 'lost' | 'draw'

/** An opponent as the HUD reports it. */
export type TribeReadout = {
  readonly tribe: number
  readonly name: string
  readonly shamanStanding: boolean
  readonly population: number
  readonly mana: number
  readonly income: number
  readonly wood: number
  readonly action: AiAction
  /** How the AI plays it ("raider"); null when nobody does. */
  readonly personality: string | null
}

export type Match = {
  /** The player's tribe, or -1 when every tribe is played by the core. */
  readonly playerTribe: number
  /** Every tribe in the world, in the scenario's order. */
  readonly tribes: readonly BuiltTribe[]
  /** Where the player's village grew from; the opening view looks at it. */
  readonly playerHome: Vec3 | null
  readonly victory: readonly VictorySpec[]
  /** What the player has to do, in a line: "Defeat every rival shaman, or hold out for 8:00". */
  readonly objective: string
  readonly outcome: MatchOutcome
  /** Every tribe but the player's. */
  readonly opponents: readonly TribeReadout[]
}

export const DEFAULT_VICTORY: readonly VictorySpec[] = [{ kind: 'conquest' }]

/** m:ss, for the HUD. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function describeVictory(victory: readonly VictorySpec[]): string {
  const parts = ['defeat every rival shaman']
  for (const condition of victory) {
    if (condition.kind === 'survive') {
      parts.push(`hold out for ${clock(condition.seconds)}`)
    } else if (condition.kind === 'population') {
      parts.push(`grow to ${condition.count} people`)
    }
  }
  const sentence = parts.join(', or ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

type OutcomeReads = Pick<
  Simulation,
  'matchOver' | 'matchWinner' | 'shamanFallen' | 'elapsedMs' | 'population'
>

/** Where the match stands for `playerTribe`. Pure over the core's answers. */
export function matchOutcome(
  simulation: OutcomeReads,
  playerTribe: number,
  victory: readonly VictorySpec[] = DEFAULT_VICTORY,
): MatchOutcome {
  if (playerTribe < 0) {
    return simulation.matchOver ? 'draw' : 'playing'
  }
  if (simulation.shamanFallen(playerTribe)) {
    return 'lost'
  }
  if (simulation.matchOver) {
    const winner = simulation.matchWinner
    return winner < 0 ? 'draw' : winner === playerTribe ? 'won' : 'lost'
  }
  for (const condition of victory) {
    if (condition.kind === 'survive' && simulation.elapsedMs >= condition.seconds * 1000) {
      return 'won'
    }
    if (condition.kind === 'population' && simulation.population(playerTribe) >= condition.count) {
      return 'won'
    }
  }
  return 'playing'
}

/** The match over a built world, read live from `simulation`. */
export function createMatch(world: Pick<World, 'scenario' | 'tribes'>, simulation: SimulationClient): Match {
  const player = world.tribes.find((tribe) => tribe.control === 'player') ?? null
  const playerTribe = player ? player.tribe : -1
  const victory = world.scenario.rules?.victory ?? DEFAULT_VICTORY
  const rivals = world.tribes.filter((tribe) => tribe.tribe !== playerTribe)
  return {
    playerTribe,
    tribes: world.tribes,
    playerHome: player?.home ?? null,
    victory,
    objective: describeVictory(victory),
    get outcome() {
      return matchOutcome(simulation, playerTribe, victory)
    },
    get opponents() {
      return rivals.map((tribe) => ({
        tribe: tribe.tribe,
        name: tribe.name,
        shamanStanding: simulation.shamanId(tribe.tribe) >= 0,
        population: simulation.population(tribe.tribe),
        mana: simulation.mana(tribe.tribe),
        income: simulation.manaIncome(tribe.tribe),
        wood: simulation.wood(tribe.tribe),
        action: simulation.aiLastAction(tribe.tribe),
        personality: tribe.personality,
      }))
    },
  }
}
