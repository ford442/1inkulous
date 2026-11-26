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
import { createGame, type Game } from './game/game'
import { createHud, matchBanner, showFatal, type Hud } from './ui/hud'
import { createStartupProgress } from './ui/loading'
import { createMenu, type Menu } from './ui/menu'
import { createInput } from './input/input'
import { createSimulationHandle, type SimulationHandle } from './sim/handle'
import { encodeReplay } from './sim/replay'
import { createSimulation, type SimulationClient } from './sim/simulation'
import type { WorkerSimulation } from './sim/workerClient'
import {
  fetchCatalog,
  fetchWorld,
  loadDraft,
  loadProgress,
  nextWorld,
  recordWin,
  saveDraft,
  standings,
  worldAfter,
  type Catalog,
  type Progress,
} from './world/campaign'
import { stringifyScenario } from './world/format'
import { readScenario, type Scenario } from './world/schema'
import { skirmishWorld } from './world/skirmish'
import { CANVAS_ASPECT } from './viewport'

/** How long a world's briefing stays under its title once the match is on. */
const BRIEFING_MS = 30_000

/** Where a world came from, which decides what the end of its match offers. */
type WorldChoice = {
  readonly scenario: Scenario
  /** Its campaign id when it is one of the campaign's worlds. */
  readonly campaignId: string | null
  /** The editor's play-test: the end of the match offers the way back. */
  readonly fromEditor: boolean
}

/**
 * The world this page plays: `?draft` the editor's play-test, `?random=<seed>`
 * a world drawn from a seed, `?world=<id>` a shipped world, and with none of
 * them the campaign's next world.
 */
async function chooseWorld(params: URLSearchParams, catalog: Catalog | null, progress: Progress): Promise<WorldChoice> {
  if (params.has('draft')) {
    const draft = loadDraft()
    if (draft) {
      return { scenario: draft, campaignId: null, fromEditor: true }
    }
    console.warn('[world] no draft from the editor in this tab; playing the campaign instead')
  }
  const random = params.get('random')
  if (random !== null) {
    const seed = Number(random)
    return { scenario: skirmishWorld(Number.isInteger(seed) ? seed : 1), campaignId: null, fromEditor: false }
  }
  const id = params.get('world') ?? (catalog ? nextWorld(catalog, progress) : null)
  if (id === null) {
    throw new Error('There is no world to play: worlds/index.json could not be read.')
  }
  const inCampaign = catalog?.campaign.worlds.some((world) => world.id === id) ?? false
  return { scenario: await fetchWorld(id), campaignId: inCampaign ? id : null, fromEditor: false }
}

/** Goes to another world: a navigation, because a page builds one world. */
function goTo(query: Record<string, string>) {
  const params = new URLSearchParams(query)
  // Kept across worlds: how the page is being run, not what it plays.
  for (const keep of ['core', 'features', 'normals']) {
    const value = new URLSearchParams(location.search).get(keep)
    if (value !== null) {
      params.set(keep, value)
    }
  }
  location.search = params.toString()
}

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

  // The world: a scenario file, from the campaign, the URL or the editor.
  const params = new URLSearchParams(location.search)
  const catalog = await fetchCatalog().catch((error: unknown) => {
    console.warn('[world] the world catalogue would not load', error)
    return null
  })
  let progress: Progress = catalog ? loadProgress(catalog) : { won: [] }
  const choice = await chooseWorld(params, catalog, progress)
  const editing = params.has('editor')
  // `?seed=` replays a match's start; with its replay, the whole of it.
  const seed = matchSeedFromUrl()
  const scenario = seed === null ? choice.scenario : { ...choice.scenario, seed }
  console.info(`[world] ${scenario.name} (${scenario.id}), match seed ${scenario.seed}`)
  const game = createGame(simulation, { scenario, mode: editing ? 'edit' : 'play' })
  exposeReplay(handle)
  // The editor keeps the core here: it reads the world back synchronously,
  // and nothing runs on the clock while a world is being made.
  const worker = editing ? null : await moveCoreToWorker(handle)
  const live: SimulationClient = handle.current
  hud.setStatus(
    worker
      ? `core ${simulation.version} on a worker (${worker.transport} snapshots)`
      : `core ${simulation.version} on the main thread`,
  )
  hud.setStatus(`core ${simulation.version} · ${scenario.name} — starting renderer…`)

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
  const renderer = await createRenderer(canvas, game, {
    withholdFeatures: withheldFeatures(params.get('features')),
    gpuNormals: params.get('normals') !== 'cpu',
    ...(followerMesh ? { followerMesh } : {}),
  })
  startup.finish()

  // The editor, loaded only when it is asked for: a play-through never
  // downloads it.
  const editor = editing
    ? (await import('./editor/editor')).createEditor({ game, simulation: handle.simulation, hud, goTo })
    : null
  const menu = createMenu()
  let paused = false
  const setPaused = (next: boolean) => {
    if (next !== paused) {
      paused = next
      if (worker) {
        if (paused) worker.pause()
        else worker.resume()
      }
    }
  }
  const openMenu = () => {
    setPaused(true)
    showWorldMenu(menu, catalog, progress, scenario, {
      close: () => {
        menu.hide()
        setPaused(false)
      },
    })
  }
  hud.bindMenu(openMenu)
  let ended = false

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
      // A world in the editor, or behind the menu, stands still.
      let mark = performance.now()
      if (!editor && !paused) {
        live.tick(deltaMs)
      }
      const tickMs = performance.now() - mark

      mark = performance.now()
      const snapshot = input.snapshot()
      if (snapshot.pressed.has('KeyP') && !editor) {
        if (menu.open) {
          menu.hide()
          setPaused(false)
        } else {
          openMenu()
        }
      }
      if (editor) {
        editor.update(deltaMs, snapshot, CANVAS_ASPECT)
      } else if (!paused) {
        game.update(deltaMs, snapshot, CANVAS_ASPECT)
      }
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
      hud.setWorld({
        name: scenario.name,
        objective: editor ? 'editing' : game.match.objective,
        chapter: choice.campaignId && catalog ? chapterOf(catalog, choice.campaignId) : null,
        elapsedSeconds: live.elapsedMs / 1000,
        // For the first half minute, and while the world is being made.
        briefing: editor || live.elapsedMs < BRIEFING_MS ? (scenario.description ?? null) : null,
      })
      if (!editor && !ended && game.match.outcome !== 'playing') {
        ended = true
        progress = endMatch(menu, game, hud, { catalog, progress, choice, scenario })
      }

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

/** `?seed=`, overriding the world's own match seed; null when not given. */
function matchSeedFromUrl(): number | null {
  const param = new URLSearchParams(location.search).get('seed')
  const seed = param === null ? NaN : Number(param)
  return Number.isInteger(seed) ? seed >>> 0 : null
}

function chapterOf(catalog: Catalog, id: string): string | null {
  const at = catalog.campaign.worlds.findIndex((world) => world.id === id)
  return at < 0 ? null : `${catalog.campaign.name} ${at + 1}/${catalog.campaign.worlds.length}`
}

/** The world menu: the campaign as far as it is open, a random world, a file, the editor. */
function showWorldMenu(
  menu: Menu,
  catalog: Catalog | null,
  progress: Progress,
  current: Scenario,
  actions: { close: () => void },
) {
  menu.showWorlds(
    {
      campaign: catalog?.campaign.name ?? 'Worlds',
      worlds: catalog
        ? standings(catalog, progress).map((world) => ({ ...world, name: worldName(world.id) }))
        : [],
      current: current.id,
    },
    {
      play: (id) => goTo({ world: id }),
      // A seed from the clock is fine here: it only picks which world to
      // build, and the world it names is then the same everywhere.
      random: () => goTo({ random: String(Date.now() % 1_000_000) }),
      editor: () => {
        saveDraft(stringifyScenario(current))
        goTo({ editor: '', draft: '' })
      },
      open: (file) => {
        void file.text().then((text) => {
          try {
            saveDraft(stringifyScenario(readScenario(text, file.name)))
            goTo({ draft: '' })
          } catch (error) {
            alert(String(error instanceof Error ? error.message : error))
          }
        })
      },
      close: actions.close,
    },
  )
}

/** A campaign id as a title until its file is read: "the-narrows" is "The Narrows". */
function worldName(id: string): string {
  return id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** The match has ended: keep a campaign win and offer what comes next. */
function endMatch(
  menu: Menu,
  game: Game,
  hud: Hud,
  context: { catalog: Catalog | null; progress: Progress; choice: WorldChoice; scenario: Scenario },
): Progress {
  const { catalog, choice, scenario } = context
  const outcome = game.match.outcome
  if (outcome === 'playing') {
    return context.progress
  }
  let progress = context.progress
  const won = outcome === 'won'
  if (won && catalog && choice.campaignId) {
    progress = recordWin(catalog, progress, choice.campaignId)
  }
  const nextId = won && catalog && choice.campaignId ? worldAfter(catalog, choice.campaignId) : null
  hud.setStatus(`${scenario.name}: ${outcome}`)
  menu.showEnd(
    {
      outcome,
      world: scenario.name,
      banner: matchBanner(game.match) ?? '',
      next: nextId ? { id: nextId, name: worldName(nextId) } : null,
      fromEditor: choice.fromEditor,
    },
    {
      next: (id) => goTo({ world: id }),
      again: () => location.reload(),
      menu: () => showWorldMenu(menu, catalog, progress, scenario, { close: () => menu.hide() }),
      editor: () => goTo({ editor: '', draft: '' }),
    },
  )
  return progress
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
