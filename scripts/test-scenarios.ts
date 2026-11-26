/**
 * Worlds as data, headless.
 *
 * The scenario format: every shipped world and the catalogue parse; a world
 * that is wrong is refused, saying where. Its canonical text reads back as
 * itself. Procedural ground: a seed and parameters are a world, the same
 * every time, with the land it asked for. The builder: every shipped world
 * goes up as its file says — tribes, homes, huts, spells, minds — and the
 * baked copy the editor works on is the same world to the state hash. The
 * editor: a world opened, edited every way the editor can, exported and
 * imported again comes back to the same text and the same world. Every
 * shipped world, played out with the core on every side, finishes. And the
 * campaign remembers what was won, whatever storage does.
 *
 * Run: npm run test:scenarios   (after npm run build:wasm)
 */
import { readdirSync } from 'node:fs'
import {
  addTribe,
  eraseNear,
  exportWorld,
  importWorld,
  placeHut,
  placeTree,
  placeUnit,
  regenerate,
  setGround,
  setSpell,
  setVictory,
  updateTribe,
} from '../src/editor/document.ts'
import type { Vec3 } from '../src/engine/math.ts'
import { createGame } from '../src/game/game.ts'
import { createPlanet } from '../src/game/planet.ts'
import { createTerrain } from '../src/game/terrain.ts'
import { createSimulation, HutKind, HutSite, Spell, type Simulation } from '../src/sim/simulation.ts'
import { roleOfFlags } from '../src/sim/role.ts'
import { buildWorld } from '../src/world/build.ts'
import {
  CAMPAIGN_KEY,
  loadProgress,
  nextWorld,
  parseCatalog,
  recordWin,
  sanitizeProgress,
  standings,
  worldAfter,
} from '../src/world/campaign.ts'
import { stringifyScenario } from '../src/world/format.ts'
import { matchOutcome } from '../src/world/match.ts'
import { aiWeights, PERSONALITIES } from '../src/world/personalities.ts'
import { nodeCountFor, parseScenario, readScenario, ScenarioError, type Scenario } from '../src/world/schema.ts'
import { skirmishWorld } from '../src/world/skirmish.ts'
import { shippedCatalog, shippedWorld, WORLDS_DIR } from './worlds.ts'

const failures: string[] = []
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`ok  ${name}${detail ? `  — ${detail}` : ''}`)
    return
  }
  const message = detail ? `${name} — ${detail}` : name
  failures.push(message)
  console.error(`FAIL ${message}`)
}

const angle = (a: readonly number[], b: readonly number[]) => {
  const d = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / Math.hypot(a[0]!, a[1]!, a[2]!) / Math.hypot(b[0]!, b[1]!, b[2]!)
  return Math.acos(Math.max(-1, Math.min(1, d)))
}

/** The problems a refusal lists, or null if it was not refused. */
function refusal(input: unknown): readonly string[] | null {
  try {
    parseScenario(input)
    return null
  } catch (error) {
    return error instanceof ScenarioError ? error.problems : [`not a ScenarioError: ${String(error)}`]
  }
}

const people = (sim: Simulation, tribe: number) => {
  const data = sim.followerInstances()
  const stride = sim.followerInstanceFloats
  const out: { id: number; role: number; shaman: boolean }[] = []
  for (let id = 0; id < sim.followerCount; id += 1) {
    if (data[id * stride + 6] === tribe) {
      out.push({ id, role: roleOfFlags(data[id * stride + 7]!), shaman: (data[id * stride + 7]! & 4) !== 0 })
    }
  }
  return out
}
const hutsOf = (sim: Simulation, tribe: number) =>
  Array.from({ length: sim.hutCount }, (_, id) => id).filter((id) => sim.hutTribe(id) === tribe)

const minimal = (): Record<string, unknown> => ({
  format: 1,
  id: 'tiny',
  name: 'Tiny',
  seed: 1,
  planet: { resolution: 8, terrain: { kind: 'flat', height: 0.02 } },
  tribes: [{ tribe: 0, control: 'player' }],
})

// --- the format ---------------------------------------------------------------

const catalog = shippedCatalog()
const ids = catalog.campaign.worlds.map((world) => world.id)
{
  check('the catalogue names a campaign of at least three worlds', ids.length >= 3, ids.join(', '))
  const files = readdirSync(WORLDS_DIR).filter((name) => name.endsWith('.json') && name !== 'index.json')
  check('and every world file beside it is in it, and every one in it is a file',
    files.length === ids.length && ids.every((id) => files.includes(`${id}.json`)), files.join(', '))
  for (const id of ids) {
    const world = shippedWorld(id)
    check(`worlds/${id}.json parses, under its own id`, world.id === id && world.name.length > 0, world.name)
  }
  check('a catalogue listing a world twice is refused', (() => {
    try {
      parseCatalog({ format: 1, campaign: { name: 'x', worlds: [{ id: 'a', teaches: '' }, { id: 'a', teaches: '' }] } })
      return false
    } catch {
      return true
    }
  })())
}

{
  check('a minimal world is a world', refusal(minimal()) === null)
  const cases: [string, (doc: Record<string, unknown>) => void, RegExp][] = [
    ['a misspelt field', (d) => ((d.tribes as Record<string, unknown>[])[0]!.brave = 3), /tribes\[0\]/],
    ['an unknown format', (d) => (d.format = 2), /format/],
    ['an id with capitals', (d) => (d.id = 'Tiny World'), /^id/],
    ['no tribes', (d) => (d.tribes = []), /at least one tribe/],
    ['five tribes', (d) => (d.tribes = [0, 1, 2, 3, 3].map((t) => ({ tribe: t, control: 'ai' }))), /at most 4/],
    ['a tribe twice', (d) => (d.tribes = [{ tribe: 0, control: 'player' }, { tribe: 0, control: 'ai' }]), /tribes\[1\]\.tribe: tribe 0 appears twice/],
    ['the player as tribe 2', (d) => (d.tribes = [{ tribe: 2, control: 'player' }]), /only tribe 0/],
    ['two shamans', (d) => (d.tribes = [{ tribe: 0, control: 'player', units: [{ role: 'shaman', at: [0, 0, 1] }] }]), /one shaman/],
    ['a direction of zeros', (d) => (d.tribes = [{ tribe: 0, control: 'player', home: [0, 0, 0] }]), /tribes\[0\]\.home/],
    ['land above 1', (d) => (d.planet = { resolution: 8, terrain: { kind: 'generated', seed: 1, land: 1.5 } }), /land must be at most 1/],
    ['an unknown terrain', (d) => (d.planet = { resolution: 8, terrain: { kind: 'lava' } }), /terrain\.kind/],
    ['a height field the wrong length', (d) => (d.planet = { resolution: 8, terrain: { kind: 'heights', encoding: 'f32-base64', data: 'AAAAAAAAAAA=' } }), /2 heights for a resolution-8 planet, which has 386 nodes/],
    ['an unlock nobody understands', (d) => (d.rules = { spells: { blast: 'soon' } }), /rules\.spells\.blast/],
    ['an unknown personality', (d) => (d.tribes = [{ tribe: 0, control: 'player' }, { tribe: 1, control: 'ai', ai: 'sneaky' }]), /tribes\[1\]\.ai/],
    ['more trees than the core holds', (d) => (d.trees = { scatter: 600 }), /trees\.scatter/],
  ]
  for (const [what, spoil, expect] of cases) {
    const doc = structuredClone(minimal())
    spoil(doc)
    const problems = refusal(doc)
    check(`refused: ${what}, saying where`, problems !== null && problems.some((p) => expect.test(p)), problems?.join(' | ') ?? 'accepted')
  }
  check('JSON that is not JSON is refused as such', (() => {
    try {
      readScenario('{ "format": 1,', 'broken.json')
      return false
    } catch (error) {
      return error instanceof ScenarioError && /not JSON/.test(error.message) && /broken\.json/.test(error.message)
    }
  })())
  check('the resolution-24 planet has the nodes the format says', nodeCountFor(24) === 3458)
}

{
  for (const id of ids) {
    const world = shippedWorld(id)
    const text = stringifyScenario(world)
    const again = readScenario(text)
    check(`worlds/${id}.json reads back from its canonical text as itself`,
      JSON.stringify(again) === JSON.stringify(world) && stringifyScenario(again) === text)
  }
  // The same world built in another order is written the same way.
  const shuffled = { tribes: [{ control: 'player', tribe: 0 }], seed: 1, planet: { terrain: { height: 0.02, kind: 'flat' }, resolution: 8 }, name: 'Tiny', id: 'tiny', format: 1 }
  check('field order does not change the text', stringifyScenario(parseScenario(shuffled)) === stringifyScenario(parseScenario(minimal())))
}

// --- procedural ground ----------------------------------------------------------

async function groundOf(params: Parameters<Simulation['generateTerrain']>[0]): Promise<{ sim: Simulation; heights: Float32Array; land: number }> {
  const sim = await createSimulation()
  const planet = createPlanet({ resolution: 24, terrain: 'flat' })
  createTerrain(planet, sim, { generate: params })
  const heights = new Float32Array(sim.navHeights())
  return { sim, heights, land: heights.filter((h) => h > 0).length }
}

{
  const params = { seed: 77, land: 0.37, continents: 2 }
  const a = await groundOf(params)
  const b = await groundOf(params)
  check('a seed and parameters are a world: the same twice, to the bit', a.heights.every((h, i) => h === b.heights[i]))
  const other = await groundOf({ ...params, seed: 78 })
  check('another seed is another world', other.heights.some((h, i) => h !== a.heights[i]))
  check('with the land it asked for, to a node', Math.abs(a.land - Math.round(0.37 * 3458)) <= 1, `${a.land} of 3458`)
  check('water is exactly sea level, land under the ceiling',
    a.heights.every((h) => h === 0 || (h > 0 && h <= 0.06 + 1e-7)))
  const before = a.sim.matchSeed
  a.sim.seedMatch(5)
  a.sim.generateTerrain(params)
  check('generating draws nothing from the match', a.sim.matchSeed === 5 && before !== undefined)

  const first = stringifyScenario(skirmishWorld(4242))
  check('a random world is its seed: the same file twice', first === stringifyScenario(skirmishWorld(4242)))
  check('and another seed another file', first !== stringifyScenario(skirmishWorld(4243)))
  const sim = await createSimulation()
  const random = buildWorld(sim, skirmishWorld(4242))
  check('and it builds, every rival placed', random.tribes.every((t) => t.home !== null) && random.tribes.length >= 2,
    `${random.tribes.length} tribes, ${random.problems.length} problems`)
}

// --- the builder ------------------------------------------------------------------

const UNLOCK = { landBridge: Spell.landBridge, blast: Spell.blast, flatten: Spell.flatten, swamp: Spell.swamp } as const

for (const id of ids) {
  const scenario = shippedWorld(id)
  const sim = await createSimulation()
  const world = buildWorld(sim, scenario)
  check(`${id}: builds with nothing refused`, world.problems.length === 0, world.problems.join('; '))
  for (const spec of scenario.tribes) {
    const wanted = ((spec.shaman ?? true) ? 1 : 0) + (spec.braves ?? 0) + (spec.warriors ?? 0) + (spec.units?.length ?? 0)
    const got = people(sim, spec.tribe)
    check(`${id}: ${spec.name} has its ${wanted} people, its shaman, ${spec.huts?.length ?? 0} huts and ${spec.wood ?? 0} wood`,
      got.length === wanted && got.filter((p) => p.shaman).length === 1 &&
        hutsOf(sim, spec.tribe).length === (spec.huts?.length ?? 0) && sim.wood(spec.tribe) === (spec.wood ?? 0),
      `${got.length} people, ${hutsOf(sim, spec.tribe).length} huts`)
    for (const key of ['landBridge', 'blast', 'flatten', 'swamp'] as const) {
      const unlock = spec.spells?.[key] ?? scenario.rules?.spells?.[key] ?? 'now'
      const expected = unlock === 'now' ? 0 : unlock === 'never' ? -1 : unlock
      if (sim.spellUnlockAt(spec.tribe, UNLOCK[key]) !== expected) {
        check(`${id}: ${spec.name}'s ${key} unlocks as the file says`, false, `${sim.spellUnlockAt(spec.tribe, UNLOCK[key])} vs ${expected}`)
      }
    }
    const isAi = spec.control === 'ai'
    check(`${id}: ${spec.name} is ${isAi ? `played by the core, as a ${typeof spec.ai === 'string' ? spec.ai : 'steady'}` : 'left to the player'}`,
      sim.aiEnabled(spec.tribe) === isAi &&
        (!isAi || JSON.stringify(sim.aiWeights(spec.tribe)) === JSON.stringify(aiWeights(spec.ai))))
  }
  const homes = world.tribes.map((t) => t.home!)
  const apart = scenario.rules?.placement?.apart ?? 1.2
  const separate = scenario.rules?.placement?.separate ?? false
  check(`${id}: villages at least ${apart} rad apart`, homes.every((a, i) => homes.every((b, j) => i === j || angle(a, b) >= apart - 1e-9)))
  // Walking between villages: from the player's shaman to each rival's.
  const at = (tribe: number): Vec3 => {
    const data = sim.followerInstances()
    const b = sim.shamanId(tribe) * sim.followerInstanceFloats
    return [data[b]!, data[b + 1]!, data[b + 2]!]
  }
  const routes = world.tribes.slice(1).map((t) => sim.module._core_nav_route(...at(0), ...at(t.tribe), 0) >= 0)
  check(`${id}: ${separate ? 'every village on its own landmass, so only a bridge joins them' : 'every village can be walked to'}`,
    separate ? routes.every((r) => !r) : routes.every(Boolean), routes.join(','))
}

check('every personality is the eight weights the core takes', Object.values(PERSONALITIES).every((w) => Object.keys(w).length === 8))

// --- baked is the same world ----------------------------------------------------------

for (const id of ids) {
  const scenario = shippedWorld(id)
  const original = await createSimulation()
  const world = buildWorld(original, scenario)
  const baked = await createSimulation()
  const again = buildWorld(baked, world.baked)
  check(`${id}: baked, every person, hut and tree written in, it is the same world — to the state hash`,
    original.stateHash() === baked.stateHash() && original.followerCount === baked.followerCount &&
      original.treeCount === baked.treeCount && original.hutCount === baked.hutCount,
    `${original.stateHash().toString(16)} vs ${baked.stateHash().toString(16)}`)
  check(`${id}: and baking it again changes nothing`, exportWorld(again.baked) === exportWorld(world.baked))
}

// --- the editor round trip ------------------------------------------------------------

{
  const id = ids[1]!
  const sim = await createSimulation()
  const game = createGame(sim, { scenario: shippedWorld(id), mode: 'edit' })
  check('the editor\'s world stands still: nobody on the AI', game.world.tribes.every((t) => !sim.aiEnabled(t.tribe)))
  let doc: Scenario = game.world.baked
  const home = game.world.tribes[0]!.home!
  const node = (direction: Vec3): Vec3 => {
    const n = sim.nearestWalkableNode(direction)
    const d = game.terrain.graph.directions
    return [d[n * 3]!, d[n * 3 + 1]!, d[n * 3 + 2]!]
  }
  const near = (distance: number, turn: number): Vec3 => {
    const t = Math.abs(home[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const e1 = [t[0]! - home[0] * (t[0]! * home[0] + t[1]! * home[1] + t[2]! * home[2]), 0, 0] as number[]
    e1[1] = t[1]! - home[1] * (t[0]! * home[0] + t[1]! * home[1] + t[2]! * home[2])
    e1[2] = t[2]! - home[2] * (t[0]! * home[0] + t[1]! * home[1] + t[2]! * home[2])
    const l = Math.hypot(...e1)
    const e2 = [home[1] * e1[2]! - home[2] * e1[1]!, home[2] * e1[0]! - home[0] * e1[2]!, home[0] * e1[1]! - home[1] * e1[0]!].map((x) => x / l)
    const dir = [0, 1, 2].map((k) => home[k]! * Math.cos(distance) + (e1[k]! / l * Math.cos(turn) + e2[k]! * Math.sin(turn)) * Math.sin(distance))
    return node(dir as Vec3)
  }
  const edits: [string, (d: Scenario) => Scenario][] = [
    ['a brave placed', (d) => placeUnit(d, 0, 'brave', near(0.12, 0.3))],
    ['a warrior placed', (d) => placeUnit(d, 0, 'warrior', near(0.14, 1.2))],
    ['the shaman moved', (d) => placeUnit(d, 0, 'shaman', near(0.1, 2.5))],
    ['a hut built', (d) => {
      // Where the editor would show a green ghost: ground a pad can be levelled on.
      const site = [0.25, 0.3, 0.35, 0.4]
        .flatMap((distance) => Array.from({ length: 12 }, (_, k) => near(distance, k * 0.5)))
        .find((at) => [HutSite.ok, HutSite.uneven].includes(sim.hutSite(at, HutKind.training, 0).site as 0 | 3) &&
          sim.terrainHeightAt(at) > 0)
      return placeHut(d, 0, 'training', site!, [0, 1, 0])
    }],
    ['a tree planted', (d) => placeTree(d, near(0.2, 5.0))],
    ['the nearest thing erased', (d) => eraseNear(d, near(0.12, 0.3), 0.05).doc],
    ['a third tribe added and given a shaman', (d) => {
      const added = addTribe(d)!
      return placeUnit(updateTribe(added, 2, { name: 'Gullwings', ai: 'raider' }), 2, 'shaman', near(0.5, 1))
    }],
    ['a spell held back', (d) => setSpell(d, 'swamp', 30)],
    ['another way to win', (d) => setVictory(d, 900, 0)],
  ]
  for (const [what, edit] of edits) {
    const next = edit(doc)
    game.rebuild(next)
    doc = next
    check(`editor: ${what}`, game.world.problems.length === 0, game.world.problems.join('; '))
  }
  // Sculpting: the stroke lands in the core, and its end saves the ground exactly.
  sim.sculptTerrain(near(0.35, 3), 0.12, 0.01)
  doc = setGround(doc, sim.navHeights())
  game.rebuild(doc)
  check('editor: the ground sculpted and saved as exact heights', doc.planet.terrain.kind === 'heights' && game.world.problems.length === 0)
  const live = sim.stateHash()

  const first = exportWorld(doc)
  const reread = importWorld(first, 'export.json')
  const second = exportWorld(reread)
  check('editor: export, import and export again is the same file, to the byte', first === second, `${first.length} bytes`)
  const fresh = await createSimulation()
  buildWorld(fresh, reread, { mode: 'edit' })
  check('editor: and the file builds the world the editor showed, to the state hash',
    fresh.stateHash() === live, `${fresh.stateHash().toString(16)} vs ${live.toString(16)}`)
  const played = await createSimulation()
  const asPlayed = buildWorld(played, reread)
  check('editor: and plays: the rivals on the AI, the new tribe a raider',
    asPlayed.tribes.length === 3 && played.aiEnabled(1) && played.aiEnabled(2) && !played.aiEnabled(0) &&
      played.aiWeights(2).muster === PERSONALITIES.raider.muster && played.spellUnlockAt(0, Spell.swamp) === 30)
  // Back to generated ground.
  const terrain = shippedWorld(id).planet.terrain
  if (terrain.kind === 'generated') {
    const { kind: _kind, ...params } = terrain
    const regenerated = regenerate(doc, { ...params, seed: params.seed + 1 })
    game.rebuild(regenerated)
    check('editor: generating new ground keeps everything on it', regenerated.planet.terrain.kind === 'generated' &&
      sim.followerCount > 0 && exportWorld(importWorld(exportWorld(regenerated))) === exportWorld(regenerated))
  }
}

// --- every world finishes -------------------------------------------------------------

const LIMIT_MINUTES = 40
for (const id of ids) {
  const sim = await createSimulation()
  const game = createGame(sim, { scenario: shippedWorld(id), allAi: true })
  const limit = LIMIT_MINUTES * 60 * 1000
  while (sim.elapsedMs < limit && game.match.outcome === 'playing') {
    sim.runSteps(20)
  }
  check(`${id}: played out with the core on every side, it finishes`, game.match.outcome !== 'playing',
    `${game.match.outcome} after ${(sim.elapsedMs / 60000).toFixed(1)} min`)
}

// --- the match's rules ------------------------------------------------------------------

{
  const reads = (over: Partial<Parameters<typeof matchOutcome>[0]>) => ({
    matchOver: false, matchWinner: -1, elapsedMs: 0, population: () => 5, shamanFallen: () => false, ...over,
  })
  check('rules: nothing decided is still playing', matchOutcome(reads({}), 0) === 'playing')
  check('rules: the player\'s shaman fallen is lost, even with two rivals fighting on',
    matchOutcome(reads({ shamanFallen: (t: number) => t === 0 }), 0) === 'lost')
  check('rules: the last shaman standing wins', matchOutcome(reads({ matchOver: true, matchWinner: 0 }), 0) === 'won')
  check('rules: holding out wins only once the time is up',
    matchOutcome(reads({ elapsedMs: 599_000 }), 0, [{ kind: 'survive', seconds: 600 }]) === 'playing' &&
      matchOutcome(reads({ elapsedMs: 600_000 }), 0, [{ kind: 'survive', seconds: 600 }]) === 'won')
  check('rules: growing wins at the count', matchOutcome(reads({ population: () => 50 }), 0, [{ kind: 'population', count: 50 }]) === 'won')
}

// --- the campaign remembers ---------------------------------------------------------------

{
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  const progress = loadProgress(catalog, storage)
  check('campaign: a first visit starts at the first world, the rest locked',
    nextWorld(catalog, progress) === ids[0] && standings(catalog, progress).filter((w) => w.open).length === 1)
  const won = recordWin(catalog, progress, ids[0]!, storage)
  check('campaign: a win opens the next and is kept', nextWorld(catalog, won) === ids[1] &&
    nextWorld(catalog, loadProgress(catalog, storage)) === ids[1] && JSON.parse(store.get(CAMPAIGN_KEY)!).won[0] === ids[0])
  check('campaign: the world after each, and none after the last',
    worldAfter(catalog, ids[0]!) === ids[1] && worldAfter(catalog, ids[ids.length - 1]!) === null)
  store.set(CAMPAIGN_KEY, '{"won": ["ember-shoal", 7, "no-such-world", null]')
  check('campaign: storage holding nonsense is a fresh start, not a crash', loadProgress(catalog, storage).won.length === 0)
  check('campaign: unknown ids are dropped, known ones kept', sanitizeProgress({ won: [ids[1], 'nope', 3] }, catalog).won.join() === ids[1])
  const hostile = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  check('campaign: storage that throws plays from the start and still counts a win',
    loadProgress(catalog, hostile).won.length === 0 && recordWin(catalog, { won: [] }, ids[0]!, hostile).won[0] === ids[0])
  const all = ids.reduce((p, id) => recordWin(catalog, p, id, storage), { won: [] as readonly string[] })
  check('campaign: with every world won, the last is where it opens', nextWorld(catalog, all) === ids[ids.length - 1])
}

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED`)
  process.exit(1)
}
console.log('\nall scenario checks passed')
