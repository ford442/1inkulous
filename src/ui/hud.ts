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

export type Hud = {
  setStatus: (message: string) => void
  setFps: (fps: number) => void
  setBrush: (brush: BrushReadout) => void
  setSimulation: (simulation: SimulationReadout) => void
  setFollowers: (followers: FollowerReadout) => void
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
      <p class="hint">Drag to orbit · scroll to zoom · 1–4 cardinal views · 0 or middle-click resets</p>
      <p class="hint">Click a follower to select · Ctrl-click adds · right-click sends them walking</p>
      <p class="hint">Hold Shift to sculpt: left raises, right lowers · wheel sizes the brush · [ ] strength</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')
  const brushEl = root.querySelector<HTMLParagraphElement>('#hud-brush')
  const simEl = root.querySelector<HTMLParagraphElement>('#hud-sim')
  const followersEl = root.querySelector<HTMLParagraphElement>('#hud-followers')

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
  }
}
