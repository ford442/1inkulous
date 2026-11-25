import type { DragRect } from '../input/input'
import { kindName, siteProblem, woodCost, type HutGhost } from '../game/huts'
import { SPELL_NAMES, spellProblem, type SpellPreview, type SpellSlot } from '../game/shaman'
import type { SpellCast } from '../sim/simulation'
import { SpellResult, type Spell } from '../sim/spell'
import { HutKind, HutSite } from '../sim/hutSite'
import { AI_ACTION_TEXT } from '../sim/ai'
import { TRIBE_NAMES, type MatchOutcome, type TribeReadout } from '../game/scenario'

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
  readonly wood: number
  readonly aiming: Spell | null
  readonly preview: SpellPreview | null
  readonly casting: SpellCast | null
  readonly spells: readonly SpellSlot[]
  readonly notice: string | null
}

/** The slice of the trees the HUD reports on. */
export type TreeReadout = {
  readonly count: number
  readonly notice: string | null
}

/** The slice of the match the HUD reports on. */
export type MatchReadout = {
  readonly playerTribe: number
  readonly outcome: MatchOutcome
  readonly enemy: TribeReadout
}

/** GPU time per pass from timestamp queries, averaged like the rest of the line. */
export type GpuPerf = {
  readonly totalMs: number
  readonly passes: readonly { readonly name: string; readonly ms: number }[]
}

/**
 * The GPU part of the perf line. Pure. `supported` false says so plainly
 * rather than leaving a gap; null timings with support means none came back
 * in this window yet.
 */
export function gpuLine(gpu: GpuPerf | null, supported: boolean): string {
  if (!supported) {
    return 'gpu n/a (no timestamp-query)'
  }
  if (!gpu) {
    return 'gpu —'
  }
  const parts = gpu.passes.filter((pass) => pass.ms > 0).map((pass) => `${pass.name} ${pass.ms.toFixed(2)}`)
  return `gpu ${gpu.totalMs.toFixed(2)}ms` + (parts.length > 0 ? ` (${parts.join(' · ')})` : '')
}

/**
 * Smoothed frame timing. `drawMs` is CPU time in `renderer.render`; `gpu` is
 * the GPU's own time, when the device can measure it.
 */
export type FramePerf = {
  readonly fps: number
  /**
   * Core time. On the main thread it is per frame; on a worker it is per fixed
   * step, measured there, and null while no step ran.
   */
  readonly simMs: number | null
  readonly simThread: 'main' | 'worker'
  /** Main-thread time swapping in the worker's latest step. */
  readonly syncMs: number
  readonly gameMs: number
  readonly drawMs: number
  readonly gpu: GpuPerf | null
  readonly gpuSupported: boolean
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
  setMatch: (match: MatchReadout) => void
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

/** The shaman's line: mana, wood, and what she has to say. Pure. */
export function shamanLine(shaman: ShamanReadout): string {
  const head =
    `mana ${Math.floor(shaman.mana)}/${shaman.manaMax} ` +
    `(+${shaman.income.toFixed(0)}/s) · wood ${shaman.wood}`
  if (shaman.id < 0) {
    return `${head} · ${shaman.notice ?? 'no shaman'}`
  }
  if (shaman.notice) {
    return `${head} · ${shaman.notice}`
  }
  if (shaman.casting) {
    return `${head} · casting ${SPELL_NAMES[shaman.casting.spell]}`
  }
  return `${head} · F finds her`
}

/** The enemy tribe's line: how big it is, what it holds and what it is up to. Pure. */
export function enemyLine(match: MatchReadout): string {
  const enemy = match.enemy
  const head =
    `${enemy.name}: ${enemy.population} people · mana ${Math.floor(enemy.mana)} ` +
    `(+${enemy.income.toFixed(0)}/s) · wood ${enemy.wood}`
  return enemy.shamanStanding ? `${head} · ${AI_ACTION_TEXT[enemy.action]}` : `${head} · shaman fallen`
}

/**
 * Who fell and what that means, once the match is over; null while it is on.
 * Pure.
 */
export function matchBanner(match: MatchReadout): string | null {
  const enemy = match.enemy.name
  const player = TRIBE_NAMES[match.playerTribe] ?? 'your tribe'
  switch (match.outcome) {
    case 'won':
      return `${enemy}'s shaman has fallen — you win. ${enemy}'s people take no more orders.`
    case 'lost':
      return `Your shaman has fallen — ${enemy} wins. ${player}'s people take no more orders.`
    case 'draw':
      return 'Both shamans have fallen — nobody wins.'
    default:
      return null
  }
}

/**
 * The spell row: every spell's key, name and cost, how long one that has just
 * landed has left to recover, a cast under way, and — for the spell being
 * aimed — the go-ahead or why not. Pure.
 */
export function spellLine(shaman: ShamanReadout): string {
  const slots = shaman.spells.map((slot) => {
    const label = `${slot.key} ${slot.name} ${slot.cost}`
    const resting = slot.cooldown > 0 ? ` (${Math.ceil(slot.cooldown)}s)` : ''
    if (slot.spell !== shaman.aiming) {
      return label + resting
    }
    const aim = shaman.preview
      ? spellProblem(slot.spell, shaman.preview.result, slot.cost)
      : 'point at the ground'
    const mark = shaman.preview && shaman.preview.result !== SpellResult.ok ? '✗' : '▸'
    return `${mark} ${label}${resting}: ${aim}`
  })
  const casting = shaman.casting
    ? `casting ${SPELL_NAMES[shaman.casting.spell]} ${Math.round(shaman.casting.progress * 100)}% · `
    : ''
  return `${casting}${slots.join(' · ')}`
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
      <p class="hint" id="hud-spells">—</p>
      <p class="hint" id="hud-trees">—</p>
      <p class="hint" id="hud-enemy">—</p>
      <p class="match-end" id="hud-match" role="status" hidden></p>
      <p class="hint">Right-drag to orbit · scroll to zoom · 1–4 cardinal views · 0 or middle-click resets</p>
      <p class="hint">Drag a box to select · Shift-drag adds · click ground clears · right-click sends them</p>
      <p class="hint">Hold C to sculpt: left raises, right lowers, Shift-left flattens · wheel sizes the brush · [ ] strength</p>
      <p class="hint">B places a hut on a flat pad, T a training hut · water, uneven, and occupied ground refuse it · huts block walking</p>
      <p class="hint">Right-click a hut to send the selected braves inside, or with nobody selected to empty it · right-click a tree to chop it</p>
      <p class="hint">A brave sent into a training hut, with wood to spare, comes out a warrior · warriors strike enemies next to them</p>
      <p class="hint">F finds the shaman · L aims a Land Bridge: click across water from her, or drag shore to shore</p>
      <p class="hint">Red plays itself: kill its shaman to win, and keep yours alive · warriors are the way to do it</p>
      <p class="hint">N turns the day: the sun stops following the camera and the night side goes dark · N again brings it back</p>
      <p class="hint">X Blast raises a hill and throws people off it · V Flatten levels a hut pad · M Swamp sinks the ground · a cast takes a moment: move her or cast again to cancel</p>
    </div>
  `

  const statusEl = root.querySelector<HTMLParagraphElement>('#hud-status')
  const fpsEl = root.querySelector<HTMLParagraphElement>('#hud-fps')
  const brushEl = root.querySelector<HTMLParagraphElement>('#hud-brush')
  const simEl = root.querySelector<HTMLParagraphElement>('#hud-sim')
  const followersEl = root.querySelector<HTMLParagraphElement>('#hud-followers')
  const hutsEl = root.querySelector<HTMLParagraphElement>('#hud-huts')
  const shamanEl = root.querySelector<HTMLParagraphElement>('#hud-shaman')
  const spellsEl = root.querySelector<HTMLParagraphElement>('#hud-spells')
  const treesEl = root.querySelector<HTMLParagraphElement>('#hud-trees')
  const enemyEl = root.querySelector<HTMLParagraphElement>('#hud-enemy')
  const matchEl = root.querySelector<HTMLParagraphElement>('#hud-match')
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
          `${perf.fps.toFixed(0)} fps · ` +
          (perf.simThread === 'worker'
            ? `sim ${perf.simMs === null ? '—' : perf.simMs.toFixed(2)}ms/step (worker) · ` +
              `sync ${perf.syncMs.toFixed(2)}ms · `
            : `sim ${(perf.simMs ?? 0).toFixed(2)}ms · `) +
          `game ${perf.gameMs.toFixed(2)}ms · draw ${perf.drawMs.toFixed(2)}ms · ` +
          gpuLine(perf.gpu, perf.gpuSupported)
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
      if (spellsEl) {
        spellsEl.textContent = spellLine(shaman)
        // Red while the spell being aimed would be refused, like the ghost disc.
        spellsEl.classList.toggle(
          'refused',
          shaman.preview !== null && shaman.preview.result !== SpellResult.ok,
        )
      }
    },
    setTrees(trees: TreeReadout) {
      if (treesEl) {
        treesEl.textContent = treeLine(trees)
      }
    },
    setMatch(match: MatchReadout) {
      if (enemyEl) {
        enemyEl.textContent = enemyLine(match)
      }
      if (matchEl) {
        const banner = matchBanner(match)
        matchEl.hidden = banner === null
        matchEl.textContent = banner ?? ''
        matchEl.classList.toggle('lost', match.outcome === 'lost')
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
