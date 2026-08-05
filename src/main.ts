import './style.css'
import { createRenderer } from './engine/renderer'
import { createGame } from './game/game'
import { createHud } from './ui/hud'
import { createInput } from './input/input'

async function main() {
  const found = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!found) {
    throw new Error('Game canvas not found')
  }
  // Aliased so the hoisted frame() below sees a non-nullable type.
  const canvas = found

  const hud = createHud()
  const game = createGame()
  const input = createInput(canvas)
  const renderer = await createRenderer(canvas, game)

  hud.setStatus(renderer.statusMessage)

  let lastTime = performance.now()

  function frame(now: number) {
    const deltaMs = now - lastTime
    lastTime = now

    const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight)
    game.update(deltaMs, input.snapshot(), aspect)
    renderer.render(game)
    hud.setFps(1000 / deltaMs)
    hud.setBrush(game.sculptor)

    input.endFrame()
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

main().catch((error: unknown) => {
  console.error(error)
  const hud = document.querySelector<HTMLDivElement>('#hud')
  if (hud) {
    hud.innerHTML = `<p class="status">Failed to start: ${String(error)}</p>`
  }
})
