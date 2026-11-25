/**
 * Determinism: the same seed and the same commands, on the same steps, give
 * the same match.
 *
 * The opening match, with the core's AI playing both tribes and a few player
 * orders on top, is played for 10,000 steps (over eight minutes of game) on
 * ragged frame times, recording every command with its step. Then:
 *
 * - the recording, replayed twice on fresh cores in exact steps, ends on the
 *   same state hash and agrees at every checkpoint on the way;
 * - another seed, or one order nudged, does not — and the checkpoints say
 *   roughly when it parted;
 * - the replay survives its text form;
 * - the checked-in recording (scripts/replays/opening.replay.json.gz) still
 *   plays to the hash it was recorded with. That one is the regression
 *   oracle: any change to what the simulation does moves it. When the change
 *   is meant, re-record it with `npm run test:replay -- --record` and commit
 *   the new file with the change that moved it.
 * - nothing on the TypeScript side of the simulation calls Math.random.
 *
 * Run it against the debug core too, to hold release and debug builds to the
 * same numbers:  CORE_WASM_DIR=cpp/build-wasm-debug/out npm run test:replay
 *
 * `npm run test:replay -- some.replay.json` plays a saved replay (from
 * `__1inkulous.saveReplay()` in the browser console) and says whether it holds.
 *
 * Run: npm run test:replay   (after npm run build:wasm)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createGame } from '../src/game/game.ts'
import { ENEMY_TRIBE } from '../src/game/scenario.ts'
import { PLAYER_TRIBE } from '../src/game/shaman.ts'
import { createSimulationHandle } from '../src/sim/handle.ts'
import {
  decodeReplay,
  encodeReplay,
  playReplay,
  type Replay,
  type StampedCommand,
} from '../src/sim/replay.ts'
import { createSimulation, type Simulation } from '../src/sim/simulation.ts'

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

const hex = (hash: number) => hash.toString(16).padStart(8, '0')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = join(ROOT, 'scripts/replays/opening.replay.json.gz')
const MATCH_STEPS = 10_000
const MATCH_SEED = 1

// Frame times a real display might hand the clock: vsync at 60 and 144, a
// hitch, a long frame. A fixed cycle, so the recording is the same each run.
const FRAMES = [16.7, 6.9, 6.9, 33.4, 7.1, 41, 12.5, 6.9, 250, 25, 3.1, 16.6]

const membersOf = (sim: Simulation, tribe: number): number[] => {
  const stride = sim.followerInstanceFloats
  const data = sim.followerInstances()
  const out: number[] = []
  for (let id = 0; id < sim.followerCount; id += 1) {
    if (data[id * stride + 6] === tribe) out.push(id)
  }
  return out
}

type Recorded = {
  replay: Replay
  live: Simulation
  seconds: number
  /** Planned step → the step the command was actually given on: the end of that frame. */
  given: Map<number, number>
}

/**
 * The opening match on a recording handle: both tribes to the AI, and the
 * player's hand on it now and then, the way a person would — select some,
 * send them, sculpt, change their mind.
 */
async function recordMatch(seed: number, nudge = 0): Promise<Recorded> {
  const core = await createSimulation()
  const handle = createSimulationHandle(core)
  const sim = handle.simulation
  const game = createGame(sim, { seed })
  sim.enableAi(PLAYER_TRIBE)
  const home = game.match.playerHome ?? [0, 0, 1]
  const enemyHome = game.match.enemyHome ?? [0, 0, -1]

  // Step → what the player does then.
  const plan = new Map<number, () => void>([
    [40, () => {
      sim.clearFollowerSelection()
      for (const id of membersOf(sim, PLAYER_TRIBE).slice(1, 5)) sim.setFollowerSelected(id, true)
      sim.orderFollowerMove([home[0] + 0.12 + nudge, home[1] - 0.05, home[2]])
    }],
    [700, () => sim.sculptTerrain([home[0] - 0.1, home[1] + 0.08, home[2]], 0.06, 0.004)],
    [1500, () => {
      for (const id of membersOf(sim, PLAYER_TRIBE).slice(0, 8)) sim.setFollowerSelected(id, true)
      sim.orderFollowerMove(enemyHome)
    }],
    [1520, () => sim.clearFollowerSelection()],
    [4000, () => sim.setWood(ENEMY_TRIBE, sim.wood(ENEMY_TRIBE) + 20)],
  ])

  // As in the game: input is handled after the frame's tick, so a command
  // lands on whatever step the frame ended on.
  const given = new Map<number, number>()
  const started = performance.now()
  let frame = 0
  while (sim.stepCount < MATCH_STEPS) {
    const owed = MATCH_STEPS - sim.stepCount
    // The last frames in whole steps, so the recording stops exactly on MATCH_STEPS.
    const ms = owed * sim.stepMs <= 250 ? sim.stepMs : FRAMES[frame++ % FRAMES.length]
    const before = sim.stepCount
    sim.tick(ms)
    for (let step = before + 1; step <= sim.stepCount; step += 1) {
      const action = plan.get(step)
      if (action) {
        action()
        given.set(step, sim.stepCount)
      }
    }
  }
  const seconds = (performance.now() - started) / 1000
  return { replay: await handle.exportReplay(), live: core, seconds, given }
}

async function replayOnFreshCore(replay: Replay) {
  const core = await createSimulation({ stepMs: replay.stepMs })
  const started = performance.now()
  const result = playReplay(core, replay)
  return { ...result, seconds: (performance.now() - started) / 1000, core }
}

// --- a saved replay, from the command line ------------------------------------

const args = process.argv.slice(2)
const files = args.filter((arg) => !arg.startsWith('--'))
if (files.length > 0) {
  for (const file of files) {
    const bytes = readFileSync(file)
    const replay = decodeReplay((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))
    const played = await replayOnFreshCore(replay)
    check(`${file}: replays to its recorded hash`, played.matches,
      `seed ${replay.seed}, ${replay.commands.length} commands, step ${played.final.step}: ` +
        `${hex(played.final.hash)} vs ${hex(replay.final.hash)}` +
        (played.divergedAt ? `, first apart at the checkpoint on step ${played.divergedAt.step}` : '') +
        (played.sameCore ? '' : ` (recorded on core ${replay.coreVersion})`))
  }
  finish()
}

// --- no Math.random on the TypeScript side of the simulation --------------------

{
  const sources = ['src/sim', 'src/game'].flatMap((dir) => walk(join(ROOT, dir)))
  const offenders = sources.filter((file) =>
    /\bMath\s*\.\s*random\b/.test(
      readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
    ),
  )
  check('no Math.random in src/sim or src/game: chance comes from the match seed', offenders.length === 0,
    offenders.length > 0 ? offenders.join(', ') : `${sources.length} files`)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
  })
}

// --- record, then replay ------------------------------------------------------

console.log(`\n--- the opening match, ${MATCH_STEPS} steps, both tribes on the AI`)
const recorded = await recordMatch(MATCH_SEED)
const { replay, live, given } = recorded
const at = (planned: number) => given.get(planned) ?? -1
console.log(`    recorded in ${recorded.seconds.toFixed(1)}s: ${replay.commands.length} commands, ` +
  `${replay.checkpoints.length} checkpoints, final ${hex(replay.final.hash)}` +
  (live.matchOver ? `, match over (winner ${live.matchWinner})` : ', match still on') +
  `, ${live.followerCount} followers, ${live.hutCount} huts, ${live.treeCount} trees`)

check('the recording ran the steps asked for, on ragged frames', replay.final.step === MATCH_STEPS)
check('and the AI played both sides', live.aiActions(PLAYER_TRIBE) > 0 && live.aiActions(ENEMY_TRIBE) > 0,
  `${live.aiActions(PLAYER_TRIBE)} and ${live.aiActions(ENEMY_TRIBE)} actions`)
check('every command carries its step, in order, and the seed comes first',
  replay.commands[0]?.op === 'seedMatch' && replay.seed === MATCH_SEED &&
  replay.commands.every((c, i) => Number.isInteger(c.step) && (i === 0 || c.step >= replay.commands[i - 1].step)))
check('player orders were stamped on the steps they were given, not the frames',
  replay.commands.some((c) => c.op === 'orderFollowerMove' && c.step === at(40)) &&
  replay.commands.some((c) => c.op === 'orderFollowerMove' && c.step === at(1500)) &&
  replay.commands.some((c) => c.op === 'sculptTerrain' && c.step === at(700)),
  `on steps ${[40, 700, 1500].map(at).join(', ')}`)
check('a checkpoint every ' + live.checkpointEvery + ' steps',
  replay.checkpoints.length === MATCH_STEPS / live.checkpointEvery &&
  replay.checkpoints.every((c, i) => c.step === (i + 1) * live.checkpointEvery))
check('the hash moves as the match does', new Set(replay.checkpoints.map((c) => c.hash)).size === replay.checkpoints.length)

const first = await replayOnFreshCore(replay)
check('replayed on a fresh core: the same hash after 10k steps', first.matches,
  `${hex(first.final.hash)} vs ${hex(replay.final.hash)} in ${first.seconds.toFixed(1)}s`)
const second = await replayOnFreshCore(replay)
check('and again, twice in a row', second.matches && second.final.hash === first.final.hash, hex(second.final.hash))
check('the replays agree with the live match on what they can see',
  second.core.followerCount === live.followerCount && second.core.hutCount === live.hutCount &&
  second.core.treeCount === live.treeCount && second.core.wood(ENEMY_TRIBE) === live.wood(ENEMY_TRIBE) &&
  second.core.mana(PLAYER_TRIBE) === live.mana(PLAYER_TRIBE))

const text = encodeReplay(replay)
const roundTrip = await replayOnFreshCore(decodeReplay(text))
check('the replay survives its text form', roundTrip.matches, `${(text.length / 1024).toFixed(0)} KB`)

// --- what the hash catches ----------------------------------------------------

console.log('\n--- departures')
const reseeded = await replayOnFreshCore({
  ...replay,
  commands: replay.commands.map((c): StampedCommand => (c.op === 'seedMatch' ? { ...c, args: [MATCH_SEED + 1] } : c)),
})
check('another seed is another match', !reseeded.matches && reseeded.divergedAt?.step === live.checkpointEvery,
  `apart from the first checkpoint, step ${reseeded.divergedAt?.step}`)

const nudged = await replayOnFreshCore({
  ...replay,
  commands: replay.commands.map((c): StampedCommand =>
    // A spacing's width: small, but past where the order snaps the click to.
    c.op === 'orderFollowerMove' && c.step === at(40)
      ? { ...c, args: [[c.args[0][0] + 0.024, c.args[0][1], c.args[0][2]]] }
      : c),
})
check('an order a little to one side is caught, at the first checkpoint after it',
  !nudged.matches && nudged.divergedAt !== null && nudged.divergedAt.step === live.checkpointEvery,
  `first apart at step ${nudged.divergedAt?.step}`)

const late = await replayOnFreshCore({
  ...replay,
  commands: replay.commands.map((c): StampedCommand =>
    c.op === 'orderFollowerMove' && c.step === at(1500) ? { ...c, step: c.step + 1 } : c),
})
check('and so is the same order one step late',
  !late.matches && late.divergedAt?.step === Math.ceil((at(1500) + 1) / live.checkpointEvery) * live.checkpointEvery,
  `first apart at step ${late.divergedAt?.step}`)

// --- the recorded match -------------------------------------------------------

console.log('\n--- the checked-in recording')
if (args.includes('--record')) {
  writeFileSync(FIXTURE, gzipSync(Buffer.from(text, 'utf8'), { level: 9 }))
  console.log(`    re-recorded ${FIXTURE} (${(statSync(FIXTURE).size / 1024).toFixed(0)} KB), ` +
    `core ${replay.coreVersion}, final ${hex(replay.final.hash)}`)
}
{
  const fixture = decodeReplay(gunzipSync(readFileSync(FIXTURE)).toString('utf8'))
  const played = await replayOnFreshCore(fixture)
  check(`it plays to the hash it was recorded with (core ${fixture.coreVersion}, step ${fixture.final.step})`,
    played.matches,
    `${hex(played.final.hash)} vs ${hex(fixture.final.hash)}` +
      (played.divergedAt ? `; first apart at the checkpoint on step ${played.divergedAt.step}` : '') +
      (played.matches
        ? ''
        : '. The simulation now does something else. If that is meant, re-record with ' +
          '`npm run test:replay -- --record` and commit the new file.'))
  check('and it is the match this script records', fixture.final.hash === replay.final.hash,
    `${hex(fixture.final.hash)} vs ${hex(replay.final.hash)}`)
}

finish()

function finish(): never {
  if (failures.length > 0) {
    console.error(`\n${failures.length} replay check(s) failed`)
    process.exit(1)
  }
  console.log('\nall replay checks passed')
  process.exit(0)
}
