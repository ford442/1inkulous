import { screenRay } from '../engine/picking'
import type { Vec3 } from '../engine/math'
import type { Game } from '../game/game'
import { isSculptModifierHeld } from '../game/sculpt'
import type { InputSnapshot } from '../input/input'
import type { Simulation } from '../sim/simulation'
import type { Hud } from '../ui/hud'
import { saveDraft } from '../world/campaign'
import { roundVec, TRIBE_NAMES } from '../world/build'
import {
  PERSONALITY_NAMES,
  SPELL_KEYS,
  type GeneratedTerrainSpec,
  type Scenario,
  type SpellKey,
  type TribeSpec,
  type UnlockSpec,
} from '../world/schema'
import {
  addTribe,
  eraseNear,
  exportWorld,
  importWorld,
  placeHut,
  placeTree,
  placeUnit,
  regenerate,
  removeTribe,
  setDetails,
  setGround,
  setSpell,
  setVictory,
  updateTribe,
  type Tool,
} from './document'

/**
 * The world editor: `?editor` opens the world being played (or the draft the
 * menu handed over) as a document, and every change is a new document built
 * again on the same planet by the game's own builder. So the picture is the
 * world the file will load as, problems and all, and Export writes exactly
 * the document.
 *
 *   hold C          sculpt, as in play: left raises, right lowers, Shift-left
 *                   flattens; the ground is saved as an exact height field
 *                   once the stroke ends
 *   click           the tool: a brave, warrior or shaman of the chosen tribe,
 *                   a dwelling or training hut, a tree, or erase the nearest
 *   right-drag      orbits, wheel zooms, as in play
 *
 * The panel holds the rest: the world's name and seed, the generator and its
 * parameters, every tribe and who plays it, the spells and the ways to win,
 * and Export, Import and Play-test.
 */

export type EditorContext = {
  game: Game
  simulation: Simulation
  hud: Hud
  goTo: (query: Record<string, string>) => void
}

export type Editor = {
  readonly document: Scenario
  readonly tool: Tool
  update: (deltaMs: number, input: InputSnapshot, aspect: number) => void
}

/** Radians round a click within which Erase finds something. */
const ERASE_REACH = 0.06
/** A hut's pad on exact ground is levelled this wide, in footprints, as the builder does. */
const PAD_SCALE = 1.8

const TOOLS: readonly { readonly label: string; readonly tool: Tool }[] = [
  { label: 'Brave', tool: { kind: 'unit', role: 'brave' } },
  { label: 'Warrior', tool: { kind: 'unit', role: 'warrior' } },
  { label: 'Shaman', tool: { kind: 'unit', role: 'shaman' } },
  { label: 'Dwelling', tool: { kind: 'hut', hut: 'dwelling' } },
  { label: 'Training hut', tool: { kind: 'hut', hut: 'training' } },
  { label: 'Tree', tool: { kind: 'tree' } },
  { label: 'Erase', tool: { kind: 'erase' } },
]

const GENERATOR_FIELDS: readonly { key: keyof Omit<GeneratedTerrainSpec, 'kind'>; label: string; step: number }[] = [
  { key: 'seed', label: 'terrain seed', step: 1 },
  { key: 'land', label: 'land', step: 0.01 },
  { key: 'continents', label: 'continents', step: 1 },
  { key: 'continentSize', label: 'continent size', step: 0.05 },
  { key: 'warp', label: 'warp', step: 0.05 },
  { key: 'ridges', label: 'ridges', step: 0.05 },
  { key: 'relief', label: 'relief', step: 0.25 },
]

const GENERATOR_DEFAULTS: Omit<GeneratedTerrainSpec, 'kind'> = {
  seed: 1,
  land: 0.4,
  continents: 3,
  continentSize: 0.8,
  warp: 0.25,
  ridges: 0.3,
  relief: 1.5,
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (HTMLElement | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  return element('label', {}, [element('span', { textContent: text }), control])
}

function download(name: string, text: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

export function createEditor(context: EditorContext): Editor {
  const { game, simulation, hud, goTo } = context
  let doc: Scenario = game.world.baked
  let tool: Tool = TOOLS[0]!.tool
  let tribe = doc.tribes[0]!.tribe
  let note = 'opened'
  let sculpting = false

  /** Builds `next` and makes it the document; says what went wrong if it would not build. */
  const commit = (next: Scenario, what: string) => {
    try {
      game.rebuild(next)
      doc = next
      note = game.world.problems.length > 0 ? `${what} — ${game.world.problems.join('; ')}` : what
    } catch (error) {
      note = `${what} refused: ${error instanceof Error ? error.message : String(error)}`
      // Put the last good world back on the planet.
      game.rebuild(doc)
    }
    render()
  }

  // --- the panel --------------------------------------------------------------

  const panel = element('div', { className: 'editor' })
  document.body.append(panel)
  const status = element('p', { className: 'editor-status' })

  function numberInput(value: number, step: number, onChange: (value: number) => void): HTMLInputElement {
    const input = element('input', { type: 'number', value: String(value), step: String(step) })
    input.addEventListener('change', () => {
      const parsed = Number(input.value)
      if (Number.isFinite(parsed)) {
        onChange(parsed)
      }
    })
    return input
  }

  function textInput(value: string, onChange: (value: string) => void): HTMLInputElement {
    const input = element('input', { type: 'text', value })
    input.addEventListener('change', () => onChange(input.value))
    return input
  }

  function select<T extends string>(options: readonly T[], value: T, onChange: (value: T) => void): HTMLSelectElement {
    const control = element(
      'select',
      {},
      options.map((option) => element('option', { value: option, textContent: option, selected: option === value })),
    )
    control.addEventListener('change', () => onChange(control.value as T))
    return control
  }

  function unlockControl(spell: SpellKey): HTMLElement {
    const current: UnlockSpec = doc.rules?.spells?.[spell] ?? 'now'
    const mode = typeof current === 'number' ? 'at' : current
    const count = numberInput(typeof current === 'number' ? current : 20, 1, (n) =>
      commit(setSpell(doc, spell, Math.max(1, Math.round(n))), `${spell} unlocks at ${n}`),
    )
    count.hidden = mode !== 'at'
    const kind = select(['now', 'never', 'at'] as const, mode, (next) =>
      commit(
        setSpell(doc, spell, next === 'at' ? Math.max(1, Math.round(Number(count.value) || 20)) : next),
        `${spell}: ${next}`,
      ),
    )
    return labelled(spell, element('span', {}, [kind, count]))
  }

  function tribeRow(spec: TribeSpec): HTMLElement {
    const slot = spec.tribe
    const personality = typeof spec.ai === 'string' ? spec.ai : (spec.ai?.personality ?? 'steady')
    const row = element('fieldset', { className: slot === tribe ? 'current' : '' }, [
      element('legend', { textContent: `${TRIBE_NAMES[slot]} — ${spec.name ?? 'unnamed'}` }),
      labelled('name', textInput(spec.name ?? '', (name) => commit(updateTribe(doc, slot, { name: name || undefined }), 'renamed'))),
      labelled(
        'played by',
        select(slot === 0 ? (['player', 'ai', 'none'] as const) : (['ai', 'none'] as const), spec.control === 'player' && slot !== 0 ? 'ai' : spec.control, (control) =>
          commit(updateTribe(doc, slot, { control }), `${TRIBE_NAMES[slot]} is ${control}`),
        ),
      ),
      labelled(
        'personality',
        select(PERSONALITY_NAMES, personality, (ai) => commit(updateTribe(doc, slot, { ai }), `${TRIBE_NAMES[slot]} plays ${ai}`)),
      ),
      labelled('wood', numberInput(spec.wood ?? 0, 5, (wood) => commit(updateTribe(doc, slot, { wood: Math.max(0, Math.round(wood)) }), 'wood set'))),
      labelled('mana', numberInput(spec.mana ?? 0, 50, (mana) => commit(updateTribe(doc, slot, { mana: Math.min(1000, Math.max(0, mana)) }), 'mana set'))),
      element('div', { className: 'editor-row' }, [
        button('place for this tribe', () => {
          tribe = slot
          render()
        }),
        ...(doc.tribes.length > 1 ? [button('remove', () => commit(removeTribe(doc, slot), `${TRIBE_NAMES[slot]} removed`))] : []),
      ]),
    ])
    return row
  }

  function button(label: string, onClick: () => void): HTMLButtonElement {
    const control = element('button', { type: 'button', textContent: label })
    control.addEventListener('click', () => {
      control.blur()
      onClick()
    })
    return control
  }

  function render() {
    const terrain = doc.planet.terrain
    const generator: Omit<GeneratedTerrainSpec, 'kind'> =
      terrain.kind === 'generated' ? (({ kind: _kind, ...rest }) => rest)(terrain) : GENERATOR_DEFAULTS
    // What the generator fields show and edit: the world's own, else the defaults.
    const fields: Record<string, number> = {}
    for (const [key, value] of Object.entries({ ...GENERATOR_DEFAULTS, ...generator })) {
      if (typeof value === 'number') {
        fields[key] = value
      }
    }
    const victory = doc.rules?.victory ?? []
    const survive = victory.find((v) => v.kind === 'survive')
    const population = victory.find((v) => v.kind === 'population')
    const file = element('input', { type: 'file', accept: '.json,application/json', hidden: true })
    file.addEventListener('change', () => {
      const chosen = file.files?.[0]
      if (!chosen) {
        return
      }
      void chosen.text().then((text) => {
        try {
          const loaded = importWorld(text, chosen.name)
          if (loaded.planet.resolution !== doc.planet.resolution) {
            // Another size of planet: a new page builds it.
            saveDraft(exportWorld(loaded))
            goTo({ editor: '', draft: '' })
            return
          }
          commit(loaded, `imported ${chosen.name}`)
        } catch (error) {
          note = error instanceof Error ? error.message : String(error)
          render()
        }
      })
    })

    panel.replaceChildren(
      element('h2', { textContent: 'World editor' }),
      element('fieldset', {}, [
        element('legend', { textContent: 'World' }),
        labelled('name', textInput(doc.name, (name) => commit(setDetails(doc, { name: name || doc.name }), 'renamed'))),
        labelled('id', textInput(doc.id, (id) => commit(setDetails(doc, { id }), 'id set'))),
        labelled('match seed', numberInput(doc.seed, 1, (seed) => commit(setDetails(doc, { seed: Math.abs(Math.round(seed)) >>> 0 }), 'match seed set'))),
        labelled(
          'briefing',
          (() => {
            const area = element('textarea', { value: doc.description ?? '', rows: 3 })
            area.addEventListener('change', () => commit(setDetails(doc, { description: area.value || undefined }), 'briefing set'))
            return area
          })(),
        ),
      ]),
      element('fieldset', {}, [
        element('legend', {
          textContent: `Ground — ${terrain.kind === 'generated' ? 'generated' : terrain.kind === 'heights' ? 'sculpted (exact heights)' : 'flat'}`,
        }),
        ...GENERATOR_FIELDS.map((field) =>
          labelled(field.label, numberInput(fields[field.key] ?? 0, field.step, (value) => (fields[field.key] = value))),
        ),
        element('div', { className: 'editor-row' }, [
          button('Generate', () => commit(regenerate(doc, { ...generator, ...fields } as Omit<GeneratedTerrainSpec, 'kind'>), 'ground generated')),
          button('New terrain seed', () =>
            commit(regenerate(doc, { ...generator, ...fields, seed: Date.now() % 100_000 } as Omit<GeneratedTerrainSpec, 'kind'>), 'new ground'),
          ),
        ]),
      ]),
      element('fieldset', {}, [
        element('legend', { textContent: `Tool — click to place for ${TRIBE_NAMES[tribe]}` }),
        element(
          'div',
          { className: 'editor-row' },
          TOOLS.map((entry) => {
            const control = button(entry.label, () => {
              tool = entry.tool
              render()
            })
            if (JSON.stringify(entry.tool) === JSON.stringify(tool)) {
              control.classList.add('current')
            }
            return control
          }),
        ),
      ]),
      element('fieldset', {}, [
        element('legend', { textContent: 'Tribes' }),
        ...doc.tribes.map(tribeRow),
        ...(doc.tribes.length < 4
          ? [
              button('Add a tribe', () => {
                const next = addTribe(doc)
                if (next) {
                  tribe = next.tribes[next.tribes.length - 1]!.tribe
                  tool = { kind: 'unit', role: 'shaman' }
                  commit(next, `${TRIBE_NAMES[tribe]} added: place its shaman`)
                }
              }),
            ]
          : []),
      ]),
      element('fieldset', {}, [
        element('legend', { textContent: 'Rules' }),
        labelled('win by surviving (s, 0 off)', numberInput(survive?.seconds ?? 0, 30, (s) => commit(setVictory(doc, Math.max(0, s), population?.count ?? 0), 'victory set'))),
        labelled('win by growing to (0 off)', numberInput(population?.count ?? 0, 5, (n) => commit(setVictory(doc, survive?.seconds ?? 0, Math.max(0, n)), 'victory set'))),
        ...SPELL_KEYS.map(unlockControl),
      ]),
      element('div', { className: 'editor-row' }, [
        button('Export', () => {
          download(`${doc.id}.json`, exportWorld(doc))
          note = `exported ${doc.id}.json`
          render()
        }),
        button('Import…', () => file.click()),
        button('Play-test', () => {
          saveDraft(exportWorld(doc))
          goTo({ draft: '' })
        }),
        button('Leave the editor', () => goTo({})),
      ]),
      file,
      status,
    )
    status.textContent =
      `${note} · ${simulation.followerCount} people · ${simulation.hutCount} huts · ` +
      `${simulation.treeCount} trees`
  }

  render()
  hud.setStatus(`editing ${doc.name}: hold C to sculpt, click to place; the panel has the rest`)

  // --- the planet -------------------------------------------------------------

  /** The walkable node under `direction`, as a unit direction: where a click places. */
  const snapped = (direction: Vec3): Vec3 | null => {
    const node = simulation.nearestWalkableNode(direction)
    if (node < 0) {
      return null
    }
    const d = game.terrain.graph.directions
    const length = Math.hypot(d[node * 3]!, d[node * 3 + 1]!, d[node * 3 + 2]!)
    return roundVec([d[node * 3]! / length, d[node * 3 + 1]! / length, d[node * 3 + 2]! / length])
  }

  function apply(at: Vec3) {
    switch (tool.kind) {
      case 'erase': {
        const { doc: next, erased } = eraseNear(doc, at, ERASE_REACH)
        if (erased) {
          commit(next, `erased ${erased}`)
        } else {
          note = 'nothing there to erase'
          render()
        }
        return
      }
      case 'tree': {
        const where = snapped(at)
        if (where) commit(placeTree(doc, where), 'tree planted')
        return
      }
      case 'unit': {
        const where = snapped(at)
        if (where) commit(placeUnit(doc, tribe, tool.role, where), `${TRIBE_NAMES[tribe]} ${tool.role} placed`)
        return
      }
      case 'hut': {
        const where = roundVec(at)
        const home = game.world.tribes.find((t) => t.tribe === tribe)?.home ?? null
        // Door towards the tribe's home, or anywhere.
        const toward: Vec3 = home ?? [0, 1, 0]
        const along = where[0] * toward[0] + where[1] * toward[1] + where[2] * toward[2]
        const door = roundVec([toward[0] - where[0] * along, toward[1] - where[1] * along, toward[2] - where[2] * along])
        let next = doc
        if (doc.planet.terrain.kind === 'heights') {
          // Exact ground is taken as it is, so the pad is levelled here.
          const footprint = simulation.hutSite(where).footprint
          simulation.flattenTerrain(where, footprint * PAD_SCALE, simulation.terrainHeightAt(where), 1)
          next = setGround(doc, simulation.navHeights())
        }
        commit(placeHut(next, tribe, tool.hut, where, Math.hypot(...door) > 1e-6 ? door : [1, 0, 0]), `${tool.hut} built`)
        return
      }
    }
  }

  return {
    get document() {
      return doc
    },
    get tool() {
      return tool
    },
    update(deltaMs, input, aspect) {
      const sculptHeld = isSculptModifierHeld(input)
      game.camera.update(deltaMs, input, { allowPointerOrbit: !sculptHeld, allowPointerZoom: !sculptHeld })
      game.sculptor.update(deltaMs, input, { camera: game.camera, aspect })
      const stroking = game.sculptor.mode !== 'idle'
      if (sculpting && !stroking) {
        // The stroke is over: the ground as it now stands is the world's.
        commit(setGround(doc, simulation.navHeights()), 'ground sculpted')
      }
      sculpting = stroking
      if (!sculptHeld) {
        for (const click of input.pointer.clicks) {
          if (click.button !== 'left') {
            continue
          }
          const direction = game.planet.pickDirection(screenRay(game.camera, click.ndc.x, click.ndc.y, aspect))
          if (direction) {
            apply(direction)
          }
        }
      }
      game.sun.update(deltaMs, input, game.camera.eye)
      game.terrain.syncMesh()
    },
  }
}
