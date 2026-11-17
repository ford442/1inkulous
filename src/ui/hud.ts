import type { DragRect } from '../input/input'
import { kindName, siteProblem, woodCost, type HutGhost } from '../game/huts'
import { bridgeProblem, type BridgePreview } from '../game/shaman'
import { HutKind, HutSite } from '../sim/hutSite'

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
  readonly warriorCount: number
}

/** The slice of the huts the HUD reports on. */
export type HutReadout = {
  readonly building: boolean
  readonly buildKind: HutKind | null
  /** Wood the player's next dwelling and training hut cost. */
  readonly dwellingCost: number
  readonly trainingCost: number
  readonly ghost: HutGhost | null
  readonly count: number
  readonly housedCount: number
  readonly capacity: number
  readonly population: number
  readonly notice: string | null
}

/** The slice of the shaman the HUD reports on. */
export type ShamanReadout = {
  readonly id: number
  readonly mana: number
  readonly manaMax: number
  readonly income: number
  readonly cost: number
  readonly wood: number
  readonly targeting: boolean
  readonly preview: BridgePreview | null
  readonly notice: string | null
}

/** The slice of the trees the HUD reports on. */
export type TreeReadout = {
  readonly count: number
  readonly notice: string | null
}

/** Smoothed frame timing. `drawMs` is CPU time in `renderer.render`, not a GPU query. */
export type FramePerf = {
  readonly fps: number
  readonly simMs: number
  readonly gameMs: number
  readonly drawMs: number
}

export type Hud = {
  setStatus: (message: string) => void
  /**
   * Replaces the whole HUD with one message and a reload button, for a failure
   * the game cannot continue past. The HUD stays dead afterwards: the readouts
   * it was updating are gone.
   */
  showFatal: (message: string) => void
  setPerf: (perf: FramePerf) => void
  setBrush: (brush: BrushReadout) => void
  setSimulation: (simulation: SimulationReadout) => void
  setFollowers: (followers: FollowerReadout) => void
  setHuts: (huts: HutReadout) => void
  setShaman: (shaman: ShamanReadout) => void
  setTrees: (trees: TreeReadout) => void
  /** Screen-space selection box, or null when there isn't one. */
  setSelectionBand: (band: DragRect | null) => void
}

/** The follower line: who is out, and what they are doing. Pure. */
export function followerLine(followers: FollowerReadout): string {
  const warriors =
    followers.warriorCount > 0
      ? ` (${followers.warriorCount} warrior${followers.warriorCount === 1 ? '' : 's'})`
      : ''
  return (
    `${followers.count} followers${warriors} · ${followers.selectedCount} selected · ` +
    `${followers.walkingCount} walking`
  )
}

/** The HUD's population and build line. Pure, so it can be checked without a DOM. */
export function hutLine(huts: HutReadout): string {
  const head =
    `population ${huts.population} · ${huts.count} hut${huts.count === 1 ? '' : 's'}, ` +
    `${huts.housedCount} inside`
  if (huts.building) {
    const kind = huts.buildKind ?? HutKind.dwelling
    const cost = kind === HutKind.training ? huts.trainingCost : huts.dwellingCost
    const site = huts.ghost
      ? huts.ghost.site === HutSite.ok
        ? `click to build (${woodCost(cost)}; Shift keeps placing)`
        : siteProblem(huts.ghost.site, cost)
      : 'point at the ground'
    return `${head} · placing a ${kindName(kind)}: ${huts.notice ?? site}`
  }
  return huts.notice
    ? `${head} · ${huts.notice}`
    : `${head} · B hut (${woodCost(huts.dwellingCost)}) · T training hut (${woodCost(huts.trainingCost)})`
}

/** The trees line. Pure. */
export function treeLine(trees: TreeReadout): string {
  const head = `${trees.count} tree${trees.count === 1 ? '' : 's'}`
  return trees.notice ? `${head} · ${trees.notice}` : `${head} · right-click one to chop it`
}

/** The shaman's line: mana, and the Land Bridge while it is being aimed. Pure. */
export function shamanLine(shaman: ShamanReadout): string {
  const head =
    `mana ${Math.floor(shaman.mana)}/${shaman.manaMax} ` +
    `(+${shaman.income.toFixed(0)}/s) · wood ${shaman.wood} · Land Bridge ${shaman.cost}`
  if (shaman.id < 0) {
    return `${head} · ${shaman.notice ?? 'no shaman'}`
  }
  if (shaman.targeting) {
    const aim = shaman.preview
      ? bridgeProblem(shaman.preview.result, shaman.cost)
      : 'point across the water'
    return `${head} · aiming: ${shaman.notice ?? aim}`
  }
  if (shaman.notice) {
    return `${head} · ${shaman.notice}`
  }
  return shaman.mana >= shaman.cost ? `${head} ready · L to cast` : head
}

/**
 * CSS pixels for a selection box over the canvas. NDC is y-up; the overlay is
 * y-down, and a drag can run in any direction so the corners are sorted.
 */
export function selectionBandLayout(
  startNdc: { x: number; y: number },
  currentNdc: { x: number; y: number },
  canvas: { left: number; top: number; width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const x0 = ((startNdc.x + 1) / 2) * canvas.width
  const y0 = ((1 - startNdc.y) / 2) * canvas.height
  const x1 = ((currentNdc.x + 1) / 2) * canvas.width
  const y1 = ((1 - currentNdc.y) / 2) * canvas.height
  return {
    left: canvas.left + Math.min(x0, x1),
    top: canvas.top + Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  }
}

/**
 * Puts `message` where the HUD was, with a button to start over. Built from
 * text nodes, never markup: the message can carry an error's own words.
 */
export function showFatal(root: HTMLElement, message: string): void {
  const panel = document.createElement('div')
  panel.className = 'fatal'
  panel.setAttribute('role', 'alert')

  const title = document.createElement('h1')
  title.className = 'title'
  title.textContent = '1inkulous'

  const text = document.createElement('p')
  text.className = 'fatal-message'
  text.textContent = message

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'fatal-reload'
  reload.textContent = 'Reload'
  reload.addEventListener('click', () => location.reload())

  panel.append(title, text, reload)
  root.replaceChildren(panel)
  // A selection box left mid-drag would hang over the message.
  document.querySelector('#select-band')?.setAttribute('hidden', '')
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
      <p class="hint" id="hud-huts">—</p>
      <p class="hint" id="hud-shaman">—</p>
      <p class="hint" id="hud-trees">—</p>
      <p class="hint">Right-drag to orbit · scroll to zoom · 1–4 cardinal views · 0 or middle-click resets</p>
      <p class="hint">Drag a box to select · Shift-drag adds · click ground clears · right-click sends them</p>
      <p class="hint">Hold C to sculpt: left raises, right lowers, Shift-left flattens · wheel sizes the brush · [ ] strength</p>
      <p class="hint">B places a hut on a flat pad, T a training hut · water, uneven, and occupied ground refuse it · huts block walking</p>
      <p class="hint">Right-click a hut to send the selected braves inside, or with nobody selected to empty it · right-click a tree to chop it</p>
      <p class="hint">A brave sent into a training hut, with wood to spare, comes out a warrior · warriors strike enemies next to them</p>
      <p class="hint">F finds the shaman · L aims a Land Bridge: click across water from her, or drag shore to shore</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')
  const brushEl = root.querySelector<HTMLParagraphElement>('#hud-brush')
  const simEl = root.querySelector<HTMLParagraphElement>('#hud-sim')
  const followersEl = root.querySelector<HTMLParagraphElement>('#hud-followers')
  const hutsEl = root.querySelector<HTMLParagraphElement>('#hud-huts')
  const shamanEl = root.querySelector<HTMLParagraphElement>('#hud-shaman')
  const treesEl = root.querySelector<HTMLParagraphElement>('#hud-trees')
  const bandEl = document.querySelector<HTMLDivElement>('#select-band')
  const canvasEl = document.querySelector<HTMLCanvasElement>('#game-canvas')

  return {
    setStatus(message: string) {
      if (statusEl) {
        statusEl.textContent = message
      }
    },
    showFatal(message: string) {
      showFatal(root, message)
    },
    setPerf(perf: FramePerf) {
      if (fpsEl) {
        fpsEl.textContent =
          `${perf.fps.toFixed(0)} fps · sim ${perf.simMs.toFixed(2)}ms · ` +
          `game ${perf.gameMs.toFixed(2)}ms · draw ${perf.drawMs.toFixed(2)}ms`
      }
    },
    setBrush(brush: BrushReadout) {
      if (!brushEl) {
        return
      }
      const degrees = ((brush.brushRadius * 180) / Math.PI).toFixed(1)
      brushEl.textContent = brush.armed
        ? `brush ${degrees}° · strength ${brush.brushStrength.toFixed(3)}/s`
        : `brush ${degrees}° (hold C)`
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
        followersEl.textContent = followerLine(followers)
      }
    },
    setHuts(huts: HutReadout) {
      if (hutsEl) {
        hutsEl.textContent = hutLine(huts)
      }
    },
    setShaman(shaman: ShamanReadout) {
      if (shamanEl) {
        shamanEl.textContent = shamanLine(shaman)
      }
    },
    setTrees(trees: TreeReadout) {
      if (treesEl) {
        treesEl.textContent = treeLine(trees)
      }
    },
    setSelectionBand(band: DragRect | null) {
      if (!bandEl) {
        return
      }
      if (!band || !canvasEl) {
        bandEl.hidden = true
        return
      }
      const bounds = canvasEl.getBoundingClientRect()
      const box = selectionBandLayout(band.startNdc, band.currentNdc, bounds)
      bandEl.hidden = false
      bandEl.style.left = `${box.left}px`
      bandEl.style.top = `${box.top}px`
      bandEl.style.width = `${box.width}px`
      bandEl.style.height = `${box.height}px`
    },
  }
}
