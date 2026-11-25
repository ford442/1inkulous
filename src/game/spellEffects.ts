import type { Vec3 } from '../engine/math'
import type { SpellCast, SpellEnd } from '../sim/simulation'
import { type Spell, SpellResult } from '../sim/spell'

/**
 * Spells landing, as events the renderer can turn into effects.
 *
 * The core reports a cast two ways: the one a tribe has under way (where, how
 * wide) and a counter that goes up each time one ends, with how it ended. A
 * spell that landed is the second ticking over with `ok`; where it landed is
 * the last thing the first said before it cleared. So each tribe's cast is
 * remembered while it lasts, and handed on when its end comes in.
 */
export type SpellLanding = {
  readonly spell: Spell
  readonly tribe: number
  /** Unit direction of the disc's centre (a bridge's far end). */
  readonly target: Vec3
  /** The disc's angular radius, in radians. */
  readonly radius: number
}

/** The slice of the simulation this reads; a worker's client or the core itself. */
export type SpellEventSource = {
  spellCasting: (tribe: number) => SpellCast | null
  lastSpellEnd: (tribe: number) => SpellEnd
}

export type SpellEvents = {
  /** Spells that landed since the last poll, oldest first. */
  poll: () => SpellLanding[]
}

export function createSpellEvents(
  source: SpellEventSource,
  tribes: readonly number[],
): SpellEvents {
  const seen = new Map<number, number>()
  const underway = new Map<number, SpellCast>()
  for (const tribe of tribes) {
    seen.set(tribe, source.lastSpellEnd(tribe).count)
  }

  return {
    poll() {
      const landed: SpellLanding[] = []
      for (const tribe of tribes) {
        // The end first: a cast that ended this frame and a new one already
        // under way must not have the new one's target given to the old.
        const end = source.lastSpellEnd(tribe)
        if (end.count !== seen.get(tribe)) {
          seen.set(tribe, end.count)
          const cast = underway.get(tribe)
          underway.delete(tribe)
          if (end.result === SpellResult.ok && cast && cast.spell === end.spell) {
            landed.push({ spell: cast.spell, tribe, target: cast.target, radius: cast.radius })
          }
        }
        const cast = source.spellCasting(tribe)
        if (cast) {
          underway.set(tribe, cast)
        }
      }
      return landed
    },
  }
}
