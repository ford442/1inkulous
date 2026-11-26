import type { Vec3 } from '../engine/math'
import { roundVec } from '../world/build'
import { stringifyScenario } from '../world/format'
import {
  encodeHeightField,
  readScenario,
  type GeneratedTerrainSpec,
  type HutKindName,
  type Scenario,
  type SpellKey,
  type TribeSpec,
  type UnitRole,
  type UnlockSpec,
  type VictorySpec,
} from '../world/schema'

/**
 * What the world editor does to a world, as plain functions over the
 * scenario: every one takes a document and returns the next, and touches
 * nothing else. The editor (./editor.ts) builds whatever these return with
 * the same builder the game boots from, so what it shows is what the file
 * will load as; and export is `stringifyScenario` of the document, import
 * `readScenario` of the text, so a world round-trips through a file exactly.
 *
 * Every document here is explicit — a baked world (src/world/build.ts): each
 * person, hut and tree where it stands, nothing left to "auto". That is what
 * the editor opens a world as, and building it gives the same world as the
 * original did.
 */

export type Tool =
  | { readonly kind: 'unit'; readonly role: UnitRole }
  | { readonly kind: 'hut'; readonly hut: HutKindName }
  | { readonly kind: 'tree' }
  | { readonly kind: 'erase' }

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const angle = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.max(-1, Math.min(1, dot(a, b) / Math.sqrt(dot(a, a) * dot(b, b)))))

function tribeIndex(doc: Scenario, slot: number): number {
  const index = doc.tribes.findIndex((tribe) => tribe.tribe === slot)
  if (index < 0) {
    throw new Error(`the world has no tribe ${slot}`)
  }
  return index
}

function withTribe(doc: Scenario, slot: number, change: (tribe: TribeSpec) => TribeSpec): Scenario {
  const index = tribeIndex(doc, slot)
  return { ...doc, tribes: doc.tribes.map((tribe, i) => (i === index ? change(tribe) : tribe)) }
}

/** A person of `role` for tribe `slot` at `at` (a node's direction). A second shaman moves the first. */
export function placeUnit(doc: Scenario, slot: number, role: UnitRole, at: Vec3): Scenario {
  return withTribe(doc, slot, (tribe) => {
    const units = (tribe.units ?? []).filter((unit) => role !== 'shaman' || unit.role !== 'shaman')
    // The shaman leads the list, as the builder spawns her: first.
    const placed = { role, at: roundVec(at) }
    return { ...tribe, shaman: false, units: role === 'shaman' ? [placed, ...units] : [...units, placed] }
  })
}

/** A hut of `kind` for tribe `slot`, its door along `door`. */
export function placeHut(doc: Scenario, slot: number, kind: HutKindName, at: Vec3, door: Vec3): Scenario {
  return withTribe(doc, slot, (tribe) => ({
    ...tribe,
    huts: [...(tribe.huts ?? []), { kind, at: roundVec(at), door: roundVec(door) }],
  }))
}

export function placeTree(doc: Scenario, at: Vec3): Scenario {
  const trees = doc.trees ?? {}
  return { ...doc, trees: { ...trees, at: [...(trees.at ?? []), roundVec(at)] } }
}

/**
 * Takes away whatever stands nearest `at` within `reach` radians: a person,
 * a hut or a tree. Returns the document unchanged, and null, when nothing is
 * that close.
 */
export function eraseNear(doc: Scenario, at: Vec3, reach: number): { doc: Scenario; erased: string | null } {
  let best: { distance: number; apply: () => Scenario; what: string } | null = null
  const consider = (where: readonly number[], what: string, apply: () => Scenario) => {
    const distance = angle(where, at)
    if (distance <= reach && (best === null || distance < best.distance)) {
      best = { distance, apply, what }
    }
  }
  doc.tribes.forEach((tribe) => {
    ;(tribe.units ?? []).forEach((unit, i) =>
      consider(unit.at, `${tribe.name ?? `tribe ${tribe.tribe}`}'s ${unit.role}`, () =>
        withTribe(doc, tribe.tribe, (t) => ({ ...t, units: t.units!.filter((_, j) => j !== i) })),
      ),
    )
    ;(tribe.huts ?? []).forEach((hut, i) => {
      if (hut.at) {
        consider(hut.at, `${tribe.name ?? `tribe ${tribe.tribe}`}'s ${hut.kind}`, () =>
          withTribe(doc, tribe.tribe, (t) => ({ ...t, huts: t.huts!.filter((_, j) => j !== i) })),
        )
      }
    })
  })
  ;(doc.trees?.at ?? []).forEach((tree, i) =>
    consider(tree, 'a tree', () => ({ ...doc, trees: { ...doc.trees, at: doc.trees!.at!.filter((_, j) => j !== i) } })),
  )
  const found = best as { apply: () => Scenario; what: string } | null
  return found ? { doc: found.apply(), erased: found.what } : { doc, erased: null }
}

/** The ground exactly as it stands now: what a sculpted world is saved as. */
export function setGround(doc: Scenario, heights: Float32Array): Scenario {
  return {
    ...doc,
    planet: { ...doc.planet, terrain: { kind: 'heights', encoding: 'f32-base64', data: encodeHeightField(heights) } },
  }
}

/** Generated ground from these parameters, replacing whatever was sculpted. */
export function regenerate(doc: Scenario, terrain: Omit<GeneratedTerrainSpec, 'kind'>): Scenario {
  return { ...doc, planet: { ...doc.planet, terrain: { kind: 'generated', ...terrain } } }
}

export function setDetails(
  doc: Scenario,
  details: Partial<Pick<Scenario, 'id' | 'name' | 'description' | 'author' | 'seed'>>,
): Scenario {
  return { ...doc, ...details }
}

export function updateTribe(doc: Scenario, slot: number, patch: Partial<Omit<TribeSpec, 'tribe'>>): Scenario {
  return withTribe(doc, slot, (tribe) => {
    const next: Record<string, unknown> = { ...tribe, ...patch }
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) {
        delete next[key]
      }
    }
    return next as TribeSpec
  })
}

/** The next free colour slot as a new rival, with a shaman to place. Null when all four are taken. */
export function addTribe(doc: Scenario): Scenario | null {
  const taken = new Set(doc.tribes.map((tribe) => tribe.tribe))
  const slot = [0, 1, 2, 3].find((s) => !taken.has(s))
  if (slot === undefined) {
    return null
  }
  return { ...doc, tribes: [...doc.tribes, { tribe: slot, control: slot === 0 ? 'player' : 'ai', ai: 'steady', shaman: false }] }
}

/** Removes a tribe and everything it had. The last one stays. */
export function removeTribe(doc: Scenario, slot: number): Scenario {
  const tribes = doc.tribes.filter((tribe) => tribe.tribe !== slot)
  return tribes.length === 0 ? doc : { ...doc, tribes }
}

/** One spell's unlock for every tribe. */
export function setSpell(doc: Scenario, spell: SpellKey, unlock: UnlockSpec): Scenario {
  const rules = doc.rules ?? {}
  return { ...doc, rules: { ...rules, spells: { ...rules.spells, [spell]: unlock } } }
}

/** The extra ways to win: 0 leaves one out. Conquest always wins. */
export function setVictory(doc: Scenario, survive: number, population: number): Scenario {
  const victory: VictorySpec[] = [{ kind: 'conquest' }]
  if (survive > 0) {
    victory.push({ kind: 'survive', seconds: survive })
  }
  if (population > 0) {
    victory.push({ kind: 'population', count: Math.round(population) })
  }
  return { ...doc, rules: { ...doc.rules, victory } }
}

/** The world as its file says it: what Export downloads. */
export const exportWorld = (doc: Scenario): string => stringifyScenario(doc)

/** A world file read back: what Import loads. Throws a ScenarioError saying where it is wrong. */
export const importWorld = (text: string, source?: string): Scenario => readScenario(text, source)
