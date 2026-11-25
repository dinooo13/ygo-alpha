// Printings in the inventory UI (#176, ADR 0034): set code and rarity in
// "Karte hinzufügen" (the rarity suggesting what YGOPRODeck lists, "Andere
// Seltenheit…" opening the full list), the printing on "Liste" rows and
// "Galerie" tiles, and the "Set / Printing" filter.

import { mountSuspended } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import AddToInventoryModal from '~/components/inventory/AddToInventoryModal.vue'
import InventoryCardTile from '~/components/inventory/InventoryCardTile.vue'
import InventoryListRow from '~/components/inventory/InventoryListRow.vue'
import InventorySearchPanel from '~/components/inventory/InventorySearchPanel.vue'
import RaritySelect from '~/components/inventory/RaritySelect.vue'
import type { InventorySearchFilters } from '~/components/inventory/InventorySearchPanel.vue'
import { RARITIES } from '~~/shared/rarity'
import { setTestLocale } from './fixtures/locale'

const setCodes = [
  { setCode: 'LC01-EN004', setName: 'Legendary Collection', rarities: ['ur', 'qcscr'] },
  { setCode: 'LOB-001', setName: 'Legend of Blue Eyes White Dragon', rarities: ['ur'] },
  { setCode: 'SDK-001', setName: 'Starter Deck: Kaiba', rarities: [] },
]

afterEach(async () => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  await setTestLocale('de')
})

enableAutoUnmount(afterEach)

type FetchCall = [string, { method?: string, body?: Record<string, unknown> } | undefined]

// A component found by name loses its prop types; narrowed to what the tests use.
interface PropsWrapper {
  props: (key: string) => unknown
  vm: { $emit: (event: string, ...args: unknown[]) => void }
  findComponent: (selector: { name: string }) => PropsWrapper
  findAllComponents: (selector: { name: string }) => PropsWrapper[]
}

function named(component: VueWrapper | PropsWrapper, name: string): PropsWrapper {
  return component.findComponent({ name }) as unknown as PropsWrapper
}

type MenuItem = { label: string, value?: string, type?: string }

function labels(menu: PropsWrapper): string[][] {
  return (menu.props('items') as MenuItem[][]).map(group => group.map(item => item.label))
}

describe('AddToInventoryModal printing (ADR 0034)', () => {
  async function mountModal() {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/printings') ? { items: setCodes } : { id: 'stack-1' })
    vi.stubGlobal('$fetch', fetchMock)
    const component = await mountSuspended(AddToInventoryModal, {
      props: { open: true, card: { id: 89631139, name: 'Blue-Eyes White Dragon', type: 'Normal Monster' }, collections: [] },
    })
    await flushPromises()
    return { component, fetchMock }
  }

  function submit() {
    const button = [...document.querySelectorAll('button')].find(entry => entry.textContent?.trim() === 'Hinzufügen')!
    button.click()
  }

  function posts(fetchMock: ReturnType<typeof vi.fn>) {
    return (fetchMock.mock.calls as unknown as FetchCall[]).filter(([url, options]) => url === '/api/inventory' && options?.method === 'POST')
  }

  function setCodeMenu(component: VueWrapper) {
    return named(named(component, 'InventoryPrintingSelect'), 'USelectMenu')
  }

  it('offers the card\'s set codes and posts "unknown" by default', async () => {
    const { component, fetchMock } = await mountModal()

    expect(fetchMock).toHaveBeenCalledWith('/api/catalog/cards/89631139/printings')
    expect(document.body.textContent).toContain('Set-Code und Seltenheit deiner Kopien, beides optional.')
    const select = named(component, 'InventoryPrintingSelect')
    expect(select.props('modelValue')).toEqual({ setCode: null, rarity: null })
    expect(setCodeMenu(component).props('items')).toEqual([
      { label: 'Set-Code unbekannt', value: '__unknown__' },
      { label: 'LC01-EN004', description: 'Legendary Collection', value: 'LC01-EN004' },
      { label: 'LOB-001', description: 'Legend of Blue Eyes White Dragon', value: 'LOB-001' },
      { label: 'SDK-001', description: 'Starter Deck: Kaiba', value: 'SDK-001' },
    ])

    submit()
    await flushPromises()
    expect(posts(fetchMock)[0]![1]!.body).toMatchObject({ catalog_card_id: 89631139, set_code: null, rarity: null, quantity: 1 })
  })

  it('picks the only listed rarity with the set code and posts both', async () => {
    const { component, fetchMock } = await mountModal()

    await setCodeMenu(component).vm.$emit('update:modelValue', 'LOB-001')
    await nextTick()
    expect(named(component, 'InventoryPrintingSelect').props('modelValue')).toEqual({ setCode: 'LOB-001', rarity: 'ur' })

    submit()
    await flushPromises()
    expect(posts(fetchMock)[0]![1]!.body).toMatchObject({ set_code: 'LOB-001', rarity: 'ur' })
  })

  it('suggests the rarities of a set code with several and takes any of the full list', async () => {
    const { component, fetchMock } = await mountModal()

    await setCodeMenu(component).vm.$emit('update:modelValue', 'LC01-EN004')
    await nextTick()
    const rarity = named(component, 'InventoryRaritySelect')
    expect(rarity.props('modelValue')).toBeNull()
    expect(labels(named(rarity, 'USelectMenu'))).toEqual([
      ['Seltenheit unbekannt', 'Ultra Rare (UR)', 'Quarter Century Secret Rare (QCScR)'],
      ['Andere Seltenheit…'],
    ])

    await named(rarity, 'USelectMenu').vm.$emit('update:modelValue', 'scr')
    await nextTick()
    submit()
    await flushPromises()
    expect(posts(fetchMock)[0]![1]!.body).toMatchObject({ set_code: 'LC01-EN004', rarity: 'scr' })
  })
})

describe('InventoryRaritySelect', () => {
  async function mountSelect(props: { suggested?: string[], modelValue?: string | null } = {}) {
    const model = { value: props.modelValue ?? null }
    const component = await mountSuspended(RaritySelect, {
      props: {
        'label': 'Seltenheit',
        'suggested': props.suggested ?? [],
        'modelValue': model.value,
        'onUpdate:modelValue': (value: string | null) => {
          model.value = value
        },
      },
    })
    return { component, model, menu: () => named(component, 'USelectMenu') }
  }

  it('opens the full list, grouped, from "Andere Seltenheit…"', async () => {
    const { menu, model } = await mountSelect({ suggested: ['ur'] })
    expect(labels(menu())).toEqual([['Seltenheit unbekannt', 'Ultra Rare (UR)'], ['Andere Seltenheit…']])

    await menu().vm.$emit('update:modelValue', '__other__')
    await flushPromises()
    // Nothing picked yet; the menu shows every rarity under its group.
    expect(model.value).toBeNull()
    const groups = menu().props('items') as MenuItem[][]
    expect(groups[0]!.map(item => item.label)).toEqual(['Seltenheit unbekannt'])
    expect(groups[1]![0]).toEqual({ type: 'label', label: 'Ohne Folie' })
    expect(groups.flat().filter(item => item.value && !item.value.startsWith('__'))).toHaveLength(RARITIES.length)
    expect(menu().props('open')).toBe(true)
  })

  it('shows the full list at once without suggestions', async () => {
    const { menu } = await mountSelect()
    expect((menu().props('items') as MenuItem[][]).flat().filter(item => item.value && !item.value.startsWith('__'))).toHaveLength(RARITIES.length)
    expect(labels(menu()).flat()).not.toContain('Andere Seltenheit…')
  })

  it('keeps a picked rarity outside the suggestions visible', async () => {
    const { menu } = await mountSelect({ suggested: ['ur'], modelValue: 'qcscr' })
    expect(menu().props('modelValue')).toBe('qcscr')
    expect(labels(menu()).flat()).toContain('Quarter Century Secret Rare (QCScR)')
  })
})

describe('InventoryListRow printing', () => {
  const base = {
    id: 'stack-1',
    collectionId: null,
    quantity: 2,
    cardName: 'Blue-Eyes White Dragon',
    cardType: 'Normal Monster',
    imageUrlSmall: null,
  }

  async function rowPrinting(printing: Record<string, unknown>) {
    const component = await mountSuspended(InventoryListRow, {
      props: { item: { ...base, ...printing }, collectionLabel: '(keine Sammlung)', showCollection: true },
    })
    return component.find('[data-testid="row-printing"]')
  }

  it('shows set code and rarity, with the set name as a tooltip, and nothing when both are unknown', async () => {
    const known = await rowPrinting({ setCode: 'LC01-EN004', rarity: 'qcscr', setName: 'Legendary Collection' })
    expect(known.text()).toBe('Printing: LC01-EN004 (QCScR)')
    expect(known.attributes('title')).toBe('Legendary Collection')

    expect((await rowPrinting({ setCode: null, rarity: 'ur' })).text()).toBe('Printing: Ultra Rare')
    expect((await rowPrinting({ setCode: null, rarity: null })).exists()).toBe(false)
  })
})

describe('InventoryCardTile printings', () => {
  const tile = {
    catalogCardId: 89631139,
    name: 'Blue-Eyes White Dragon',
    type: 'Normal Monster',
    attribute: 'LIGHT',
    race: 'Dragon',
    level: 8,
    atk: 3000,
    def: 2500,
    imageSmall: null,
    totalQuantity: 5,
    collectionBreakdown: [{ collectionId: null, collectionName: null, quantity: 5 }],
  }

  it('lists the known printings with their copies', async () => {
    const component = await mountSuspended(InventoryCardTile, {
      props: {
        item: {
          ...tile,
          printingBreakdown: [
            { setCode: 'LC01-EN004', rarity: 'qcscr', quantity: 2 },
            { setCode: 'LOB-001', rarity: 'ur', quantity: 1 },
            { setCode: null, rarity: 'scr', quantity: 1 },
          ],
        },
      },
    })
    expect(component.find('[data-testid="tile-printings"]').text())
      .toBe('Printings: LC01-EN004 (QCScR) ×2 · LOB-001 (UR) ×1 · Secret Rare ×1')
  })

  it('shows no printing line without known printings', async () => {
    const component = await mountSuspended(InventoryCardTile, { props: { item: { ...tile, printingBreakdown: [] } } })
    expect(component.find('[data-testid="tile-printings"]').exists()).toBe(false)
  })
})

describe('InventorySearchPanel "Set / Printing"', () => {
  function filters(overrides: Partial<InventorySearchFilters> = {}): InventorySearchFilters {
    return { kind: [], type: [], attribute: [], race: [], level: [], set: [], sort: 'name', ...overrides }
  }

  const cardFacets = { types: [], attributes: [], races: [], levels: [] }

  // The set menu is the one whose options are sets or "Printing unbekannt".
  function setMenu(component: VueWrapper) {
    return component.findAllComponents({ name: 'USelectMenu' })
      .find(menu => (menu.props('items') as Array<{ value: unknown }>).some(item => item.value === '__unknown__' || item.value === 'lob'))
  }

  it('stays hidden until some copy has a set code', async () => {
    const component = await mountSuspended(InventorySearchPanel, {
      props: { filters: filters(), facets: { ...cardFacets, sets: [], hasUnknownPrinting: true } },
    })
    expect(setMenu(component)).toBeUndefined()
  })

  it('offers "Printing unbekannt" and the owned sets; Reset clears the choice', async () => {
    const model = filters({ set: ['lob'] })
    const component = await mountSuspended(InventorySearchPanel, {
      props: {
        'filters': model,
        'onUpdate:filters': (value: InventorySearchFilters) => Object.assign(model, value),
        'facets': { ...cardFacets, sets: [{ id: 'lob', name: 'Legend of Blue Eyes White Dragon' }], hasUnknownPrinting: true },
      },
    })

    const menu = setMenu(component)!
    expect(component.html()).toContain('Set / Printing')
    expect(menu.props('items')).toEqual([
      { label: 'Printing unbekannt', value: '__unknown__' },
      { label: 'Legend of Blue Eyes White Dragon', value: 'lob' },
    ])
    expect(menu.props('modelValue')).toEqual(['lob'])

    const reset = component.findAll('button').find(button => button.text() === 'Reset')!
    await reset.trigger('click')
    expect(model.set).toEqual([])
  })
})
