import './style.css'
import { createRenderer } from './engine/renderer'
import { createGame } from './game/game'
import { createHud } from './ui/hud'
import { createInput } from './input/input'
import { createSimulation } from './sim/simulation'
import { CANVAS_ASPECT } from './viewport'

async function main() {
  const found = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!found) {
    throw new Error('Game canvas not found')
  }
  // Aliased so the hoisted frame() below sees a non-nullable type.
  const canvas = found

  const hud = createHud()
  const input = createInput(canvas)
  // Report the core as soon as it is up, so a later renderer failure cannot
  // hide whether the WASM boundary came alive. The game is built on top of it:
  // followers and the graph they walk live inside the core.
  const simulation = await createSimulation()
  console.info(
    `[core] simulation core ${simulation.version}, ${simulation.stepMs}ms fixed step`,
  )
  hud.setStatus(`core ${simulation.version} loaded — building the world…`)

  const game = createGame(simulation)
  hud.setStatus(
    `core ${simulation.version} · ${game.followers.count} followers — starting renderer…`,
  )

  const renderer = await createRenderer(canvas, game)
  hud.setStatus(`${renderer.statusMessage} · core ${simulation.version}`)

  let lastTime = performance.now()
  // Average over half a second so the HUD is readable rather than twitching
  // with every vsync hiccup.
  const PERF_WINDOW_MS = 500
  let perfWindowStart = lastTime
  let perfFrames = 0
  let perfSimMs = 0
  let perfGameMs = 0
  let perfDrawMs = 0

  function frame(now: number) {
    const deltaMs = now - lastTime
    lastTime = now

    // Simulation first: the C++ core consumes whole fixed steps, and rendering
    // then draws whatever state they left behind.
    let mark = performance.now()
    simulation.tick(deltaMs)
    const simMs = performance.now() - mark

    mark = performance.now()
    game.update(deltaMs, input.snapshot(), CANVAS_ASPECT)
    const gameMs = performance.now() - mark

    mark = performance.now()
    renderer.render(game)
    const drawMs = performance.now() - mark

    perfFrames += 1
    perfSimMs += simMs
    perfGameMs += gameMs
    perfDrawMs += drawMs
    const windowMs = now - perfWindowStart
    if (windowMs >= PERF_WINDOW_MS && perfFrames > 0) {
      hud.setPerf({
        fps: (perfFrames * 1000) / windowMs,
        simMs: perfSimMs / perfFrames,
        gameMs: perfGameMs / perfFrames,
        drawMs: perfDrawMs / perfFrames,
      })
      perfWindowStart = now
      perfFrames = 0
      perfSimMs = 0
      perfGameMs = 0
      perfDrawMs = 0
    }

    hud.setBrush(game.sculptor)
    hud.setSimulation(simulation)
    hud.setFollowers(game.followers)

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
