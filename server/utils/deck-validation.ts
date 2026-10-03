// Bridges the pure rule engine (shared/rule-formats.ts) and the database:
// loads exactly the catalog fields a rule can look at and runs the engine.
//
// Validation results are never stored — they are recomputed on every read, so
// a banlist/catalog refresh or a format edit takes effect immediately
// (docs/adr/0005-rule-format-model.md).

import { inArray } from 'drizzle-orm'
import type { useDb } from '../db'
import { catalogCard, catalogPrinting } from '../db/schema'
import { cardNameDeSql } from './card-translation-sql'
import { defaultSectionForCard } from '../../shared/deck-sections'
import type { ClassicPlusBanlist } from '../../shared/classic-plus'
import { DEFAULT_MAX_COPIES, evaluateDeck } from '../../shared/rule-formats'
import type {
  DeckCardEntry,
  DeckValidation,
  RuleSet,
  ValidationCardData,
} from '../../shared/rule-formats'
import classicPlusBanlistJson from './classic-plus-banlist.json'
import edisonBanlistJson from './edison-banlist.json'

type Db = ReturnType<typeof useDb>

/** Classic Plus banlist status by card id, in YGOPRODeck's wording (ADR 0022). */
const classicPlusBanlist: ClassicPlusBanlist = classicPlusBanlistJson
const classicPlusStatus = new Map<number, string>([
  ...classicPlusBanlist.forbidden.map(id => [id, 'Forbidden'] as const),
  ...classicPlusBanlist.limited.map(id => [id, 'Limited'] as const),
  ...classicPlusBanlist.semiLimited.map(id => [id, 'Semi-Limited'] as const),
])

/** Edison banlist status by card id: the TCG list of March 2010, from the Format Library (ADR 0030). */
const edisonBanlist: ClassicPlusBanlist = edisonBanlistJson
const edisonStatus = new Map<number, string>([
  ...edisonBanlist.forbidden.map(id => [id, 'Forbidden'] as const),
  ...edisonBanlist.limited.map(id => [id, 'Limited'] as const),
  ...edisonBanlist.semiLimited.map(id => [id, 'Semi-Limited'] as const),
])

/**
 * Loads the catalog data the rule engine needs for `cardIds`: card fields plus
 * the ids of the sets the card has a printing in (one extra query, not one per
 * card). The Edison and Classic Plus statuses aren't catalog data; they are
 * added to `banlistInfo` here, so the engine reads every banlist the same way.
 */
export function loadCardDataForValidation(db: Db, cardIds: number[]): Map<number, ValidationCardData> {
  const uniqueIds = [...new Set(cardIds)]
  const byId = new Map<number, ValidationCardData>()
  if (uniqueIds.length === 0) {
    return byId
  }

  const rows = db
    .select({
      id: catalogCard.id,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      frameType: catalogCard.frameType,
      attribute: catalogCard.attribute,
      race: catalogCard.race,
      archetype: catalogCard.archetype,
      level: catalogCard.level,
      atk: catalogCard.atk,
      def: catalogCard.def,
      banlistInfo: catalogCard.banlistInfo,
      tcgDate: catalogCard.tcgDate,
      ocgDate: catalogCard.ocgDate,
    })
    .from(catalogCard)
    .where(inArray(catalogCard.id, uniqueIds))
    .all()

  for (const row of rows) {
    const edison = edisonStatus.get(row.id)
    const classicPlus = classicPlusStatus.get(row.id)
    const banlistInfo = edison || classicPlus
      ? {
          ...row.banlistInfo,
          ...(edison ? { ban_edison: edison } : {}),
          ...(classicPlus ? { ban_classic_plus: classicPlus } : {}),
        }
      : row.banlistInfo
    byId.set(row.id, { ...row, banlistInfo, setIds: [] })
  }

  const printings = db
    .select({ cardId: catalogPrinting.cardId, setId: catalogPrinting.setId })
    .from(catalogPrinting)
    .where(inArray(catalogPrinting.cardId, uniqueIds))
    .all()

  for (const printing of printings) {
    const card = byId.get(printing.cardId)
    if (card && !card.setIds!.includes(printing.setId)) {
      card.setIds!.push(printing.setId)
    }
  }

  return byId
}

/**
 * English and German catalog card names by id (ADR 0015) — the format
 * editor's rule summaries and the assistant's proposal rows. `cardNamesDe`
 * only has the cards with a German name.
 */
export function loadCardNameRecords(db: Db, cardIds: number[]): { cardNames: Record<number, string>, cardNamesDe: Record<number, string> } {
  const uniqueIds = [...new Set(cardIds)]
  if (uniqueIds.length === 0) {
    return { cardNames: {}, cardNamesDe: {} }
  }

  const rows = db
    .select({ id: catalogCard.id, name: catalogCard.name, nameDe: cardNameDeSql() })
    .from(catalogCard)
    .where(inArray(catalogCard.id, uniqueIds))
    .all()

  return {
    cardNames: Object.fromEntries(rows.map(row => [row.id, row.name])),
    cardNamesDe: Object.fromEntries(rows.flatMap(row => (row.nameDe ? [[row.id, row.nameDe]] : []))),
  }
}

/** Card ids that do not exist in the catalog. */
export function missingCatalogCardIds(db: Db, cardIds: number[]): number[] {
  const uniqueIds = [...new Set(cardIds)]
  if (uniqueIds.length === 0) {
    return []
  }

  const known = new Set(db
    .select({ id: catalogCard.id })
    .from(catalogCard)
    .where(inArray(catalogCard.id, uniqueIds))
    .all()
    .map(row => row.id))

  return uniqueIds.filter(id => !known.has(id))
}

/** Runs the rule engine for one deck, loading the card data it needs. */
export function validateDeckCards(
  db: Db,
  ruleSet: RuleSet,
  deckCards: DeckCardEntry[],
): DeckValidation {
  const cardData = loadCardDataForValidation(db, deckCards.map(entry => entry.catalogCardId))
  return evaluateDeck(ruleSet, deckCards, cardData)
}

/**
 * The effective per-card copy limit under a rule set — the rule engine's own
 * `maxCopies` (the minimum of the `copies` rule, any `card_status`, the
 * banlist, and every applicable `filter` rule), so it can never disagree
 * with what `evaluateDeck` later reports. `0` means the card is forbidden.
 * Without a rule set every card gets the standard limit (3). Used by the chat
 * assistant's `search_inventory` to tell the model how many copies of an
 * owned card a format allows (docs/adr/0011-deck-assistance-in-chat.md).
 */
export function maxCopiesByCard(db: Db, rules: RuleSet | null, cardIds: number[]): Map<number, number> {
  const uniqueIds = [...new Set(cardIds)]
  if (!rules) {
    return new Map(uniqueIds.map(id => [id, DEFAULT_MAX_COPIES]))
  }

  const cardData = loadCardDataForValidation(db, uniqueIds)
  const cards = [...cardData.values()]
  const validation = evaluateDeck(
    rules,
    cards.map(card => ({ catalogCardId: card.id, section: defaultSectionForCard(card), quantity: 1 })),
    cardData,
  )

  return new Map(uniqueIds.map(id => [id, validation.cards[id]?.maxCopies ?? DEFAULT_MAX_COPIES]))
}
