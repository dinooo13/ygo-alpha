// What the quick entry just wrote ("gerade gespeichert"): the copies of each
// save, kept so they can be moved to another collection afterwards without
// typing the list in again. Pure helpers, so the bookkeeping can be unit
// tested on its own (`EntryReviewTable` builds the copies, `EntryJustSavedPanel`
// shows and moves them).

import type { EntryBulkEntry, EntryRow } from '~/utils/card-entry'
import { selectedCandidate } from '~/utils/card-entry'

export interface SavedCopy {
  /** The owned-card stack the copies went into (`POST /api/inventory/bulk`'s `items[].id`). */
  ownedCardId: string
  catalogCardId: number
  name: string
  nameDe: string | null
  /** The copies this save added, not the stack's total. */
  quantity: number
  /** `null` = "ohne Sammlung". */
  collectionId: string | null
}

/** The part of a bulk answer's item the panel needs. */
interface BulkResponseItem {
  id: string
}

/**
 * The saved copies of one bulk batch: `items` are the server's stacks in the
 * order of `entries` (what was sent). Two lines for the same card and
 * collection end up in one stack and so in one entry.
 */
export function savedCopiesOf(entries: EntryBulkEntry[], items: BulkResponseItem[] | undefined, rows: EntryRow[]): SavedCopy[] {
  if (!items || items.length !== entries.length) {
    return []
  }
  const byRowId = new Map(rows.map(row => [row.id, row]))
  const copies: SavedCopy[] = []
  entries.forEach((entry, index) => {
    const row = byRowId.get(entry.rowId)
    const candidate = row ? selectedCandidate(row) : undefined
    copies.push({
      ownedCardId: items[index]!.id,
      catalogCardId: entry.item.catalogCardId,
      name: candidate?.name ?? String(entry.item.catalogCardId),
      nameDe: candidate?.nameDe ?? null,
      quantity: entry.item.quantity,
      collectionId: entry.item.collectionId,
    })
  })
  return mergeSavedCopies([], copies)
}

/** Adds `incoming` to `existing`; copies in the same stack add up. */
export function mergeSavedCopies(existing: SavedCopy[], incoming: SavedCopy[]): SavedCopy[] {
  const merged = new Map<string, SavedCopy>()
  for (const copy of [...existing, ...incoming]) {
    const known = merged.get(copy.ownedCardId)
    merged.set(copy.ownedCardId, known ? { ...known, quantity: known.quantity + copy.quantity } : { ...copy })
  }
  return [...merged.values()]
}

/**
 * Follows moved copies: every moved entry now is in the target collection, in
 * the stack the move says (`resultId`: a new stack, or one the copies merged
 * into, which entries of the same card coming from different collections can
 * share).
 */
export function applyMovedCopies(
  copies: SavedCopy[],
  moved: Array<{ ownedCardId: string, resultId: string }>,
  toCollectionId: string | null,
): SavedCopy[] {
  const resultByStack = new Map(moved.map(item => [item.ownedCardId, item.resultId]))
  const updated = copies.map((copy) => {
    const resultId = resultByStack.get(copy.ownedCardId)
    return resultId === undefined ? copy : { ...copy, ownedCardId: resultId, collectionId: toCollectionId }
  })
  return mergeSavedCopies([], updated)
}
