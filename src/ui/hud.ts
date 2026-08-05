/** The slice of the terrain brush the HUD reports on. */
export type BrushReadout = {
  readonly armed: boolean
  readonly brushRadius: number
  readonly brushStrength: number
}

export type Hud = {
  setStatus: (message: string) => void
  setFps: (fps: number) => void
  setBrush: (brush: BrushReadout) => void
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
      <p class="hint">Drag to orbit · scroll to zoom · 1–4 cardinal views · 0 or middle-click resets</p>
      <p class="hint">Hold Shift to sculpt: left raises, right lowers · wheel sizes the brush · [ ] strength</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')
  const brushEl = root.querySelector<HTMLParagraphElement>('#hud-brush')

  return {
    setStatus(message: string) {
      if (statusEl) {
        statusEl.textContent = message
      }
    },
    setFps(fps: number) {
      if (fpsEl) {
        fpsEl.textContent = `${fps.toFixed(0)} fps`
      }
    },
    setBrush(brush: BrushReadout) {
      if (!brushEl) {
        return
      }
      const degrees = ((brush.brushRadius * 180) / Math.PI).toFixed(1)
      brushEl.textContent = brush.armed
        ? `brush ${degrees}° · strength ${brush.brushStrength.toFixed(3)}/s`
        : `brush ${degrees}° (hold Shift)`
    },
  }
}
