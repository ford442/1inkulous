import './style.css'
import { createRenderer } from './engine/renderer'
import { createGame } from './game/game'
import { createHud } from './ui/hud'
import { createInput } from './input/input'
import { createSimulation } from './sim/simulation'

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
  // Report the core as soon as it is up, so a later renderer failure cannot
  // hide whether the WASM boundary came alive.
  const simulation = await createSimulation()
  console.info(
    `[core] simulation core ${simulation.version}, ${simulation.stepMs}ms fixed step`,
  )
  hud.setStatus(`core ${simulation.version} loaded — starting renderer…`)

  const renderer = await createRenderer(canvas, game)
  hud.setStatus(`${renderer.statusMessage} · core ${simulation.version}`)

  let lastTime = performance.now()

  function frame(now: number) {
    const deltaMs = now - lastTime
    lastTime = now

    // Simulation first: the C++ core consumes whole fixed steps, and rendering
    // then draws whatever state they left behind.
    simulation.tick(deltaMs)

    const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight)
    game.update(deltaMs, input.snapshot(), aspect)
    renderer.render(game)
    hud.setFps(1000 / deltaMs)
    hud.setBrush(game.sculptor)
    hud.setSimulation(simulation)

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
