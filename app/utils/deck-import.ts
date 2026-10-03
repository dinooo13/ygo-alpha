// Pure helpers for the deck import review (Roadmap Phase 3): turning the
// preview's matches into rows, sorting each resolved card into the section
// its type allows, and building the `POST /api/decks` payload. Kept out of
// the components so the section and merge rules can be unit tested.
import { DECK_LIMITS, defaultSectionForCard, DECK_SECTIONS, MAX_DECK_CARD_QUANTITY } from '~~/shared/deck-sections'
import type { DeckSection } from '~~/shared/deck-sections'
import type { DecklistFormat } from '~~/shared/decklist'
import type { DeckWarning } from '~~/shared/rule-formats'
import { createEntryRow, isEntryRowResolved, selectedCandidate } from '~/utils/card-entry'
import type { EntryRow, EntrySuggestResult } from '~/utils/card-entry'

/** Mirrors MAX_DECK_CREATE_CARDS in server/utils/decks.ts. */
export const MAX_IMPORT_CARDS = 100

/** Mirrors MAX_ENTRY_TEXT_LENGTH in server/utils/card-entry.ts. */
export const IMPORT_TEXT_MAX_LENGTH = 20_000
/** A deck list file is a few KB; this only keeps a wrong file from being read. */
export const IMPORT_FILE_MAX_BYTES = 200_000

export interface DeckImportPreview {
  format: DecklistFormat
  sections: Record<DeckSection, EntrySuggestResult[]>
}

/** A review row plus the section its line was in; see `rowSection` for the section it ends up in. */
export interface DeckImportRow extends EntryRow {
  section: DeckSection
}

export interface DeckImportCard {
  catalog_card_id: number
  section: DeckSection
  quantity: number
}

export function createImportRows(preview: DeckImportPreview): DeckImportRow[] {
  return DECK_SECTIONS.flatMap(section => preview.sections[section].map(result => ({
    ...createEntryRow(result),
    section,
  })))
}

/**
 * The section a row's card goes to. The Side Deck takes any card; Main and
 * Extra follow the card's type, because an Omega code and a list without
 * headers don't separate them, and the server rejects an Extra Deck monster in
 * Main. An unresolved row keeps the section its line was in.
 */
export function rowSection(row: DeckImportRow): DeckSection {
  const card = selectedCandidate(row)
  if (!card || row.section === 'side') {
    return row.section
  }
  return defaultSectionForCard(card)
}

export function rowsInSection(rows: DeckImportRow[], section: DeckSection): DeckImportRow[] {
  return rows.filter(row => rowSection(row) === section)
}

/** Copies per section, resolved rows only. */
export function importCounts(rows: DeckImportRow[]): Record<DeckSection, number> {
  const counts: Record<DeckSection, number> = { main: 0, extra: 0, side: 0 }
  for (const row of rows) {
    if (isEntryRowResolved(row)) {
      counts[rowSection(row)] += row.quantity
    }
  }
  return counts
}

/**
 * The usual deck sizes the import exceeds or misses (`DECK_LIMITS`), in the
 * shape of the deck editor's structural warnings so the same texts render them.
 * Informational: the deck is created anyway.
 */
export function importSizeWarnings(counts: Record<DeckSection, number>): DeckWarning[] {
  const warnings: DeckWarning[] = []
  const cards = (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`

  if (counts.main < DECK_LIMITS.mainMin) {
    warnings.push({
      code: 'main_below_min',
      params: { section: 'main', count: counts.main, min: DECK_LIMITS.mainMin },
      message: `The Main Deck has ${cards(counts.main)}; the usual minimum is ${DECK_LIMITS.mainMin}.`,
    })
  }
  if (counts.main > DECK_LIMITS.mainMax) {
    warnings.push({
      code: 'main_above_max',
      params: { section: 'main', count: counts.main, max: DECK_LIMITS.mainMax },
      message: `The Main Deck has ${cards(counts.main)}; the usual maximum is ${DECK_LIMITS.mainMax}.`,
    })
  }
  if (counts.extra > DECK_LIMITS.extraMax) {
    warnings.push({
      code: 'extra_above_max',
      params: { section: 'extra', count: counts.extra, max: DECK_LIMITS.extraMax },
      message: `The Extra Deck has ${cards(counts.extra)}; the usual maximum is ${DECK_LIMITS.extraMax}.`,
    })
  }
  if (counts.side > DECK_LIMITS.sideMax) {
    warnings.push({
      code: 'side_above_max',
      params: { section: 'side', count: counts.side, max: DECK_LIMITS.sideMax },
      message: `The Side Deck has ${cards(counts.side)}; the usual maximum is ${DECK_LIMITS.sideMax}.`,
    })
  }
  return warnings
}

/**
 * The `cards` of `POST /api/decks`: one entry per card and section, copies
 * summed (two rows may have been pointed at the same card by hand).
 */
export function buildImportCards(rows: DeckImportRow[]): DeckImportCard[] {
  const merged = new Map<string, DeckImportCard>()
  for (const row of rows) {
    if (!isEntryRowResolved(row)) {
      continue
    }
    const section = rowSection(row)
    const key = `${row.selectedCardId}:${section}`
    const existing = merged.get(key)
    if (existing) {
      existing.quantity = Math.min(MAX_DECK_CARD_QUANTITY, existing.quantity + row.quantity)
    }
    else {
      merged.set(key, { catalog_card_id: row.selectedCardId!, section, quantity: Math.min(MAX_DECK_CARD_QUANTITY, row.quantity) })
    }
  }
  return [...merged.values()]
}
