import type { Vec3 } from '../engine/math'
import type { GameEvent } from '../game/gameEvents'
import type { PlayOptions } from './engine'
import type { SoundId } from './sounds'

/**
 * Which sound a game event makes, and where. The one place that says "a chop
 * sounds like this": the engine knows sounds and positions, the event channel
 * knows what happened, and neither knows the other.
 */

export type SoundRequest = {
  readonly sound: SoundId
  /** Null plays it unplaced, heard as-is. */
  readonly at: Vec3 | null
  readonly options?: PlayOptions
}

export function soundForEvent(event: GameEvent): SoundRequest | null {
  switch (event.type) {
    case 'chop':
      return { sound: 'chop', at: event.position }
    case 'treeFelled':
      // The last blow: lower and heavier than the rest.
      return { sound: 'chop', at: event.position, options: { pitch: 0.7, gain: 1.4 } }
    case 'hutBuilt':
      return { sound: 'buildComplete', at: event.position }
    case 'spellCast':
      return { sound: 'spellCast', at: event.position }
    case 'spellLanded':
      return { sound: 'spellImpact', at: event.position }
    case 'death':
      return { sound: 'death', at: event.position }
  }
}
