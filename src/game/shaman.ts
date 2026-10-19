import type { Vec3 } from '../engine/math'
import { screenRay, type RayCamera } from '../engine/picking'
import type { DragRect, InputSnapshot, PointerClick } from '../input/input'
import { LandBridge } from '../sim/landBridge'
import type { LandBridgePlan, Simulation } from '../sim/simulation'
import type { Planet } from './planet'
import { isSculptModifierHeld, isSculptModifierIn } from './sculpt'

/**
 * The shaman and her one spell, Land Bridge.
 *
 * She is a follower in the core with the shaman flag set, so selecting and
 * ordering her goes through the follower code like anyone else. This module
 * is what only she has: F to find her, mana on the HUD, and L to raise a
 * strip of land across water.
 *
 * The core judges a cast and charges for it; the terrain belongs to the
 * planet, so the stamps are laid here with the brush's own sculpt primitive
 * and the new heights pushed straight into the nav buffer. The next order
 * walks over the bridge with no graph rebuild.
 */

/** The player's tribe: blue, the one the shaman belongs to. */
export const PLAYER_TRIBE = 0

const NOTICE_MS = 2500

const FIND_KEYS = ['KeyF']
const CAST_KEYS = ['KeyL']
const CANCEL_KEYS = ['Escape', 'KeyB']

/** Instance layout, in floats: position(3), heading(3), tribe, flags. */
const OFFSET_POSITION = 0

/** A camera the shaman can be found with: rays for picking, and a way to look at her. */
export type ShamanCamera = RayCamera & {
  focusOn: (direction: Vec3, immediate?: boolean) => void
}

export type ShamanViewContext = {
  camera: ShamanCamera
  /** Viewport width / height. */
  aspect: number
}

/** The bridge the cursor is pointing out, and whether the core would raise it. */
export type BridgePreview = {
  readonly from: Vec3
  readonly to: Vec3
  readonly result: LandBridge
}

export type ShamanUpdate = {
  /** Clicks this frame that were a cast, not a selection or an order. */
  consumed: ReadonlySet<PointerClick>
  /** True while Land Bridge owns the left button, so no box selection starts. */
  targeting: boolean
}

export type ShamanOptions = {
  /**
   * Pushes the planet's heights into the core's nav buffer. Called right after
   * a bridge is laid, so an order given in the same frame already walks it.
   */
  syncTerrain: () => void
}

export type Shaman = {
  readonly tribe: number
  /** Her follower id right now, or -1. Ids shift as others go into huts. */
  readonly id: number
  readonly mana: number
  readonly manaMax: number
  /** Mana gained per second at the tribe's current size. */
  readonly income: number
  readonly cost: number
  readonly targeting: boolean
  /** Null outside targeting, while sculpting, or with the cursor off the planet. */
  readonly preview: BridgePreview | null
  /** Angular radius of a bridge stamp, in radians — the width of the strip. */
  readonly stripRadius: number
  readonly notice: string | null
  update: (deltaMs: number, input: InputSnapshot, view: ShamanViewContext) => ShamanUpdate
}

export function createShaman(
  planet: Planet,
  simulation: Simulation,
  options: ShamanOptions,
): Shaman {
  const tribe = PLAYER_TRIBE
  let targeting = false
  let preview: BridgePreview | null = null
  let notice: string | null = null
  let noticeMs = 0

  const say = (message: string) => {
    notice = message
    noticeMs = NOTICE_MS
  }

  const position = (): Vec3 | null => {
    const id = simulation.shamanId(tribe)
    if (id < 0) {
      return null
    }
    const data = simulation.followerInstances()
    const base = id * simulation.followerInstanceFloats + OFFSET_POSITION
    const point: Vec3 = [data[base], data[base + 1], data[base + 2]]
    const length = Math.hypot(point[0], point[1], point[2])
    return length > 0 ? [point[0] / length, point[1] / length, point[2] / length] : null
  }

  const pick = (ndc: { x: number; y: number }, view: ShamanViewContext): Vec3 | null =>
    planet.pickDirection(screenRay(view.camera, ndc.x, ndc.y, view.aspect))

  // A click casts from where she stands; a drag casts from where it began.
  const endsOf = (
    view: ShamanViewContext,
    to: { x: number; y: number },
    drag: DragRect | null,
  ): { from: Vec3; to: Vec3 } | null => {
    const end = pick(to, view)
    const start = drag ? pick(drag.startNdc, view) : position()
    return end && start ? { from: start, to: end } : null
  }

  const cast = (from: Vec3, to: Vec3): boolean => {
    const { result, plan } = simulation.castLandBridge(tribe, from, to)
    if (!plan) {
      say(bridgeProblem(result, simulation.landBridgeCost))
      return false
    }
    layLandBridge(planet, plan)
    options.syncTerrain()
    say('the land rises')
    return true
  }

  return {
    tribe,
    get id() {
      return simulation.shamanId(tribe)
    },
    get mana() {
      return simulation.mana(tribe)
    },
    manaMax: simulation.manaMax,
    get income() {
      return simulation.manaIncome(tribe)
    },
    cost: simulation.landBridgeCost,
    get targeting() {
      return targeting
    },
    get preview() {
      return preview
    },
    get stripRadius() {
      return simulation.landBridgeStampRadius
    },
    get notice() {
      return notice
    },

    update(deltaMs: number, input: InputSnapshot, view: ShamanViewContext) {
      const consumed = new Set<PointerClick>()
      const pointer = input.pointer

      noticeMs -= deltaMs
      if (noticeMs <= 0) {
        notice = null
      }

      if (FIND_KEYS.some((code) => input.pressed.has(code))) {
        const id = simulation.shamanId(tribe)
        const at = position()
        if (id >= 0 && at) {
          simulation.clearFollowerSelection()
          simulation.setFollowerSelected(id, true)
          view.camera.focusOn(at)
        } else {
          say('the tribe has no shaman')
        }
      }

      if (CAST_KEYS.some((code) => input.pressed.has(code))) {
        targeting = !targeting && simulation.shamanId(tribe) >= 0
        if (!targeting && simulation.shamanId(tribe) < 0) {
          say('the tribe has no shaman')
        }
      }
      if (CANCEL_KEYS.some((code) => input.pressed.has(code))) {
        targeting = false
      }

      const sculpting = isSculptModifierHeld(input)
      const live = pointer.dragRect && pointer.dragRect.button === 'left' ? pointer.dragRect : null
      preview = null
      if (targeting && !sculpting && pointer.ndc) {
        const ends = endsOf(view, live ? live.currentNdc : pointer.ndc, live)
        if (ends) {
          preview = { ...ends, result: simulation.checkLandBridge(tribe, ends.from, ends.to) }
        }
      }

      if (!targeting) {
        return { consumed, targeting }
      }

      for (const click of pointer.clicks) {
        if (click.button === 'middle' || isSculptModifierIn(click.held)) {
          continue
        }
        consumed.add(click)
        if (click.button === 'right') {
          targeting = false
          continue
        }
        // Judged where the click landed, not where the preview was drawn.
        const ends = endsOf(view, click.ndc, null)
        if (ends && cast(ends.from, ends.to)) {
          targeting = click.shiftKey
        }
      }

      for (const drag of pointer.drags) {
        if (drag.button !== 'left' || isSculptModifierIn(drag.held)) {
          continue
        }
        const ends = endsOf(view, drag.currentNdc, drag)
        if (ends && cast(ends.from, ends.to)) {
          targeting = drag.shiftKey
        }
      }

      // Still true on the frame a cast ends targeting, so the drag that cast
      // it does not also land as a selection box.
      return { consumed, targeting: true }
    },
  }
}

/**
 * Carries out a cast's plan on the terrain: one sculpt stamp per centre, each
 * lifting its centre to the crest height and nothing where the ground is
 * already that high, so a bridge raises the strait and leaves the hills at its
 * ends alone. Returns true if any ground moved.
 */
export function layLandBridge(planet: Planet, plan: LandBridgePlan): boolean {
  let moved = false
  for (const stamp of plan.stamps) {
    const lift = plan.height - planet.heightAt(stamp)
    if (lift > 0 && planet.sculpt(stamp, plan.stampRadius, lift)) {
      moved = true
    }
  }
  return moved
}

/** What the HUD says about a bridge the core turned down. */
export function bridgeProblem(result: LandBridge, cost: number): string {
  switch (result) {
    case LandBridge.ok:
      return 'click to raise the land'
    case LandBridge.noShaman:
      return 'the tribe has no shaman'
    case LandBridge.outOfRange:
      return 'too far from the shaman — walk her closer'
    case LandBridge.noShore:
      return 'one end has to touch the shore'
    case LandBridge.dry:
      return 'that is dry land already'
    case LandBridge.noMana:
      return `not enough mana (${cost} needed)`
    default:
      return 'the world is not ready'
  }
}
