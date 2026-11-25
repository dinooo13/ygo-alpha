// Retired catalog cards (ADR 0019).
//
// YGOPRODeck drops cards from its API: pre-release placeholders get their
// real passcode, and now and then a passcode changes. The sync only upserts,
// so without this step those rows would stay in `catalog_card` for good and
// show up twice in every catalog-wide search. Deleting them is not an option:
// `owned_card`, `deck_card` and `wishlist_item` cascade on delete.
//
// After every sync, `applyCatalogRetirement`:
//
// 1. marks the active rows the latest response didn't list as retired
//    (`retired_at`), unless suspiciously many are missing (the guard);
// 2. finds a replacement for every retired row where it safely can
//    (`replaced_by_id`): the same Konami id, else the same decoded name and
//    type, unique among the active rows;
// 3. moves the users' references to that replacement: inventory, decks, deck
//    covers, wishlist, and the card ids in user formats.
//
// Everything runs in one synchronous transaction (better-sqlite3).
//
// Then `pruneUnlistedCatalogRows` deletes the printings and images the
// response no longer lists (ADR 0023). Owned stacks keep their set code and
// rarity as text (ADR 0034), so pruning a printing never touches them.

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { useDb } from '../db'
import { catalogCard, catalogCardImage, catalogPrinting, deck, deckCard, ownedCard, ruleFormat, wishlistItem } from '../db/schema'
import type { Rule, RuleSet } from '../../shared/rule-formats'
import { chunkRows } from './catalog-sync'
import { MAX_DECK_CARD_QUANTITY } from './decks'
import { joinNotes, sameTupleWhere } from './inventory'

type Db = ReturnType<typeof useDb>

const ID_CHUNK_SIZE = 500
// How many `replaced_by_id` hops the chain rule follows before giving up.
const MAX_CHAIN_HOPS = 10

export interface CatalogRetirementResult {
  /** Rows newly marked retired by this run. */
  retired: number
  /** Retired rows that the latest response listed again (un-retired by the upsert). */
  restored: number
  /** All retired rows that now have an active replacement. */
  withReplacement: number
  withoutReplacement: number
  /** References moved (or merged) to a replacement, per table. */
  remapped: { ownedCards: number, deckCards: number, deckCovers: number, wishlistItems: number, ruleFormats: number }
  /** The guard refused to retire anything (suspiciously many missing cards). */
  skipped: boolean
}

/**
 * Retirement is skipped when more than `max(minimum, ceil(ratio × active))`
 * cards are missing from the response: that looks like a truncated or broken
 * API response, not like YGOPRODeck dropping cards.
 */
export interface RetireGuard {
  minimum: number
  ratio: number
}

export const DEFAULT_RETIRE_GUARD: RetireGuard = { minimum: 200, ratio: 0.05 }

export interface ReplacementCandidate {
  id: number
  konamiId: number | null
  name: string
  type: string
}

export interface ReplacementIndex {
  byKonamiId: Map<number, ReplacementCandidate[]>
  byNameType: Map<string, ReplacementCandidate[]>
}

const NAME_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#039;': '\'',
  '&#39;': '\'',
  '&lt;': '<',
  '&gt;': '>',
}

/**
 * Decodes the few HTML entities YGOPRODeck used in older card names
 * ("Graceful &amp; Skull Dice"). One pass, so `&amp;quot;` becomes `&quot;`.
 */
export function decodeCardNameEntities(name: string): string {
  return name.replace(/&(?:amp|quot|#0?39|lt|gt);/g, entity => NAME_ENTITIES[entity] ?? entity)
}

function nameTypeKey(name: string, type: string): string {
  return `${decodeCardNameEntities(name)}\u0000${type}`
}

function pushTo<K>(map: Map<K, ReplacementCandidate[]>, key: K, row: ReplacementCandidate) {
  const list = map.get(key)
  if (list) {
    list.push(row)
  }
  else {
    map.set(key, [row])
  }
}

/** Builds the lookup maps `pickReplacement` needs from the **active** rows. */
export function buildReplacementIndex(activeRows: ReplacementCandidate[]): ReplacementIndex {
  const index: ReplacementIndex = { byKonamiId: new Map(), byNameType: new Map() }
  for (const row of activeRows) {
    if (row.konamiId !== null) {
      pushTo(index.byKonamiId, row.konamiId, row)
    }
    pushTo(index.byNameType, nameTypeKey(row.name, row.type), row)
  }
  return index
}

/**
 * The active card a retired row was renumbered to, or `null` when there is
 * no certain match:
 *
 * 1. the only active row with the same Konami id (if several share it, the
 *    only one of them with the same decoded name);
 * 2. else the only active row with the same decoded name **and** type.
 *
 * The folded `name_search` is deliberately not used: it collides for real,
 * distinct cards.
 */
export function pickReplacement(
  retired: ReplacementCandidate,
  index: ReplacementIndex,
): ReplacementCandidate | null {
  const decodedName = decodeCardNameEntities(retired.name)

  if (retired.konamiId !== null) {
    const byKonami = index.byKonamiId.get(retired.konamiId) ?? []
    if (byKonami.length === 1) {
      return byKonami[0]!
    }
    if (byKonami.length > 1) {
      const sameName = byKonami.filter(row => decodeCardNameEntities(row.name) === decodedName)
      if (sameName.length === 1) {
        return sameName[0]!
      }
    }
  }

  const byName = index.byNameType.get(nameTypeKey(retired.name, retired.type)) ?? []
  return byName.length === 1 ? byName[0]! : null
}

function remapIds(ids: number[], map: Map<number, number>): { ids: number[], changed: boolean } {
  if (!ids.some(id => map.has(id))) {
    return { ids, changed: false }
  }
  const seen = new Set<number>()
  const next: number[] = []
  for (const id of ids) {
    const mapped = map.get(id) ?? id
    if (!seen.has(mapped)) {
      seen.add(mapped)
      next.push(mapped)
    }
  }
  return { ids: next, changed: true }
}

/**
 * Replaces retired card ids in a format's `card_status` rules and
 * `filter.cardIds` (de-duplicated, order kept). Never mutates `ruleSet`.
 */
export function remapRuleSetCardIds(
  ruleSet: RuleSet,
  map: Map<number, number>,
): { ruleSet: RuleSet, changed: boolean } {
  let changed = false
  const rules = ruleSet.rules.map((rule): Rule => {
    if (rule.kind === 'card_status') {
      const result = remapIds(rule.cardIds, map)
      if (!result.changed) {
        return rule
      }
      changed = true
      return { ...rule, cardIds: result.ids }
    }
    if (rule.kind === 'filter' && rule.filter.cardIds) {
      const result = remapIds(rule.filter.cardIds, map)
      if (!result.changed) {
        return rule
      }
      changed = true
      return { ...rule, filter: { ...rule.filter, cardIds: result.ids } }
    }
    return rule
  })

  return changed ? { ruleSet: { ...ruleSet, rules }, changed } : { ruleSet, changed }
}

function laterDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

/**
 * Resolves `replaced_by_id` for every retired row. A row without a direct
 * match follows its old `replaced_by_id` chain to the first active row, so
 * A → B stays valid when B retires later and is itself replaced by C.
 * Returns the `old → new` map of rows that have an active replacement.
 */
function resolveReplacements(db: Db): Map<number, number> {
  const activeRows = db
    .select({ id: catalogCard.id, konamiId: catalogCard.konamiId, name: catalogCard.name, type: catalogCard.type })
    .from(catalogCard)
    .where(isNull(catalogCard.retiredAt))
    .all()
  const retiredRows = db
    .select({
      id: catalogCard.id,
      konamiId: catalogCard.konamiId,
      name: catalogCard.name,
      type: catalogCard.type,
      replacedById: catalogCard.replacedById,
    })
    .from(catalogCard)
    .where(isNotNull(catalogCard.retiredAt))
    .all()

  const index = buildReplacementIndex(activeRows)
  const activeIds = new Set(activeRows.map(row => row.id))
  const retiredById = new Map(retiredRows.map(row => [row.id, row]))

  const direct = new Map<number, number>()
  for (const row of retiredRows) {
    const match = pickReplacement(row, index)
    if (match) {
      direct.set(row.id, match.id)
    }
  }

  const followChain = (start: number | null): number | null => {
    const visited = new Set<number>()
    let current = start
    for (let hop = 0; hop < MAX_CHAIN_HOPS && current !== null; hop++) {
      if (activeIds.has(current)) {
        return current
      }
      if (visited.has(current)) {
        return null
      }
      visited.add(current)
      current = direct.get(current) ?? retiredById.get(current)?.replacedById ?? null
    }
    return null
  }

  const replacements = new Map<number, number>()
  for (const row of retiredRows) {
    const target = direct.get(row.id) ?? followChain(row.replacedById)
    if (target !== row.replacedById) {
      db.update(catalogCard).set({ replacedById: target }).where(eq(catalogCard.id, row.id)).run()
    }
    if (target !== null) {
      replacements.set(row.id, target)
    }
  }
  return replacements
}

type OwnedCardRow = typeof ownedCard.$inferSelect

/**
 * Moves an owned row to another card and set code. When the user already has
 * a stack with that tuple (ADR 0034: user, card, collection, set code,
 * rarity), the row merges into it like two rows that end up with the same
 * tuple elsewhere (ADR 0017, migration 0014): quantities add up (no cap), the
 * distinct notes are joined. Unlike a user edit, the sync keeps the later
 * `updated_at` instead of bumping it.
 */
function moveOwnedRow(db: Db, row: OwnedCardRow, to: { catalogCardId: number, setCode: string | null }) {
  const target = db
    .select()
    .from(ownedCard)
    .where(sameTupleWhere(row.userId, { ...to, collectionId: row.collectionId, rarity: row.rarity }, row.id))
    .get()

  if (target) {
    db.update(ownedCard)
      .set({
        quantity: target.quantity + row.quantity,
        note: joinNotes(target.note, row.note),
        updatedAt: laterDate(target.updatedAt, row.updatedAt),
      })
      .where(eq(ownedCard.id, target.id))
      .run()
    db.delete(ownedCard).where(eq(ownedCard.id, row.id)).run()
  }
  else {
    db.update(ownedCard)
      // The legacy `printing_id` (ADR 0017) is cleared, as before ADR 0034.
      .set({ catalogCardId: to.catalogCardId, setCode: to.setCode, printingId: null })
      .where(eq(ownedCard.id, row.id))
      .run()
  }
}

// Owned cards move to the replacement card. The set code stays when the
// replacement lists it (renumbered cards keep their set codes), else it
// becomes unknown, as when a user edit changes the card; the rarity stays.
function remapOwnedCards(db: Db, replacements: Map<number, number>): number {
  let count = 0
  for (const oldIds of chunkRows([...replacements.keys()], ID_CHUNK_SIZE)) {
    const rows = db.select().from(ownedCard).where(inArray(ownedCard.catalogCardId, oldIds)).all()
    const newIds = [...new Set(rows.map(row => replacements.get(row.catalogCardId)!))]
    const listed = new Set(
      (newIds.length === 0
        ? []
        : db.select({ cardId: catalogPrinting.cardId, setCode: catalogPrinting.setCode })
            .from(catalogPrinting)
            .where(inArray(catalogPrinting.cardId, newIds))
            .all()
      ).map(printing => `${printing.cardId}|${printing.setCode}`),
    )

    for (const row of rows) {
      const newId = replacements.get(row.catalogCardId)!
      const setCode = row.setCode && listed.has(`${newId}|${row.setCode}`) ? row.setCode : null
      moveOwnedRow(db, row, { catalogCardId: newId, setCode })
      count += 1
    }
  }
  return count
}

function remapDeckCards(db: Db, replacements: Map<number, number>): number {
  let count = 0
  for (const oldIds of chunkRows([...replacements.keys()], ID_CHUNK_SIZE)) {
    const rows = db.select().from(deckCard).where(inArray(deckCard.catalogCardId, oldIds)).all()
    for (const row of rows) {
      const newId = replacements.get(row.catalogCardId)!
      const target = db
        .select()
        .from(deckCard)
        .where(and(
          eq(deckCard.deckId, row.deckId),
          eq(deckCard.catalogCardId, newId),
          eq(deckCard.section, row.section),
        ))
        .get()

      if (target) {
        db.update(deckCard)
          .set({ quantity: Math.min(MAX_DECK_CARD_QUANTITY, target.quantity + row.quantity) })
          .where(eq(deckCard.id, target.id))
          .run()
        db.delete(deckCard).where(eq(deckCard.id, row.id)).run()
      }
      else {
        db.update(deckCard).set({ catalogCardId: newId }).where(eq(deckCard.id, row.id)).run()
      }
      count += 1
    }
  }
  return count
}

function remapDeckCovers(db: Db, replacements: Map<number, number>): number {
  let count = 0
  for (const [oldId, newId] of replacements) {
    count += db.update(deck).set({ coverCardId: newId }).where(eq(deck.coverCardId, oldId)).run().changes
  }
  return count
}

// A wish is not a stock: when both cards are on the wishlist, the higher
// quantity wins instead of the sum.
function remapWishlistItems(db: Db, replacements: Map<number, number>): number {
  let count = 0
  for (const oldIds of chunkRows([...replacements.keys()], ID_CHUNK_SIZE)) {
    const rows = db.select().from(wishlistItem).where(inArray(wishlistItem.catalogCardId, oldIds)).all()
    for (const row of rows) {
      const newId = replacements.get(row.catalogCardId)!
      const target = db
        .select()
        .from(wishlistItem)
        .where(and(eq(wishlistItem.userId, row.userId), eq(wishlistItem.catalogCardId, newId)))
        .get()

      if (target) {
        db.update(wishlistItem)
          .set({ quantity: Math.max(target.quantity, row.quantity), note: target.note ?? row.note })
          .where(eq(wishlistItem.id, target.id))
          .run()
        db.delete(wishlistItem).where(eq(wishlistItem.id, row.id)).run()
      }
      else {
        db.update(wishlistItem).set({ catalogCardId: newId }).where(eq(wishlistItem.id, row.id)).run()
      }
      count += 1
    }
  }
  return count
}

// Built-in formats are reseeded from code and reference no card ids.
function remapRuleFormats(db: Db, replacements: Map<number, number>): number {
  let count = 0
  const formats = db
    .select({ id: ruleFormat.id, rules: ruleFormat.rules })
    .from(ruleFormat)
    .where(eq(ruleFormat.isBuiltin, false))
    .all()
  for (const format of formats) {
    const { ruleSet, changed } = remapRuleSetCardIds(format.rules, replacements)
    if (changed) {
      db.update(ruleFormat).set({ rules: ruleSet }).where(eq(ruleFormat.id, format.id)).run()
      count += 1
    }
  }
  return count
}

/**
 * Retires the active cards missing from `seenIds` (the ids of the latest
 * YGOPRODeck response), resolves replacements for every retired card and
 * moves references to them. Idempotent: a second run with the same ids
 * changes nothing. Never bumps `updated_at` (a sync is not a user edit) and
 * never rewrites tournament snapshots or pending assistant actions.
 *
 * `restored` is passed through into the result: the upsert already
 * un-retired those rows before this runs.
 */
export function applyCatalogRetirement(
  db: Db,
  options: { seenIds: Set<number>, now: Date, guard?: RetireGuard, restored: number },
): CatalogRetirementResult {
  const guard = options.guard ?? DEFAULT_RETIRE_GUARD

  return db.transaction((transaction) => {
    const tx = transaction as unknown as Db
    const activeIds = tx
      .select({ id: catalogCard.id })
      .from(catalogCard)
      .where(isNull(catalogCard.retiredAt))
      .all()
      .map(row => row.id)
    const missing = activeIds.filter(id => !options.seenIds.has(id))

    const limit = Math.max(guard.minimum, Math.ceil(guard.ratio * activeIds.length))
    if (missing.length > limit) {
      console.warn(
        `[catalog-retire] ${missing.length} of ${activeIds.length} active cards are missing from the response`
        + ` (limit ${limit}); skipping retirement`,
      )
      return {
        retired: 0,
        restored: options.restored,
        withReplacement: 0,
        withoutReplacement: 0,
        remapped: { ownedCards: 0, deckCards: 0, deckCovers: 0, wishlistItems: 0, ruleFormats: 0 },
        skipped: true,
      }
    }

    for (const ids of chunkRows(missing, ID_CHUNK_SIZE)) {
      tx.update(catalogCard).set({ retiredAt: options.now }).where(inArray(catalogCard.id, ids)).run()
    }

    const replacements = resolveReplacements(tx)
    const retiredCount = tx
      .select({ id: catalogCard.id })
      .from(catalogCard)
      .where(isNotNull(catalogCard.retiredAt))
      .all()
      .length

    return {
      retired: missing.length,
      restored: options.restored,
      withReplacement: replacements.size,
      withoutReplacement: retiredCount - replacements.size,
      remapped: {
        ownedCards: remapOwnedCards(tx, replacements),
        deckCards: remapDeckCards(tx, replacements),
        deckCovers: remapDeckCovers(tx, replacements),
        wishlistItems: remapWishlistItems(tx, replacements),
        ruleFormats: remapRuleFormats(tx, replacements),
      },
      skipped: false,
    }
  })
}

export interface CatalogCleanupResult {
  /** Printings deleted because the latest response no longer lists them. */
  printings: number
  /** Card images deleted because the latest response no longer lists them. */
  images: number
  /** Retirement was skipped (the guard), so nothing was pruned either. */
  skipped: boolean
}

/**
 * Deletes the printings and card images the latest YGOPRODeck response no
 * longer lists (ADR 0023). The upsert never removes rows, so without this a
 * reprint YGOPRODeck dropped and the placeholder image of a renumbered card
 * would stay forever. Runs in one transaction.
 *
 * - Retired cards **without** a replacement keep their rows: their image is
 *   the only picture of a card users may still hold.
 * - Retired cards with a replacement lose their stale placeholder image;
 *   `CardFloatingImage` / `CardThumb` render a card without one.
 * - Owned stacks store their set code and rarity as text (ADR 0034), so a
 *   deleted printing changes none of them; the legacy `printing_id` is
 *   NULL everywhere.
 * - `catalog_set` rows stay (format set filters reference set ids), and so
 *   do the translations.
 *
 * The caller skips this when retirement was skipped: a response that looks
 * truncated must not prune anything either.
 */
export function pruneUnlistedCatalogRows(
  db: Db,
  options: { seenPrintingIds: Set<string>, seenImageIds: Set<number> },
): CatalogCleanupResult {
  return db.transaction((transaction) => {
    const tx = transaction as unknown as Db
    const keep = new Set(
      tx
        .select({ id: catalogCard.id })
        .from(catalogCard)
        .where(and(isNotNull(catalogCard.retiredAt), isNull(catalogCard.replacedById)))
        .all()
        .map(row => row.id),
    )

    const printingIds = tx
      .select({ id: catalogPrinting.id, cardId: catalogPrinting.cardId })
      .from(catalogPrinting)
      .all()
      .filter(row => !options.seenPrintingIds.has(row.id) && !keep.has(row.cardId))
      .map(row => row.id)
    for (const ids of chunkRows(printingIds, ID_CHUNK_SIZE)) {
      tx.delete(catalogPrinting).where(inArray(catalogPrinting.id, ids)).run()
    }

    const imageIds = tx
      .select({ id: catalogCardImage.id, cardId: catalogCardImage.cardId })
      .from(catalogCardImage)
      .all()
      .filter(row => !options.seenImageIds.has(row.id) && !keep.has(row.cardId))
      .map(row => row.id)
    for (const ids of chunkRows(imageIds, ID_CHUNK_SIZE)) {
      tx.delete(catalogCardImage).where(inArray(catalogCardImage.id, ids)).run()
    }

    return { printings: printingIds.length, images: imageIds.length, skipped: false }
  })
}
