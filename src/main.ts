import './style.css'
import { fetchAssetIndex } from './assets/index'
import { createGameAssets } from './assets/manager'
import { followerMeshFromAssets } from './assets/models'
import { createAudioEngine } from './audio/engine'
import { soundForEvent } from './audio/events'
import { SOUND_SAMPLE_KEYS } from './audio/sounds'
import { listenerPoseFromView } from './audio/spatial'
import { createRenderer } from './engine/renderer'
import { deviceLossMessage, WebGpuUnavailableError, withheldFeatures } from './engine/webgpu'
import { FOLLOWER_HEIGHT_FRACTION, FOLLOWER_RADIUS_FRACTION } from './game/followers'
import { createGame, DEFAULT_MATCH_SEED } from './game/game'
import { createHud, showFatal } from './ui/hud'
import { createStartupProgress } from './ui/loading'
import { createInput } from './input/input'
import { createSimulationHandle, type SimulationHandle } from './sim/handle'
import { encodeReplay } from './sim/replay'
import { createSimulation, type SimulationClient } from './sim/simulation'
import type { WorkerSimulation } from './sim/workerClient'
import { CANVAS_ASPECT } from './viewport'

async function main() {
  const found = document.querySelector<HTMLCanvasElement>('#game-canvas')
  if (!found) {
    throw new Error('Game canvas not found')
  }
  // Aliased so the hoisted frame() below sees a non-nullable type.
  const canvas = found

  const hud = createHud()
  // Four stages, in order: the core, the world, the assets, the renderer.
  const startup = createStartupProgress(4, hud.setLoading)
  startup.stage(0, 'Starting the simulation core')

  // Fetching starts now and runs alongside the core and the world; it is
  // waited for just before the renderer, which is the first to need a model.
  const assets = createGameAssets({ index: await fetchAssetIndex() })
  const booting = assets.loadGroup('boot')
  // Reported where it is awaited below; this only keeps it from being unhandled
  // while the core starts.
  booting.catch(() => {})

  const input = createInput(canvas)
  // Report the core as soon as it is up, so a later renderer failure cannot
  // hide whether the WASM boundary came alive. The game is built on top of it:
  // followers and the graph they walk live inside the core.
  const core = await createSimulation()
  // The world is built here, on the in-process core, with every command it
  // takes recorded; the worker then replays them and takes over.
  const handle = createSimulationHandle(core)
  const simulation = handle.simulation
  console.info(
    `[core] simulation core ${simulation.version}, ${simulation.stepMs}ms fixed step`,
  )
  hud.setStatus(`core ${simulation.version} loaded — building the world…`)
  startup.stage(1, 'Building the world')

  // `?seed=` replays a match's start; with its replay, the whole of it.
  const seed = matchSeedFromUrl()
  console.info(`[core] match seed ${seed}`)
  const game = createGame(simulation, { seed })
  exposeReplay(handle)
  const worker = await moveCoreToWorker(handle)
  const live: SimulationClient = handle.current
  hud.setStatus(
    worker
      ? `core ${simulation.version} on a worker (${worker.transport} snapshots)`
      : `core ${simulation.version} on the main thread`,
  )
  hud.setStatus(
    `core ${simulation.version} · ${game.followers.count} followers against ${game.match.enemy.name} — starting renderer…`,
  )

  startup.stage(2, 'Loading assets', assets.progress.fraction)
  const stopWatching = assets.onProgress((progress) =>
    startup.stage(2, 'Loading assets', progress.fraction),
  )
  await booting
  stopWatching()

  startup.stage(3, 'Starting the renderer')
  // A loaded follower model, if there is one and it is usable; the renderer
  // draws the procedural pawn otherwise. Nothing in the simulation or the game
  // modules knows the difference.
  const followerMesh = followerMeshFromAssets(assets, {
    height: game.planet.radius * FOLLOWER_HEIGHT_FRACTION,
    radius: game.planet.radius * FOLLOWER_RADIUS_FRACTION,
  })

  // `?features=none` (or `-timestamp-query,-shader-f16`) runs the paths an
  // adapter without them would take; `?normals=cpu` keeps sculpted normals on
  // the CPU, for comparing the two.
  const params = new URLSearchParams(location.search)
  const renderer = await createRenderer(canvas, game, {
    withholdFeatures: withheldFeatures(params.get('features')),
    gpuNormals: params.get('normals') !== 'cpu',
    ...(followerMesh ? { followerMesh } : {}),
  })
  startup.finish()

  // Sound. It stays locked until the first click or key (browsers insist), and
  // plays synthesised voices unless a recorded sample is present and decoded.
  // Recorded files are fetched now, in the background, so they are ready by the
  // time anything makes a sound; none of them is required.
  const audio = createAudioEngine({
    planetRadius: game.planet.radius,
    loadSample: (id) => assets.load(SOUND_SAMPLE_KEYS[id]),
    loadMusic: () => assets.load('audio.music'),
  })
  audio.attach(window, document)
  hud.bindAudio({
    setMuted: (muted) => {
      audio.setMuted(muted)
      audio.play('click')
    },
    setMasterVolume: (volume) => audio.setVolume('master', volume),
  })
  void assets.loadGroup('deferred').catch((error: unknown) => {
    console.warn('[assets] background assets did not all load', error)
  })
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
    worker?.dispose()
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
  let perfSyncMs = 0
  let perfGameMs = 0
  let perfDrawMs = 0

  function frame(now: number) {
    if (!running) {
      return
    }
    try {
      const deltaMs = now - lastTime
      lastTime = now

      // Simulation first. In-process, the C++ core consumes whole fixed steps
      // here; on a worker it keeps its own clock, and this only swaps in the
      // latest step it finished. Rendering then draws whatever that left behind.
      let mark = performance.now()
      live.tick(deltaMs)
      const tickMs = performance.now() - mark

      mark = performance.now()
      const snapshot = input.snapshot()
      game.update(deltaMs, snapshot, CANVAS_ASPECT)
      const gameMs = performance.now() - mark

      // Sound follows the camera and what the world just did.
      if (snapshot.pressed.has('KeyK')) {
        audio.toggleMuted()
      }
      audio.setListener(listenerPoseFromView(game.camera.viewMatrix, game.camera.eye))
      for (const event of game.takeEvents()) {
        const request = soundForEvent(event)
        if (request) {
          audio.play(request.sound, request.at, request.options)
        }
      }

      mark = performance.now()
      renderer.render(game)
      const drawMs = performance.now() - mark

      perfFrames += 1
      if (worker) {
        perfSyncMs += tickMs
      } else {
        perfSimMs += tickMs
      }
      perfGameMs += gameMs
      perfDrawMs += drawMs
      const windowMs = now - perfWindowStart
      if (windowMs >= PERF_WINDOW_MS && perfFrames > 0) {
        hud.setPerf({
          fps: (perfFrames * 1000) / windowMs,
          simMs: worker ? worker.takeSimMsPerStep() : perfSimMs / perfFrames,
          simThread: worker ? 'worker' : 'main',
          syncMs: perfSyncMs / perfFrames,
          gameMs: perfGameMs / perfFrames,
          drawMs: perfDrawMs / perfFrames,
          gpu: renderer.takeGpuTimings(),
          gpuSupported: renderer.gpuTimingSupported,
        })
        perfWindowStart = now
        perfFrames = 0
        perfSimMs = 0
        perfSyncMs = 0
        perfGameMs = 0
        perfDrawMs = 0
      }

      hud.setAudio({ muted: audio.settings.muted, master: audio.settings.master, state: audio.state })
      hud.setBrush(game.sculptor)
      hud.setSimulation(live)
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

function matchSeedFromUrl(): number {
  const param = new URLSearchParams(location.search).get('seed')
  const seed = param === null ? NaN : Number(param)
  return Number.isInteger(seed) ? seed >>> 0 : DEFAULT_MATCH_SEED
}

/**
 * `__1inkulous.saveReplay()` in the console downloads the match so far: its
 * seed, the core's version and every command on the step it landed. What a
 * bug report attaches; `npm run test:replay -- <file>` plays one back.
 */
function exposeReplay(handle: SimulationHandle) {
  const saveReplay = async () => {
    const replay = await handle.exportReplay()
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([encodeReplay(replay)], { type: 'application/json' }))
    link.download = `1inkulous-seed${replay.seed}-step${replay.final.step}.replay.json`
    link.click()
    // Not straight away: some browsers drop a download whose URL is revoked under it.
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    return { seed: replay.seed, step: replay.final.step, hash: replay.final.hash.toString(16) }
  }
  Object.assign(globalThis, { __1inkulous: { saveReplay, exportReplay: handle.exportReplay } })
}

/**
 * Hands the core to a worker, unless `?core=main` asks to keep it here or the
 * worker cannot start; either way the game plays on. Snapshots are shared
 * memory when the page is cross-origin isolated, posted copies otherwise.
 */
async function moveCoreToWorker(
  handle: SimulationHandle,
): Promise<WorkerSimulation | null> {
  if (new URLSearchParams(location.search).get('core') === 'main') {
    return null
  }
  let thread: Worker | null = null
  try {
    thread = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' })
    const worker = await handle.moveToWorker(thread, {
      shared: globalThis.crossOriginIsolated === true,
    })
    document.addEventListener('visibilitychange', () =>
      document.hidden ? worker.pause() : worker.resume(),
    )
    console.info(`[core] running on a worker, ${worker.transport} snapshots`)
    return worker
  } catch (error) {
    thread?.terminate()
    console.warn('[core] could not move the core to a worker; it stays on the main thread', error)
    return null
  }
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
