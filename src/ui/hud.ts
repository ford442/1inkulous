import type { DragRect } from '../input/input'

/** The slice of the terrain brush the HUD reports on. */
export type BrushReadout = {
  readonly armed: boolean
  readonly brushRadius: number
  readonly brushStrength: number
}

/** The slice of the simulation core the HUD reports on. */
export type SimulationReadout = {
  readonly version: string
  readonly stepCount: number
  readonly elapsedMs: number
}

/** The slice of the follower set the HUD reports on. */
export type FollowerReadout = {
  readonly count: number
  readonly selectedCount: number
  readonly walkingCount: number
}

/** Smoothed frame timing. `drawMs` is CPU time in `renderer.render`, not a GPU query. */
export type FramePerf = {
  readonly fps: number
  readonly simMs: number
  readonly gameMs: number
  readonly drawMs: number
}

export type Hud = {
  setStatus: (message: string) => void
  setPerf: (perf: FramePerf) => void
  setBrush: (brush: BrushReadout) => void
  setSimulation: (simulation: SimulationReadout) => void
  setFollowers: (followers: FollowerReadout) => void
  /** Screen-space selection box, or null when there isn't one. */
  setSelectionBand: (band: DragRect | null) => void
}

/**
 * CSS pixels for a selection box over the canvas. NDC is y-up; the overlay is
 * y-down, and a drag can run in any direction so the corners are sorted.
 */
export function selectionBandLayout(
  startNdc: { x: number; y: number },
  currentNdc: { x: number; y: number },
  canvas: { left: number; top: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const x0 = ((startNdc.x + 1) / 2) * canvas.width
  const y0 = ((1 - startNdc.y) / 2) * canvas.height
  const x1 = ((currentNdc.x + 1) / 2) * canvas.width
  const y1 = ((1 - currentNdc.y) / 2) * canvas.height
  return {
    left: canvas.left + Math.min(x0, x1),
    top: canvas.top + Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  }
}

export function createHud(): Hud {
  const root = document.querySelector<HTMLDivElement>('#hud')
  if (!root) {
    throw new Error('HUD root not found')
  }

  root.innerHTML = `
    <div>
      <h1 class="title">1inkulous</h1>
      <p class="status" id="hud-status">Starting…</p>
    </div>
    <div>
      <p class="hint" id="hud-fps">— fps</p>
      <p class="hint" id="hud-brush">—</p>
      <p class="hint" id="hud-sim">—</p>
      <p class="hint" id="hud-followers">—</p>
      <p class="hint">Right-drag to orbit · scroll to zoom · 1–4 cardinal views · 0 or middle-click resets</p>
      <p class="hint">Drag a box to select · Shift-drag adds · click ground clears · right-click sends them</p>
      <p class="hint">Hold C to sculpt: left raises, right lowers · wheel sizes the brush · [ ] strength</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')
  const brushEl = root.querySelector<HTMLParagraphElement>('#hud-brush')
  const simEl = root.querySelector<HTMLParagraphElement>('#hud-sim')
  const followersEl = root.querySelector<HTMLParagraphElement>('#hud-followers')
  const bandEl = document.querySelector<HTMLDivElement>('#select-band')
  const canvasEl = document.querySelector<HTMLCanvasElement>('#game-canvas')

  return {
    setStatus(message: string) {
      if (statusEl) {
        statusEl.textContent = message
      }
    },
    setPerf(perf: FramePerf) {
      if (fpsEl) {
        fpsEl.textContent =
          `${perf.fps.toFixed(0)} fps · sim ${perf.simMs.toFixed(2)}ms · ` +
          `game ${perf.gameMs.toFixed(2)}ms · draw ${perf.drawMs.toFixed(2)}ms`
      }
    },
    setBrush(brush: BrushReadout) {
      if (!brushEl) {
        return
      }
      const degrees = ((brush.brushRadius * 180) / Math.PI).toFixed(1)
      brushEl.textContent = brush.armed
        ? `brush ${degrees}° · strength ${brush.brushStrength.toFixed(3)}/s`
        : `brush ${degrees}° (hold C)`
    },
    setSimulation(simulation: SimulationReadout) {
      if (simEl) {
        simEl.textContent =
          `core ${simulation.version} · ${simulation.stepCount} steps · ` +
          `${(simulation.elapsedMs / 1000).toFixed(1)}s simulated`
      }
    },
    setFollowers(followers: FollowerReadout) {
      if (followersEl) {
        followersEl.textContent =
          `${followers.count} followers · ${followers.selectedCount} selected · ` +
          `${followers.walkingCount} walking`
      }
    },
    setSelectionBand(band: DragRect | null) {
      if (!bandEl) {
        return
      }
      if (!band || !canvasEl) {
        bandEl.hidden = true
        return
      }
      const bounds = canvasEl.getBoundingClientRect()
      const box = selectionBandLayout(band.startNdc, band.currentNdc, bounds)
      bandEl.hidden = false
      bandEl.style.left = `${box.left}px`
      bandEl.style.top = `${box.top}px`
      bandEl.style.width = `${box.width}px`
      bandEl.style.height = `${box.height}px`
    },
  }
}
