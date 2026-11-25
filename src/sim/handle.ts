import { isCommandOp, type Command, type HostOptions } from './protocol'
import { createRecorder, exportReplay, type Replay, type StampedCommand } from './replay'
import type { Simulation, SimulationClient } from './simulation'
import { connectWorkerSimulation, type ClientPort, type WorkerSimulation } from './workerClient'

export type SimulationHandle = {
  /**
   * The simulation the game is built on. While the core is in-process every
   * command it takes is recorded, stamped with its step; `moveToWorker` then
   * swaps what stands behind it, so the game keeps the same object, and the
   * worker's host carries the log on from there.
   *
   * Typed as the in-process `Simulation` because setup code reads command
   * results synchronously; frame-time code takes it as a `SimulationClient`.
   */
  readonly simulation: Simulation
  /** Where the core runs now. */
  readonly current: SimulationClient
  /** The commands recorded in-process: the world's building, and the match if it stays here. */
  readonly log: readonly StampedCommand[]
  /**
   * Replays the world onto a core behind `port` and switches to it. Rejects,
   * and leaves the in-process core in charge, if the replay does not match.
   */
  moveToWorker: (port: ClientPort, options?: HostOptions) => Promise<WorkerSimulation>
  /** The match so far, wherever the core is running. */
  exportReplay: () => Promise<Replay>
}

export function createSimulationHandle(core: Simulation): SimulationHandle {
  const recorder = createRecorder(core)
  let current: SimulationClient = core
  let worker: WorkerSimulation | null = null
  let recording = true

  const simulation = new Proxy(core, {
    get(_target, name) {
      const value = Reflect.get(current, name, current) as unknown
      if (typeof value !== 'function') {
        return value
      }
      if (recording && isCommandOp(name)) {
        return (...args: unknown[]) => {
          recorder.record({ op: name, args } as unknown as Command)
          return (value as (...a: unknown[]) => unknown).apply(current, args)
        }
      }
      return value
    },
  }) as Simulation

  return {
    simulation,
    get current() {
      return current
    },
    log: recorder.commands,
    async moveToWorker(port, options) {
      // Nothing may change the in-process core between here and the switch,
      // or the worker would start from a world we have moved on from.
      recording = false
      try {
        worker = await connectWorkerSimulation(port, core, recorder.commands, options)
        current = worker
        return worker
      } catch (error) {
        recording = true
        throw error
      }
    },
    exportReplay() {
      return worker ? worker.exportReplay() : Promise.resolve(exportReplay(core, recorder.commands))
    },
  }
}
