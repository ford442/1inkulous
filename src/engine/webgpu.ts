export type WebGpuContext = {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  /** Settles once, when the device is lost. Never rejects. */
  lost: Promise<DeviceLoss>
}

export type DeviceLoss = {
  reason: GPUDeviceLostReason
  message: string
}

/**
 * Raised when this browser or machine cannot give the game a GPU. Its message
 * is a whole sentence written for the player, safe to put on screen as is.
 */
export class WebGpuUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebGpuUnavailableError'
  }
}

/**
 * What a frame needs from the device, in the units of the limits that govern
 * it. The renderer works these out from the sizes of the buffers it makes.
 */
export type FrameNeeds = {
  /** The largest single buffer: the biggest instance buffer or the planet mesh. */
  maxBufferSize: number
  /** The frame's uniform block. */
  maxUniformBufferBindingSize: number
}

/**
 * What WebGPU guarantees every device whatever is asked for. A need at or below
 * this is already met, so it is not requested: asking for a limit buys nothing
 * until the frame outgrows its default, and can only narrow which adapters work.
 */
const GUARANTEED: Readonly<Record<keyof FrameNeeds, number>> = {
  maxBufferSize: 256 * 1024 * 1024,
  maxUniformBufferBindingSize: 64 * 1024,
}

export type LimitPlan = {
  /** Only the limits the frame needs beyond the guaranteed defaults. */
  requiredLimits: Record<string, number>
  /** One sentence fragment per need the adapter cannot meet. */
  shortfalls: string[]
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/**
 * Decides which limits to request. Pure, so it can be checked without a GPU:
 * the adapter's limits come in as a plain record.
 */
export function planRequiredLimits(
  needs: FrameNeeds,
  supported: Readonly<Record<string, number>>,
): LimitPlan {
  const requiredLimits: Record<string, number> = {}
  const shortfalls: string[] = []
  for (const key of Object.keys(GUARANTEED) as (keyof FrameNeeds)[]) {
    const need = needs[key]
    if (need <= GUARANTEED[key]) {
      continue
    }
    const have = supported[key]
    if (!(have >= need)) {
      shortfalls.push(`${key}: the game needs ${megabytes(need)} but this GPU allows ${megabytes(have ?? 0)}`)
      continue
    }
    requiredLimits[key] = need
  }
  return { requiredLimits, shortfalls }
}

/** Why there is no `navigator.gpu`: an insecure page is a different fix from an old browser. */
export function unsupportedMessage(secureContext: boolean): string {
  return secureContext
    ? 'This browser does not support WebGPU, which the game needs to draw the planet. ' +
        'Use a current desktop Chrome, Edge or Safari, or turn WebGPU on in the browser’s settings.'
    : 'WebGPU is only available on secure pages, and this one was loaded over plain http. ' +
        'Open the game from an https:// address (or from localhost) and reload.'
}

const NO_ADAPTER_MESSAGE =
  'This browser supports WebGPU but could not find a graphics adapter to use. The GPU may be ' +
  'blocklisted, its driver too old, or the browser may be running without GPU access. ' +
  'Update the graphics driver or the browser and reload.'

/** The sentence put on screen when the device is lost. */
export function deviceLossMessage(loss: DeviceLoss): string {
  const detail = loss.message ? ` (${loss.reason}: ${loss.message})` : ` (${loss.reason})`
  return (
    'The graphics device was lost, so the game stopped drawing. The GPU driver may have reset, ' +
    'the GPU may have been removed or run out of memory, or the browser reclaimed it. ' +
    `This match cannot be resumed; reload to start a new one.${detail}`
  )
}

/**
 * An `uncapturederror` listener that reports each distinct message once.
 *
 * A bad pipeline or buffer fails the same way every frame; reported naively
 * that is sixty console entries a second and the one line that mattered buried.
 * After `limit` different messages it says so once and goes quiet.
 */
export function createGpuErrorReporter(
  report: (message: string) => void,
  limit = 8,
): (event: { error: { message: string }; preventDefault: () => void }) => void {
  const seen = new Set<string>()
  let silenced = false
  return (event) => {
    // The browser would otherwise add its own console warning per event, which
    // is the very flood this exists to avoid.
    event.preventDefault()
    const message = event.error.message
    if (seen.has(message) || silenced) {
      return
    }
    if (seen.size >= limit) {
      silenced = true
      report(`further distinct GPU errors are being suppressed after the first ${limit}`)
      return
    }
    seen.add(message)
    report(message)
  }
}

/** Every limit on an adapter or device as a plain record, for logging and planning. */
function limitsRecord(limits: GPUSupportedLimits): Record<string, number> {
  const record: Record<string, number> = {}
  // Limits are accessors on the prototype, so for-in is what finds them.
  for (const key in limits) {
    const value = (limits as unknown as Record<string, unknown>)[key]
    if (typeof value === 'number') {
      record[key] = value
    }
  }
  return record
}

/**
 * The high-performance adapter if there is one — on a machine with both an
 * integrated and a discrete GPU that is the discrete one — otherwise whatever
 * the browser offers.
 */
async function requestAdapter(gpu: GPU): Promise<GPUAdapter> {
  try {
    const adapter =
      (await gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
      (await gpu.requestAdapter())
    if (adapter) {
      return adapter
    }
  } catch (cause) {
    throw new WebGpuUnavailableError(NO_ADAPTER_MESSAGE, { cause })
  }
  throw new WebGpuUnavailableError(NO_ADAPTER_MESSAGE)
}

export async function initWebGpu(
  canvas: HTMLCanvasElement,
  needs: FrameNeeds,
): Promise<WebGpuContext> {
  if (!navigator.gpu) {
    throw new WebGpuUnavailableError(unsupportedMessage(window.isSecureContext !== false))
  }

  const adapter = await requestAdapter(navigator.gpu)

  const supported = limitsRecord(adapter.limits)
  // What the machine offers, once, where a bug report can find it.
  console.info('[webgpu] adapter', {
    vendor: adapter.info?.vendor,
    architecture: adapter.info?.architecture,
    description: adapter.info?.description,
    features: [...adapter.features],
  })
  console.info('[webgpu] adapter limits', supported)

  const plan = planRequiredLimits(needs, supported)
  if (plan.shortfalls.length > 0) {
    throw new WebGpuUnavailableError(
      `This GPU cannot run the game: ${plan.shortfalls.join('; ')}.`,
    )
  }
  console.info(
    '[webgpu] requiredLimits',
    Object.keys(plan.requiredLimits).length > 0
      ? plan.requiredLimits
      : 'none beyond the defaults',
    `(frame needs ${megabytes(needs.maxBufferSize)} in one buffer, ` +
      `${needs.maxUniformBufferBindingSize} bytes of uniforms)`,
  )

  // No `requiredFeatures`: none of the shaders use an optional feature.
  let device: GPUDevice
  try {
    device = await adapter.requestDevice({ requiredLimits: plan.requiredLimits })
  } catch (cause) {
    throw new WebGpuUnavailableError(
      'The GPU would not create a device for the game. Reload the page; if it keeps happening, ' +
        'update the graphics driver or the browser.',
      { cause },
    )
  }

  const lost = device.lost.then((info): DeviceLoss => {
    const loss = { reason: info.reason, message: info.message }
    console.error('[webgpu] device lost', loss)
    return loss
  })

  device.addEventListener(
    'uncapturederror',
    createGpuErrorReporter((message) => console.error(`[webgpu] ${message}`)),
  )

  const context = canvas.getContext('webgpu') as GPUCanvasContext | null
  if (!context) {
    throw new WebGpuUnavailableError(
      'The browser would not give the game a WebGPU drawing surface. Reload the page, or try ' +
        'another browser.',
    )
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({
    device,
    format,
    // The canvas is the whole frame: the page behind it never shows through,
    // and nothing it composites needs an alpha channel.
    alphaMode: 'opaque',
    // `toneMapping` stays unset on purpose. The shaders apply their own
    // exposure curve (1 - exp(-1.35 * color)); anything the canvas added on top
    // would be a second curve over the first.
  })

  return { device, context, format, lost }
}
