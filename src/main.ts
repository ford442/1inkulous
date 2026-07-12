import './style.css'
import { createRenderer } from './engine/renderer'
import { createGame } from './game/game'
import { createHud } from './ui/hud'
import { createInput } from './input/input'

async function main() {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!canvas) {
    throw new Error('Game canvas not found')
  }

  const hud = createHud()
  const game = createGame()
  const input = createInput(canvas)
  const renderer = await createRenderer(canvas)

  hud.setStatus(renderer.statusMessage)

  let lastTime = performance.now()

  function frame(now: number) {
    const deltaMs = now - lastTime
    lastTime = now

    game.update(deltaMs, input.snapshot())
    renderer.render(game)
    hud.setFps(1000 / deltaMs)

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
