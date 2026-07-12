export type Hud = {
  setStatus: (message: string) => void
  setFps: (fps: number) => void
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
      <p class="hint">Hold Space to brighten the clear color</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')

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
  }
}
