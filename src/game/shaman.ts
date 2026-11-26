import type { Vec3 } from '../engine/math'
import { screenRay, type RayCamera } from '../engine/picking'
import type { DragRect, InputSnapshot, PointerClick } from '../input/input'
import { Spell, SPELLS, SpellResult } from '../sim/spell'
import { settle, type SimulationClient, type SpellCast } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'

/**
 * The shaman and her spells.
 *
 * She is a follower in the core with the shaman flag set, so selecting and
 * ordering her goes through the follower code like anyone else. This module
 * is what only she has: F to find her, mana on the HUD, and a key per spell
 * to aim it.
 *
 * Every spell goes through the same two core calls — check, then cast — so a
 * shaman the player does not control casts exactly the same way. The core
 * judges a cast, runs its cast time, charges for it when it lands and writes
 * the ground itself. Nothing here touches the terrain: the mesh picks the
 * change up from the core's dirty range at the end of the frame, and the next
 * order walks over it with no graph rebuild.
 */

/** The player's tribe: blue, the one the shaman belongs to. */
export const PLAYER_TRIBE = 0

const NOTICE_MS = 2500

const FIND_KEYS = ['KeyF']
/**
 * One key per spell. Clear of the brush (C), huts (B, T), the shaman (F), the
 * camera (WASD, arrows, Q, E, digits, Home) and the brush's [ and ].
 */
export const SPELL_KEYS: Readonly<Record<Spell, string>> = {
  [Spell.landBridge]: 'KeyL',
  [Spell.blast]: 'KeyX',
  [Spell.flatten]: 'KeyV',
  [Spell.swamp]: 'KeyM',
}
const CANCEL_KEYS = ['Escape', 'KeyB', 'KeyT']

export const SPELL_NAMES: Readonly<Record<Spell, string>> = {
  [Spell.landBridge]: 'Land Bridge',
  [Spell.blast]: 'Blast',
  [Spell.flatten]: 'Flatten',
  [Spell.swamp]: 'Swamp',
}

/** The key's letter, for the HUD: 'KeyX' -> 'X'. */
export const keyLabel = (code: string) => code.replace(/^Key/, '')

/** Instance layout, in floats: position(3), heading(3), tribe, flags. */
const OFFSET_POSITION = 0

/** A camera the shaman can be found with: rays for picking, and a way to look at her. */
export type ShamanCamera = RayCamera & {
  focusOn: (direction: Vec3, immediate?: boolean) => void
}

export type ShamanViewContext = {
  camera: ShamanCamera
  /** Viewport width / height. */
  aspect: number
}

/** The spell the cursor is pointing out, and whether the core would cast it. */
export type SpellPreview = {
  readonly spell: Spell
  /** A Land Bridge's near end; null for the disc spells. */
  readonly from: Vec3 | null
  /** The disc's centre, or a bridge's far end. */
  readonly to: Vec3
  readonly result: SpellResult
}

/** One spell as the HUD lists it. */
export type SpellSlot = {
  readonly spell: Spell
  readonly key: string
  readonly name: string
  readonly cost: number
  /** Seconds before it can be cast again; 0 when it can. */
  readonly cooldown: number
  /** 0 unlocked, -1 not this match, or the population that unlocks it. */
  readonly unlockAt: number
}

export type ShamanUpdate = {
  /** Clicks this frame that were a cast, not a selection or an order. */
  consumed: ReadonlySet<PointerClick>
  /** True while a spell owns the left button, so no box selection starts. */
  targeting: boolean
}

export type Shaman = {
  readonly tribe: number
  /** Her follower id right now, or -1. Ids shift as others go into huts. */
  readonly id: number
  readonly mana: number
  readonly manaMax: number
  /** Mana gained per second at the tribe's current size. */
  readonly income: number
  /** The tribe's wood, shown beside its mana. */
  readonly wood: number
  /** The spell being aimed, or null. */
  readonly aiming: Spell | null
  readonly targeting: boolean
  /** Null outside targeting, while sculpting, or with the cursor off the planet. */
  readonly preview: SpellPreview | null
  /** The cast she has under way, or null. */
  readonly casting: SpellCast | null
  /** Every spell, in id order. */
  readonly spells: readonly SpellSlot[]
  /** Angular radius in radians of the disc a spell writes — a bridge's width. */
  radiusOf: (spell: Spell) => number
  readonly notice: string | null
  update: (deltaMs: number, input: InputSnapshot, view: ShamanViewContext) => ShamanUpdate
}

export function createShaman(planet: Planet, simulation: SimulationClient): Shaman {
  const tribe = PLAYER_TRIBE
  let aiming: Spell | null = null
  let preview: SpellPreview | null = null
  let notice: string | null = null
  let noticeMs = 0
  let endsSeen = simulation.lastSpellEnd(tribe).count

  const say = (message: string) => {
    notice = message
    noticeMs = NOTICE_MS
  }

  const position = (): Vec3 | null => {
    const id = simulation.shamanId(tribe)
    if (id < 0) {
      return null
    }
    const data = simulation.followerInstances()
    const base = id * simulation.followerInstanceFloats + OFFSET_POSITION
    const point: Vec3 = [data[base]!, data[base + 1]!, data[base + 2]!]
    const length = Math.hypot(point[0], point[1], point[2])
    return length > 0 ? [point[0] / length, point[1] / length, point[2] / length] : null
  }

  const pick = (ndc: { x: number; y: number }, view: ShamanViewContext): Vec3 | null =>
    planet.pickDirection(screenRay(view.camera, ndc.x, ndc.y, view.aspect))

  // A disc lands where the pointer is. A bridge clicked runs from where she
  // stands; one dragged runs from where the drag began.
  const aimAt = (
    spell: Spell,
    view: ShamanViewContext,
    to: { x: number; y: number },
    drag: DragRect | null,
  ): { from: Vec3 | null; to: Vec3 } | null => {
    const end = pick(to, view)
    if (!end) {
      return null
    }
    if (spell !== Spell.landBridge) {
      return { from: null, to: end }
    }
    const start = drag ? pick(drag.startNdc, view) : position()
    return start ? { from: start, to: end } : null
  }

  // `origin` is a dragged bridge's near end. Null leaves it to the core:
  // wherever she stands when the cast starts.
  // On a worker the answer comes a frame later; until then the cast is taken
  // as started, and a refusal still reaches the HUD when it arrives.
  const cast = (spell: Spell, to: Vec3, origin: Vec3 | null): boolean =>
    settle(simulation.castSpell(spell, tribe, to, origin), (result) => {
      const cost = simulation.spellRules[spell]!.cost
      if (result !== SpellResult.ok) {
        say(spellProblem(spell, result, cost))
        return false
      }
      say(`casting ${SPELL_NAMES[spell]}…`)
      return true
    }) ?? true
  const spells: SpellSlot[] = SPELLS.map((spell) => ({
    spell,
    key: keyLabel(SPELL_KEYS[spell]),
    name: SPELL_NAMES[spell],
    cost: simulation.spellRules[spell]!.cost,
    get cooldown() {
      return simulation.spellCooldown(tribe, spell)
    },
    get unlockAt() {
      return simulation.spellUnlockAt(tribe, spell)
    },
  }))

  return {
    tribe,
    get id() {
      return simulation.shamanId(tribe)
    },
    get mana() {
      return simulation.mana(tribe)
    },
    manaMax: simulation.manaMax,
    get income() {
      return simulation.manaIncome(tribe)
    },
    get wood() {
      return simulation.wood(tribe)
    },
    get aiming() {
      return aiming
    },
    get targeting() {
      return aiming !== null
    },
    get preview() {
      return preview
    },
    get casting() {
      return simulation.spellCasting(tribe)
    },
    spells,
    radiusOf(spell: Spell) {
      return simulation.spellRadius(spell)
    },
    get notice() {
      return notice
    },

    update(deltaMs: number, input: InputSnapshot, view: ShamanViewContext) {
      const consumed = new Set<PointerClick>()
      const pointer = input.pointer

      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      // A cast that ended since the last frame — landed, cut short, or
      // turned down when its time came — says so.
      const ended = simulation.lastSpellEnd(tribe)
      if (ended.count !== endsSeen) {
        endsSeen = ended.count
        say(castEnding(ended.spell, ended.result, simulation.spellRules[ended.spell]!.cost))
      }

      if (FIND_KEYS.some((code) => input.pressed.has(code))) {
        const id = simulation.shamanId(tribe)
        const at = position()
        if (id >= 0 && at) {
          simulation.clearFollowerSelection()
          simulation.setFollowerSelected(id, true)
          view.camera.focusOn(at)
        } else {
          say('the tribe has no shaman')
        }
      }

      // A spell's key aims it; again puts it away; another spell's key
      // switches to that one.
      for (const spell of SPELLS) {
        if (!input.pressed.has(SPELL_KEYS[spell])) {
          continue
        }
        if (simulation.shamanId(tribe) < 0) {
          aiming = null
          say('the tribe has no shaman')
        } else {
          aiming = aiming === spell ? null : spell
        }
      }
      if (CANCEL_KEYS.some((code) => input.pressed.has(code))) {
        aiming = null
      }

      const sculpting = isSculptModifierHeld(input)
      const live = pointer.dragRect && pointer.dragRect.button === 'left' ? pointer.dragRect : null
      preview = null
      if (aiming !== null && !sculpting && pointer.ndc) {
        const aim = aimAt(aiming, view, live ? live.currentNdc : pointer.ndc, live)
        if (aim) {
          preview = {
            spell: aiming,
            ...aim,
            result: simulation.checkSpell(aiming, tribe, aim.to, live ? aim.from : null),
          }
        }
      }

      if (aiming === null) {
        return { consumed, targeting: false }
      }

      for (const click of pointer.clicks) {
        if (aiming === null || click.button === 'middle' || isSculptModifierIn(click.held)) {
          continue
        }
        consumed.add(click)
        if (click.button === 'right') {
          aiming = null
          continue
        }
        // Judged where the click landed, not where the preview was drawn.
        const aim = aimAt(aiming, view, click.ndc, null)
        if (aim && cast(aiming, aim.to, null)) {
          aiming = click.shiftKey ? aiming : null
        }
      }

      for (const gesture of pointer.drags) {
        if (aiming === null || gesture.button !== 'left' || isSculptModifierIn(gesture.held)) {
          continue
        }
        const aim = aimAt(aiming, view, gesture.currentNdc, gesture)
        if (aim && cast(aiming, aim.to, aim.from)) {
          aiming = gesture.shiftKey ? aiming : null
        }
      }

      // Still true on the frame a cast ends targeting, so the drag that cast
      // it does not also land as a selection box.
      return { consumed, targeting: true }
    },
  }
}

/** What the HUD says about a spell aimed at the cursor: the go-ahead, or the reason not. */
export function spellProblem(spell: Spell, result: SpellResult, cost: number): string {
  switch (result) {
    case SpellResult.ok:
      return spell === Spell.landBridge
        ? 'click to raise the land'
        : spell === Spell.blast
          ? 'click to blast the ground'
          : spell === Spell.flatten
            ? 'click to level a pad'
            : 'click to sink the ground'
    case SpellResult.noShaman:
      return 'the tribe has no shaman'
    case SpellResult.outOfRange:
      return 'too far from the shaman — walk her closer'
    case SpellResult.noShore:
      return 'one end has to touch the shore'
    case SpellResult.dry:
      return 'that is dry land already'
    case SpellResult.noMana:
      return `not enough mana (${cost} needed)`
    case SpellResult.cooling:
      return 'not ready again yet'
    case SpellResult.nothing:
      return spell === Spell.flatten
        ? 'that is level already'
        : spell === Spell.swamp
          ? 'that is water already'
          : 'nothing there to blast'
    case SpellResult.wet:
      return 'that is under water'
    case SpellResult.cancelled:
      return 'cancelled'
    case SpellResult.locked:
      return 'not unlocked yet — grow the tribe'
    default:
      return 'the world is not ready'
  }
}

/** What the HUD says when a cast ends. */
export function castEnding(spell: Spell, result: SpellResult, cost: number): string {
  const name = SPELL_NAMES[spell]
  if (result === SpellResult.ok) {
    return spell === Spell.landBridge
      ? 'the land rises'
      : spell === Spell.blast
        ? 'the ground bursts up'
        : spell === Spell.flatten
          ? 'the ground lies level'
          : 'the ground sinks into swamp'
  }
  if (result === SpellResult.cancelled) {
    return `${name} cancelled`
  }
  return `${name} failed: ${spellProblem(spell, result, cost)}`
}
