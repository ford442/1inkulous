import { applyCommand, type Command, type CommandOp } from './protocol'
import type { Simulation } from './simulation'

/**
 * Matches as data: the command log, stamped with steps, and the replays built
 * from it.
 *
 * The core is deterministic: the same seed and the same commands, each landing
 * between the same two steps, give the same state hash after every step. So a
 * match is fully described by `{ seed, version, commands }`, every command
 * stamped with the step count it was applied at — applied after that many
 * steps and before the next. Frame times never enter it: replaying runs exact
 * steps (`runSteps`), so it does not matter how the original frames fell.
 *
 * The log is recorded wherever commands enter the core: by the handle while
 * the core is in-process (src/sim/handle.ts), and by the host once it is on a
 * worker (src/sim/host.ts), which is also where lockstep will take its turns.
 */

/** Bumped when the shape below changes; old replays are then refused. */
export const REPLAY_FORMAT = 1

/** A command and the step count it was applied at. */
export type StampedCommand = Command & { readonly step: number }

/** The core's state hash as step `step` ended. */
export type Checkpoint = { readonly step: number; readonly hash: number }

export type Replay = {
  readonly format: typeof REPLAY_FORMAT
  /** The core that recorded it, e.g. "0.11.0". Another core may well disagree. */
  readonly coreVersion: string
  /** What the match was seeded with; the seeding itself is in `commands`. */
  readonly seed: number
  readonly stepMs: number
  readonly commands: readonly StampedCommand[]
  /** The core's checkpoints as recorded, oldest first. */
  readonly checkpoints: readonly Checkpoint[]
  /** Where the recording stopped, and the state hash there. */
  readonly final: Checkpoint
}

/**
 * Not part of a match. A tick is wall time — the step stamps already say how
 * many steps ran — and taking the terrain's dirty range is the mesh's
 * bookkeeping, done every frame.
 */
const UNRECORDED: ReadonlySet<CommandOp> = new Set<CommandOp>(['tick', 'takeTerrainDirty'])

export const isRecorded = (op: CommandOp): boolean => !UNRECORDED.has(op)

/** What a recorder needs of the core: which step it is on. */
type Clock = { readonly stepCount: number }

export type CommandRecorder = {
  readonly commands: readonly StampedCommand[]
  /** Stamps `command` with the clock's step and keeps a copy, if it is part of a match. */
  record: (command: Command) => void
}

/** A log that carries on from `initial`, which must already be stamped. */
export function createRecorder(clock: Clock, initial: readonly StampedCommand[] = []): CommandRecorder {
  const commands: StampedCommand[] = [...initial]
  return {
    commands,
    record(command) {
      if (!isRecorded(command.op)) {
        return
      }
      // A copy: the caller may reuse its vectors.
      commands.push({ op: command.op, args: structuredClone(command.args), step: clock.stepCount } as StampedCommand)
    },
  }
}

/**
 * Runs `simulation` forward to `step` in exact steps. A step already passed is
 * an error: the log is out of order, or it was played onto the wrong core.
 */
export function advanceTo(simulation: Simulation, step: number): void {
  const owed = step - simulation.stepCount
  if (owed < 0) {
    throw new Error(`A command stamped step ${step} reached a core already at step ${simulation.stepCount}.`)
  }
  if (owed > 0) {
    simulation.runSteps(owed)
  }
}

/** Plays a stamped log onto a fresh core: each command after exactly its steps. */
export function playCommands(simulation: Simulation, commands: readonly StampedCommand[]): void {
  for (const command of commands) {
    advanceTo(simulation, command.step)
    applyCommand(simulation, command)
  }
}

/** The match so far on `simulation`, from the log that built it. */
export function exportReplay(simulation: Simulation, commands: readonly StampedCommand[]): Replay {
  return {
    format: REPLAY_FORMAT,
    coreVersion: simulation.version,
    seed: simulation.matchSeed,
    stepMs: simulation.stepMs,
    commands: [...commands],
    checkpoints: simulation.checkpoints(),
    final: { step: simulation.stepCount, hash: simulation.stateHash() },
  }
}

export type ReplayResult = {
  /** Where the replay ended and the hash there; `final` of a faithful replay. */
  readonly final: Checkpoint
  /** True when every checkpoint and the final hash agree with the recording. */
  readonly matches: boolean
  /** The first recorded checkpoint this run disagreed with, if any: roughly when it parted. */
  readonly divergedAt: Checkpoint | null
  /** False when the replay was recorded by another core version: a mismatch may be expected. */
  readonly sameCore: boolean
}

/**
 * Plays `replay` onto `simulation`, a fresh core, and says whether it came out
 * the same. The core must have been created with the replay's step length.
 */
export function playReplay(simulation: Simulation, replay: Replay): ReplayResult {
  if (replay.format !== REPLAY_FORMAT) {
    throw new Error(`Replay format ${String(replay.format)} is not ${REPLAY_FORMAT}.`)
  }
  if (simulation.stepMs !== replay.stepMs) {
    throw new Error(`The replay steps every ${replay.stepMs}ms; this core every ${simulation.stepMs}ms.`)
  }
  playCommands(simulation, replay.commands)
  advanceTo(simulation, replay.final.step)

  const final = { step: simulation.stepCount, hash: simulation.stateHash() }
  const ours = new Map(simulation.checkpoints().map((c) => [c.step, c.hash]))
  const divergedAt = replay.checkpoints.find((c) => ours.get(c.step) !== c.hash) ?? null
  return {
    final,
    matches: divergedAt === null && final.hash === replay.final.hash && final.step === replay.final.step,
    divergedAt,
    sameCore: replay.coreVersion === simulation.version,
  }
}

// --- text form --------------------------------------------------------------

/**
 * JSON, with the typed arrays a graph upload carries written as base64 so a
 * replay of the real planet stays a few hundred kilobytes rather than a few
 * megabytes of number lists. Little-endian, as wasm and every browser are.
 */
export function encodeReplay(replay: Replay): string {
  return JSON.stringify(replay, (_key, value: unknown) => {
    if (value instanceof Float32Array) {
      return { $f32: toBase64(value) }
    }
    if (value instanceof Int32Array) {
      return { $i32: toBase64(value) }
    }
    return value
  })
}

export function decodeReplay(text: string): Replay {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object') {
      const tagged = value as { $f32?: string; $i32?: string }
      if (typeof tagged.$f32 === 'string') {
        return new Float32Array(fromBase64(tagged.$f32))
      }
      if (typeof tagged.$i32 === 'string') {
        return new Int32Array(fromBase64(tagged.$i32))
      }
    }
    return value
  }) as Replay
}

function toBase64(array: Float32Array | Int32Array): string {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
  let binary = ''
  // In chunks: spreading a whole graph into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
