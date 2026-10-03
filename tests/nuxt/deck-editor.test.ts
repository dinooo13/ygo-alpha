import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper as BodyWrapper, enableAutoUnmount, flushPromises } from '@vue/test-utils'
import type { DOMWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { DecksDeckFormModal, UApp, UDropdownMenu, USelect } from '#components'
import DeckEditorPage from '~/pages/decks/[id].vue'
import { optionLabels, selectWithOption } from './fixtures/select-wrapper'
import type { DeckValidation } from '~~/shared/rule-formats'
import { setTestLocale } from './fixtures/locale'

type DeckSection = 'main' | 'extra' | 'side'

interface DeckCardRow {
  catalogCardId: number
  name: string
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  atk: number | null
  def: number | null
  imageSmall: string | null
  section: DeckSection
  quantity: number
  owned: number
  usedInDeck: number
  shortfall: number
  nameDe?: string | null
  retired?: boolean
}

function row(overrides: Partial<DeckCardRow> & { name: string, section: DeckSection }): DeckCardRow {
  return {
    catalogCardId: 46986414,
    type: 'Normal Monster',
    frameType: 'normal',
    attribute: 'DARK',
    race: 'Spellcaster',
    level: 7,
    atk: 2500,
    def: 2100,
    imageSmall: null,
    quantity: 1,
    owned: 1,
    usedInDeck: 1,
    shortfall: 0,
    ...overrides,
  }
}

const state = vi.hoisted(() => ({
  deck: {} as Record<string, unknown>,
  source: { items: [] as Array<Record<string, unknown>>, total: 0 },
  facets: { types: [] as string[], attributes: [] as string[] },
  ownedQuantities: {} as Record<string, number>,
  collections: { items: [] as Array<{ id: string, name: string }>, allCount: 0 },
  /** The add panel's `query` option (a computed), as passed to `useFetch`. */
  sourceQuery: null as unknown,
  formats: {
    items: [
      { id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true },
      { id: 'own-1', name: 'Nur alte Karten', isBuiltin: false },
    ],
  },
}))

mockNuxtImport('useFetch', () => {
  return (url: string | (() => string), options?: { query?: unknown }) => {
    const resolvedUrl = typeof url === 'function' ? url() : url

    if (resolvedUrl === '/api/inventory/search' || resolvedUrl === '/api/catalog/cards') {
      state.sourceQuery = options?.query
      return { data: ref(state.source), pending: ref(false), error: ref(null), refresh: vi.fn() }
    }
    if (resolvedUrl === '/api/inventory/search/facets') {
      return { data: ref(state.facets), pending: ref(false), error: ref(null), refresh: vi.fn() }
    }
    if (resolvedUrl === '/api/inventory/owned-quantities') {
      return { data: ref(state.ownedQuantities), pending: ref(false), error: ref(null), refresh: vi.fn() }
    }
    if (resolvedUrl === '/api/collections') {
      return { data: ref(state.collections), pending: ref(false), error: ref(null), refresh: vi.fn() }
    }
    if (resolvedUrl === '/api/formats') {
      return { data: ref(state.formats), pending: ref(false), error: ref(null), refresh: vi.fn() }
    }
    return { data: ref(state.deck), pending: ref(false), error: ref(null), refresh: vi.fn() }
  }
})

mockNuxtImport('useRoute', () => {
  return () => ({ path: '/decks/deck-1', params: { id: 'deck-1' }, query: {} })
})

function deckDetail(
  sections: Partial<Record<DeckSection, DeckCardRow[]>>,
  warnings: Array<{ code: string, message: string, params?: Record<string, unknown> }> = [],
  format: { id: string, name: string, isBuiltin: boolean } | null = null,
  validation: DeckValidation | null = null,
) {
  const full = { main: [], extra: [], side: [], ...sections } as Record<DeckSection, DeckCardRow[]>
  const count = (section: DeckSection) => full[section].reduce((total, card) => total + card.quantity, 0)

  return {
    format,
    validation,
    id: 'deck-1',
    name: 'Test Deck',
    description: 'Meine Notizen',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    sections: full,
    counts: {
      main: count('main'),
      extra: count('extra'),
      side: count('side'),
      total: count('main') + count('extra') + count('side'),
    },
    limits: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15, maxCopies: 3 },
    warnings,
    cover: null as { catalogCardId: number, name: string, imageSmall: string | null, imageLarge: string | null } | null,
    coverIsChosen: false,
    inactiveCoverChoice: null as { catalogCardId: number, name: string, imageSmall: string | null, imageLarge: string | null } | null,
  }
}

/** A `UCheckbox` by its label text (its `<label for>` points at the checkbox). */
function checkboxByLabel(component: { findAll: (selector: string) => Array<DOMWrapper<Element>>, find: (selector: string) => DOMWrapper<Element> }, text: string) {
  const id = component.findAll('label').find(label => label.text() === text)?.attributes('for')
  return component.find(`[role="checkbox"][id="${id}"]`)
}

// mountSuspended leaves every page mounted; unmount it after each test so a
// later locale switch doesn't re-render all earlier pages.
enableAutoUnmount(afterEach)

afterEach(async () => {
  await setTestLocale('de')
  state.formats = {
    items: [
      { id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true },
      { id: 'own-1', name: 'Nur alte Karten', isBuiltin: false },
    ],
  }
  vi.unstubAllGlobals()
  state.ownedQuantities = {}
})

describe('deck editor', () => {
  it('renders the deck header, section counts against their limits, and warnings', async () => {
    state.source = { items: [], total: 0 }
    state.facets = { types: [], attributes: [] }
    state.deck = deckDetail(
      {
        main: [row({ name: 'Dark Magician', section: 'main', quantity: 3, owned: 2, usedInDeck: 3, shortfall: 1 })],
        extra: [row({
          name: 'Stardust Dragon',
          section: 'extra',
          catalogCardId: 44508094,
          type: 'Synchro Monster',
          frameType: 'synchro',
          level: 8,
        })],
      },
      [{ code: 'main_below_min', message: 'Das Main Deck hat 3 Karten, mindestens 40 sind üblich.' }],
    )

    const component = await mountSuspended(DeckEditorPage)
    const text = component.text()

    expect(text).toContain('Test Deck')
    expect(text).toContain('Meine Notizen')
    expect(text).toContain('4 Karten insgesamt')

    expect(text).toContain('Main Deck')
    expect(text).toContain('3/40–60')
    expect(text).toContain('1/15')
    expect(text).toContain('Noch keine Karten im Side Deck.')

    expect(text).toContain('Das Main Deck hat 3 Karten, mindestens 40 sind üblich.')
    expect(text).toContain('Zurück zu den Decks')

    // No entry point into the assistant (ADR 0021).
    expect(component.find('a[href^="/assistant"]').exists()).toBe(false)
    expect(text).not.toContain('Mit KI')
  })

  it('marks an undersized and an oversized section', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({
      main: [row({ name: 'Pot of Greed', section: 'main', catalogCardId: 55144522, type: 'Spell Card', quantity: 3, owned: 3, usedInDeck: 3 })],
      extra: [row({ name: 'Stardust Dragon', section: 'extra', catalogCardId: 44508094, type: 'Synchro Monster', quantity: 16, owned: 16, usedInDeck: 16 })],
    })

    const component = await mountSuspended(DeckEditorPage)

    const mainCount = component.find('[aria-label="Anzahl im Main Deck"]')
    expect(mainCount.text()).toBe('3/40–60')
    expect(mainCount.attributes('data-state')).toBe('under')

    const extraCount = component.find('[aria-label="Anzahl im Extra Deck"]')
    expect(extraCount.text()).toBe('16/15')
    expect(extraCount.attributes('data-state')).toBe('over')
  })

  it('keeps the retired-card warning when a format validates the deck, and only that one (#109)', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail(
      { main: [row({ name: 'Old Placeholder', section: 'main', catalogCardId: 101402013, retired: true })] },
      [
        { code: 'main_below_min', message: 'x', params: { section: 'main', count: 3, min: 40 } },
        { code: 'card_retired', message: 'x', params: { cardId: 101402013, cardName: 'Old Placeholder' } },
      ],
      { id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true },
      { legal: true, issues: [], cards: {} },
    )

    const component = await mountSuspended(DeckEditorPage)
    const text = component.text()

    expect(text).toContain('Hinweise zum Deckaufbau')
    expect(text).toContain('Old Placeholder ist nicht mehr im Katalog; Banlist-Status und Kartendaten werden nicht mehr aktualisiert.')
    expect(text).not.toContain('mindestens 40 sind üblich')
  })

  it('marks a card YGOPRODeck no longer lists, and only that one (ADR 0019)', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({
      main: [
        row({ name: 'Dark Magician', section: 'main' }),
        row({ name: 'Old Placeholder', section: 'main', catalogCardId: 101402013, retired: true }),
      ],
    })

    // Inside UApp, like in the real app.
    const component = await mountSuspended(defineComponent({
      setup: () => () => h(UApp, null, { default: () => h(DeckEditorPage) }),
    }))

    const badges = component.findAll('[data-testid="card-retired-badge"]')
    expect(badges).toHaveLength(1)
    expect(badges[0]!.text()).toBe('Nicht mehr im Katalog')
    const rows = component.findAll('li')
    expect(rows.find(item => item.text().includes('Old Placeholder'))!.text()).toContain('Nicht mehr im Katalog')
    expect(rows.find(item => item.text().includes('Dark Magician'))!.text()).not.toContain('Nicht mehr im Katalog')
  })

  it('highlights a shortfall on the owned indicator', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({
      main: [
        row({ name: 'Dark Magician', section: 'main', quantity: 3, owned: 2, usedInDeck: 3, shortfall: 1 }),
        row({ name: 'Pot of Greed', section: 'main', catalogCardId: 55144522, type: 'Spell Card', quantity: 1, owned: 4, usedInDeck: 1 }),
      ],
    })

    const component = await mountSuspended(DeckEditorPage)

    const indicators = component.findAll('span[title], span.tabular-nums')
    const shortfallIndicator = indicators.find(element => element.text() === '3/2')
    expect(shortfallIndicator).toBeTruthy()
    expect(shortfallIndicator!.attributes('data-shortfall')).toBeDefined()
    expect(shortfallIndicator!.attributes('title')).toBe('Du besitzt nur 2')

    const okIndicator = indicators.find(element => element.text() === '1/4')
    expect(okIndicator).toBeTruthy()
    expect(okIndicator!.attributes('data-shortfall')).toBeUndefined()
    expect(okIndicator!.attributes('title')).toBeUndefined()
  })

  it('disables the sections a card may not be added to and shows owned/in-deck counts', async () => {
    state.deck = deckDetail({
      main: [row({ name: 'Dark Magician', section: 'main', quantity: 2, owned: 2, usedInDeck: 2 })],
    })
    state.source = {
      items: [
        {
          catalogCardId: 46986414,
          name: 'Dark Magician',
          type: 'Normal Monster',
          attribute: 'DARK',
          race: 'Spellcaster',
          level: 7,
          imageSmall: null,
          totalQuantity: 2,
        },
        {
          catalogCardId: 44508094,
          name: 'Stardust Dragon',
          type: 'Synchro Monster',
          attribute: 'WIND',
          race: 'Dragon',
          level: 8,
          imageSmall: null,
          totalQuantity: 1,
        },
      ],
      total: 2,
    }

    const component = await mountSuspended(DeckEditorPage)

    expect(component.text()).toContain('Aus Inventar hinzufügen')
    expect(component.text()).toContain('Auch Katalogkarten anzeigen')
    // Owned quantity and how many copies are already in this deck.
    expect(component.text()).toContain('Besitz: 2')

    const buttonFor = (card: string, section: string) =>
      component.find(`[aria-label="${card} zum ${section} hinzufügen"]`)

    // A main-deck card cannot go into the extra deck, and vice versa.
    expect(buttonFor('Dark Magician', 'Main Deck').attributes('disabled')).toBeUndefined()
    expect(buttonFor('Dark Magician', 'Extra Deck').attributes('disabled')).toBeDefined()
    expect(buttonFor('Dark Magician', 'Side Deck').attributes('disabled')).toBeUndefined()

    expect(buttonFor('Stardust Dragon', 'Main Deck').attributes('disabled')).toBeDefined()
    expect(buttonFor('Stardust Dragon', 'Extra Deck').attributes('disabled')).toBeUndefined()
    expect(buttonFor('Stardust Dragon', 'Side Deck').attributes('disabled')).toBeUndefined()
  })

  it('names deck rows and add-panel cards in the card language (ADR 0015)', async () => {
    state.deck = deckDetail({
      main: [row({ name: 'Dark Magician', nameDe: 'Dunkler Magier', section: 'main', quantity: 2, owned: 2, usedInDeck: 2 })],
    })
    state.source = {
      items: [{
        catalogCardId: 44508094,
        name: 'Stardust Dragon',
        nameDe: 'Sternenstaubdrache',
        type: 'Synchro Monster',
        attribute: 'WIND',
        race: 'Dragon',
        level: 8,
        imageSmall: null,
        totalQuantity: 1,
      }],
      total: 1,
    }

    const german = await mountSuspended(DeckEditorPage)
    expect(german.text()).toContain('Dunkler Magier')
    expect(german.text()).toContain('Sternenstaubdrache')
    expect(german.text()).not.toContain('Dark Magician')
    expect(german.find('[aria-label="Sternenstaubdrache zum Extra Deck hinzufügen"]').exists()).toBe(true)
    german.unmount()

    useState('card-locale-choice').value = 'en'
    const english = await mountSuspended(DeckEditorPage)
    expect(english.text()).toContain('Dark Magician')
    expect(english.text()).toContain('Stardust Dragon')
    expect(english.text()).not.toContain('Dunkler Magier')
    english.unmount()
    useState('card-locale-choice').value = null
  })

  it('offers a quantity stepper and a remove action per deck row', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({
      main: [row({ name: 'Dark Magician', section: 'main', quantity: 2, owned: 2, usedInDeck: 2 })],
    })

    const component = await mountSuspended(DeckEditorPage)

    expect(component.find('[aria-label="Anzahl von Dark Magician im Main Deck"]').exists()).toBe(true)
    expect(component.find('[aria-label="Eine Kopie von Dark Magician zum Main Deck hinzufügen"]').exists()).toBe(true)
    expect(component.find('[aria-label="Eine Kopie von Dark Magician aus dem Main Deck entfernen"]').exists()).toBe(true)
    expect(component.find('[aria-label="Dark Magician aus dem Main Deck entfernen"]').exists()).toBe(true)
    expect(component.find('[aria-label="Optionen für Dark Magician"]').exists()).toBe(true)
  })
})

describe('deck editor mutations', () => {
  // The page also runs through Nuxt's session helpers, which use `$fetch`
  // too — only deck writes go to the handler under test.
  function stubDeckFetch(handler: (url: string, options?: Record<string, unknown>) => Promise<unknown>) {
    const mock = vi.fn((url: string, options?: Record<string, unknown>) => (
      url.startsWith('/api/decks/')
        ? handler(url, options)
        : Promise.resolve(null)
    ))
    vi.stubGlobal('$fetch', mock)
    return mock
  }

  function deckCalls(mock: ReturnType<typeof stubDeckFetch>) {
    return mock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))
  }

  function darkMagicianDeck(quantity: number) {
    return deckDetail({
      main: [row({ name: 'Dark Magician', section: 'main', quantity, owned: 3, usedInDeck: quantity })],
    })
  }

  const plusLabel = '[aria-label="Eine Kopie von Dark Magician zum Main Deck hinzufügen"]'
  const minusLabel = '[aria-label="Eine Kopie von Dark Magician aus dem Main Deck entfernen"]'
  const quantityLabel = 'input[aria-label="Anzahl von Dark Magician im Main Deck"]'
  const mainCount = '[aria-label="Anzahl im Main Deck"]'

  function shownQuantity(component: { find: <T extends Element>(selector: string) => DOMWrapper<T> }) {
    return component.find<HTMLInputElement>(quantityLabel).element.value
  }

  function shownQuantityOf(component: { find: <T extends Element>(selector: string) => DOMWrapper<T> }, name: string) {
    return component.find<HTMLInputElement>(`input[aria-label="Anzahl von ${name} im Main Deck"]`).element.value
  }

  // A write that waits for the test, so the queue can be observed.
  function deferredWrites() {
    const resolvers: Array<(detail: unknown) => void> = []
    const mock = stubDeckFetch(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    return { mock, resolvers }
  }

  it('queues the writes and keeps the controls enabled (#148)', async () => {
    state.source = {
      items: [{
        catalogCardId: 46986414,
        name: 'Dark Magician',
        type: 'Normal Monster',
        attribute: 'DARK',
        race: 'Spellcaster',
        level: 7,
        imageSmall: null,
        totalQuantity: 3,
      }],
      total: 1,
    }
    state.deck = darkMagicianDeck(1)
    const { mock: fetchMock, resolvers } = deferredWrites()

    const component = await mountSuspended(DeckEditorPage)
    const addLabel = '[aria-label="Dark Magician zum Main Deck hinzufügen"]'

    await component.find(plusLabel).trigger('click')
    await flushPromises()
    expect(deckCalls(fetchMock)).toEqual([[
      '/api/decks/deck-1/cards',
      { method: 'PUT', body: { catalogCardId: 46986414, section: 'main', quantity: 2 } },
    ]])

    // The asked-for value shows at once, and nothing is locked while the
    // write is in flight (a disabled, focused button would lose the focus).
    expect(shownQuantity(component)).toBe('2')
    expect(component.find(mainCount).text()).toBe('2/40–60')
    expect(component.find(plusLabel).attributes('disabled')).toBeUndefined()
    expect(component.find(addLabel).attributes('disabled')).toBeUndefined()
    expect(component.find(quantityLabel).attributes('disabled')).toBeUndefined()

    // The second click counts from the shown value; its PUT waits for the first.
    await component.find(plusLabel).trigger('click')
    await flushPromises()
    expect(shownQuantity(component)).toBe('3')
    expect(deckCalls(fetchMock)).toHaveLength(1)

    resolvers[0]!(darkMagicianDeck(2))
    await flushPromises()
    expect(deckCalls(fetchMock)).toHaveLength(2)
    expect(deckCalls(fetchMock)[1]).toEqual([
      '/api/decks/deck-1/cards',
      { method: 'PUT', body: { catalogCardId: 46986414, section: 'main', quantity: 3 } },
    ])
    // The first answer is outdated by the queued write: the view stays at 3.
    expect(shownQuantity(component)).toBe('3')
    expect(component.find(mainCount).text()).toBe('3/40–60')

    resolvers[1]!(darkMagicianDeck(3))
    await flushPromises()
    expect(shownQuantity(component)).toBe('3')
    expect(component.find(mainCount).text()).toBe('3/40–60')
    expect(component.find(plusLabel).attributes('disabled')).toBeUndefined()
  })

  it('renders only the answer of the last write', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(1)
    const { resolvers } = deferredWrites()

    const component = await mountSuspended(DeckEditorPage)

    // "−" to 0 keeps the row (and its focused stepper) until the queue drains.
    await component.find(minusLabel).trigger('click')
    await flushPromises()
    expect(shownQuantity(component)).toBe('0')
    await component.find(plusLabel).trigger('click')
    await flushPromises()
    expect(shownQuantity(component)).toBe('1')

    // The superseded write answers with something else: it is not rendered.
    resolvers[0]!(darkMagicianDeck(42))
    await flushPromises()
    expect(component.find(mainCount).text()).toBe('1/40–60')

    resolvers[1]!(darkMagicianDeck(7))
    await flushPromises()
    expect(component.find(mainCount).text()).toBe('7/40–60')
  })

  it('surfaces a rejected write and rolls back to the server\'s deck', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(1)

    // The API's error code is shown translated, never its technical
    // statusMessage (ADR 0014). The rollback GETs the deck again.
    let rejectWrite: ((error: unknown) => void) | undefined
    const fetchMock = stubDeckFetch((_url, options) => (options?.method === 'PUT'
      ? new Promise((_resolve, reject) => {
          rejectWrite = reject
        })
      : Promise.resolve(darkMagicianDeck(1))))

    const component = await mountSuspended(DeckEditorPage)
    await component.find(plusLabel).trigger('click')
    await flushPromises()
    expect(shownQuantity(component)).toBe('2')

    rejectWrite!(Object.assign(new Error('[PUT] "/api/decks/deck-1/cards": 400'), {
      data: {
        statusMessage: 'Extra deck cards can only be placed in the extra or side section',
        data: { code: 'section_not_allowed' },
      },
    }))
    await flushPromises()

    expect(deckCalls(fetchMock).at(-1)).toEqual(['/api/decks/deck-1'])
    expect(component.text()).toContain('Diese Karte kann nicht in diesen Deckbereich.')
    expect(component.text()).not.toContain('Extra deck cards can only be placed')
    expect(shownQuantity(component)).toBe('1')
    expect(component.find(mainCount).text()).toBe('1/40–60')
    expect(component.find(plusLabel).attributes('disabled')).toBeUndefined()
  })

  // A card new to a section gets its row at once (#148), built from the add
  // panel's card and sorted like the server sorts.
  describe('optimistic rows', () => {
    const POT_OF_GREED = 55144522
    const MIRROR_FORCE = 44095762
    const potOfGreedSource = {
      catalogCardId: POT_OF_GREED,
      name: 'Pot of Greed',
      type: 'Spell Card',
      frameType: 'spell',
      attribute: 'SPELL',
      race: 'Normal',
      level: null,
      imageSmall: 'https://images.example/cards_small/55144522.jpg',
      totalQuantity: 2,
    }

    function mainRowNames(component: { findAll: (selector: string) => Array<DOMWrapper<Element>> }) {
      return component.findAll('input[aria-label^="Anzahl von "][aria-label$=" im Main Deck"]')
        .map(input => input.attributes('aria-label')!.replace('Anzahl von ', '').replace(' im Main Deck', ''))
    }

    function deckWith(potQuantity: number) {
      return deckDetail({
        main: [
          row({ name: 'Dark Magician', section: 'main', quantity: 1, owned: 3, usedInDeck: 1 }),
          ...(potQuantity > 0
            ? [row({ name: 'Pot of Greed', section: 'main', catalogCardId: POT_OF_GREED, type: 'Spell Card', frameType: 'spell', quantity: potQuantity, owned: 2, usedInDeck: potQuantity })]
            : []),
          row({ name: 'Mirror Force', section: 'main', catalogCardId: MIRROR_FORCE, type: 'Trap Card', frameType: 'trap', quantity: 1, owned: 1, usedInDeck: 1 }),
        ],
      })
    }

    it('shows the row right after "+ Main", before the write answers, where the server sorts it', async () => {
      state.source = { items: [potOfGreedSource], total: 1 }
      state.deck = deckWith(0)
      const { mock: fetchMock, resolvers } = deferredWrites()

      const component = await mountSuspended(DeckEditorPage)
      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Mirror Force'])

      await component.find('[aria-label="Pot of Greed zum Main Deck hinzufügen"]').trigger('click')
      await flushPromises()
      expect(deckCalls(fetchMock)).toHaveLength(1)

      // Monsters, spells, traps — the new spell sits between them.
      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Pot of Greed', 'Mirror Force'])
      const potRow = component.find('input[aria-label="Anzahl von Pot of Greed im Main Deck"]').element.closest('li')!
      expect(potRow.textContent).toContain('1/2')
      expect(potRow.getAttribute('data-frame')).toBe('spell')
      expect(potRow.querySelector('img')?.getAttribute('src')).toBe('https://images.example/cards_small/55144522.jpg')

      // A second click counts on the new row; no duplicate row.
      await component.find('[aria-label="Pot of Greed zum Main Deck hinzufügen"]').trigger('click')
      await flushPromises()
      expect(shownQuantityOf(component, 'Pot of Greed')).toBe('2')
      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Pot of Greed', 'Mirror Force'])

      // The server's row takes over once the last answer is in.
      resolvers[0]!(deckWith(1))
      await flushPromises()
      resolvers[1]!(deckWith(2))
      await flushPromises()
      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Pot of Greed', 'Mirror Force'])
      expect(shownQuantityOf(component, 'Pot of Greed')).toBe('2')
      expect(component.find(mainCount).text()).toBe('4/40–60')
    })

    it('drops the row again when the write fails', async () => {
      state.source = { items: [potOfGreedSource], total: 1 }
      state.deck = deckWith(0)
      let rejectWrite: ((error: unknown) => void) | undefined
      stubDeckFetch((_url, options) => (options?.method === 'PUT'
        ? new Promise((_resolve, reject) => {
            rejectWrite = reject
          })
        : Promise.resolve(deckWith(0))))

      const component = await mountSuspended(DeckEditorPage)
      await component.find('[aria-label="Pot of Greed zum Main Deck hinzufügen"]').trigger('click')
      await flushPromises()
      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Pot of Greed', 'Mirror Force'])

      rejectWrite!(new Error('[PUT] "/api/decks/deck-1/cards": 500'))
      await flushPromises()

      expect(mainRowNames(component)).toEqual(['Dark Magician', 'Mirror Force'])
      expect(component.find(mainCount).text()).toBe('2/40–60')
      expect(component.text()).toContain('Die Änderung konnte nicht gespeichert werden.')
    })

    it('shows a new Side Deck row for a card already in the Main Deck, with its owned total', async () => {
      state.source = { items: [], total: 0 }
      state.deck = deckWith(1)
      deferredWrites()

      const component = await mountSuspended(DeckEditorPage)
      // The row's "…" menu has no quick add to Side; the overlay does.
      await component.findAll('button[aria-haspopup="dialog"]').find(button => button.text() === 'Pot of Greed')!.trigger('click')
      await flushPromises()
      await vi.waitFor(() => {
        expect(document.body.querySelector('[aria-label="Eine Kopie mehr im Side Deck"]')).not.toBeNull()
      })
      await new BodyWrapper(document.body).find('button[aria-label="Eine Kopie mehr im Side Deck"]').trigger('click')
      await flushPromises()

      const sideInput = component.find('input[aria-label="Anzahl von Pot of Greed im Side Deck"]')
      expect(sideInput.exists()).toBe(true)
      expect((sideInput.element as HTMLInputElement).value).toBe('1')
      // 1 in Main + 1 in Side of 2 owned, on both rows.
      expect(sideInput.element.closest('li')!.textContent).toContain('2/2')
      expect(component.find('[aria-label="Anzahl im Side Deck"]').text()).toBe('1/15')
    })
  })

  it('drops the asked-for value even when the rollback reload fails too', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(1)
    stubDeckFetch(() => Promise.reject(new Error('offline')))

    const component = await mountSuspended(DeckEditorPage)
    await component.find(plusLabel).trigger('click')
    await flushPromises()

    // The write's error stays, not the reload's; the view is the last known deck.
    expect(component.text()).toContain('Die Änderung konnte nicht gespeichert werden.')
    expect(shownQuantity(component)).toBe('1')
    expect(component.find(mainCount).text()).toBe('1/40–60')
  })

  it('keeps the format select enabled while a write is queued', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(1)
    const { mock: fetchMock, resolvers } = deferredWrites()

    const component = await mountSuspended(DeckEditorPage)
    await component.find(plusLabel).trigger('click')
    await flushPromises()

    const formatSelect = selectWithOption(component.findAllComponents(USelect), '__no_format__')
    expect(formatSelect!.props('disabled')).toBeFalsy()
    // The new selection shows at once; its PATCH waits for the PUT.
    await formatSelect!.setValue('tcg-advanced')
    await flushPromises()
    expect(formatSelect!.props('modelValue')).toBe('tcg-advanced')
    expect(deckCalls(fetchMock)).toHaveLength(1)

    resolvers[0]!(darkMagicianDeck(2))
    await flushPromises()
    expect(deckCalls(fetchMock)[1]).toEqual(['/api/decks/deck-1', { method: 'PATCH', body: { formatId: 'tcg-advanced' } }])
  })

  it('searches the card text in the add panel on request (#148)', async () => {
    vi.useFakeTimers()
    try {
      state.source = { items: [], total: 0 }
      state.deck = darkMagicianDeck(1)
      const sourceQuery = () => unref(state.sourceQuery as Ref<Record<string, unknown>>)

      const component = await mountSuspended(DeckEditorPage)
      const inText = checkboxByLabel(component, 'Auch im Kartentext suchen')
      expect(inText.exists()).toBe(true)

      // Without a search term the flag isn't sent.
      await inText.trigger('click')
      await flushPromises()
      expect(sourceQuery().inText).toBeUndefined()

      await component.find('[aria-label="Karten für das Deck suchen"]').setValue('Hexer')
      await vi.advanceTimersByTimeAsync(350)
      expect(sourceQuery()).toMatchObject({ q: 'Hexer', inText: 1 })

      await inText.trigger('click')
      await flushPromises()
      expect(sourceQuery()).toMatchObject({ q: 'Hexer' })
      expect(sourceQuery().inText).toBeUndefined()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('picks the add panel\'s "Quelle": a collection\'s own copies, or all', async () => {
    state.collections = { items: [{ id: 'box-1', name: 'Box 1' }, { id: 'box-2', name: 'Deck-Box' }], allCount: 5 }
    state.source = {
      items: [{ catalogCardId: 46986414, name: 'Dark Magician', type: 'Normal Monster', attribute: 'DARK', race: 'Spellcaster', level: 7, imageSmall: null, totalQuantity: 2 }],
      total: 1,
    }
    state.deck = darkMagicianDeck(1)
    const sourceQuery = () => unref(state.sourceQuery as Ref<Record<string, unknown>>)

    const component = await mountSuspended(DeckEditorPage)
    const source = selectWithOption(component.findAllComponents(USelect), 'box-1')!

    expect(optionLabels(source)).toEqual(['Alle Sammlungen', 'Ohne Sammlung', 'Box 1', 'Deck-Box'])
    // Default: the whole inventory, as before.
    expect(sourceQuery().collectionId).toBeUndefined()
    expect(sourceQuery().scoped).toBeUndefined()
    expect(component.text()).toContain('Besitz: 2 · im Deck: 1')

    await source.setValue('box-1')
    await flushPromises()
    // The server counts only that collection's copies, so the owned count is that collection's.
    expect(sourceQuery()).toMatchObject({ collectionId: 'box-1', scoped: 1 })
    expect(component.text()).toContain('In Box 1: 2 · im Deck: 1')

    await source.setValue('__none__')
    await flushPromises()
    expect(sourceQuery()).toMatchObject({ collectionId: '__none__', scoped: 1 })
    expect(component.text()).toContain('In Ohne Sammlung: 2')

    await source.setValue('__all_sources__')
    await flushPromises()
    expect(sourceQuery().collectionId).toBeUndefined()

    // The catalog has no collections: the select is off and nothing is sent.
    await source.setValue('box-2')
    await checkboxByLabel(component, 'Auch Katalogkarten anzeigen').trigger('click')
    await flushPromises()
    expect(sourceQuery().collectionId).toBeUndefined()
    expect(sourceQuery().scoped).toBeUndefined()
    expect(component.find('[aria-label="Quelle"]').attributes('disabled')).toBeDefined()
    state.collections = { items: [], allCount: 0 }
  })

  it('filters the add panel by "Kartenart" next to the exact type', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(1)
    const sourceQuery = () => unref(state.sourceQuery as Ref<Record<string, unknown>>)

    const component = await mountSuspended(DeckEditorPage)
    const kind = selectWithOption(component.findAllComponents(USelect), 'effect')!

    expect(optionLabels(kind)).toEqual(['Alle Kartenarten', 'Normal', 'Effekt', 'Ritual', 'Fusion', 'Synchro', 'XYZ', 'Link', 'Pendel', 'Spielmarke', 'Zauber', 'Falle'])
    expect(sourceQuery().kind).toBeUndefined()

    await kind.setValue('effect')
    await flushPromises()
    expect(sourceQuery()).toMatchObject({ kind: 'effect' })
    expect(sourceQuery().type).toBeUndefined()

    await kind.setValue('__all_kinds__')
    await flushPromises()
    expect(sourceQuery().kind).toBeUndefined()
  })

  it('ignores an emptied quantity field instead of deleting the card', async () => {
    state.source = { items: [], total: 0 }
    state.deck = darkMagicianDeck(2)

    const fetchMock = stubDeckFetch(() => Promise.resolve(darkMagicianDeck(2)))

    const component = await mountSuspended(DeckEditorPage)
    const input = component.find('input[aria-label="Anzahl von Dark Magician im Main Deck"]')

    await input.setValue('')
    await input.trigger('change')
    await flushPromises()

    expect(deckCalls(fetchMock)).toEqual([])
    await component.vm.$nextTick()
    // The field is re-synced from the stored quantity.
    const resynced = component.find<HTMLInputElement>('input[aria-label="Anzahl von Dark Magician im Main Deck"]')
    expect(resynced.element.value).toBe('2')
  })

  it('shows owned totals for catalog-only cards from the owned-quantities endpoint', async () => {
    state.deck = deckDetail({})
    state.ownedQuantities = { 46986414: 4 }
    state.source = {
      items: [{
        id: 46986414,
        name: 'Dark Magician',
        type: 'Normal Monster',
        frameType: 'normal',
        attribute: 'DARK',
        race: 'Spellcaster',
        level: 7,
        imageSmall: null,
      }],
      total: 1,
    }

    const component = await mountSuspended(DeckEditorPage)
    await checkboxByLabel(component, 'Auch Katalogkarten anzeigen').trigger('click')
    await flushPromises()
    await component.vm.$nextTick()

    expect(component.text()).toContain('Auch Katalogkarten anzeigen')
    expect(component.text()).toContain('Besitz: 4')
  })
})

// The header's card-kind chips (owner feedback in #148): copies per kind in
// Main and Extra, live from the rendered deck; the Side Deck isn't counted.
describe('deck editor card-kind breakdown', () => {
  function breakdownDeck(spells = 2) {
    return deckDetail({
      main: [
        row({ name: 'Dark Magician', section: 'main', quantity: 3 }),
        row({ name: 'Kuriboh', section: 'main', catalogCardId: 40640057, type: 'Effect Monster', frameType: 'effect', quantity: 2 }),
        row({ name: 'Relinquished', section: 'main', catalogCardId: 64631466, type: 'Ritual Effect Monster', frameType: 'ritual', quantity: 1 }),
        row({ name: 'Timegazer Magician', section: 'main', catalogCardId: 20409757, type: 'Pendulum Effect Monster', frameType: 'effect_pendulum', quantity: 1 }),
        row({ name: 'Pot of Greed', section: 'main', catalogCardId: 55144522, type: 'Spell Card', frameType: 'spell', quantity: spells }),
        row({ name: 'Mirror Force', section: 'main', catalogCardId: 44095762, type: 'Trap Card', frameType: 'trap', quantity: 1 }),
      ],
      extra: [
        row({ name: 'Stardust Dragon', section: 'extra', catalogCardId: 44508094, type: 'Synchro Monster', frameType: 'synchro', quantity: 1 }),
        row({ name: 'Number 39: Utopia', section: 'extra', catalogCardId: 84013237, type: 'XYZ Monster', frameType: 'xyz', quantity: 2 }),
        row({ name: 'Decode Talker', section: 'extra', catalogCardId: 1861629, type: 'Link Monster', frameType: 'link', quantity: 1 }),
      ],
      side: [
        row({ name: 'Mirror Force', section: 'side', catalogCardId: 44095762, type: 'Trap Card', frameType: 'trap', quantity: 2 }),
      ],
    })
  }

  function chips(component: { find: (selector: string) => DOMWrapper<Element> }, section: 'main' | 'extra') {
    return component.find(`[data-testid="deck-breakdown"] [data-section="${section}"] ul`)
  }

  it('counts the copies per card kind in Main and Extra', async () => {
    state.source = { items: [], total: 0 }
    state.deck = breakdownDeck()

    const component = await mountSuspended(DeckEditorPage)

    const main = chips(component, 'main')
    expect(main.attributes('aria-label')).toBe('Kartenarten im Main Deck')
    expect(main.findAll('li').map(li => li.text())).toEqual([
      '3 Normale Monster',
      '3 Effektmonster',
      '1 Ritualmonster',
      '2 Zauberkarten',
      '1 Fallenkarte',
    ])
    const extra = chips(component, 'extra')
    expect(extra.attributes('aria-label')).toBe('Kartenarten im Extra Deck')
    expect(extra.findAll('li').map(li => li.text())).toEqual(['1 Synchro', '2 Xyz', '1 Link'])
    expect(component.find('[data-testid="deck-breakdown"]').text()).not.toContain('Fusion')
    // The chips take their dot color from the frame.
    expect(main.find('li[data-kind="spell"]').attributes('data-frame')).toBe('spell')
    // The Side Deck's two traps are not counted.
    expect(component.find('[data-testid="deck-breakdown"] [data-section="side"]').exists()).toBe(false)
  })

  it('shows no breakdown for an empty deck', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({})

    const component = await mountSuspended(DeckEditorPage)

    expect(component.find('[data-testid="deck-breakdown"]').exists()).toBe(false)
  })

  it('updates at once, before the write answers', async () => {
    state.source = { items: [], total: 0 }
    state.deck = breakdownDeck()
    let resolveWrite: ((detail: unknown) => void) | undefined
    vi.stubGlobal('$fetch', vi.fn((url: string) => (url.startsWith('/api/decks/')
      ? new Promise((resolve) => {
          resolveWrite = resolve
        })
      : Promise.resolve(null))))

    const component = await mountSuspended(DeckEditorPage)
    await component.find('[aria-label="Eine Kopie von Pot of Greed zum Main Deck hinzufügen"]').trigger('click')
    await flushPromises()
    expect(chips(component, 'main').find('li[data-kind="spell"]').text()).toBe('3 Zauberkarten')

    resolveWrite!(breakdownDeck(3))
    await flushPromises()
    expect(chips(component, 'main').find('li[data-kind="spell"]').text()).toBe('3 Zauberkarten')
  })
})

// The card overlay in the deck editor (owner feedback in #148): no
// printings, and the card's quantity per allowed section.
describe('deck editor card overlay', () => {
  const DARK_MAGICIAN = 46986414
  const STARDUST = 44508094
  const POT_OF_GREED = 55144522

  // UModal teleports its content to <body>.
  function body() {
    return new BodyWrapper(document.body)
  }

  function dialog() {
    return body().find('[role="dialog"]')
  }

  // Unmounted before the body is cleared: Vue can't remove a teleported
  // dialog whose nodes are already gone.
  const mounted: Array<{ unmount: () => void }> = []

  async function mountPage() {
    const component = await mountSuspended(DeckEditorPage)
    mounted.push(component)
    return component
  }

  afterEach(() => {
    for (const component of mounted.splice(0)) {
      component.unmount()
    }
    document.body.innerHTML = ''
  })

  function overlayDeck(mainQuantity: number) {
    return deckDetail({
      main: [row({ name: 'Dark Magician', section: 'main', quantity: mainQuantity, owned: 3, usedInDeck: mainQuantity })],
      extra: [row({ name: 'Stardust Dragon', section: 'extra', catalogCardId: STARDUST, type: 'Synchro Monster', frameType: 'synchro', level: 8 })],
    })
  }

  function catalogDetail(id: number) {
    return {
      card: {
        id,
        name: 'Dark Magician',
        nameDe: 'Dunkler Magier',
        type: 'Normal Monster',
        frameType: 'normal',
        desc: 'The ultimate wizard in terms of attack and defense.',
        descDe: 'Der ultimative Zauberer.',
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
        tcgDate: '2002-03-08',
        ocgDate: null,
        ygoprodeckUrl: null,
        retired: false,
        replacedById: null,
      },
      printings: [{ setCode: 'LOB-005', setName: 'Legend of Blue Eyes White Dragon', rarity: 'Ultra Rare', price: null }],
      images: [],
    }
  }

  // Catalog details answer at once; deck writes wait for the test.
  function stubOverlayFetch(deckAnswer: (url: string, options?: Record<string, unknown>) => Promise<unknown>) {
    const mock = vi.fn((url: string, options?: Record<string, unknown>) => {
      if (url.startsWith('/api/catalog/cards/')) {
        return Promise.resolve(catalogDetail(Number(url.split('/').at(-1))))
      }
      return url.startsWith('/api/decks/') ? deckAnswer(url, options) : Promise.resolve(null)
    })
    vi.stubGlobal('$fetch', mock)
    return mock
  }

  function deckCalls(mock: ReturnType<typeof stubOverlayFetch>) {
    return mock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))
  }

  async function openOverlay(component: { findAll: (selector: string) => Array<DOMWrapper<Element>> }, name: string) {
    const button = component.findAll('button[aria-haspopup="dialog"]').find(btn => btn.text() === name)
    await button!.trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(dialog().text()).toContain('Im Deck')
    })
  }

  function stepperInput(label: string) {
    return dialog().find<HTMLInputElement>(`input[aria-label="${label}"]`)
  }

  it('shows the card without printings and a stepper per allowed section', async () => {
    state.source = { items: [], total: 0 }
    state.deck = overlayDeck(1)
    stubOverlayFetch(() => Promise.resolve(null))

    const component = await mountPage()
    await openOverlay(component, 'Dark Magician')
    await vi.waitFor(() => {
      expect(dialog().text()).toContain('Der ultimative Zauberer.')
    })

    const text = dialog().text()
    expect(text).toContain('Englisch: Dark Magician')
    expect(text).toContain('2002-03-08')
    expect(text).not.toContain('Printings')
    expect(text).not.toContain('LOB-005')
    expect(dialog().find('h3').text()).toBe('Im Deck')
    expect(text).toContain('Besitz: 3 · im Deck: 1')

    expect(stepperInput('Kopien im Main Deck').element.value).toBe('1')
    expect(stepperInput('Kopien im Side Deck').element.value).toBe('0')
    expect(stepperInput('Kopien im Extra Deck').exists()).toBe(false)
  })

  it('offers Extra and Side for an Extra Deck monster', async () => {
    state.source = { items: [], total: 0 }
    state.deck = overlayDeck(1)
    stubOverlayFetch(() => Promise.resolve(null))

    const component = await mountPage()
    await openOverlay(component, 'Stardust Dragon')

    expect(stepperInput('Kopien im Extra Deck').element.value).toBe('1')
    expect(stepperInput('Kopien im Side Deck').element.value).toBe('0')
    expect(stepperInput('Kopien im Main Deck').exists()).toBe(false)
  })

  it('writes the new quantity, keeps the controls enabled while it is in flight, and updates the overlay and the row', async () => {
    state.source = { items: [], total: 0 }
    state.deck = overlayDeck(1)
    const resolvers: Array<(detail: unknown) => void> = []
    const fetchMock = stubOverlayFetch(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))

    const component = await mountPage()
    await openOverlay(component, 'Dark Magician')

    const plus = () => dialog().find('button[aria-label="Eine Kopie mehr im Main Deck"]')
    await plus().trigger('click')
    await flushPromises()
    expect(deckCalls(fetchMock)).toEqual([[
      '/api/decks/deck-1/cards',
      { method: 'PUT', body: { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 2 } },
    ]])

    // In flight: the overlay and the row show the new value, nothing is locked.
    expect(stepperInput('Kopien im Main Deck').element.value).toBe('2')
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl von Dark Magician im Main Deck"]').element.value).toBe('2')
    expect(plus().attributes('disabled')).toBeUndefined()
    expect(dialog().find('button[aria-label="Eine Kopie weniger im Main Deck"]').attributes('disabled')).toBeUndefined()
    expect(component.find('[aria-label="Eine Kopie von Dark Magician zum Main Deck hinzufügen"]').attributes('disabled')).toBeUndefined()

    // A second click queues PUT 3 behind the first.
    await plus().trigger('click')
    await flushPromises()
    expect(stepperInput('Kopien im Main Deck').element.value).toBe('3')
    expect(deckCalls(fetchMock)).toHaveLength(1)

    resolvers[0]!(overlayDeck(2))
    await flushPromises()
    expect(deckCalls(fetchMock)[1]).toEqual([
      '/api/decks/deck-1/cards',
      { method: 'PUT', body: { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 3 } },
    ])
    resolvers[1]!(overlayDeck(3))
    await flushPromises()

    expect(stepperInput('Kopien im Main Deck').element.value).toBe('3')
    expect(component.find<HTMLInputElement>('input[aria-label="Anzahl von Dark Magician im Main Deck"]').element.value).toBe('3')
    expect(component.find('[aria-label="Anzahl im Main Deck"]').text()).toBe('3/40–60')
    expect(plus().attributes('disabled')).toBeUndefined()
  })

  it('shows a rejected write inside the dialog and rolls the value back', async () => {
    state.source = { items: [], total: 0 }
    state.deck = overlayDeck(1)
    let rejectWrite: ((error: unknown) => void) | undefined
    stubOverlayFetch((_url, options) => (options?.method === 'PUT'
      ? new Promise((_resolve, reject) => {
          rejectWrite = reject
        })
      : Promise.resolve(overlayDeck(1))))

    const component = await mountPage()
    await openOverlay(component, 'Dark Magician')
    await dialog().find('button[aria-label="Eine Kopie mehr im Side Deck"]').trigger('click')
    await flushPromises()
    expect(stepperInput('Kopien im Side Deck').element.value).toBe('1')

    rejectWrite!(new Error('[PUT] "/api/decks/deck-1/cards": 500'))
    await flushPromises()

    const alert = dialog().find('[role="alert"]')
    expect(alert.text()).toBe('Die Änderung konnte nicht gespeichert werden.')
    expect(stepperInput('Kopien im Side Deck').element.value).toBe('0')
  })

  it('starts at zero for an add-panel card that is not in the deck, and "+" adds it', async () => {
    state.source = {
      items: [{
        catalogCardId: POT_OF_GREED,
        name: 'Pot of Greed',
        type: 'Spell Card',
        attribute: null,
        race: 'Normal',
        level: null,
        imageSmall: null,
        totalQuantity: 2,
      }],
      total: 1,
    }
    state.deck = overlayDeck(1)
    const fetchMock = stubOverlayFetch(() => new Promise(() => {}))

    const component = await mountPage()
    await openOverlay(component, 'Pot of Greed')

    expect(stepperInput('Kopien im Main Deck').element.value).toBe('0')
    expect(stepperInput('Kopien im Side Deck').element.value).toBe('0')
    expect(dialog().text()).toContain('Besitz: 2 · im Deck: 0')

    await dialog().find('button[aria-label="Eine Kopie mehr im Main Deck"]').trigger('click')
    await flushPromises()
    expect(deckCalls(fetchMock)).toEqual([[
      '/api/decks/deck-1/cards',
      { method: 'PUT', body: { catalogCardId: POT_OF_GREED, section: 'main', quantity: 1 } },
    ]])
    // Counted at once, although the card has no deck row yet.
    expect(stepperInput('Kopien im Main Deck').element.value).toBe('1')
    expect(dialog().text()).toContain('Besitz: 2 · im Deck: 1')
    expect(component.find('[aria-label="Anzahl im Main Deck"]').text()).toBe('2/40–60')
  })
})

describe('deck editor add panel layout', () => {
  const searchInput = '[aria-label="Karten für das Deck suchen"]'
  const toggle = '[aria-controls="deck-add-panel-body"]'

  it('renders the deck sections before the add panel', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const component = await mountSuspended(DeckEditorPage)
    const text = component.text()

    expect(text.indexOf('Noch keine Karten im Side Deck.')).toBeGreaterThan(-1)
    expect(text.indexOf('Noch keine Karten im Side Deck.')).toBeLessThan(text.indexOf('Aus Inventar hinzufügen'))
  })

  it('collapses the add panel on small screens once the deck has cards', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const component = await mountSuspended(DeckEditorPage)
    const body = () => component.find('#deck-add-panel-body')

    // Hidden below `lg`, always shown from `lg` up — and still in the DOM.
    expect(body().classes()).toContain('hidden')
    expect(body().classes()).toContain('lg:flex')
    expect(component.find(toggle).attributes('aria-expanded')).toBe('false')
    expect(component.find(toggle).text()).toContain('Anzeigen')
    expect(component.find(searchInput).exists()).toBe(true)

    await component.find(toggle).trigger('click')

    expect(body().classes()).not.toContain('hidden')
    expect(component.find(toggle).attributes('aria-expanded')).toBe('true')
    expect(component.find(toggle).text()).toContain('Ausblenden')
    expect(component.find(searchInput).exists()).toBe(true)
  })

  it('starts expanded for an empty deck', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({})

    const component = await mountSuspended(DeckEditorPage)

    expect(component.find('#deck-add-panel-body').classes()).not.toContain('hidden')
    expect(component.find(toggle).attributes('aria-expanded')).toBe('true')
  })

  it('opens and scrolls to the add panel from the header shortcut', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const originalScrollIntoView = Element.prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    try {
      const component = await mountSuspended(DeckEditorPage)
      expect(component.find('#deck-add-panel-body').classes()).toContain('hidden')

      const shortcut = component.findAll('button').find(button => button.text() === 'Karten hinzufügen')
      expect(shortcut).toBeTruthy()
      await shortcut!.trigger('click')
      await flushPromises()

      expect(component.find('#deck-add-panel-body').classes()).not.toContain('hidden')
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
    }
    finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })
})

describe('deck editor rule validation', () => {
  function validation(overrides: Partial<DeckValidation> = {}): DeckValidation {
    return {
      legal: true,
      issues: [],
      cards: {},
      ...overrides,
    }
  }

  it('shows a neutral state while no format is assigned', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const component = await mountSuspended(DeckEditorPage)

    expect(component.text()).toContain('Regelprüfung')
    expect(component.text()).toContain('Kein Format gewählt')
    expect(component.text()).toContain('Wähle oben ein Format')
  })

  it('renders the legality badge, the issue list, and per-row status badges', async () => {
    state.source = {
      items: [{
        catalogCardId: 55144522,
        name: 'Pot of Greed',
        type: 'Spell Card',
        attribute: null,
        race: 'Normal',
        level: null,
        imageSmall: null,
        totalQuantity: 1,
      }],
      total: 1,
    }
    state.deck = deckDetail(
      {
        main: [
          row({ name: 'Pot of Greed', section: 'main', catalogCardId: 55144522, type: 'Spell Card' }),
          row({ name: 'Dark Magician', section: 'main', quantity: 2, owned: 2, usedInDeck: 2 }),
        ],
      },
      [],
      { id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true },
      validation({
        legal: false,
        issues: [
          { severity: 'error', code: 'card_forbidden', cardId: 55144522, params: { cardId: 55144522, cardName: 'Pot of Greed' }, message: 'Pot of Greed is forbidden in this format.' },
          { severity: 'error', code: 'deck_size_min', section: 'main', params: { section: 'main', count: 3, min: 40 }, message: 'The Main Deck has 3 cards; at least 40 are required.' },
        ],
        cards: {
          55144522: { maxCopies: 0, status: 'forbidden', reasons: [{ kind: 'banlist', source: 'tcg', raw: 'Forbidden' }] },
          46986414: { maxCopies: 3, status: 'unrestricted', reasons: [] },
        },
      }),
    )

    const component = await mountSuspended(DeckEditorPage)
    const text = component.text()

    expect(component.find('[aria-label="Regelprüfung Status"]').text()).toBe('Nicht legal – 2 Probleme')
    expect(text).toContain('Pot of Greed ist in diesem Format verboten.')
    expect(text).toContain('Das Main Deck hat 3 Karten, mindestens 40 sind erforderlich.')

    // The forbidden card is badged (in the deck list *and* the card picker)
    // and its row is highlighted; the legal card is not.
    expect(text).toContain('Verboten')
    const forbiddenRows = component.findAll('li').filter(item => item.attributes('data-issue') !== undefined)
    expect(forbiddenRows).toHaveLength(1)
    expect(forbiddenRows[0]!.text()).toContain('Pot of Greed')
  })

  it('shows a green badge for a legal deck', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail(
      { main: [row({ name: 'Dark Magician', section: 'main' })] },
      [],
      { id: 'own-1', name: 'Nur alte Karten', isBuiltin: false },
      validation({ legal: true, cards: { 46986414: { maxCopies: 3, status: 'unrestricted', reasons: [] } } }),
    )

    const component = await mountSuspended(DeckEditorPage)

    expect(component.find('[aria-label="Regelprüfung Status"]').text()).toBe('Legal')
    expect(component.text()).toContain('Das Deck erfüllt alle Regeln von "Nur alte Karten".')
  })

  it('PATCHes the deck when another format is selected and renders the response', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const patched = deckDetail(
      { main: [row({ name: 'Dark Magician', section: 'main' })] },
      [],
      { id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true },
      validation({
        legal: false,
        issues: [{ severity: 'error', code: 'deck_size_min', section: 'main', params: { section: 'main', count: 1, min: 40 }, message: 'The Main Deck has 1 card; at least 40 are required.' }],
        cards: {},
      }),
    )

    const fetchMock = vi.fn((url: string) => (
      url.startsWith('/api/decks/') ? Promise.resolve(patched) : Promise.resolve(null)
    ))
    vi.stubGlobal('$fetch', fetchMock)

    const component = await mountSuspended(DeckEditorPage)

    // The format select teleports its listbox, so drive its v-model directly.
    const formatSelect = selectWithOption(component.findAllComponents(USelect), '__no_format__')
    expect(formatSelect).toBeTruthy()
    expect(optionLabels(formatSelect!)).toEqual([
      'Kein Format',
      'TCG Advanced',
      'Nur alte Karten (eigenes)',
    ])

    await formatSelect!.setValue('tcg-advanced')
    await flushPromises()
    await component.vm.$nextTick()

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))).toEqual([[
      '/api/decks/deck-1',
      { method: 'PATCH', body: { formatId: 'tcg-advanced' } },
    ]])

    expect(component.find('[aria-label="Regelprüfung Status"]').text()).toBe('Nicht legal – 1 Problem')
    vi.unstubAllGlobals()
  })
})

describe('deck editor header and row layout', () => {
  it('keeps rename and delete in the "Weitere Aktionen" menu at every width', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })

    const component = await mountSuspended(DeckEditorPage)
    const buttonTexts = component.findAll('button').map(button => button.text())

    // No standalone buttons: one code path, no duplicate markup per breakpoint.
    expect(buttonTexts).not.toContain('Umbenennen')
    expect(buttonTexts).not.toContain('Löschen')
    expect(component.find('[aria-label="Weitere Aktionen"]').exists()).toBe(true)
    expect(component.find('[aria-label="Weitere Aktionen"]').classes()).toContain('tap-target')

    // The menu teleports its content, so drive its items directly.
    const menus = component.findAllComponents(UDropdownMenu) as unknown as Array<{ props: (key: string) => unknown }>
    const menu = menus.find(candidate =>
      (candidate.props('items') as Array<Array<{ label: string }>>).flat().some(item => item.label === 'Umbenennen'))
    expect(menu).toBeTruthy()
    const items = (menu!.props('items') as Array<Array<{ label: string, onSelect: () => void }>>).flat()
    expect(items.map(item => item.label)).toEqual(['Umbenennen', 'Löschen'])

    expect(component.findComponent(DecksDeckFormModal).props('open')).toBe(false)
    items[0]!.onSelect()
    await component.vm.$nextTick()
    expect(component.findComponent(DecksDeckFormModal).props('open')).toBe(true)
  })

  it('lets a long deck name wrap instead of truncating it', async () => {
    state.source = { items: [], total: 0 }
    state.deck = deckDetail({})

    const component = await mountSuspended(DeckEditorPage)

    expect(component.findAll('h1')).toHaveLength(1)
    expect(component.find('h1').text()).toBe('Test Deck')
    expect(component.find('h1').classes()).not.toContain('truncate')
  })

  it('gives the row controls and the add buttons 44px tap targets on phones', async () => {
    state.deck = deckDetail({ main: [row({ name: 'Dark Magician', section: 'main' })] })
    state.source = {
      items: [{
        catalogCardId: 46986414,
        name: 'Dark Magician',
        type: 'Normal Monster',
        attribute: 'DARK',
        race: 'Spellcaster',
        level: 7,
        imageSmall: null,
        totalQuantity: 1,
      }],
      total: 1,
    }

    const component = await mountSuspended(DeckEditorPage)

    for (const label of [
      'Eine Kopie von Dark Magician aus dem Main Deck entfernen',
      'Eine Kopie von Dark Magician zum Main Deck hinzufügen',
      'Optionen für Dark Magician',
      'Dark Magician aus dem Main Deck entfernen',
      'Dark Magician zum Main Deck hinzufügen',
      'Dark Magician zum Extra Deck hinzufügen',
      'Dark Magician zum Side Deck hinzufügen',
    ]) {
      expect(component.find(`[aria-label="${label}"]`).classes(), label).toContain('tap-target')
    }
    expect(component.find('[aria-controls="deck-add-panel-body"]').classes()).toContain('tap-target')

    // The full name stays available when it wraps onto a second line.
    expect(component.find('p[title="Dark Magician"]').classes()).toContain('line-clamp-2')
  })
})

describe('deck editor cover card', () => {
  const DARK_MAGICIAN = 46986414
  const POT_OF_GREED = 55144522

  type MenuItem = { label: string, icon?: string, disabled?: boolean, onSelect: () => void }
  type MenuWrapper = { props: (key: string) => unknown }

  function stubDeckFetch(handler: (url: string, options?: Record<string, unknown>) => Promise<unknown>) {
    const mock = vi.fn((url: string, options?: Record<string, unknown>) => (
      url.startsWith('/api/decks/')
        ? handler(url, options)
        : Promise.resolve(null)
    ))
    vi.stubGlobal('$fetch', mock)
    return mock
  }

  function coverOf(catalogCardId: number, name: string) {
    return { catalogCardId, name, imageSmall: null, imageLarge: null }
  }

  /** Dark Magician in Main and Side, Pot of Greed in Main; the rule picks Dark Magician. */
  function coverDeck(cover: { id: number, name: string } | null = { id: DARK_MAGICIAN, name: 'Dark Magician' }, coverIsChosen = false) {
    return {
      ...deckDetail({
        main: [
          row({ name: 'Dark Magician', section: 'main', usedInDeck: 2 }),
          row({ catalogCardId: POT_OF_GREED, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', attribute: null, race: 'Normal', level: null, atk: null, def: null, section: 'main' }),
        ],
        side: [row({ name: 'Dark Magician', section: 'side', usedInDeck: 2 })],
      }),
      cover: cover ? coverOf(cover.id, cover.name) : null,
      coverIsChosen,
    }
  }

  // The menus teleport their content, so drive their items directly. A row's
  // move items name the sections it is *not* in.
  function rowMenu(component: Awaited<ReturnType<typeof mountSuspended>>, name: string, section: DeckSection): MenuItem[] {
    const menus = component.findAllComponents(UDropdownMenu) as unknown as Array<MenuWrapper & { find: (selector: string) => { exists: () => boolean } }>
    const others = (['main', 'extra', 'side'] as const)
      .filter(other => other !== section)
      .map(other => `Nach ${{ main: 'Main Deck', extra: 'Extra Deck', side: 'Side Deck' }[other]}`)
    const menu = menus.find((candidate) => {
      const labels = (candidate.props('items') as MenuItem[][]).flat().map(item => item.label)
      return candidate.find(`[aria-label="Optionen für ${name}"]`).exists()
        && others.every(label => labels.includes(label))
    })
    expect(menu, `${name} (${section})`).toBeTruthy()
    return (menu!.props('items') as MenuItem[][]).flat()
  }

  function rowItem(component: Awaited<ReturnType<typeof mountSuspended>>, name: string, section: DeckSection) {
    const sectionLabel = { main: 'Main Deck', extra: 'Extra Deck', side: 'Side Deck' }[section]
    const item = component.findAll('li').find((li: DOMWrapper<Element>) => li.find(`[aria-label="${name} aus dem ${sectionLabel} entfernen"]`).exists())
    expect(item, `${name} (${section})`).toBeTruthy()
    return item!
  }

  it('offers "Als Titelkarte festlegen" in Main/Extra row menus, next to the moves, but not for Side rows', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck()

    const component = await mountSuspended(DeckEditorPage)

    const potMenu = rowMenu(component, 'Pot of Greed', 'main')
    expect(potMenu.map(item => item.label)).toEqual(['Nach Extra Deck', 'Nach Side Deck', 'Als Titelkarte festlegen'])

    const sideMenu = rowMenu(component, 'Dark Magician', 'side')
    expect(sideMenu.map(item => item.label)).toEqual(['Nach Main Deck', 'Nach Extra Deck'])

    // The menu button is the "Optionen für …" row menu.
    const button = component.find('[aria-label="Optionen für Pot of Greed"]')
    expect(button.classes()).toContain('tap-target')
  })

  it('PATCHes the chosen cover and shows the response\'s "Titelkarte" badge', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck()

    const fetchMock = stubDeckFetch(() => Promise.resolve(coverDeck({ id: POT_OF_GREED, name: 'Pot of Greed' }, true)))
    const component = await mountSuspended(DeckEditorPage)

    rowMenu(component, 'Pot of Greed', 'main').find(item => item.label === 'Als Titelkarte festlegen')!.onSelect()
    await flushPromises()
    await component.vm.$nextTick()

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))).toEqual([[
      '/api/decks/deck-1',
      { method: 'PATCH', body: { coverCardId: POT_OF_GREED } },
    ]])
    expect(rowItem(component, 'Pot of Greed', 'main').text()).toContain('Titelkarte')
    expect(rowItem(component, 'Pot of Greed', 'main').text()).not.toContain('Titelkarte (automatisch)')
    expect(rowItem(component, 'Dark Magician', 'main').text()).not.toContain('Titelkarte')
  })

  it('marks a rule-picked cover as automatic on its Main row only, and lets the user pin it', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck()

    const component = await mountSuspended(DeckEditorPage)

    expect(rowItem(component, 'Dark Magician', 'main').text()).toContain('Titelkarte (automatisch)')
    expect(rowItem(component, 'Dark Magician', 'side').text()).not.toContain('Titelkarte')
    expect(rowItem(component, 'Pot of Greed', 'main').text()).not.toContain('Titelkarte')
    expect(component.findAll('li').filter(li => li.text().includes('Titelkarte'))).toHaveLength(1)

    expect(rowMenu(component, 'Dark Magician', 'main').map(item => item.label)).toContain('Als Titelkarte festlegen')
  })

  it('offers "Titelkarte automatisch wählen" on a chosen cover, which PATCHes null', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck({ id: POT_OF_GREED, name: 'Pot of Greed' }, true)

    const fetchMock = stubDeckFetch(() => Promise.resolve(coverDeck()))
    const component = await mountSuspended(DeckEditorPage)

    expect(rowItem(component, 'Pot of Greed', 'main').text()).toContain('Titelkarte')

    const potMenu = rowMenu(component, 'Pot of Greed', 'main')
    expect(potMenu.map(item => item.label)).not.toContain('Als Titelkarte festlegen')
    // Other Main rows can still take over as the chosen cover.
    expect(rowMenu(component, 'Dark Magician', 'main').map(item => item.label)).toContain('Als Titelkarte festlegen')

    potMenu.find(item => item.label === 'Titelkarte automatisch wählen')!.onSelect()
    await flushPromises()
    await component.vm.$nextTick()

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))).toEqual([[
      '/api/decks/deck-1',
      { method: 'PATCH', body: { coverCardId: null } },
    ]])
    expect(rowItem(component, 'Dark Magician', 'main').text()).toContain('Titelkarte (automatisch)')
  })

  it('hints at a chosen cover that is no longer in Main/Extra and clears it (#57)', async () => {
    state.source = { items: [], total: 0 }
    state.deck = { ...coverDeck(), inactiveCoverChoice: coverOf(12580477, 'Raigeki') }

    const fetchMock = stubDeckFetch(() => Promise.resolve(coverDeck()))
    const component = await mountSuspended(DeckEditorPage)

    expect(component.text()).toContain('Gewählte Titelkarte nicht aktiv')
    expect(component.text()).toContain('"Raigeki" ist nicht mehr im Main oder Extra Deck')
    // The rule's pick is still marked as the automatic cover.
    expect(rowItem(component, 'Dark Magician', 'main').text()).toContain('Titelkarte (automatisch)')

    const clear = component.findAll('button').find(button => button.text() === 'Auswahl aufheben')
    expect(clear).toBeTruthy()
    await clear!.trigger('click')
    await flushPromises()
    await component.vm.$nextTick()

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/decks/'))).toEqual([[
      '/api/decks/deck-1',
      { method: 'PATCH', body: { coverCardId: null } },
    ]])
    expect(component.text()).not.toContain('Gewählte Titelkarte nicht aktiv')
  })

  it('shows no inactive-cover hint without a stored choice', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck()

    const component = await mountSuspended(DeckEditorPage)

    expect(component.text()).not.toContain('Gewählte Titelkarte nicht aktiv')
  })

  it('shows no inactive-cover hint while the chosen cover is active', async () => {
    state.source = { items: [], total: 0 }
    state.deck = coverDeck({ id: POT_OF_GREED, name: 'Pot of Greed' }, true)

    const component = await mountSuspended(DeckEditorPage)

    expect(component.text()).not.toContain('Gewählte Titelkarte nicht aktiv')
  })
})

describe('deck editor add panel paging', () => {
  function inventoryItems(count: number, offset = 0) {
    return Array.from({ length: count }, (_, index) => ({
      catalogCardId: 1000 + offset + index,
      name: `Karte ${String(offset + index + 1).padStart(2, '0')}`,
      type: 'Normal Monster',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 4,
      imageSmall: null,
      totalQuantity: 1,
    }))
  }

  function catalogItems(count: number, offset = 0) {
    return Array.from({ length: count }, (_, index) => ({
      id: 2000 + offset + index,
      name: `Katalogkarte ${String(offset + index + 1).padStart(2, '0')}`,
      type: 'Normal Monster',
      frameType: 'normal',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 4,
      imageSmall: null,
    }))
  }

  interface Wrapper {
    findAll: (selector: string) => Array<DOMWrapper<Element>>
  }

  const panelCards = (component: Wrapper) => component.findAll('#deck-add-panel-body li')
  const loadMoreButton = (component: Wrapper) =>
    component.findAll('button').find(button => button.text() === 'Mehr laden')

  function stubSourceFetch(handler: (url: string, options?: { query?: Record<string, unknown> }) => Promise<unknown>) {
    const mock = vi.fn((url: string, options?: { query?: Record<string, unknown> }) => (
      url.startsWith('/api/inventory/') || url.startsWith('/api/catalog/')
        ? handler(url, options)
        : Promise.resolve(null)
    ))
    vi.stubGlobal('$fetch', mock)
    return mock
  }

  it('shows how many of the matches are listed and appends the next page', async () => {
    state.deck = deckDetail({})
    state.source = { items: inventoryItems(12), total: 14 }
    const fetchMock = stubSourceFetch(() => Promise.resolve({ items: inventoryItems(2, 12), total: 14 }))

    const component = await mountSuspended(DeckEditorPage)

    expect(panelCards(component)).toHaveLength(12)
    expect(component.text()).toContain('12 von 14 Karten')
    expect(loadMoreButton(component)).toBeTruthy()

    await loadMoreButton(component)!.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/inventory/search', {
      query: expect.objectContaining({ page: 2, pageSize: 12, sort: 'name' }),
    })
    expect(panelCards(component)).toHaveLength(14)
    expect(component.text()).toContain('Karte 14')
    expect(component.text()).toContain('14 Karten')
    expect(component.text()).not.toContain('von 14 Karten')
    expect(loadMoreButton(component)).toBeUndefined()
  })

  it('fetches the owned totals of a further catalog page', async () => {
    state.deck = deckDetail({})
    state.source = { items: catalogItems(12), total: 14 }
    const fetchMock = stubSourceFetch((url) => {
      if (url === '/api/catalog/cards') {
        return Promise.resolve({ items: catalogItems(2, 12), total: 14 })
      }
      if (url === '/api/inventory/owned-quantities') {
        return Promise.resolve({ 2012: 4 })
      }
      return Promise.resolve(null)
    })

    const component = await mountSuspended(DeckEditorPage)
    await checkboxByLabel(component, 'Auch Katalogkarten anzeigen').trigger('click')
    await flushPromises()

    await loadMoreButton(component)!.trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/catalog/cards', {
      query: expect.objectContaining({ page: 2, pageSize: 12 }),
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/inventory/owned-quantities', { query: { ids: '2012,2013' } })

    const loaded = panelCards(component).find(item => item.text().includes('Katalogkarte 13'))
    expect(loaded).toBeTruthy()
    expect(loaded!.text()).toContain('Besitz: 4')
  })

  it('starts over at the first page when a filter changes', async () => {
    state.deck = deckDetail({})
    state.source = { items: inventoryItems(12), total: 14 }
    stubSourceFetch(() => Promise.resolve({ items: inventoryItems(2, 12), total: 14 }))

    const component = await mountSuspended(DeckEditorPage)
    await loadMoreButton(component)!.trigger('click')
    await flushPromises()
    expect(panelCards(component)).toHaveLength(14)

    await selectWithOption(component.findAllComponents(USelect), '__all_types__')!.setValue('Normal Monster')
    await flushPromises()

    expect(panelCards(component)).toHaveLength(12)
    expect(component.text()).toContain('12 von 14 Karten')
    expect(loadMoreButton(component)).toBeTruthy()
  })

  it('drops a page that arrives after the filters changed', async () => {
    state.deck = deckDetail({})
    state.source = { items: inventoryItems(12), total: 14 }
    let resolvePage: ((page: unknown) => void) | undefined
    stubSourceFetch(() => new Promise((resolve) => {
      resolvePage = resolve
    }))

    const component = await mountSuspended(DeckEditorPage)
    await loadMoreButton(component)!.trigger('click')

    await selectWithOption(component.findAllComponents(USelect), '__all_types__')!.setValue('Normal Monster')
    await flushPromises()

    resolvePage!({ items: inventoryItems(2, 12), total: 14 })
    await flushPromises()

    expect(panelCards(component)).toHaveLength(12)
    expect(component.text()).not.toContain('Karte 13')
    expect(component.text()).toContain('12 von 14 Karten')
    expect(loadMoreButton(component)).toBeTruthy()
  })

  it('reports a failed page and keeps the list', async () => {
    state.deck = deckDetail({})
    state.source = { items: inventoryItems(12), total: 14 }
    stubSourceFetch(() => Promise.reject(new Error('offline')))

    const component = await mountSuspended(DeckEditorPage)
    await loadMoreButton(component)!.trigger('click')
    await flushPromises()

    expect(component.text()).toContain('Weitere Karten konnten nicht geladen werden.')
    expect(panelCards(component)).toHaveLength(12)
    expect(loadMoreButton(component)).toBeTruthy()
  })

  it('offers no "Mehr laden" when every match is listed', async () => {
    state.deck = deckDetail({})
    state.source = { items: inventoryItems(12), total: 12 }

    const component = await mountSuspended(DeckEditorPage)

    expect(panelCards(component)).toHaveLength(12)
    expect(component.text()).toContain('12 Karten')
    expect(component.text()).not.toContain('von 12 Karten')
    expect(loadMoreButton(component)).toBeUndefined()
  })
})

describe('deck editor in English', () => {
  const POT_OF_GREED = 55144522
  const RAIGEKI = 12580477

  function goatDeck() {
    return {
      ...deckDetail(
        {
          main: [
            row({ name: 'Dark Magician', section: 'main' }),
            row({ catalogCardId: POT_OF_GREED, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', attribute: null, race: 'Normal', level: null, section: 'main' }),
            row({ catalogCardId: RAIGEKI, name: 'Raigeki', type: 'Spell Card', frameType: 'spell', attribute: null, race: 'Normal', level: null, section: 'main' }),
          ],
        },
        [],
        { id: 'goat', name: 'GOAT Format', isBuiltin: true },
        {
          legal: false,
          issues: [
            { severity: 'error', code: 'deck_size_min', section: 'main', params: { section: 'main', count: 3, min: 40 }, message: 'The Main Deck has 3 cards; at least 40 are required.' },
            { severity: 'error', code: 'card_forbidden', cardId: RAIGEKI, params: { cardId: RAIGEKI, cardName: 'Raigeki' }, message: 'Raigeki is forbidden in this format.' },
          ],
          cards: {
            [POT_OF_GREED]: { maxCopies: 1, status: 'limited', reasons: [{ kind: 'banlist', source: 'goat', raw: 'Limited' }] },
            [RAIGEKI]: {
              maxCopies: 0,
              status: 'forbidden',
              reasons: [{
                kind: 'filter',
                label: 'Only cards up to June 2005',
                rule: { kind: 'filter', match: 'not_matching', filter: { releasedBefore: '2005-07-01' }, maxCopies: 0, label: 'Only cards up to June 2005' },
              }],
            },
          },
        },
      ),
      cover: { catalogCardId: 46986414, name: 'Dark Magician', imageSmall: null, imageLarge: null },
      coverIsChosen: true,
    }
  }

  it('renders the validation issues, status badges, cover badge and row menu in English', async () => {
    state.source = { items: [], total: 0 }
    state.deck = goatDeck()
    state.formats = {
      items: [
        { id: 'goat', name: 'GOAT Format', isBuiltin: true },
        { id: 'unlimited', name: 'No banlist', isBuiltin: true },
        { id: 'own-1', name: 'Nur alte Karten', isBuiltin: false },
      ],
    }
    await setTestLocale('en')

    const component = await mountSuspended(DeckEditorPage)
    const text = component.text()

    expect(component.find('[aria-label="Rule check status"]').text()).toBe('Not legal – 2 issues')
    expect(text).toContain('The Main Deck has 3 cards; at least 40 are required.')
    expect(text).toContain('Raigeki is forbidden in this format.')
    expect(text).toContain('3 cards in total')
    expect(component.find('[data-testid="deck-breakdown"]').findAll('li').map(li => li.text())).toEqual(['1 Normal Monster', '2 Spell Cards'])
    expect(component.find('[data-testid="deck-breakdown"] ul').attributes('aria-label')).toBe('Card kinds in the Main Deck')
    expect(text).toContain('Cover card')
    expect(text).toContain('Add from inventory')
    expect(text).not.toMatch(/Karte|Regel|Titelkarte|Verboten|Limitiert|hinzufügen/)

    // Status badges and their tooltips (the reasons behind the limit).
    const forbidden = component.find('[title="Only cards up to June 2005"]')
    expect(forbidden.exists()).toBe(true)
    expect(forbidden.text()).toBe('Forbidden')
    expect(component.find('[title="GOAT banlist: Limited"]').text()).toBe('Limited (1)')

    const formatSelect = selectWithOption(component.findAllComponents(USelect), '__no_format__')
    expect(optionLabels(formatSelect!)).toEqual(['No format', 'GOAT Format', 'No banlist', 'Nur alte Karten (custom)'])

    const menus = component.findAllComponents(UDropdownMenu) as unknown as Array<{ props: (key: string) => unknown, find: (selector: string) => { exists: () => boolean } }>
    const potMenu = menus.find(menu => menu.find('[aria-label="Options for Pot of Greed"]').exists())
    expect((potMenu!.props('items') as Array<Array<{ label: string }>>).flat().map(item => item.label))
      .toEqual(['Move to Extra Deck', 'Move to Side Deck', 'Set as cover card'])
    expect(component.find('[aria-label="Remove one copy of Dark Magician from the Main Deck"]').exists()).toBe(true)
  })

  it('shows a built-in format\'s German cutoff label in German mode', async () => {
    state.source = { items: [], total: 0 }
    state.deck = goatDeck()

    const component = await mountSuspended(DeckEditorPage)

    expect(component.find('[title="Nur Karten bis Juni 2005"]').text()).toBe('Verboten')
    expect(component.find('[title="GOAT-Banliste: Limited"]').text()).toBe('Limitiert (1)')
    expect(component.text()).toContain('Das Main Deck hat 3 Karten, mindestens 40 sind erforderlich.')
    expect(component.text()).toContain('Titelkarte')
  })
})
