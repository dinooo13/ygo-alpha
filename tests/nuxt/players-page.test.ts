import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount } from '@vue/test-utils'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import PlayerIndexPage from '~/pages/players/[handle]/index.vue'
import PlayerDeckPage from '~/pages/players/[handle]/decks/[id].vue'
import type { PublicProfileResponse, SharedDeckView, SharedWishlistResponse } from '~~/shared/sharing'
import { setTestLocale } from './fixtures/locale'

const state = vi.hoisted(() => ({
  profile: null as PublicProfileResponse | null,
  deck: null as SharedDeckView | null,
  wishlist: null as SharedWishlistResponse | null,
  error: null as Error | null,
  // Consumed by `SharingNotFoundNotice` (mocked module below) to decide
  // whether the "melde dich an" hint should render on the not-found box.
  session: null as { session: unknown, user: { email: string } } | null,
}))

vi.mock('~/utils/session', () => ({
  getAuthSession: vi.fn(() => Promise.resolve(state.session)),
}))

mockNuxtImport('useFetch', () => {
  return (url: string | (() => string)) => {
    const resolvedUrl = typeof url === 'function' ? url() : url
    if (resolvedUrl.includes('/decks/')) {
      return { data: ref(state.deck), error: ref(state.error), pending: ref(false), refresh: vi.fn() }
    }
    if (resolvedUrl.endsWith('/wishlist')) {
      return { data: ref(state.wishlist), error: ref(null), pending: ref(false), refresh: vi.fn() }
    }
    return { data: ref(state.profile), error: ref(state.error), pending: ref(false), refresh: vi.fn() }
  }
})

mockNuxtImport('useRoute', () => {
  return () => ({ params: { handle: 'fabian', id: 'deck-1' }, query: {}, fullPath: '/players/fabian' })
})

// mountSuspended never unmounts; a later locale switch would re-render every earlier mount (#104).
enableAutoUnmount(afterEach)

afterEach(async () => {
  state.session = null
  state.wishlist = null
  await setTestLocale('de')
})

function profileResponse(overrides: Partial<PublicProfileResponse> = {}): PublicProfileResponse {
  return {
    profile: { handle: 'fabian', displayName: 'Fabian', bio: 'Sammle Blue-Eyes' },
    viewer: { isAuthenticated: false, isOwner: false },
    decks: [],
    collections: [],
    inventory: { visible: false, cardCount: 0 },
    wishlist: { visible: false, itemCount: 0 },
    ...overrides,
  }
}

describe('public profile page', () => {
  it('renders display name, bio, shared decks, shared collections and the inventory link', async () => {
    state.error = null
    state.profile = profileResponse({
      decks: [{
        id: 'deck-1',
        name: 'Blue-Eyes Deck',
        description: null,
        mainCount: 40,
        extraCount: 0,
        sideCount: 0,
        cardCount: 40,
        formatName: null,
        legal: null,
        visibility: 'public',
        updatedAt: '2025-01-01T00:00:00.000Z',
        cover: {
          catalogCardId: 89631139,
          name: 'Blue-Eyes White Dragon',
          nameDe: null,
          imageSmall: 'https://images.example/cards_small/89631139.jpg',
          imageLarge: 'https://images.example/cards/89631139.jpg',
        },
        breakdown: [{ section: 'main', kinds: [{ kind: 'normal', count: 30 }, { kind: 'spell', count: 10 }] }],
      }],
      collections: [{ id: 'col-1', name: 'Binder', description: null, cardCount: 10, visibility: 'public' }],
      inventory: { visible: true, cardCount: 120 },
    })

    const component = await mountSuspended(PlayerIndexPage)
    const text = component.text()

    expect(text).toContain('Fabian')
    expect(text).toContain('Sammle Blue-Eyes')
    expect(text).toContain('Blue-Eyes Deck')
    expect(text).toContain('Binder')
    expect(text).toContain('Inventar ansehen')

    // Initials avatar (#29) and the deck tile's cover card.
    expect(component.find('[data-slot="fallback"]').text()).toBe('F')
    expect(component.find('img[src="https://images.example/cards_small/89631139.jpg"]').exists()).toBe(true)

    // Whole tiles are click targets (#134): one stretched link per tile, the
    // decorative cover outside any link.
    const [deckTile, collectionTile] = component.findAll('ul.grid > li')
    const deckLinks = deckTile!.findAll('a')
    expect(deckLinks).toHaveLength(1)
    expect(deckLinks[0]!.attributes('href')).toBe('/players/fabian/decks/deck-1')
    expect(deckLinks[0]!.classes()).toContain('stretched-link')
    expect(deckTile!.find('img').element.closest('a')).toBeNull()

    // The compact card-kind chips (#148): short text, the full one for screen readers.
    const kinds = deckTile!.find('ul[aria-label="Kartenarten im Main und Extra Deck"]')
    expect(kinds.findAll('li').map(li => li.find('[aria-hidden="true"]:not(.frame-dot)').text())).toEqual(['30 Normal', '10 Zauber'])
    expect(kinds.findAll('li .sr-only').map(span => span.text())).toEqual(['30 Normale Monster', '10 Zauberkarten'])

    const collectionLinks = collectionTile!.findAll('a')
    expect(collectionLinks).toHaveLength(1)
    expect(collectionLinks[0]!.attributes('href')).toBe('/players/fabian/collections/col-1')
    expect(collectionLinks[0]!.classes()).toContain('stretched-link')
  })

  it('renders in English with English plurals', async () => {
    await setTestLocale('en')
    state.error = null
    state.profile = profileResponse({
      viewer: { isAuthenticated: true, isOwner: true },
      collections: [{ id: 'col-1', name: 'Binder', description: null, cardCount: 1, visibility: 'link' }],
      inventory: { visible: true, cardCount: 1200 },
    })

    const component = await mountSuspended(PlayerIndexPage)
    const text = component.text()

    expect(text).toContain('@fabian')
    expect(text).toContain('Preview of your profile – only you can see private content.')
    expect(text).toContain('Collections')
    expect(text).toContain('1 card')
    expect(text).toContain('Link only')
    expect(text).toContain('1,200 cards')
    expect(text).toContain('View inventory')
    expect(text).not.toMatch(/Karte|Sammlungen|Inventar/)
  })

  it('hides the inventory link when the inventory is not visible', async () => {
    state.error = null
    state.profile = profileResponse({ inventory: { visible: false, cardCount: 0 } })

    const component = await mountSuspended(PlayerIndexPage)

    expect(component.text()).not.toContain('Inventar ansehen')
  })

  it('shows the all-empty state for a profile that shares nothing', async () => {
    state.error = null
    state.profile = profileResponse()

    const component = await mountSuspended(PlayerIndexPage)

    expect(component.text()).toContain('Dieses Profil teilt aktuell nichts.')
  })

  it('does not show the owner preview notice to a visitor', async () => {
    state.error = null
    state.profile = profileResponse()

    const component = await mountSuspended(PlayerIndexPage)

    expect(component.text()).not.toContain('Vorschau deines Profils')
    expect(component.text()).not.toContain('Sichtbarkeit verwalten')
  })

  it('marks a retired card in the wishlist teaser, with the public hint (ADR 0019, #108)', async () => {
    state.error = null
    state.profile = profileResponse({ wishlist: { visible: true, itemCount: 2 } })
    const item = (id: number, name: string, retired: boolean) => ({
      id: `wish-${id}`,
      catalogCardId: id,
      name,
      nameDe: null,
      type: 'Effect Monster',
      imageSmall: null,
      retired,
      quantity: 1,
      note: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    state.wishlist = {
      owner: { handle: 'fabian', displayName: 'Fabian', bio: null },
      items: [item(101402013, 'Leviathan of Atlantis - Daedalus', true), item(40640057, 'Kuriboh', false)],
      total: 2,
      page: 1,
      pageSize: 5,
    }

    const component = await mountSuspended(PlayerIndexPage)

    const rows = component.findAll('li')
    const retiredRow = rows.find(row => row.text().includes('Leviathan'))!
    expect(retiredRow.text()).toContain('Nicht mehr im Katalog')
    expect(rows.find(row => row.text().includes('Kuriboh'))!.text()).not.toContain('Nicht mehr im Katalog')

    await retiredRow.find('[data-testid="card-retired-badge"]').trigger('click')
    await vi.waitFor(() => {
      expect(new DOMWrapper(document.body).find('[data-testid="card-retired-hint"]').text())
        .toBe('YGOPRODeck führt diese Karte nicht mehr, deshalb taucht sie in der Suche nicht mehr auf.')
    })
  })

  it('shows the owner a preview notice and an owner-specific empty state', async () => {
    state.error = null
    state.profile = profileResponse({ viewer: { isAuthenticated: true, isOwner: true } })

    const component = await mountSuspended(PlayerIndexPage)
    const text = component.text()

    expect(text).toContain('Vorschau deines Profils – private Inhalte siehst nur du.')
    expect(text).toContain('Du teilst aktuell nichts.')
    expect(text).not.toContain('Dieses Profil teilt aktuell nichts.')
    const manageLinks = component.findAll('a[href="/profile"]')
    expect(manageLinks.length).toBe(2)
    expect(manageLinks[0]!.text()).toContain('Sichtbarkeit verwalten')
  })
})

describe('shared not-found notice', () => {
  it('offers an anonymous visitor a login link carrying the current path as redirect', async () => {
    state.error = new Error('Not found')
    state.profile = null
    state.session = null

    const component = await mountSuspended(PlayerIndexPage)
    await component.vm.$nextTick()

    expect(component.text()).toContain('Nicht gefunden oder nicht freigegeben.')
    expect(component.text()).toContain('Falls die Freigabe für dein Konto gilt')
    const loginLink = component.find('a[href^="/login"]')
    expect(loginLink.exists()).toBe(true)
    expect(loginLink.attributes('href')).toBe('/login?redirect=/players/fabian')
  })

  it('does not show the login hint to an already signed-in visitor', async () => {
    state.error = new Error('Not found')
    state.profile = null
    state.session = { session: {}, user: { email: 'other@example.com' } }

    const component = await mountSuspended(PlayerIndexPage)
    await component.vm.$nextTick()

    expect(component.text()).toContain('Nicht gefunden oder nicht freigegeben.')
    expect(component.text()).not.toContain('Falls die Freigabe für dein Konto gilt')
  })
})

describe('public deck page', () => {
  it('renders section headings and quantities without ownership or edit affordances for a non-owner', async () => {
    state.error = null
    state.deck = {
      owner: { handle: 'fabian', displayName: 'Fabian', bio: null },
      deck: { id: 'deck-1', name: 'Blue-Eyes Deck', description: null, updatedAt: '2025-01-01T00:00:00.000Z', coverCardId: null },
      sections: {
        main: [{
          catalogCardId: 89631139,
          name: 'Blue-Eyes White Dragon',
          nameDe: null,
          type: 'Normal Monster',
          frameType: 'normal',
          attribute: 'LIGHT',
          race: 'Dragon',
          level: 8,
          linkval: null,
          atk: 3000,
          def: 2500,
          imageSmall: null,
          imageLarge: null,
          section: 'main',
          quantity: 3,
          retired: false,
        }],
        extra: [],
        side: [],
      },
      counts: { main: 3, extra: 0, side: 0, total: 3 },
      limits: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15, maxCopies: 3 },
      warnings: [],
      format: null,
      validation: null,
      isOwner: false,
    }

    const component = await mountSuspended(PlayerDeckPage)
    const text = component.text()

    expect(text).toContain('Main Deck')
    expect(text).toContain('Blue-Eyes White Dragon')
    expect(text).toContain('3×')
    expect(text).not.toContain('besitzt')
    expect(text).not.toContain('fehlt')
    expect(text).not.toContain('Bearbeiten')
    expect(text).toContain('Geteilt von Fabian')
    expect(component.find('[data-slot="fallback"]').text()).toBe('F')
    expect(component.find('[data-testid="card-retired-badge"]').exists()).toBe(false)
    // The card-kind chips (#148), from the shared rows.
    const breakdown = component.find('[data-testid="deck-breakdown"]')
    expect(breakdown.find('[data-section="main"] ul').attributes('aria-label')).toBe('Kartenarten im Main Deck')
    expect(breakdown.findAll('li').map(li => li.text())).toEqual(['3 Normale Monster'])
  })

  it('marks a retired card in the shared deck (ADR 0019, #108)', async () => {
    state.error = null
    state.deck = baseDeck({
      sections: {
        main: [{
          catalogCardId: 101402013,
          name: 'Leviathan of Atlantis - Daedalus',
          nameDe: null,
          type: 'Effect Monster',
          frameType: 'effect',
          attribute: 'WATER',
          race: 'Sea Serpent',
          level: 7,
          linkval: null,
          atk: 2600,
          def: 1500,
          imageSmall: null,
          imageLarge: null,
          section: 'main',
          quantity: 1,
          retired: true,
        }],
        extra: [],
        side: [],
      },
    })

    const component = await mountSuspended(PlayerDeckPage)

    const row = component.findAll('li').find(item => item.text().includes('Leviathan'))!
    expect(row.find('[data-testid="card-retired-badge"]').text()).toBe('Nicht mehr im Katalog')
  })

  function baseDeck(overrides: Partial<SharedDeckView> = {}): SharedDeckView {
    return {
      owner: { handle: 'fabian', displayName: 'Fabian', bio: null },
      deck: { id: 'deck-1', name: 'Blue-Eyes Deck', description: null, updatedAt: '2025-01-01T00:00:00.000Z', coverCardId: null },
      sections: { main: [], extra: [], side: [] },
      counts: { main: 8, extra: 0, side: 0, total: 8 },
      limits: { mainMin: 40, mainMax: 60, extraMax: 15, sideMax: 15, maxCopies: 3 },
      warnings: [{ code: 'main_below_min', params: { section: 'main', count: 8, min: 40 }, message: 'The Main Deck has 8 cards; the usual minimum is 40.' }],
      format: { id: 'format-1', name: 'Standard', isBuiltin: true },
      validation: {
        legal: false,
        issues: [{ severity: 'error', code: 'deck_size_min', section: 'main', params: { section: 'main', count: 8, min: 40 }, message: 'The Main Deck has 8 cards; at least 40 are required.' }],
        cards: {},
      },
      isOwner: false,
      ...overrides,
    }
  }

  it('hides the deck-building coaching box from a non-owner but shows the legality issues collapsed under the badge', async () => {
    state.error = null
    state.deck = baseDeck({ isOwner: false })

    const component = await mountSuspended(PlayerDeckPage)
    const text = component.text()

    expect(text).not.toContain('Hinweise zum Deckaufbau')
    expect(text).toContain('Nicht legal')
    expect(text).toContain('Details anzeigen')
    // Collapsed by default — the issue text sits in the (unmounted-on-hide)
    // collapsible content, so it should not yet appear in the rendered text.
    expect(text).not.toContain('mindestens 40 sind erforderlich')

    const detailsButton = component.findAll('button').find(btn => btn.text().includes('Details anzeigen'))
    expect(detailsButton).toBeTruthy()
    await detailsButton!.trigger('click')
    await component.vm.$nextTick()

    expect(component.text()).toContain('mindestens 40 sind erforderlich')
  })

  it('renders the player deck page in English', async () => {
    state.error = null
    state.deck = baseDeck({ isOwner: true, format: { id: 'goat', name: 'GOAT Format', isBuiltin: true } })
    await setTestLocale('en')

    const component = await mountSuspended(PlayerDeckPage)
    const text = component.text()

    expect(text).toContain('Shared by Fabian')
    expect(text).toContain('8 cards in total · View only')
    expect(text).toContain('Back to profile')
    expect(text).toContain('Edit')
    expect(text).toContain('Not legal')
    expect(text).toContain('Show details')
    expect(text).toContain('Deck-building hints')
    expect(text).toContain('The Main Deck has 8 cards; the usual minimum is 40.')
    expect(text).toContain('No cards in the Extra Deck yet.')
    expect(text).not.toMatch(/Karte|Geteilt|Hinweise|Details anzeigen|Bearbeiten/)

    const detailsButton = component.findAll('button').find(btn => btn.text().includes('Show details'))
    await detailsButton!.trigger('click')
    await component.vm.$nextTick()
    expect(component.text()).toContain('The Main Deck has 8 cards; at least 40 are required.')
  })

  it('shows the deck-building coaching box to the owner', async () => {
    state.error = null
    state.deck = baseDeck({ isOwner: true })

    const component = await mountSuspended(PlayerDeckPage)

    expect(component.text()).toContain('Hinweise zum Deckaufbau')
  })
})
