import './style.css'
import { createRenderer } from './engine/renderer'
import { deviceLossMessage, WebGpuUnavailableError } from './engine/webgpu'
import { createGame } from './game/game'
import { createHud, showFatal } from './ui/hud'
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
    `core ${simulation.version} · ${game.followers.count} followers against ${game.match.enemy.name} — starting renderer…`,
  )

  const renderer = await createRenderer(canvas, game)
  hud.setStatus(`${renderer.statusMessage} · core ${simulation.version}`)

  // One way out of the frame loop, whatever the reason: the loop stops, the
  // HUD says why and offers a reload. Without it a failure either spins an
  // exception every frame or freezes the picture with nothing on screen.
  let running = true
  let frameHandle = 0
  function halt(message: string) {
    if (!running) {
      return
    }
    running = false
    cancelAnimationFrame(frameHandle)
    hud.showFatal(message)
  }
  // Attached straight away, so a loss during the first frames is not missed.
  void renderer.lost.then((loss) => halt(deviceLossMessage(loss)))

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
    if (!running) {
      return
    }
    try {
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
      hud.setHuts(game.huts)
      hud.setShaman(game.shaman)
      hud.setTrees(game.trees)
      hud.setSelectionBand(game.followers.selectionBand)
      hud.setMatch(game.match)

      input.endFrame()
    } catch (error) {
      console.error(error)
      halt(`The game stopped after an unexpected error: ${String(error)}`)
      return
    }
    frameHandle = requestAnimationFrame(frame)
  }

  frameHandle = requestAnimationFrame(frame)
}

main().catch((error: unknown) => {
  console.error(error)
  // WebGpuUnavailableError's message is already a sentence for the player;
  // anything else is a bug, shown as it came.
  const message =
    error instanceof WebGpuUnavailableError
      ? error.message
      : `The game failed to start: ${String(error)}`
  const root = document.querySelector<HTMLElement>('#hud')
  if (root) {
    showFatal(root, message)
  }
})
