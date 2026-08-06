import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../viewport'

export type PointerButtons = {
  left: boolean
  middle: boolean
  right: boolean
}

export type PointerButton = 'left' | 'middle' | 'right'

/**
 * A press and release at the same spot — the gesture that selects a unit or
 * gives an order, as distinct from a drag, which swings the camera.
 *
 * These are recorded from the events themselves rather than by watching
 * `buttons` across frames: a real click can begin and end inside a single
 * frame, and polling would miss it entirely.
 */
export type PointerClick = {
  button: PointerButton
  /** Where the release happened, in CSS pixels relative to the canvas. */
  position: { x: number; y: number }
  /** The same point in normalised device coordinates (-1..1, y up). */
  ndc: { x: number; y: number }
  /**
   * Modifiers as they were at the moment of the click, not as they are when the
   * frame gets round to reading it. Releasing a modifier right after clicking is
   * ordinary behaviour, and it can easily happen before the next frame runs — so
   * a consumer that polled the live keyboard state would see the wrong thing.
   */
  ctrlKey: boolean
  shiftKey: boolean
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
  /** Clicks completed during this frame only. Cleared by endFrame(). */
  clicks: readonly PointerClick[]
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

/**
 * A press that travels further than this before release was a drag, not a
 * click. Generous enough to forgive a shaky hand on a trackpad.
 */
const CLICK_SLOP_PIXELS = 6

const BUTTON_NAMES: Record<number, PointerButton> = {
  0: 'left',
  1: 'middle',
  2: 'right',
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
  // How far each held button has travelled since it went down, so a release can
  // be classified as a click or the end of a drag.
  const travelWhileDown = new Map<PointerButton, number>()
  let clicks: PointerClick[] = []

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

    const width = CANVAS_WIDTH
    const height = CANVAS_HEIGHT
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
    const name = BUTTON_NAMES[event.button]
    if (name) {
      travelWhileDown.set(name, 0)
    }
    // Capture so a drag keeps reporting once the pointer leaves the canvas.
    canvas.setPointerCapture(event.pointerId)
  }

  /**
   * Adds a hop to every held button's running total.
   *
   * Measured from the canvas positions rather than from `movementX/Y`: the
   * click threshold is in CSS pixels, and movement deltas are not reliably in
   * the same units across browsers and zoom levels. `delta` below keeps using
   * the raw movement, which is what the camera wants for orbiting.
   */
  const accumulateTravel = (
    from: { x: number; y: number } | null,
    to: { x: number; y: number } | null,
  ) => {
    if (!from || !to || travelWhileDown.size === 0) {
      return
    }
    const travelled = Math.hypot(to.x - from.x, to.y - from.y)
    if (travelled === 0) {
      return
    }
    for (const [button, total] of travelWhileDown) {
      travelWhileDown.set(button, total + travelled)
    }
  }

  const onPointerMove = (event: PointerEvent) => {
    const previous = position
    trackPosition(event)
    if (activePointers.size > 0) {
      // movementX/Y is unset for touch input, so fall back to differencing.
      delta.x += event.movementX ?? (previous ? position!.x - previous.x : 0)
      delta.y += event.movementY ?? (previous ? position!.y - previous.y : 0)
      accumulateTravel(previous, position)
    }
  }

  const onPointerUp = (event: PointerEvent) => {
    // The release can carry the last of the movement, so take its position and
    // count that hop before judging whether the press was a click.
    const previous = position
    trackPosition(event)
    accumulateTravel(previous, position)

    setButton(event.button, false)
    activePointers.delete(event.pointerId)

    const name = BUTTON_NAMES[event.button]
    const travelled = name ? travelWhileDown.get(name) : undefined
    if (name) {
      travelWhileDown.delete(name)
    }
    // A press the canvas never saw begin (the pointer came in from outside
    // already held) has no travel recorded and is not a click.
    if (name && travelled !== undefined && travelled <= CLICK_SLOP_PIXELS) {
      if (position && ndc) {
        clicks.push({
          button: name,
          position: { x: position.x, y: position.y },
          ndc: { x: ndc.x, y: ndc.y },
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        })
      }
    }
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
    travelWhileDown.clear()
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
    clicks,
  }

  return {
    snapshot() {
      pointer.position = position
      pointer.ndc = ndc
      pointer.wheel = wheel
      pointer.dragging = activePointers.size > 0
      pointer.clicks = clicks
      return { keys, pressed, pointer }
    },
    endFrame() {
      pressed.clear()
      delta.x = 0
      delta.y = 0
      wheel = 0
      // A fresh array rather than a truncation: the snapshot handed out this
      // frame may still be held by a caller.
      clicks = []
    },
  }
}
