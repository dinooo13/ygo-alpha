import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import EntryReviewRow from '~/components/entry/EntryReviewRow.vue'
import DeckEditorPage from '~/pages/decks/[id].vue'
import WishlistPage from '~/pages/wishlist.vue'
import type { EntryRow } from '~/utils/card-entry'
import type { OwnProfile, WishlistItemView, WishlistResponse } from '~~/shared/sharing'

// The card overlay (#114) from the deck editor, the wishlist and quick
// entry, and the shared quantity stepper in the deck and wishlist rows (#144).

const DARK_MAGICIAN = 46986414
const KURIBOH = 40640057

// UModal teleports its content to <body>.
function body() {
  return new DOMWrapper(document.body)
}

function catalogDetail(id: number, name: string) {
  return {
    card: {
      id,
      name,
      nameDe: null,
      type: 'Normal Monster',
      frameType: 'normal',
      desc: `The card text of ${name}.`,
      descDe: null,
      race: 'Spellcaster',
      archetype: null,
      attribute: 'DARK',
      atk: 2500,
      def: 2100,
      level: 7,
      linkval: null,
      scale: null,
      linkMarkers: null,
      banlistInfo: null,
      cardPrices: null,
      tcgDate: null,
      ocgDate: null,
      ygoprodeckUrl: null,
    },
    printings: [],
    images: [],
  }
}

function deckRow(quantity: number) {
  return {
    catalogCardId: DARK_MAGICIAN,
    name: 'Dark Magician',
    nameDe: null,
    type: 'Normal Monster',
    frameType: 'normal',
    attribute: 'DARK',
    race: 'Spellcaster',
    level: 7,
    atk: 2500,
    def: 2100,
    imageSmall: null,
    section: 'main',
    quantity,
    owned: 3,
    usedInDeck: quantity,
    shortfall: 0,
    retired: false,
  }
}

function deckDetail(quantity: number) {
  return {
    id: 'deck-1',
    name: 'Test Deck',
    description: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    sections: { main: [deckRow(quantity)], extra: [], side: [] },
    counts: { main: quantity, extra: 0, side: 0, total: quantity },
    limits: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15, maxCopies: 3 },
    warnings: [],
    format: null,
    validation: null,
    visibility: 'private',
    cover: null,
    coverIsChosen: false,
    inactiveCoverChoice: null,
  }
}

function wishlistItem(overrides: Partial<WishlistItemView> = {}): WishlistItemView {
  return {
    id: 'wish-1',
    catalogCardId: KURIBOH,
    name: 'Kuriboh',
    nameDe: null,
    type: 'Effect Monster',
    imageSmall: null,
    retired: false,
    quantity: 1,
    note: null,
    owned: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const state = vi.hoisted(() => ({
  deck: {} as Record<string, unknown>,
  source: {
    items: [{
      catalogCardId: 46986414,
      name: 'Dark Magician',
      type: 'Normal Monster',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 7,
      imageSmall: null,
      totalQuantity: 3,
    }] as Array<Record<string, unknown>>,
    total: 1,
  },
  wishlist: { items: [], total: 0, page: 1, pageSize: 24 } as WishlistResponse,
  profile: {
    userId: 'user-a',
    handle: 'fabian',
    displayName: 'Fabian',
    bio: null,
    inventoryVisibility: 'private',
    wishlistVisibility: 'private',
    locale: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  } as OwnProfile,
}))

mockNuxtImport('useFetch', () => {
  return (url: string | (() => string)) => {
    const resolvedUrl = typeof url === 'function' ? url() : url
    const result = (data: unknown) => ({ data: ref(data), pending: ref(false), error: ref(null), status: ref('success'), refresh: vi.fn() })

    if (resolvedUrl === '/api/inventory/search' || resolvedUrl === '/api/catalog/cards') {
      return result(state.source)
    }
    if (resolvedUrl === '/api/inventory/search/facets') {
      return result({ types: [], attributes: [] })
    }
    if (resolvedUrl === '/api/inventory/owned-quantities') {
      return result({})
    }
    if (resolvedUrl === '/api/formats') {
      return result({ items: [] })
    }
    if (resolvedUrl === '/api/profile') {
      return result(state.profile)
    }
    if (resolvedUrl === '/api/wishlist') {
      return result(state.wishlist)
    }
    return result(state.deck)
  }
})

mockNuxtImport('useRoute', () => {
  return () => ({ path: '/decks/deck-1', params: { id: 'deck-1' }, query: {} })
})

// Every `$fetch`: the overlay's card detail, deck and wishlist writes. Nuxt's
// own helpers use `$fetch` too and get `null`.
function stubFetch(handlers: Record<string, (options?: Record<string, unknown>) => unknown> = {}) {
  const mock = vi.fn((url: string, options?: Record<string, unknown>) => {
    if (url === `/api/catalog/cards/${DARK_MAGICIAN}`) {
      return Promise.resolve(catalogDetail(DARK_MAGICIAN, 'Dark Magician'))
    }
    if (url === `/api/catalog/cards/${KURIBOH}`) {
      return Promise.resolve(catalogDetail(KURIBOH, 'Kuriboh'))
    }
    const handler = handlers[url]
    return Promise.resolve(handler ? handler(options) : null)
  })
  vi.stubGlobal('$fetch', mock)
  return mock
}

function callsTo(mock: ReturnType<typeof stubFetch>, url: string) {
  return mock.mock.calls.filter(([calledUrl]) => calledUrl === url).map(([, options]) => options)
}

async function expectOverlayFor(name: string) {
  await vi.waitFor(() => {
    const dialog = body().find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.find('h2').text()).toBe(name)
    expect(dialog.text()).toContain(`The card text of ${name}.`)
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// Unmount each mount before the cleanup above (hooks run in reverse), so a
// teleported overlay is still there to be removed.
enableAutoUnmount(afterEach)

describe('deck editor rows', () => {
  it('open the card overlay from the name', async () => {
    state.deck = deckDetail(2)
    stubFetch()

    const component = await mountSuspended(DeckEditorPage)
    const nameButton = component.findAll('li button[aria-haspopup="dialog"]').find(button => button.text() === 'Dark Magician')
    expect(nameButton).toBeTruthy()
    // The row's name keeps its two-line clamp around the button.
    expect(nameButton!.element.closest('p')!.classList.contains('line-clamp-2')).toBe(true)

    await nameButton!.trigger('click')
    await expectOverlayFor('Dark Magician')
  })

  it('open the card overlay from a card in the add panel', async () => {
    state.deck = deckDetail(2)
    stubFetch()

    const component = await mountSuspended(DeckEditorPage)
    const panelButton = component.findAll('#deck-add-panel button[aria-haspopup="dialog"]').find(button => button.text() === 'Dark Magician')
    expect(panelButton).toBeTruthy()

    await panelButton!.trigger('click')
    await expectOverlayFor('Dark Magician')
  })

  it('step the quantity with the shared stepper (#144)', async () => {
    state.deck = deckDetail(2)
    const mock = stubFetch({ '/api/decks/deck-1/cards': () => deckDetail(3) })

    const component = await mountSuspended(DeckEditorPage)
    await component.find('[aria-label="Eine Kopie von Dark Magician zum Main Deck hinzufügen"]').trigger('click')
    await flushPromises()

    expect(callsTo(mock, '/api/decks/deck-1/cards')).toEqual([
      { method: 'PUT', body: { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 3 } },
    ])
    // The overlay stays shut: the stepper is above the row's link.
    expect(body().find('[role="dialog"]').exists()).toBe(false)
  })

  it('take a typed quantity (#144)', async () => {
    state.deck = deckDetail(2)
    const mock = stubFetch({ '/api/decks/deck-1/cards': () => deckDetail(3) })

    const component = await mountSuspended(DeckEditorPage)
    const input = component.find('input[aria-label="Anzahl von Dark Magician im Main Deck"]')
    await input.setValue('3')
    await input.trigger('change')
    await flushPromises()

    expect(callsTo(mock, '/api/decks/deck-1/cards')).toEqual([
      { method: 'PUT', body: { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 3 } },
    ])
  })
})

describe('wishlist rows', () => {
  it('open the card overlay from the name', async () => {
    state.wishlist = { items: [wishlistItem()], total: 1, page: 1, pageSize: 24 }
    stubFetch()

    const component = await mountSuspended(WishlistPage)
    const nameButton = component.findAll('li button[aria-haspopup="dialog"]').find(button => button.text() === 'Kuriboh')
    expect(nameButton).toBeTruthy()

    await nameButton!.trigger('click')
    await expectOverlayFor('Kuriboh')
  })

  it('take a typed quantity, and − stays disabled at 1 (#144)', async () => {
    state.wishlist = { items: [wishlistItem({ quantity: 1 })], total: 1, page: 1, pageSize: 24 }
    const mock = stubFetch({ '/api/wishlist/wish-1': () => wishlistItem({ quantity: 5 }) })

    const component = await mountSuspended(WishlistPage)
    expect(component.find('[aria-label="Ein Exemplar von Kuriboh entfernen"]').attributes('disabled')).toBeDefined()

    const input = component.find<HTMLInputElement>('input[aria-label="Anzahl von Kuriboh"]')
    expect(input.element.value).toBe('1')
    await input.setValue('5')
    await input.trigger('change')
    await flushPromises()

    expect(callsTo(mock, '/api/wishlist/wish-1')).toEqual([{ method: 'PATCH', body: { quantity: 5 } }])
    expect(body().find('[role="dialog"]').exists()).toBe(false)
  })
})

describe('quick entry review row', () => {
  it('opens the selected card\'s overlay from its name', async () => {
    const row: EntryRow = {
      id: 'row-1',
      raw: 'Dark Magician',
      query: 'Dark Magician',
      quantity: 1,
      setCode: null,
      printingId: null,
      conflict: false,
      collectionId: null,
      candidates: [{
        cardId: DARK_MAGICIAN,
        name: 'Dark Magician',
        nameDe: null,
        type: 'Normal Monster',
        frameType: 'normal',
        imageSmall: null,
        score: 1,
        matchedBy: 'exact',
      }],
      selectedCardId: DARK_MAGICIAN,
    }
    const mock = stubFetch()

    const component = await mountSuspended(EntryReviewRow, { props: { row, collections: [] } })
    // Nothing loads before it opens.
    expect(callsTo(mock, `/api/catalog/cards/${DARK_MAGICIAN}`)).toEqual([])

    const nameButton = component.findAll('button[aria-haspopup="dialog"]').find(button => button.text() === 'Dark Magician')
    expect(nameButton).toBeTruthy()
    await nameButton!.trigger('click')
    await expectOverlayFor('Dark Magician')
  })
})
