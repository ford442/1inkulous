import { isCommandOp, type Command, type HostOptions } from './protocol'
import type { Simulation, SimulationClient } from './simulation'
import { connectWorkerSimulation, type ClientPort, type WorkerSimulation } from './workerClient'

export type SimulationHandle = {
  /**
   * The simulation the game is built on. While the world is being set up it is
   * the in-process core, and every command it takes is recorded; `moveToWorker`
   * then swaps what stands behind it, so the game keeps the same object.
   *
   * Typed as the in-process `Simulation` because setup code reads command
   * results synchronously; frame-time code takes it as a `SimulationClient`.
   */
  readonly simulation: Simulation
  /** Where the core runs now. */
  readonly current: SimulationClient
  /** The commands that built the world so far. */
  readonly log: readonly Command[]
  /**
   * Replays the world onto a core behind `port` and switches to it. Rejects,
   * and leaves the in-process core in charge, if the replay does not match.
   */
  moveToWorker: (port: ClientPort, options?: HostOptions) => Promise<WorkerSimulation>
}

export function createSimulationHandle(core: Simulation): SimulationHandle {
  const log: Command[] = []
  let current: SimulationClient = core
  let recording = true

  const simulation = new Proxy(core, {
    get(_target, name) {
      const value = Reflect.get(current, name, current) as unknown
      if (typeof value !== 'function') {
        return value
      }
      if (recording && isCommandOp(name)) {
        return (...args: unknown[]) => {
          // A copy: the caller may reuse its vectors.
          log.push({ op: name, args: structuredClone(args) } as unknown as Command)
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
    log,
    async moveToWorker(port, options) {
      // Nothing may change the in-process core between here and the switch,
      // or the worker would start from a world we have moved on from.
      recording = false
      try {
        const worker = await connectWorkerSimulation(port, core, log, options)
        current = worker
        return worker
      } catch (error) {
        recording = true
        throw error
      }
    },
  }
}
