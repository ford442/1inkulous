/**
 * GPU time per pass, from `timestamp-query`. Each timed pass writes a
 * timestamp as it begins and as it ends; once a frame's work is done the
 * stamps are copied to a buffer the CPU can map, and the durations averaged
 * until the HUD next asks.
 *
 * Reading back is asynchronous and a buffer is busy while it is mapped, so a
 * few readback buffers take turns. A frame that finds none free is simply not
 * timed: the HUD shows an average, and skipping a frame does not bias it.
 *
 * Without the feature every call is a no-op and the HUD says the GPU time is
 * not available, rather than showing a number that is really CPU time.
 */

export type GpuTimings = {
  /** Sum of the timed passes, in milliseconds, averaged over the frames timed. */
  readonly totalMs: number
  /** Each pass's average, in milliseconds, in the order the passes were named. */
  readonly passes: readonly { readonly name: string; readonly ms: number }[]
  /** How many frames went into the average. */
  readonly frames: number
}

export type GpuTimer = {
  readonly supported: boolean
  /**
   * Starts a frame. Returns false when this frame will not be timed (no
   * feature, or every readback buffer is still in flight).
   */
  beginFrame: () => boolean
  /** The `timestampWrites` for a named pass, or undefined while not timing. */
  passWrites: (name: string) => GPURenderPassTimestampWrites | undefined
  /** Copies the stamps out; call on the frame's encoder after its last pass. */
  resolve: (encoder: GPUCommandEncoder) => void
  /** Call after the frame is submitted: starts reading the stamps back. */
  afterSubmit: () => void
  /** The average since the last call, or null when nothing was timed. */
  take: () => GpuTimings | null
}

/**
 * Durations from raw timestamps (nanoseconds), two per pass in `names` order:
 * begin, end. A pass whose stamps are missing or run backwards — some drivers
 * do across a power-state change — gives null rather than a nonsense number.
 */
export function passDurations(
  stamps: ArrayLike<bigint>,
  names: readonly string[],
): ({ name: string; ms: number } | null)[] {
  return names.map((name, i) => {
    const begin = stamps[i * 2]
    const end = stamps[i * 2 + 1]
    if (begin === undefined || end === undefined || begin === 0n || end < begin) {
      return null
    }
    return { name, ms: Number(end - begin) / 1e6 }
  })
}

const READBACK_BUFFERS = 3

export function createGpuTimer(
  device: GPUDevice,
  supported: boolean,
  names: readonly string[],
): GpuTimer {
  const off: GpuTimer = {
    supported: false,
    beginFrame: () => false,
    passWrites: () => undefined,
    resolve: () => {},
    afterSubmit: () => {},
    take: () => null,
  }
  if (!supported) {
    return off
  }

  const count = names.length * 2
  const bytes = count * 8
  const querySet = device.createQuerySet({ label: 'gpu-timer', type: 'timestamp', count })
  const resolveBuffer = device.createBuffer({
    label: 'gpu-timer-resolve',
    size: bytes,
    usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
  })
  const free: GPUBuffer[] = Array.from({ length: READBACK_BUFFERS }, (_, i) =>
    device.createBuffer({
      label: `gpu-timer-readback-${i}`,
      size: bytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    }),
  )

  let current: GPUBuffer | null = null
  let used = new Set<string>()
  const sums = new Map<string, number>()
  let frames = 0

  return {
    supported: true,
    beginFrame() {
      current = free.pop() ?? null
      used = new Set()
      return current !== null
    },
    passWrites(name) {
      const index = names.indexOf(name)
      if (!current || index < 0) {
        return undefined
      }
      used.add(name)
      return {
        querySet,
        beginningOfPassWriteIndex: index * 2,
        endOfPassWriteIndex: index * 2 + 1,
      }
    },
    resolve(encoder) {
      if (!current) {
        return
      }
      encoder.resolveQuerySet(querySet, 0, count, resolveBuffer, 0)
      encoder.copyBufferToBuffer(resolveBuffer, 0, current, 0, bytes)
    },
    afterSubmit() {
      const buffer = current
      const timed = used
      current = null
      if (!buffer) {
        return
      }
      buffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const stamps = new BigUint64Array(buffer.getMappedRange().slice(0))
          buffer.unmap()
          free.push(buffer)
          // A pass that did not run this frame (no dirty terrain, say) left
          // last frame's stamps in its slots; those are not this frame's.
          const durations = passDurations(stamps, names)
          let any = false
          for (const duration of durations) {
            if (duration && timed.has(duration.name)) {
              sums.set(duration.name, (sums.get(duration.name) ?? 0) + duration.ms)
              any = true
            }
          }
          if (any) {
            frames += 1
          }
        })
        .catch(() => {
          // The device was lost mid-read; the loss is reported elsewhere.
        })
    },
    take() {
      if (frames === 0) {
        return null
      }
      const passes = names.map((name) => ({ name, ms: (sums.get(name) ?? 0) / frames }))
      const result = {
        totalMs: passes.reduce((sum, pass) => sum + pass.ms, 0),
        passes,
        frames,
      }
      sums.clear()
      frames = 0
      return result
    },
  }
}
