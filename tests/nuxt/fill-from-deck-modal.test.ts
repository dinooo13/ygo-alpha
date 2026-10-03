import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FillFromDeckModal from '~/components/collections/FillFromDeckModal.vue'
import { setTestLocale } from './fixtures/locale'
import { selectWithOption } from './fixtures/select-wrapper'

const toastAdd = vi.hoisted(() => vi.fn())
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

const collections = [
  { id: 'box-1', name: 'Box 1', description: null, cardCount: 1, visibility: 'private' as const },
  { id: 'box-2', name: 'Deck-Box', description: null, cardCount: 5, visibility: 'private' as const },
]

function fillAnswer(overrides: Record<string, unknown> = {}) {
  return {
    deck: { id: 'deck-1', name: 'Dark Magician Deck' },
    collection: { id: 'box-1', name: 'Box 1' },
    sourceCollectionIds: ['__none__', 'box-2'],
    cards: [
      {
        catalogCardId: 46986414, name: 'Dark Magician', nameDe: null, type: 'Normal Monster', imageSmall: null,
        needed: 3, alreadyInTarget: 1, toMove: 2, missing: 0, ownedElsewhere: 0, notOwned: 0,
        moves: [{ ownedCardId: 's1', fromCollectionId: null, quantity: 2 }],
      },
      {
        catalogCardId: 44095762, name: 'Mirror Force', nameDe: null, type: 'Trap Card', imageSmall: null,
        needed: 3, alreadyInTarget: 0, toMove: 1, missing: 2, ownedElsewhere: 1, notOwned: 1,
        moves: [{ ownedCardId: 's2', fromCollectionId: 'box-2', quantity: 1 }],
      },
      {
        catalogCardId: 44508094, name: 'Stardust Dragon', nameDe: null, type: 'Synchro Monster', imageSmall: null,
        needed: 1, alreadyInTarget: 0, toMove: 0, missing: 1, ownedElsewhere: 0, notOwned: 1, moves: [],
      },
    ],
    totals: { cards: 3, needed: 7, alreadyInTarget: 1, toMove: 3, missing: 3, notOwned: 2 },
    executed: false,
    moved: 0,
    ...overrides,
  }
}

type Call = [string, { method?: string, body?: Record<string, unknown>, query?: Record<string, unknown> }]

function callsTo(fetchMock: ReturnType<typeof vi.fn>, url: string) {
  return (fetchMock.mock.calls as unknown as Call[]).filter(call => call[0] === url)
}

function stubFetch(extra: (url: string, options: Call[1]) => unknown = () => undefined) {
  const fetchMock = vi.fn(async (url: string, options: Call[1] = {}) => {
    const custom = extra(url, options)
    if (custom !== undefined) {
      return custom
    }
    if (url === '/api/decks/deck-1/fill-collection') {
      return options.body?.dryRun
        ? fillAnswer()
        : fillAnswer({ executed: true, moved: 3 })
    }
    if (url === '/api/decks') {
      return { items: [{ id: 'deck-1', name: 'Dark Magician Deck' }, { id: 'deck-2', name: 'Zweites Deck' }] }
    }
    return {}
  })
  vi.stubGlobal('$fetch', fetchMock)
  return fetchMock
}

const bodyText = () => document.body.textContent ?? ''
const button = (label: string) => [...document.querySelectorAll('button')].find(element => element.textContent?.includes(label))

afterEach(async () => {
  vi.unstubAllGlobals()
  toastAdd.mockClear()
  document.body.innerHTML = ''
  await setTestLocale('de')
})

enableAutoUnmount(afterEach)

describe('FillFromDeckModal', () => {
  it('previews what a deck needs, with the sources in order and the target left out', async () => {
    const fetchMock = stubFetch()

    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })
    await vi.waitFor(() => expect(bodyText()).toContain('Wird verschoben'))

    // A dry run first, "ohne Sammlung" before the other collections, never the target itself.
    expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')[0]![1]).toEqual({
      method: 'POST',
      body: { collectionId: 'box-1', sourceCollectionIds: ['__none__', 'box-2'], dryRun: true },
    })
    const text = bodyText()
    expect(text).toContain('3 zu verschieben')
    expect(text).toContain('1 schon in der Sammlung')
    expect(text).toContain('3 fehlen')
    expect(text).toContain('Dark Magician')
    expect(text).toContain('×2')
    expect(text).toContain('2 aus Ohne Sammlung')
    expect(text).toContain('1 aus Deck-Box')
    // The shortfall says what is missing and what lies in other collections.
    expect(document.querySelector('[data-testid="fill-shortfall"]')!.textContent).toContain('Mirror Force')
    expect(document.querySelector('[data-testid="fill-shortfall"]')!.textContent).toContain('2 fehlen · 1 in anderen Sammlungen')
    // Nothing is moved before "Sammlung befüllen".
    expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(1)
  })

  it('moves the copies and shows the result with the shortfall', async () => {
    const fetchMock = stubFetch()
    const component = await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })
    await vi.waitFor(() => expect(button('Sammlung befüllen')!.disabled).toBe(false))

    button('Sammlung befüllen')!.click()
    await vi.waitFor(() => expect(bodyText()).toContain('3 Karten nach „Box 1“ verschoben.'))

    const run = callsTo(fetchMock, '/api/decks/deck-1/fill-collection')[1]![1]
    expect(run).toEqual({ method: 'POST', body: { collectionId: 'box-1', sourceCollectionIds: ['__none__', 'box-2'] } })
    expect(component.emitted('done')).toHaveLength(1)
    // Done: the choices are gone, the shortfall stays.
    expect(document.querySelector('[data-testid="fill-shortfall"]')).toBeTruthy()
    expect(button('Sammlung befüllen')).toBeUndefined()
    expect(button('Schließen')).toBeTruthy()
  })

  it('puts the cards nobody owns on the wishlist', async () => {
    const fetchMock = stubFetch()
    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })
    await vi.waitFor(() => expect(button('2 Karten auf die Wunschliste')).toBeTruthy())

    button('2 Karten auf die Wunschliste')!.click()
    await vi.waitFor(() => expect(button('Auf der Wunschliste')!.disabled).toBe(true))

    // Mirror Force (1 not owned at all) and Stardust Dragon: quantities that are really missing.
    expect(callsTo(fetchMock, '/api/wishlist').map(call => call[1].body)).toEqual([
      { catalogCardId: 44095762, quantity: 1 },
      { catalogCardId: 44508094, quantity: 1 },
    ])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '2 Karten auf die Wunschliste gesetzt' }))
  })

  it('plans again without a source the user unticks', async () => {
    const fetchMock = stubFetch()
    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })
    await vi.waitFor(() => expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(1))

    const box = [...document.querySelectorAll('label')].find(label => label.textContent?.trim() === 'Deck-Box')!
    const checkbox = document.getElementById(box.getAttribute('for')!) as HTMLElement
    checkbox.click()

    await vi.waitFor(() => expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(2))
    expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')[1]![1].body).toEqual({
      collectionId: 'box-1',
      sourceCollectionIds: ['__none__'],
      dryRun: true,
    })
  })

  it('asks for the deck when none is given, and for a target before it plans', async () => {
    const fetchMock = stubFetch()
    const component = await mountSuspended(FillFromDeckModal, { props: { open: true, collections } })
    await vi.waitFor(() => expect(callsTo(fetchMock, '/api/decks')).toHaveLength(1))

    // No deck, no target yet: nothing to preview.
    expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(0)
    expect(button('Sammlung befüllen')!.disabled).toBe(true)

    const selects = component.findAllComponents({ name: 'USelect' })
    await vi.waitFor(() => expect(selectWithOption(selects, 'deck-1')).toBeTruthy())
    await selectWithOption(selects, 'deck-1')!.setValue('deck-1')
    expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(0)

    await selectWithOption(selects, 'box-1')!.setValue('box-1')
    await vi.waitFor(() => expect(callsTo(fetchMock, '/api/decks/deck-1/fill-collection')).toHaveLength(1))
    // Only a real collection can be the target.
    expect((selectWithOption(selects, 'box-1')!.props('items') as Array<{ value: string }>).map(item => item.value)).toEqual(['box-1', 'box-2', '__new__'])
  })

  it('says so when there is nothing to move', async () => {
    stubFetch((url, options) => url === '/api/decks/deck-1/fill-collection' && options.body?.dryRun
      ? fillAnswer({ cards: [], totals: { cards: 0, needed: 0, alreadyInTarget: 0, toMove: 0, missing: 0, notOwned: 0 } })
      : undefined)
    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })

    await vi.waitFor(() => expect(bodyText()).toContain('Aus den gewählten Quellen gibt es nichts zu verschieben.'))
    expect(button('Sammlung befüllen')!.disabled).toBe(true)
  })

  it('shows why the preview failed', async () => {
    stubFetch((url) => {
      if (url === '/api/decks/deck-1/fill-collection') {
        throw { data: { statusCode: 404, data: { code: 'deck_not_found' } } }
      }
      return undefined
    })
    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe('Dieses Deck gibt es nicht mehr.'))
  })

  it('renders in English', async () => {
    await setTestLocale('en')
    stubFetch()
    await mountSuspended(FillFromDeckModal, { props: { open: true, deckId: 'deck-1', collectionId: 'box-1', collections } })
    await vi.waitFor(() => expect(bodyText()).toContain('Will be moved'))

    expect(bodyText()).toContain('Fill collection from deck')
    expect(bodyText()).toContain('3 to move')
    expect(bodyText()).toContain('2 from No collection')
    expect(bodyText()).toContain('Take cards from')
    expect(bodyText()).not.toMatch(/Sammlung befüllen|verschieben|fehlen|Quelle/)
  })
})
