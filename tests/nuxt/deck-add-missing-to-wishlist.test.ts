// "Fehlende Karten auf die Wunschliste" (#178): the deck editor's dialog that
// puts the cards a deck is short of on the wishlist, skipping the ones
// already there so their quantity and note stay.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import AddMissingToWishlistModal from '~/components/decks/DeckAddMissingToWishlistModal.vue'
import type { MissingCard } from '~/utils/deck-shortfall'
import { MAX_WISHLIST_QUANTITY } from '~~/shared/sharing'
import { setTestLocale } from './fixtures/locale'

const toastAdd = vi.hoisted(() => vi.fn())
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

const DARK_MAGICIAN = 46986414
const STARDUST = 44508094
const KURIBOH = 40640057

function card(catalogCardId: number, name: string, missing: number, wishlisted = false, nameDe: string | null = null): MissingCard {
  return { catalogCardId, name, nameDe, missing, wishlisted }
}

// Registered first, so it runs after the unmount: Vue can't remove a
// teleported dialog whose nodes are already gone.
afterEach(async () => {
  vi.unstubAllGlobals()
  toastAdd.mockClear()
  document.body.innerHTML = ''
  await setTestLocale('de')
})

enableAutoUnmount(afterEach)

function body() {
  return new DOMWrapper(document.body)
}

function button(label: string) {
  return body().findAll('[role="dialog"] button').find(entry => entry.text() === label)
}

function rows() {
  return body().findAll('[data-testid="missing-cards"] li')
}

/** `$fetch` with the server's wishlist ids; `post` answers each POST. */
function stubFetch(wishedIds: number[], post: (catalogCardId: number) => Promise<unknown> = () => Promise.resolve(null)) {
  const fetchMock = vi.fn((url: string, options?: { body: { catalogCardId: number } }) => (
    url === '/api/wishlist/ids' ? Promise.resolve({ ids: wishedIds }) : post(options!.body.catalogCardId)
  ))
  vi.stubGlobal('$fetch', fetchMock)
  return fetchMock
}

async function mountModal(cards: MissingCard[]) {
  const component = await mountSuspended(AddMissingToWishlistModal, { props: { open: true, cards } })
  await flushPromises()
  return component
}

describe('DeckAddMissingToWishlistModal', () => {
  it('lists every missing card with its count and marks the wished ones', async () => {
    await mountModal([card(DARK_MAGICIAN, 'Dark Magician', 2, false, 'Dunkler Magier'), card(STARDUST, 'Stardust Dragon', 1, true)])

    expect(body().text()).toContain('Fehlende Karten auf die Wunschliste')
    expect(rows().map(row => row.text())).toEqual([
      'Dunkler Magier2 fehlen',
      'Stardust Dragonschon auf der Wunschliste1 fehlt',
    ])
    expect(rows()[1]!.attributes('data-wishlisted')).toBe('')
    expect(body().text()).toContain('Karten, die schon auf der Wunschliste stehen, bleiben, wie sie sind.')
    expect(button('1 Karte auf die Wunschliste')).toBeTruthy()
  })

  it('posts the cards not yet wished, one after another, with their shortfall', async () => {
    const fetchMock = stubFetch([STARDUST])
    const component = await mountModal([
      card(DARK_MAGICIAN, 'Dark Magician', 2),
      card(STARDUST, 'Stardust Dragon', 1, true),
      card(KURIBOH, 'Kuriboh', MAX_WISHLIST_QUANTITY + 1),
    ])

    await button('2 Karten auf die Wunschliste')!.trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls).toEqual([
      ['/api/wishlist/ids'],
      ['/api/wishlist', { method: 'POST', body: { catalogCardId: DARK_MAGICIAN, quantity: 2 } }],
      ['/api/wishlist', { method: 'POST', body: { catalogCardId: KURIBOH, quantity: MAX_WISHLIST_QUANTITY } }],
    ])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '2 Karten auf die Wunschliste gesetzt', color: 'success' }))
    expect(component.emitted('added')).toEqual([[[DARK_MAGICIAN, KURIBOH]]])
    expect(component.emitted('update:open')).toEqual([[false]])
  })

  it('says so and offers no confirm when every missing card is already wished', async () => {
    const fetchMock = stubFetch([STARDUST])
    await mountModal([card(STARDUST, 'Stardust Dragon', 1, true)])

    expect(body().text()).toContain('Alle fehlenden Karten sind schon auf der Wunschliste.')
    expect(button('Schließen')).toBeTruthy()
    expect(body().findAll('[role="dialog"] button').some(entry => entry.text().includes('auf die Wunschliste'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the error, stays open and reports the cards added before it', async () => {
    const fetchMock = stubFetch([], id => (id === KURIBOH ? Promise.reject(new Error('offline')) : Promise.resolve(null)))
    const component = await mountModal([card(DARK_MAGICIAN, 'Dark Magician', 2), card(KURIBOH, 'Kuriboh', 1), card(STARDUST, 'Stardust Dragon', 1)])

    await button('3 Karten auf die Wunschliste')!.trigger('click')
    await flushPromises()

    // The ids, then stops at the failed card.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(body().find('[role="alert"]').text()).toBe('Die Wunschliste konnte nicht aktualisiert werden.')
    expect(toastAdd).not.toHaveBeenCalled()
    expect(component.emitted('added')).toEqual([[[DARK_MAGICIAN]]])
    expect(component.emitted('update:open')).toBeUndefined()
  })

  it('skips a card wished since the page loaded, so its quantity and note stay', async () => {
    // The page still shows Kuriboh as not wished; another tab wished it since.
    const fetchMock = stubFetch([KURIBOH])
    const component = await mountModal([card(DARK_MAGICIAN, 'Dark Magician', 2), card(KURIBOH, 'Kuriboh', 1)])

    await button('2 Karten auf die Wunschliste')!.trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls).toEqual([
      ['/api/wishlist/ids'],
      ['/api/wishlist', { method: 'POST', body: { catalogCardId: DARK_MAGICIAN, quantity: 2 } }],
    ])
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: '1 Karte auf die Wunschliste gesetzt' }))
    expect(component.emitted('added')).toEqual([[[DARK_MAGICIAN]]])
  })

  it('posts nothing when the wishlist cannot be read', async () => {
    const fetchMock = vi.fn((url: string) => (
      url === '/api/wishlist/ids' ? Promise.reject(new Error('offline')) : Promise.resolve(null)
    ))
    vi.stubGlobal('$fetch', fetchMock)
    const component = await mountModal([card(DARK_MAGICIAN, 'Dark Magician', 2)])

    await button('1 Karte auf die Wunschliste')!.trigger('click')
    await flushPromises()

    expect(fetchMock.mock.calls).toEqual([['/api/wishlist/ids']])
    expect(body().find('[role="alert"]').text()).toBe('Die Wunschliste konnte nicht aktualisiert werden.')
    expect(component.emitted('update:open')).toBeUndefined()
  })

  it('reads in English', async () => {
    await setTestLocale('en')
    await mountModal([card(DARK_MAGICIAN, 'Dark Magician', 1), card(STARDUST, 'Stardust Dragon', 2, true)])

    expect(body().text()).toContain('Add missing cards to wishlist')
    expect(rows().map(row => row.text())).toEqual(['Dark Magician1 missing', 'Stardust Dragonalready on your wishlist2 missing'])
    expect(button('Add 1 card to wishlist')).toBeTruthy()
    expect(body().text()).not.toMatch(/Karte|Wunschliste|fehlt/)
  })
})
