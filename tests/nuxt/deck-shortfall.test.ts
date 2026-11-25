import { describe, expect, it } from 'vitest'
import { missingCards, wishlistQuantity } from '~/utils/deck-shortfall'
import { MAX_WISHLIST_QUANTITY } from '~~/shared/sharing'

const DARK_MAGICIAN = 46986414
const STARDUST = 44508094
const KURIBOH = 40640057

function row(catalogCardId: number, name: string, quantity: number, owned: number, nameDe: string | null = null) {
  return { catalogCardId, name, nameDe, quantity, owned }
}

describe('missingCards (#178)', () => {
  it('lists the cards the deck has more copies of than owned, in deck order', () => {
    const missing = missingCards({
      main: [row(DARK_MAGICIAN, 'Dark Magician', 3, 2, 'Dunkler Magier'), row(1, 'Pot of Greed', 1, 4)],
      extra: [row(STARDUST, 'Stardust Dragon', 1, 0)],
      side: [],
    })

    expect(missing).toEqual([
      { catalogCardId: DARK_MAGICIAN, name: 'Dark Magician', nameDe: 'Dunkler Magier', missing: 1, wishlisted: false },
      { catalogCardId: STARDUST, name: 'Stardust Dragon', nameDe: null, missing: 1, wishlisted: false },
    ])
  })

  it('sums a card\'s copies over Main, Extra and Side', () => {
    const missing = missingCards({
      main: [row(KURIBOH, 'Kuriboh', 2, 1)],
      extra: [],
      side: [row(KURIBOH, 'Kuriboh', 2, 1)],
    })

    expect(missing).toEqual([{ catalogCardId: KURIBOH, name: 'Kuriboh', nameDe: null, missing: 3, wishlisted: false }])
  })

  it('leaves out a card whose copies are covered only over the whole deck', () => {
    expect(missingCards({
      main: [row(KURIBOH, 'Kuriboh', 1, 2)],
      extra: [],
      side: [row(KURIBOH, 'Kuriboh', 1, 2)],
    })).toEqual([])
  })

  it('marks the cards already on the wishlist', () => {
    const missing = missingCards(
      {
        main: [row(DARK_MAGICIAN, 'Dark Magician', 3, 0)],
        extra: [row(STARDUST, 'Stardust Dragon', 1, 0)],
        side: [],
      },
      id => id === STARDUST,
    )

    expect(missing.map(card => [card.catalogCardId, card.wishlisted])).toEqual([[DARK_MAGICIAN, false], [STARDUST, true]])
  })

  it('is empty for an empty deck', () => {
    expect(missingCards({ main: [], extra: [], side: [] })).toEqual([])
  })
})

describe('wishlistQuantity', () => {
  it('wishes for the shortfall, at least one and at most the cap', () => {
    expect(wishlistQuantity(0)).toBe(1)
    expect(wishlistQuantity(2)).toBe(2)
    expect(wishlistQuantity(MAX_WISHLIST_QUANTITY + 5)).toBe(MAX_WISHLIST_QUANTITY)
  })
})
