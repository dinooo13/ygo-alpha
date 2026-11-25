import { DECK_SECTIONS } from '~~/shared/deck-sections'
import type { DeckSection } from '~~/shared/deck-sections'
import { MAX_WISHLIST_QUANTITY } from '~~/shared/sharing'

/** What a deck row needs for the shortfall: the card, its copies here, the owned total. */
export interface ShortfallRow {
  catalogCardId: number
  name: string
  nameDe?: string | null
  quantity: number
  owned: number
}

/** A card the deck is short of, over Main + Extra + Side. */
export interface MissingCard {
  catalogCardId: number
  name: string
  nameDe: string | null
  /** Copies in the whole deck minus the copies owned; always > 0. */
  missing: number
  wishlisted: boolean
}

/**
 * The cards a deck needs more copies of than the user owns (#178): copies
 * are summed over all sections, the owned total is the card's (every row of
 * a card carries the same one). In deck order, Main first; `isWishlisted`
 * marks the cards already on the wishlist.
 */
export function missingCards(
  sections: Record<DeckSection, readonly ShortfallRow[]>,
  isWishlisted: (catalogCardId: number) => boolean = () => false,
): MissingCard[] {
  const byCard = new Map<number, { row: ShortfallRow, used: number }>()
  for (const section of DECK_SECTIONS) {
    for (const row of sections[section]) {
      const entry = byCard.get(row.catalogCardId)
      if (entry) {
        entry.used += row.quantity
      }
      else {
        byCard.set(row.catalogCardId, { row, used: row.quantity })
      }
    }
  }

  const missing: MissingCard[] = []
  for (const { row, used } of byCard.values()) {
    const short = used - row.owned
    if (short > 0) {
      missing.push({
        catalogCardId: row.catalogCardId,
        name: row.name,
        nameDe: row.nameDe ?? null,
        missing: short,
        wishlisted: isWishlisted(row.catalogCardId),
      })
    }
  }
  return missing
}

/** The quantity to wish for: the shortfall, at least 1, at most the wishlist's cap. */
export function wishlistQuantity(shortfall: number): number {
  return Math.min(MAX_WISHLIST_QUANTITY, Math.max(1, shortfall))
}
