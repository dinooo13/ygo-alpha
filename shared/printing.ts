// A printing is one card in one set code, and an owned stack records the set
// code and the rarity of its copies, each optional (ADR 0034). Shared by the
// catalog sync, the inventory and the UI, so keys and labels are built the
// same way everywhere.

import { rarityByKey } from './rarity'

/**
 * The `catalog_printing.id` of a YGOPRODeck `card_sets[]` entry:
 * `<card id>|<set code>|<rarity>`, where the rarity is the rarity key
 * (`normalizeRarity`, shared/rarity.ts) or, when the entry names no known
 * rarity ("New", "2"), YGOPRODeck's text.
 *
 * The set code alone is not unique: one set code comes in several rarities
 * (LC01-EN004 is an Ultra Rare and a Quarter Century Secret Rare), and
 * YGOPRODeck lists a few set codes under two different cards. The card id
 * makes the key unique across the whole catalog.
 */
export function printingKey(input: {
  cardId: number
  setCode: string
  rarityKey?: string | null
  rarity?: string | null
}): string {
  const rarity = input.rarityKey ?? input.rarity?.trim() ?? ''
  return `${input.cardId}|${input.setCode.trim()}|${rarity}`
}

/** The printing of an owned stack: set code and rarity key, `null` = unknown. */
export interface StackPrinting {
  setCode: string | null
  rarity: string | null
}

/**
 * The label of a stack's printing: "LC01-EN004 (QCScR)", the bare set code
 * without a rarity, the rarity's name without a set code
 * ("Quarter Century Secret Rare"); `null` when both are unknown.
 */
export function printingLabel(printing: StackPrinting): string | null {
  const rarity = rarityByKey(printing.rarity)
  if (printing.setCode) {
    return rarity ? `${printing.setCode} (${rarity.abbr})` : printing.setCode
  }
  return rarity?.name ?? null
}

/**
 * One set code of a card with the rarities YGOPRODeck lists for it (ADR
 * 0034): the suggestions of the printing pickers. `rarities` holds rarity
 * keys in `RARITIES` order and may be empty (no usable data: the picker then
 * offers every rarity).
 */
export interface CardSetCode {
  setCode: string
  setName: string
  rarities: string[]
}

/**
 * Special `set` filter value for the stacks without a set code ("Printing
 * unbekannt"), next to the set ids.
 */
export const UNKNOWN_PRINTING_FILTER = '__unknown__'
