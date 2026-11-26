import type { WorldStanding } from '../world/campaign'
import type { MatchOutcome } from '../world/match'

/**
 * The world menu and the panel at the end of a match.
 *
 * Both are plain DOM over the canvas, built from text nodes (a world's name
 * and briefing come from a file anyone can write). Choosing a world is a
 * navigation — `?world=<id>`, `?random=<seed>`, `?editor` — because a world
 * is built once per page: the planet, the core and the renderer go with it.
 * The text each one shows is worked out by the pure functions below, so the
 * tests can hold it without a document.
 */

export type MenuModel = {
  readonly campaign: string
  readonly worlds: readonly (WorldStanding & { readonly name: string })[]
  /** The world being played, to mark in the list. */
  readonly current: string | null
}

export type MenuActions = {
  play: (id: string) => void
  random: () => void
  editor: () => void
  /** A world file the player picked. */
  open: (file: File) => void
  close: () => void
}

export type EndModel = {
  readonly outcome: Exclude<MatchOutcome, 'playing'>
  readonly world: string
  readonly banner: string
  /** The campaign world after this one, once this one is won; null for none. */
  readonly next: { readonly id: string; readonly name: string } | null
  /** Set when the match came from the editor: the button back to it. */
  readonly fromEditor: boolean
}

export type EndActions = {
  next: (id: string) => void
  again: () => void
  menu: () => void
  editor: () => void
}

/** A world's line in the menu. Pure. */
export function standingLabel(world: MenuModel['worlds'][number]): string {
  const mark = world.won ? '✓' : world.open ? '▸' : '🔒'
  return `${mark} ${world.chapter}. ${world.name} — ${world.teaches}`
}

/** The end panel's heading. Pure. */
export function endTitle(outcome: EndModel['outcome']): string {
  return outcome === 'won' ? 'Victory' : outcome === 'lost' ? 'Defeat' : 'Stalemate'
}

export type Menu = {
  readonly open: boolean
  showWorlds: (model: MenuModel, actions: MenuActions) => void
  showEnd: (model: EndModel, actions: EndActions) => void
  hide: () => void
}

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.disabled = disabled
  element.addEventListener('click', () => {
    element.blur()
    onClick()
  })
  return element
}

export function createMenu(parent: HTMLElement = document.body): Menu {
  const panel = document.createElement('div')
  panel.className = 'menu'
  panel.hidden = true
  panel.setAttribute('role', 'dialog')
  parent.append(panel)

  const open = (children: HTMLElement[]) => {
    panel.replaceChildren(...children)
    panel.hidden = false
  }

  return {
    get open() {
      return !panel.hidden
    },
    showWorlds(model, actions) {
      const title = document.createElement('h2')
      title.textContent = model.campaign
      const list = document.createElement('ol')
      list.className = 'menu-worlds'
      for (const world of model.worlds) {
        const item = document.createElement('li')
        const pick = button(standingLabel(world), () => actions.play(world.id), !world.open)
        if (world.id === model.current) {
          pick.classList.add('current')
        }
        item.append(pick)
        list.append(item)
      }
      const file = document.createElement('input')
      file.type = 'file'
      file.accept = '.json,application/json'
      file.hidden = true
      file.addEventListener('change', () => {
        const chosen = file.files?.[0]
        if (chosen) {
          actions.open(chosen)
        }
      })
      const row = document.createElement('div')
      row.className = 'menu-row'
      row.append(
        button('Random world', actions.random),
        button('Open a world file…', () => file.click()),
        button('World editor', actions.editor),
        button('Back to the game', actions.close),
      )
      open([title, list, row, file])
    },
    showEnd(model, actions) {
      const title = document.createElement('h2')
      title.textContent = `${endTitle(model.outcome)} — ${model.world}`
      const text = document.createElement('p')
      text.textContent = model.banner
      const row = document.createElement('div')
      row.className = 'menu-row'
      if (model.next) {
        const next = model.next
        row.append(button(`Next: ${next.name}`, () => actions.next(next.id)))
      }
      row.append(button('Play again', actions.again), button('Worlds', actions.menu))
      if (model.fromEditor) {
        row.append(button('Back to the editor', actions.editor))
      }
      open([title, text, row])
    },
    hide() {
      panel.hidden = true
    },
  }
}
