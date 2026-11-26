import * as v from 'valibot'
import { fromBase64, toBase64 } from '../sim/base64'

/**
 * The scenario format: a world as data.
 *
 * A scenario is one JSON file — the planet (its size and its ground, either a
 * seed and the parameters the core generates it from or the exact height of
 * every node), the forest, up to four tribes with where they start and what
 * they start with, and the rules the match is played by: which spells each
 * tribe has and when, and what wins. `parseScenario` checks a file against
 * the schema below and the rules no schema can say (one shaman a tribe, a
 * height field the right length for its planet, …) and says exactly where it
 * is wrong. Everything the game boots, every shipped world and everything the
 * editor writes goes through it.
 *
 * Optional fields are left out of the parsed document rather than filled in:
 * the defaults live in the builder (src/world/build.ts), so a file written
 * back out says no more than it did coming in.
 */

export const SCENARIO_FORMAT = 1

/** Mirror kMaxFollowers, kMaxHuts and kMaxTrees in cpp/include/1inkulous/. */
const MAX_FOLLOWERS = 1024
const MAX_HUTS = 256
const MAX_TREES = 512
const MAX_TRIBES = 4

/** Welded vertices — nav nodes — on a cube-sphere of `resolution` quads a face edge. */
export const nodeCountFor = (resolution: number): number => 6 * resolution * resolution + 2

const finite = (message: string) => v.pipe(v.number(message), v.finite(message))
const between = (low: number, high: number, what: string) =>
  v.pipe(
    v.number(`${what} must be a number`),
    v.finite(`${what} must be a number`),
    v.minValue(low, `${what} must be at least ${low}`),
    v.maxValue(high, `${what} must be at most ${high}`),
  )
const whole = (low: number, high: number, what: string) =>
  v.pipe(
    v.number(`${what} must be a whole number`),
    v.integer(`${what} must be a whole number`),
    v.minValue(low, `${what} must be at least ${low}`),
    v.maxValue(high, `${what} must be at most ${high}`),
  )

/** A direction from the planet's centre: three numbers, not all zero. Need not be unit length. */
export const Vec3Schema = v.pipe(
  v.tuple(
    [finite('a direction is three numbers'), finite('a direction is three numbers'), finite('a direction is three numbers')],
    'a direction is three numbers [x, y, z]',
  ),
  v.check(([x, y, z]) => Math.hypot(x, y, z) > 1e-9, 'a direction cannot be [0, 0, 0]'),
)
export type Vec3Spec = v.InferOutput<typeof Vec3Schema>

// --- the ground -------------------------------------------------------------

/** Parameters of the core's world generator (inkulous::WorldGenParams); see worldgen.hpp. */
const GeneratedTerrain = v.strictObject({
  kind: v.literal('generated'),
  seed: whole(0, 0xffffffff, 'terrain.seed'),
  land: v.optional(between(0, 1, 'land')),
  continents: v.optional(whole(0, 16, 'continents')),
  continentSize: v.optional(between(0.05, Math.PI, 'continentSize')),
  continentWeight: v.optional(between(0, 1, 'continentWeight')),
  frequency: v.optional(between(0.1, 16, 'frequency')),
  octaves: v.optional(whole(1, 8, 'octaves')),
  persistence: v.optional(between(0.05, 0.95, 'persistence')),
  lacunarity: v.optional(between(1.1, 4, 'lacunarity')),
  warp: v.optional(between(0, 2, 'warp')),
  ridges: v.optional(between(0, 1, 'ridges')),
  /** In quarter steps: the core rounds it to the nearest. */
  relief: v.optional(between(0.25, 4, 'relief')),
  peak: v.optional(between(0.05, 1, 'peak')),
  smoothing: v.optional(whole(0, 8, 'smoothing')),
})

/** The exact ground: one float32 height per nav node, base64, little-endian. */
const HeightsTerrain = v.strictObject({
  kind: v.literal('heights'),
  encoding: v.literal('f32-base64'),
  data: v.string(),
})

/** Every node at one height: 0 is an ocean world. */
const FlatTerrain = v.strictObject({
  kind: v.literal('flat'),
  height: v.optional(v.pipe(finite('height must be a number'), v.minValue(0, 'height cannot be below sea level'))),
})

export const TerrainSchema = v.variant(
  'kind',
  [GeneratedTerrain, HeightsTerrain, FlatTerrain],
  'terrain.kind must be "generated", "heights" or "flat"',
)
export type TerrainSpec = v.InferOutput<typeof TerrainSchema>
export type GeneratedTerrainSpec = v.InferOutput<typeof GeneratedTerrain>

const PlanetSchema = v.strictObject({
  /** Quads per cube-face edge: 24 is the default world, about 3,500 nodes. */
  resolution: whole(4, 64, 'planet.resolution'),
  radius: v.optional(v.pipe(finite('planet.radius must be a number'), v.minValue(0.1), v.maxValue(100))),
  /** Highest the ground may stand above sea level, in world units. */
  maxHeight: v.optional(v.pipe(finite('planet.maxHeight must be a number'), v.minValue(0.001), v.maxValue(10))),
  terrain: TerrainSchema,
})

// --- the forest -------------------------------------------------------------

/** `[x, y, z]`, or `[x, y, z, size, turn]` as the core scattered or planted it. */
export const TreeSchema = v.pipe(
  v.array(finite('a tree is [x, y, z] or [x, y, z, size, turn]')),
  v.check((tree) => tree.length === 3 || tree.length === 5, 'a tree is [x, y, z] or [x, y, z, size, turn]'),
  v.check((tree) => Math.hypot(tree[0]!, tree[1]!, tree[2]!) > 1e-9, 'a tree cannot stand at [0, 0, 0]'),
  v.check((tree) => tree.length === 3 || tree[3]! > 0, 'a tree\'s size must be above 0'),
)
export type TreeSpec = v.InferOutput<typeof TreeSchema>

const TreesSchema = v.strictObject({
  /** Trees scattered over dry land from the match seed. */
  scatter: v.optional(whole(0, MAX_TREES, 'trees.scatter')),
  /** Trees each village is sure of nearby, planted if the scatter left it short. */
  groves: v.optional(whole(0, 16, 'trees.groves')),
  at: v.optional(v.array(TreeSchema)),
})

// --- rules ------------------------------------------------------------------

export const SPELL_KEYS = ['landBridge', 'blast', 'flatten', 'swamp'] as const
export type SpellKey = (typeof SPELL_KEYS)[number]

/** "now", "never", or the population the tribe must first reach. */
export const UnlockSchema = v.union(
  [v.literal('now'), v.literal('never'), whole(1, MAX_FOLLOWERS, 'an unlock population')],
  'a spell unlocks "now", "never", or at a population (a whole number)',
)
export type UnlockSpec = v.InferOutput<typeof UnlockSchema>

const SpellsSchema = v.strictObject({
  landBridge: v.optional(UnlockSchema),
  blast: v.optional(UnlockSchema),
  flatten: v.optional(UnlockSchema),
  swamp: v.optional(UnlockSchema),
})
export type SpellsSpec = v.InferOutput<typeof SpellsSchema>

const VictorySchema = v.variant(
  'kind',
  [
    /** Every other shaman fallen. */
    v.strictObject({ kind: v.literal('conquest') }),
    /** The player's shaman still standing after this long. */
    v.strictObject({ kind: v.literal('survive'), seconds: between(1, 24 * 3600, 'survive.seconds') }),
    /** The player's tribe grown to this many. */
    v.strictObject({ kind: v.literal('population'), count: whole(1, MAX_FOLLOWERS, 'population.count') }),
  ],
  'victory.kind must be "conquest", "survive" or "population"',
)
export type VictorySpec = v.InferOutput<typeof VictorySchema>

const RulesSchema = v.strictObject({
  /** Any one of these wins. Losing your shaman always loses. Default: conquest. */
  victory: v.optional(v.pipe(v.array(VictorySchema), v.minLength(1, 'victory needs at least one condition'))),
  /** Spell unlocks for every tribe; a tribe's own `spells` override these. */
  spells: v.optional(SpellsSchema),
  /** How villages placed with `home: "auto"` are spread round the planet. */
  placement: v.optional(
    v.strictObject({
      /** Fewest radians between two homes. */
      apart: v.optional(between(0, Math.PI, 'placement.apart')),
      /** Every village on the first one's landmass (the largest). Default true. */
      walkable: v.optional(v.boolean()),
      /** Every village on a landmass of its own, the largest first: a world of islands. */
      separate: v.optional(v.boolean()),
    }),
  ),
})

// --- tribes -----------------------------------------------------------------

export const PERSONALITY_NAMES = ['steady', 'gentle', 'builder', 'raider', 'warlord'] as const
export type PersonalityName = (typeof PERSONALITY_NAMES)[number]

const PersonalityName = v.picklist(PERSONALITY_NAMES, `ai must be one of ${PERSONALITY_NAMES.join(', ')}`)

/** A personality by name, or one with some of its weights changed. */
export const AiSchema = v.union(
  [
    PersonalityName,
    v.strictObject({
      personality: v.optional(PersonalityName),
      thinkSeconds: v.optional(between(0.1, 30, 'ai.thinkSeconds')),
      hutCap: v.optional(whole(0, MAX_HUTS, 'ai.hutCap')),
      buildReach: v.optional(between(0.05, 2, 'ai.buildReach')),
      forageReach: v.optional(between(0.05, 3, 'ai.forageReach')),
      patch: v.optional(whole(0, MAX_FOLLOWERS, 'ai.patch')),
      muster: v.optional(whole(1, MAX_FOLLOWERS, 'ai.muster')),
      settle: v.optional(whole(0, MAX_FOLLOWERS, 'ai.settle')),
      bridges: v.optional(v.boolean()),
    }),
  ],
  `ai is a personality (${PERSONALITY_NAMES.join(', ')}) or { personality, …weights }`,
)
export type AiSpec = v.InferOutput<typeof AiSchema>

export const UNIT_ROLES = ['shaman', 'brave', 'warrior'] as const
export type UnitRole = (typeof UNIT_ROLES)[number]
export const UnitSchema = v.strictObject({
  role: v.picklist(UNIT_ROLES, 'a unit is a "shaman", "brave" or "warrior"'),
  at: Vec3Schema,
})
export type UnitSpec = v.InferOutput<typeof UnitSchema>

export const HUT_KINDS = ['dwelling', 'training'] as const
export type HutKindName = (typeof HUT_KINDS)[number]
export const HutSchema = v.strictObject({
  kind: v.picklist(HUT_KINDS, 'a hut is a "dwelling" or a "training" hut'),
  /** Where it stands. Left out: at the tribe's home, then round it. */
  at: v.optional(Vec3Schema),
  /** Which way its door faces. Left out: towards the nearest other village. */
  door: v.optional(Vec3Schema),
})
export type HutSpec = v.InferOutput<typeof HutSchema>

export const CONTROLS = ['player', 'ai', 'none'] as const
export const TribeSchema = v.strictObject({
  /** The colour slot, 0..3: blue, red, yellow, green. The player is tribe 0. */
  tribe: whole(0, MAX_TRIBES - 1, 'tribe'),
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
  control: v.picklist(CONTROLS, 'control is "player", "ai" or "none"'),
  ai: v.optional(AiSchema),
  /** A direction, or "auto" (the default): the flattest land far enough from the others. */
  home: v.optional(v.union([v.literal('auto'), Vec3Schema], 'home is "auto" or a direction [x, y, z]')),
  /** A shaman at the heart of the village. Default true. */
  shaman: v.optional(v.boolean()),
  /** Braves and warriors spread round home, after the shaman. */
  braves: v.optional(whole(0, MAX_FOLLOWERS, 'braves')),
  warriors: v.optional(whole(0, MAX_FOLLOWERS, 'warriors')),
  /** Each one where it stands, after those. */
  units: v.optional(v.array(UnitSchema)),
  huts: v.optional(v.array(HutSchema)),
  wood: v.optional(whole(0, 100000, 'wood')),
  mana: v.optional(between(0, 1000, 'mana')),
  spells: v.optional(SpellsSchema),
})
export type TribeSpec = v.InferOutput<typeof TribeSchema>

export const ScenarioSchema = v.strictObject({
  format: v.literal(SCENARIO_FORMAT, `format must be ${SCENARIO_FORMAT}`),
  id: v.pipe(
    v.string(),
    v.regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'id is lower-case letters, digits and dashes, at most 48'),
  ),
  name: v.pipe(v.string(), v.minLength(1, 'name cannot be empty'), v.maxLength(48)),
  description: v.optional(v.pipe(v.string(), v.maxLength(800))),
  author: v.optional(v.pipe(v.string(), v.maxLength(64))),
  /** The match seed: the scattered forest, and every random choice the core makes. */
  seed: whole(0, 0xffffffff, 'seed'),
  planet: PlanetSchema,
  trees: v.optional(TreesSchema),
  tribes: v.pipe(
    v.array(TribeSchema),
    v.minLength(1, 'a world needs at least one tribe'),
    v.maxLength(MAX_TRIBES, `a world has at most ${MAX_TRIBES} tribes`),
  ),
  rules: v.optional(RulesSchema),
})
export type Scenario = v.InferOutput<typeof ScenarioSchema>

// --- parsing ----------------------------------------------------------------

export class ScenarioError extends Error {
  /** Every problem found, each `path: what is wrong`. */
  readonly problems: readonly string[]
  constructor(problems: readonly string[], source = 'scenario') {
    super(`${source} is not a valid world:\n  ${problems.join('\n  ')}`)
    this.name = 'ScenarioError'
    this.problems = problems
  }
}

function pathOf(issue: v.BaseIssue<unknown>): string {
  let out = ''
  for (const item of issue.path ?? []) {
    const key = item.key as PropertyKey
    out += typeof key === 'number' ? `[${key}]` : out === '' ? String(key) : `.${String(key)}`
  }
  return out === '' ? '(top)' : out
}

/** The rules a schema cannot say. Empty when the scenario holds together. */
export function crossCheck(scenario: Scenario): string[] {
  const problems: string[] = []
  const slots = new Set<number>()
  let followers = 0
  let huts = 0
  scenario.tribes.forEach((tribe, i) => {
    const at = `tribes[${i}]`
    if (slots.has(tribe.tribe)) {
      problems.push(`${at}.tribe: tribe ${tribe.tribe} appears twice`)
    }
    slots.add(tribe.tribe)
    if (tribe.control === 'player' && tribe.tribe !== 0) {
      problems.push(`${at}.control: only tribe 0 can be the player's`)
    }
    const shamans = (tribe.shaman ?? true ? 1 : 0) + (tribe.units ?? []).filter((u) => u.role === 'shaman').length
    if (shamans > 1) {
      problems.push(`${at}: a tribe has one shaman, not ${shamans} (set "shaman": false to place her by hand)`)
    }
    followers += shamans + (tribe.braves ?? 0) + (tribe.warriors ?? 0) +
      (tribe.units ?? []).filter((u) => u.role !== 'shaman').length
    huts += (tribe.huts ?? []).length
  })
  if (followers > MAX_FOLLOWERS) {
    problems.push(`tribes: ${followers} followers is more than the core holds (${MAX_FOLLOWERS})`)
  }
  if (huts > MAX_HUTS) {
    problems.push(`tribes: ${huts} huts is more than the core holds (${MAX_HUTS})`)
  }
  const trees = (scenario.trees?.scatter ?? 0) + (scenario.trees?.at?.length ?? 0)
  if (trees > MAX_TREES) {
    problems.push(`trees: ${trees} trees is more than the core holds (${MAX_TREES})`)
  }
  const terrain = scenario.planet.terrain
  if (terrain.kind === 'heights') {
    const expected = nodeCountFor(scenario.planet.resolution)
    let heights: Float32Array | null = null
    try {
      heights = decodeHeightField(terrain.data)
    } catch {
      problems.push('planet.terrain.data: not base64')
    }
    if (heights && heights.length !== expected) {
      problems.push(
        `planet.terrain.data: ${heights.length} heights for a resolution-${scenario.planet.resolution} planet, which has ${expected} nodes`,
      )
    } else if (heights && heights.some((h) => !Number.isFinite(h) || h < 0)) {
      problems.push('planet.terrain.data: every height must be a number at or above sea level (0)')
    }
  }
  return problems
}

/**
 * Checks `input` — parsed JSON — against the format and returns it as a
 * Scenario. Throws a ScenarioError listing every problem, each with where it
 * is, when it is not one.
 */
export function parseScenario(input: unknown, source?: string): Scenario {
  const result = v.safeParse(ScenarioSchema, input)
  if (!result.success) {
    throw new ScenarioError(
      result.issues.map((issue) => `${pathOf(issue)}: ${issue.message}`),
      source,
    )
  }
  const problems = crossCheck(result.output)
  if (problems.length > 0) {
    throw new ScenarioError(problems, source)
  }
  return result.output
}

/** `parseScenario` over JSON text, with a JSON syntax error reported the same way. */
export function readScenario(text: string, source?: string): Scenario {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new ScenarioError([`(top): not JSON — ${(error as Error).message}`], source)
  }
  return parseScenario(json, source)
}

// --- the height field -------------------------------------------------------

/** One float32 per node as `f32-base64` text. */
export function encodeHeightField(heights: Float32Array): string {
  // A copy, so a view into the core's memory is read once and not held.
  return toBase64(new Float32Array(heights))
}

export function decodeHeightField(data: string): Float32Array {
  const bytes = fromBase64(data)
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('height field is not a whole number of float32s')
  }
  return new Float32Array(bytes)
}
