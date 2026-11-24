// A printing is one card in one set with one rarity (ADR 0034). Shared by the
// catalog sync, the inventory and the UI, so the key and the label are built
// the same way everywhere.

/**
 * Normalizes YGOPRODeck's `set_rarity_code` ("(UR)", "(ScR)", sometimes "")
 * to the bare code ("UR", "ScR"); `null` when there is none.
 */
export function normalizeRarityCode(code: string | null | undefined): string | null {
  const bare = code?.trim().replace(/^\(+|\)+$/g, '').trim()
  return bare ? bare : null
}

/**
 * The `catalog_printing.id` of a printing: `<card id>|<set code>|<rarity>`,
 * where the rarity is the rarity code, or the rarity name when YGOPRODeck has
 * no code for it (about 1,500 printings, e.g. "Quarter Century Secret Rare").
 *
 * The set code alone is not unique: one set code comes in several rarities
 * (Blue-Eyes White Dragon has 78 printings under 69 set codes), and YGOPRODeck
 * lists a few set codes under two different cards. The card id makes the key
 * unique across the whole catalog.
 */
export function printingKey(input: {
  cardId: number
  setCode: string
  rarityCode?: string | null
  rarity?: string | null
}): string {
  const rarity = normalizeRarityCode(input.rarityCode) ?? input.rarity?.trim() ?? ''
  return `${input.cardId}|${input.setCode.trim()}|${rarity}`
}

/** What a printing label needs. */
export interface PrintingLabelInput {
  setCode: string
  rarity?: string | null
  rarityCode?: string | null
}

/**
 * The short label of a printing: "LOB-001 (UR)", or "LOB-001 Quarter Century
 * Secret Rare" without a rarity code, or the bare set code without a rarity.
 */
export function printingShortLabel(printing: PrintingLabelInput): string {
  const code = normalizeRarityCode(printing.rarityCode)
  if (code) {
    return `${printing.setCode} (${code})`
  }
  const rarity = printing.rarity?.trim()
  return rarity ? `${printing.setCode} ${rarity}` : printing.setCode
}

/** The long label: "LOB-001 · Ultra Rare (UR)", for pickers. */
export function printingRarityLabel(printing: PrintingLabelInput): string {
  const code = normalizeRarityCode(printing.rarityCode)
  const rarity = printing.rarity?.trim()
  if (rarity && code) {
    return `${rarity} (${code})`
  }
  return rarity || (code ? `(${code})` : '')
}

/**
 * Special `printing` filter value for the stacks without a printing
 * ("Printing unbekannt"), next to the set ids.
 */
export const UNKNOWN_PRINTING_FILTER = '__unknown__'
