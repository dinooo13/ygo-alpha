// Printings in the inventory UI (#176, ADR 0034): the optional picker in
// "Karte hinzufügen", the printing on "Liste" rows and "Galerie" tiles, and
// the "Set / Printing" filter.

import { mountSuspended } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import AddToInventoryModal from '~/components/inventory/AddToInventoryModal.vue'
import InventoryCardTile from '~/components/inventory/InventoryCardTile.vue'
import InventoryListRow from '~/components/inventory/InventoryListRow.vue'
import InventorySearchPanel from '~/components/inventory/InventorySearchPanel.vue'
import type { InventorySearchFilters } from '~/components/inventory/InventorySearchPanel.vue'
import { setTestLocale } from './fixtures/locale'

const LOB = '46986414|LOB-005|UR'
const SDY = '46986414|SDY-006|UR'
const printings = [
  { id: LOB, setCode: 'LOB-005', setName: 'Legend of Blue Eyes White Dragon', rarity: 'Ultra Rare', rarityCode: 'UR' },
  { id: SDY, setCode: 'SDY-006', setName: 'Starter Deck: Yugi', rarity: 'Ultra Rare', rarityCode: 'UR' },
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
}

function printingSelect(component: VueWrapper): PropsWrapper {
  return component.findComponent({ name: 'InventoryPrintingSelect' }) as unknown as PropsWrapper
}

describe('AddToInventoryModal printing (ADR 0034)', () => {
  async function mountModal() {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/printings') ? { items: printings } : { id: 'stack-1' })
    vi.stubGlobal('$fetch', fetchMock)
    const component = await mountSuspended(AddToInventoryModal, {
      props: { open: true, card: { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }, collections: [] },
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

  it('offers the card\'s printings, optional, and posts "printing unknown" by default', async () => {
    const { component, fetchMock } = await mountModal()

    expect(fetchMock).toHaveBeenCalledWith('/api/catalog/cards/46986414/printings')
    expect(document.body.textContent).toContain('Printing')
    expect(document.body.textContent).toContain('Ohne Angabe bleibt das Printing unbekannt.')
    const select = printingSelect(component)
    expect(select.props('printings')).toEqual(printings)
    expect(select.props('modelValue')).toBeNull()
    const items = select.findComponent({ name: 'USelectMenu' }).props('items') as Array<{ label: string, description?: string, value: string }>
    expect(items).toEqual([
      { label: 'Printing unbekannt', value: '__unknown__' },
      { label: 'LOB-005 · Ultra Rare (UR)', description: 'Legend of Blue Eyes White Dragon', value: LOB },
      { label: 'SDY-006 · Ultra Rare (UR)', description: 'Starter Deck: Yugi', value: SDY },
    ])

    submit()
    await flushPromises()
    expect(posts(fetchMock)[0]![1]!.body).toMatchObject({ catalog_card_id: 46986414, printing_id: null, quantity: 1 })
  })

  it('posts the picked printing', async () => {
    const { component, fetchMock } = await mountModal()

    await printingSelect(component).findComponent({ name: 'USelectMenu' }).vm.$emit('update:modelValue', SDY)
    await nextTick()
    expect(printingSelect(component).props('modelValue')).toBe(SDY)

    submit()
    await flushPromises()
    expect(posts(fetchMock)[0]![1]!.body).toMatchObject({ printing_id: SDY })
  })
})

describe('InventoryListRow printing', () => {
  const base = {
    id: 'stack-1',
    collectionId: null,
    quantity: 2,
    cardName: 'Dark Magician',
    cardType: 'Normal Monster',
    imageUrlSmall: null,
  }

  it('shows a known printing with its set name and nothing for an unknown one', async () => {
    const known = await mountSuspended(InventoryListRow, {
      props: {
        item: { ...base, printingSetCode: 'LOB-005', printingRarity: 'Ultra Rare', printingRarityCode: 'UR', printingSetName: 'Legend of Blue Eyes White Dragon' },
        collectionLabel: '(keine Sammlung)',
        showCollection: true,
      },
    })
    const printing = known.find('[data-testid="row-printing"]')
    expect(printing.text()).toBe('Printing: LOB-005 (UR)')
    expect(printing.attributes('title')).toBe('Legend of Blue Eyes White Dragon')

    const unknown = await mountSuspended(InventoryListRow, {
      props: { item: { ...base, printingSetCode: null }, collectionLabel: '(keine Sammlung)', showCollection: true },
    })
    expect(unknown.find('[data-testid="row-printing"]').exists()).toBe(false)
  })
})

describe('InventoryCardTile printings', () => {
  const tile = {
    catalogCardId: 46986414,
    name: 'Dark Magician',
    type: 'Normal Monster',
    attribute: 'DARK',
    race: 'Spellcaster',
    level: 7,
    atk: 2500,
    def: 2100,
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
            { printingId: LOB, setCode: 'LOB-005', rarity: 'Ultra Rare', rarityCode: 'UR', quantity: 2 },
            { printingId: '46986414|LC01-EN004|Quarter Century Secret Rare', setCode: 'LC01-EN004', rarity: 'Quarter Century Secret Rare', rarityCode: null, quantity: 1 },
          ],
        },
      },
    })
    expect(component.find('[data-testid="tile-printings"]').text())
      .toBe('Printings: LOB-005 (UR) ×2 · LC01-EN004 Quarter Century Secret Rare ×1')
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

  it('stays hidden until some copy has a printing', async () => {
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
