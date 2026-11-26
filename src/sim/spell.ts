/**
 * The shaman's spells and why one will or will not go ahead. Mirrors
 * inkulous::Spell and inkulous::SpellResult in cpp/include/1inkulous/shaman.hpp.
 * Kept apart from the bridge so game code and tests can name them without
 * loading the WebAssembly module.
 */
export const Spell = {
  landBridge: 0,
  blast: 1,
  flatten: 2,
  swamp: 3,
} as const
export type Spell = (typeof Spell)[keyof typeof Spell]

/** Every spell, in id order. */
export const SPELLS: readonly Spell[] = [Spell.landBridge, Spell.blast, Spell.flatten, Spell.swamp]

export const SpellResult = {
  ok: 0,
  noGrid: 1,
  noShaman: 2,
  outOfRange: 3,
  /** Land Bridge: neither end near land. */
  noShore: 4,
  /** Land Bridge: the line is dry already. */
  dry: 5,
  noMana: 6,
  cooling: 7,
  /** The ground is already what the spell would make it. */
  nothing: 8,
  /** Flatten: the centre is under water. */
  wet: 9,
  /** Only as how a cast ended: another order or another cast cut it short. */
  cancelled: 10,
  unknownSpell: 11,
  /** The tribe has not unlocked it yet (see `setSpellUnlock`). */
  locked: 12,
} as const

/** An unlock threshold for a spell a tribe never gets this match. */
export const SPELL_NEVER = -1
export type SpellResult = (typeof SpellResult)[keyof typeof SpellResult]
