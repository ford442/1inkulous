export type PointerButtons = {
  left: boolean
  middle: boolean
  right: boolean
}

export type PointerSnapshot = {
  /**
   * Pointer position in CSS pixels relative to the canvas, or null before the
   * pointer has ever been over it. CSS pixels, not device pixels, so this is
   * independent of devicePixelRatio.
   */
  position: { x: number; y: number } | null
  /**
   * Same position in normalised device coordinates (-1..1, y up) — the form a
   * future picking ray for spell targeting will want.
   */
  ndc: { x: number; y: number } | null
  /** Movement in CSS pixels accumulated since the last endFrame(). */
  delta: { x: number; y: number }
  buttons: PointerButtons
  /** Wheel notches accumulated since the last endFrame(). Positive scrolls down. */
  wheel: number
  /** True while a drag started on the canvas is in progress. */
  dragging: boolean
}

export type InputSnapshot = {
  /** Keys currently held, by KeyboardEvent.code. */
  keys: ReadonlySet<string>
  /** Keys that went down during this frame only — for one-shot actions. */
  pressed: ReadonlySet<string>
  pointer: PointerSnapshot
}

export type Input = {
  snapshot: () => InputSnapshot
  endFrame: () => void
}

/** Converts a wheel event of any deltaMode into notches. */
function wheelNotches(event: WheelEvent): number {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY / 3
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY
    default:
      return event.deltaY / 100
  }
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>()
  const pressed = new Set<string>()

  let position: { x: number; y: number } | null = null
  let ndc: { x: number; y: number } | null = null
  const delta = { x: 0, y: 0 }
  const buttons: PointerButtons = { left: false, middle: false, right: false }
  let wheel = 0
  const activePointers = new Set<number>()

  const setButton = (button: number, down: boolean) => {
    if (button === 0) buttons.left = down
    else if (button === 1) buttons.middle = down
    else if (button === 2) buttons.right = down
  }

  const trackPosition = (event: PointerEvent) => {
    // offsetX/Y is relative to the canvas' padding box, already in CSS pixels.
    const x = event.offsetX
    const y = event.offsetY
    position = { x, y }

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    ndc =
      width > 0 && height > 0
        ? { x: (x / width) * 2 - 1, y: 1 - (y / height) * 2 }
        : null
  }

  const onPointerDown = (event: PointerEvent) => {
    canvas.focus()
    setButton(event.button, true)
    activePointers.add(event.pointerId)
    trackPosition(event)
    // Capture so a drag keeps reporting once the pointer leaves the canvas.
    canvas.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent) => {
    const previous = position
    trackPosition(event)
    if (activePointers.size > 0) {
      // movementX/Y is unset for touch input, so fall back to differencing.
      const dx = event.movementX ?? (previous ? position!.x - previous.x : 0)
      const dy = event.movementY ?? (previous ? position!.y - previous.y : 0)
      delta.x += dx
      delta.y += dy
    }
  }

  const onPointerUp = (event: PointerEvent) => {
    setButton(event.button, false)
    activePointers.delete(event.pointerId)
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }
  }

  const onPointerLeave = () => {
    if (activePointers.size === 0) {
      position = null
      ndc = null
    }
  }

  const onWheel = (event: WheelEvent) => {
    // The canvas owns scrolling, so the page must not scroll with it.
    event.preventDefault()
    wheel += wheelNotches(event)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    keys.add(event.code)
    pressed.add(event.code)
  }

  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code)
  }

  const onBlur = () => {
    // Losing focus mid-drag would otherwise leave buttons stuck down.
    keys.clear()
    activePointers.clear()
    buttons.left = false
    buttons.middle = false
    buttons.right = false
  }

  const onContextMenu = (event: MouseEvent) => {
    // Right-drag is reserved for gameplay, so suppress the browser menu.
    event.preventDefault()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onContextMenu)

  canvas.tabIndex = 0
  canvas.focus()

  const pointer: PointerSnapshot = {
    position,
    ndc,
    delta,
    buttons,
    wheel,
    dragging: false,
  }

  return {
    snapshot() {
      pointer.position = position
      pointer.ndc = ndc
      pointer.wheel = wheel
      pointer.dragging = activePointers.size > 0
      return { keys, pressed, pointer }
    },
    endFrame() {
      pressed.clear()
      delta.x = 0
      delta.y = 0
      wheel = 0
    },
  }
}
