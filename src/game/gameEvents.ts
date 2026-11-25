import type { Vec3 } from '../engine/math'
import type { SpellCast } from '../sim/simulation'
import type { Spell } from '../sim/spell'
import type { HutKind } from '../sim/hutSite'
import { createSpellEvents, type SpellEventSource, type SpellLanding } from './spellEffects'

/**
 * Things that happened in the world, as events the renderer and the speakers
 * can react to — the same channel the spell particles ride (`spellEffects.ts`).
 *
 * The core does not push events. It keeps state and the game reads it, and
 * works out what changed since the last look. That keeps events out of the
 * snapshots the worker publishes (and so out of the determinism hash and the
 * replays): an event here is a *view* of the simulation, never part of it.
 *
 * - **chop** — a blow landed on a tree: its chop progress crossed one of
 *   `CHOP_BLOWS` marks. **treeFelled** — a tree that was well into being chopped
 *   is gone.
 * - **hutBuilt** — a hut appeared. Huts go up whole, so this is also when
 *   building completes.
 * - **spellCast** — a shaman began a cast, aimed at a place; **spellLanded** —
 *   it landed there (the same landing the particles are made from).
 * - **death** — someone's people got fewer. The core takes the dead out of its
 *   follower list, so the spot is found by comparing this frame's followers
 *   with the last's: whoever is no longer in line.
 *
 * Each has a world position (null for a death whose place could not be told),
 * in the same planet-centred units the instance buffers use.
 */

export type GameEvent =
  | { readonly type: 'chop'; readonly position: Vec3 }
  | { readonly type: 'treeFelled'; readonly position: Vec3 }
  | { readonly type: 'hutBuilt'; readonly position: Vec3; readonly tribe: number; readonly kind: HutKind }
  | { readonly type: 'spellCast'; readonly position: Vec3; readonly tribe: number; readonly spell: Spell }
  | { readonly type: 'spellLanded'; readonly position: Vec3; readonly tribe: number; readonly spell: Spell }
  | { readonly type: 'death'; readonly position: Vec3 | null; readonly tribe: number }

/** The instance layouts, in floats; mirrors trees.hpp, huts.hpp and followers.hpp. */
const TREE_PROGRESS = 7
const HUT_TRIBE = 6
const HUT_KIND = 8
const FOLLOWER_TRIBE = 6

/** How many blows a tree takes to fell, for the sound of it. */
export const CHOP_BLOWS = 6
/** A vanished tree counts as felled (rather than built over or drowned) past this progress. */
export const FELLED_PROGRESS = 0.5

/**
 * How far a follower may have moved between two looks and still be the same
 * one, as a chord on the unit planet. A step is a tenth of a second or so of
 * walking — a few thousandths; this leaves room for a stalled frame.
 */
export const SAME_FOLLOWER_DISTANCE = 0.05

/** The slice of the simulation these events are read from. */
export type GameEventSource = SpellEventSource & {
  /**
   * Fixed steps run so far. The world only changes on a step, so when this has
   * not moved since the last poll there is nothing to look at — at 144 Hz on a
   * 20 Hz core, six frames in seven. Optional: without it, every poll looks.
   */
  readonly stepCount?: number
  treeInstances: () => Float32Array
  readonly treeInstanceFloats: number
  hutInstances: () => Float32Array
  readonly hutInstanceFloats: number
  followerInstances: () => Float32Array
  readonly followerInstanceFloats: number
  population: (tribe: number) => number
}

export type GameEvents = {
  /** What happened since the last poll, oldest first. */
  poll: () => GameEvent[]
}

/** A position's identity for something that never walks: its direction, to a hair. */
function placeKey(x: number, y: number, z: number): string {
  const length = Math.hypot(x, y, z) || 1
  return `${Math.round((x / length) * 20000)},${Math.round((y / length) * 20000)},${Math.round((z / length) * 20000)}`
}

/** A follower as the death finder sees it. */
type Placed = { x: number; y: number; z: number; tribe: number }

/**
 * Which of `before` are gone from `after`. The core keeps followers in a dense
 * list and removes the dead from it, so `after` is `before` with some entries
 * deleted (and newcomers added at the end): walk the two together, and an
 * entry in `before` that does not line up with the next in `after` is a gap.
 *
 * Someone thrown a long way in one step does not line up with themselves,
 * which would read as a death and then drag every later pairing off by one. So
 * a mismatch looks one ahead first: if the *next* in `before` lines up, this one
 * is gone; if not, and the tribes agree, this one is taken to have moved a long
 * way, and the two are paired anyway.
 */
export function removedFollowers(before: readonly Placed[], after: readonly Placed[]): Placed[] {
  const near = (a: Placed, b: Placed) =>
    a.tribe === b.tribe && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < SAME_FOLLOWER_DISTANCE
  const gone: Placed[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const was = before[i]!
    const is = after[j]!
    if (near(was, is)) {
      i += 1
      j += 1
    } else if (i + 1 < before.length && near(before[i + 1]!, is)) {
      gone.push(was)
      i += 1
    } else if (was.tribe === is.tribe) {
      i += 1
      j += 1
    } else {
      gone.push(was)
      i += 1
    }
  }
  for (; i < before.length; i += 1) {
    gone.push(before[i]!)
  }
  return gone
}

export function createGameEvents(
  source: GameEventSource,
  options: { tribes: readonly number[]; planetRadius: number },
): GameEvents {
  const { tribes, planetRadius } = options
  const spells = createSpellEvents(source, tribes)

  // Trees and huts do not move, so they are remembered by place.
  const trees = new Map<string, { progress: number; position: Vec3 }>()
  const huts = new Set<string>()
  const casting = new Map<number, SpellCast | null>()
  const population = new Map<number, number>()
  let followers: Placed[] = []

  const readTrees = (): Map<string, { progress: number; position: Vec3 }> => {
    const data = source.treeInstances()
    const stride = source.treeInstanceFloats
    const now = new Map<string, { progress: number; position: Vec3 }>()
    for (let at = 0; at + stride <= data.length; at += stride) {
      const x = data[at]!
      const y = data[at + 1]!
      const z = data[at + 2]!
      now.set(placeKey(x, y, z), { progress: data[at + TREE_PROGRESS]!, position: [x, y, z] })
    }
    return now
  }

  const readFollowers = (): Placed[] => {
    const data = source.followerInstances()
    const stride = source.followerInstanceFloats
    const out: Placed[] = []
    for (let at = 0; at + stride <= data.length; at += stride) {
      out.push({ x: data[at]!, y: data[at + 1]!, z: data[at + 2]!, tribe: Math.round(data[at + FOLLOWER_TRIBE]!) })
    }
    return out
  }

  // The world as it starts is not news: remember it, say nothing.
  for (const [key, tree] of readTrees()) {
    trees.set(key, tree)
  }
  {
    const data = source.hutInstances()
    const stride = source.hutInstanceFloats
    for (let at = 0; at + stride <= data.length; at += stride) {
      huts.add(placeKey(data[at]!, data[at + 1]!, data[at + 2]!))
    }
  }
  for (const tribe of tribes) {
    casting.set(tribe, source.spellCasting(tribe))
    population.set(tribe, source.population(tribe))
  }
  followers = readFollowers()
  let lastStep = source.stepCount

  const onSphere = (direction: Vec3): Vec3 => [
    direction[0] * planetRadius,
    direction[1] * planetRadius,
    direction[2] * planetRadius,
  ]

  return {
    poll() {
      if (source.stepCount !== undefined && source.stepCount === lastStep) {
        return []
      }
      lastStep = source.stepCount
      const events: GameEvent[] = []

      // Trees: blows as the chop progress passes each mark, and the felled.
      const now = readTrees()
      for (const [key, tree] of now) {
        const before = trees.get(key)
        const previous = before ? before.progress : 0
        if (tree.progress > 0 && Math.floor(tree.progress * CHOP_BLOWS) > Math.floor(previous * CHOP_BLOWS)) {
          events.push({ type: 'chop', position: tree.position })
        }
      }
      for (const [key, tree] of trees) {
        if (!now.has(key) && tree.progress >= FELLED_PROGRESS) {
          events.push({ type: 'treeFelled', position: tree.position })
        }
      }
      trees.clear()
      for (const [key, tree] of now) {
        trees.set(key, tree)
      }

      // Huts: one that was not there before.
      {
        const data = source.hutInstances()
        const stride = source.hutInstanceFloats
        const seen = new Set<string>()
        for (let at = 0; at + stride <= data.length; at += stride) {
          const key = placeKey(data[at]!, data[at + 1]!, data[at + 2]!)
          seen.add(key)
          if (!huts.has(key)) {
            events.push({
              type: 'hutBuilt',
              position: [data[at]!, data[at + 1]!, data[at + 2]!],
              tribe: Math.round(data[at + HUT_TRIBE]!),
              kind: Math.round(data[at + HUT_KIND]!) as HutKind,
            })
          }
        }
        huts.clear()
        for (const key of seen) {
          huts.add(key)
        }
      }

      // Spells: a cast beginning, and (from the spell channel) one landing.
      for (const tribe of tribes) {
        const cast = source.spellCasting(tribe)
        const was = casting.get(tribe) ?? null
        if (cast && (!was || was.spell !== cast.spell)) {
          events.push({ type: 'spellCast', position: onSphere(cast.target), tribe, spell: cast.spell })
        }
        casting.set(tribe, cast)
      }
      for (const landing of spells.poll()) {
        events.push(spellLanded(landing, onSphere))
      }

      // Deaths: a tribe with fewer people, placed by who is missing from the line.
      const nowFollowers = readFollowers()
      let missing: Placed[] | null = null
      for (const tribe of tribes) {
        const count = source.population(tribe)
        const drop = (population.get(tribe) ?? count) - count
        population.set(tribe, count)
        if (drop <= 0) {
          continue
        }
        missing ??= removedFollowers(followers, nowFollowers)
        const ofTribe = missing.filter((one) => one.tribe === tribe)
        for (let n = 0; n < drop; n += 1) {
          const one = ofTribe[n]
          events.push({ type: 'death', position: one ? [one.x, one.y, one.z] : null, tribe })
        }
      }
      followers = nowFollowers

      return events
    },
  }
}

function spellLanded(landing: SpellLanding, onSphere: (direction: Vec3) => Vec3): GameEvent {
  return { type: 'spellLanded', position: onSphere(landing.target), tribe: landing.tribe, spell: landing.spell }
}
