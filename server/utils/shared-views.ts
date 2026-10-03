// Read-only projections for the sharing feature (Phase 6). These are
// deliberately NOT built by reusing the owner-side detail builders in
// decks.ts/inventory.ts: a shared view must never carry ownership-derived
// fields (owned / usedInDeck / shortfall) or a cross-collection breakdown —
// see docs/adr/0007-sharing-and-profile-model.md.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { useDb } from '../db'
import { catalogCard, collection, deck, deckCard, ownedCard, ruleFormat } from '../db/schema'
import { buildWarnings, DECK_LIMITS, deckBreakdownsFor, loadDeckCovers, sortDeckSections } from './decks'
import { loadCardDataForValidation } from './deck-validation'
import { ruleFormatsById } from './rule-formats'
import { grantedResourceIds } from './sharing'
import { primaryImageUrlSql } from './card-image-sql'
import { cardNameMatches } from './card-name-search'
import { cardNameDeSql, cardSortKey } from './card-translation-sql'
import { evaluateDeck } from '../../shared/rule-formats'
import type { DeckSection } from '../../shared/deck-sections'
import type { AppLocale } from '../../shared/locale'
import type {
  PublicProfileSummary,
  SharedCardListItem,
  SharedCollectionSummary,
  SharedDeckCardRow,
  SharedDeckSummary,
  SharedDeckView,
} from '../../shared/sharing'

type Db = ReturnType<typeof useDb>

const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 100

function loadSharedDeckCardRows(db: Db, deckId: string): SharedDeckCardRow[] {
  const rows = db
    .select({
      catalogCardId: deckCard.catalogCardId,
      section: deckCard.section,
      quantity: deckCard.quantity,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      frameType: catalogCard.frameType,
      attribute: catalogCard.attribute,
      race: catalogCard.race,
      level: catalogCard.level,
      linkval: catalogCard.linkval,
      atk: catalogCard.atk,
      def: catalogCard.def,
      // The primary artwork (ADR 0025), both sizes from the same image.
      imageSmall: primaryImageUrlSql('imageUrlSmall'),
      imageLarge: primaryImageUrlSql('imageUrl'),
      retiredAt: catalogCard.retiredAt,
    })
    .from(deckCard)
    .innerJoin(catalogCard, eq(deckCard.catalogCardId, catalogCard.id))
    .where(eq(deckCard.deckId, deckId))
    .all()

  // Only the flag leaves the server, not the date (ADR 0019).
  return rows.map(({ retiredAt, ...row }) => ({
    ...row,
    section: row.section as DeckSection,
    retired: retiredAt !== null,
  }))
}

/**
 * Deck detail minus every ownership-derived field. Quantities only. Sections
 * are sorted by the card names in `cardLocale` (ADR 0015).
 */
export function buildSharedDeckView(
  db: Db,
  deckRow: typeof deck.$inferSelect,
  owner: PublicProfileSummary,
  isOwner = false,
  cardLocale: AppLocale = 'en',
): SharedDeckView {
  const rows = loadSharedDeckCardRows(db, deckRow.id)

  const formatRow = deckRow.formatId
    ? db
        .select({
          id: ruleFormat.id,
          name: ruleFormat.name,
          isBuiltin: ruleFormat.isBuiltin,
          rules: ruleFormat.rules,
        })
        .from(ruleFormat)
        .where(eq(ruleFormat.id, deckRow.formatId))
        .get()
    : undefined

  const sections: Record<DeckSection, SharedDeckCardRow[]> = { main: [], extra: [], side: [] }
  for (const row of rows) {
    sections[row.section].push(row)
  }

  sortDeckSections(sections, cardLocale)

  const sum = (section: DeckSection) =>
    sections[section].reduce((total, row) => total + row.quantity, 0)

  const counts = { main: sum('main'), extra: sum('extra'), side: sum('side'), total: 0 }
  counts.total = counts.main + counts.extra + counts.side

  return {
    owner,
    deck: {
      id: deckRow.id,
      name: deckRow.name,
      description: deckRow.description,
      updatedAt: deckRow.updatedAt.toISOString(),
      coverCardId: loadDeckCovers(db, [deckRow.id]).get(deckRow.id)?.catalogCardId ?? null,
    },
    sections,
    counts,
    limits: DECK_LIMITS,
    warnings: buildWarnings(counts, rows),
    format: formatRow
      ? { id: formatRow.id, name: formatRow.name, isBuiltin: formatRow.isBuiltin }
      : null,
    validation: formatRow
      ? evaluateDeck(
          formatRow.rules,
          rows.map(row => ({ catalogCardId: row.catalogCardId, section: row.section, quantity: row.quantity })),
          loadCardDataForValidation(db, rows.map(row => row.catalogCardId)),
        )
      : null,
    isOwner,
  }
}

export interface SharedCardListOptions {
  q?: string
  page?: number
  pageSize?: number
  sort?: 'name' | '-name' | 'quantity'
  /** The viewer's card language: "by name" sorts by the German name in `de` (ADR 0015). */
  cardLocale?: AppLocale
}

const CARD_LIST_SORTS = new Set(['name', '-name', 'quantity'])

/** Parses `?q=&page=&pageSize=&sort=` for the shared collection/inventory endpoints. */
export function parseSharedCardListQuery(rawQuery: Record<string, unknown>): SharedCardListOptions {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)

  const rawQ = first(rawQuery.q)
  const rawPage = Number(first(rawQuery.page))
  const rawPageSize = Number(first(rawQuery.pageSize))
  const rawSort = first(rawQuery.sort)

  return {
    q: typeof rawQ === 'string' && rawQ.trim() !== '' ? rawQ.trim() : undefined,
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : undefined,
    pageSize: Number.isInteger(rawPageSize) && rawPageSize > 0 ? rawPageSize : undefined,
    sort: typeof rawSort === 'string' && CARD_LIST_SORTS.has(rawSort) ? rawSort as SharedCardListOptions['sort'] : undefined,
  }
}

/** Parses `?page=&pageSize=` for the shared wishlist endpoint. */
export function parsePageQuery(rawQuery: Record<string, unknown>): { page?: number, pageSize?: number } {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const rawPage = Number(first(rawQuery.page))
  const rawPageSize = Number(first(rawQuery.pageSize))

  return {
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : undefined,
    pageSize: Number.isInteger(rawPageSize) && rawPageSize > 0 ? rawPageSize : undefined,
  }
}

export interface SharedCardListPage {
  items: SharedCardListItem[]
  total: number
  page: number
  pageSize: number
}

function listAggregatedCards(db: Db, where: SQL, options: SharedCardListOptions): SharedCardListPage {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))
  const totalQuantitySql = sql<number>`sum(${ownedCard.quantity})`

  const nameKey = cardSortKey(options.cardLocale ?? 'en')
  const orderBy = options.sort === '-name'
    ? [desc(nameKey)]
    : options.sort === 'quantity'
      ? [desc(totalQuantitySql), asc(nameKey)]
      : [asc(nameKey)]

  const pageRows = db
    .select({ catalogCardId: ownedCard.catalogCardId, quantity: totalQuantitySql })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .groupBy(ownedCard.catalogCardId)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const total = db
    .select({ count: sql<number>`count(distinct ${ownedCard.catalogCardId})` })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .get()?.count ?? 0

  const catalogCardIds = pageRows.map(row => row.catalogCardId)

  const displayRows = catalogCardIds.length > 0
    ? db
        .select({
          catalogCardId: catalogCard.id,
          name: catalogCard.name,
          nameDe: cardNameDeSql(),
          type: catalogCard.type,
          frameType: catalogCard.frameType,
          attribute: catalogCard.attribute,
          race: catalogCard.race,
          level: catalogCard.level,
          linkval: catalogCard.linkval,
          atk: catalogCard.atk,
          def: catalogCard.def,
          imageSmall: primaryImageUrlSql('imageUrlSmall'),
          imageLarge: primaryImageUrlSql('imageUrl'),
          retiredAt: catalogCard.retiredAt,
        })
        .from(catalogCard)
        .where(inArray(catalogCard.id, catalogCardIds))
        .all()
    : []

  const displayByCardId = new Map(displayRows.map(row => [row.catalogCardId, row]))

  const items: SharedCardListItem[] = pageRows.map((row) => {
    const display = displayByCardId.get(row.catalogCardId)
    return {
      catalogCardId: row.catalogCardId,
      name: display?.name ?? '',
      nameDe: display?.nameDe ?? null,
      type: display?.type ?? '',
      frameType: display?.frameType ?? null,
      attribute: display?.attribute ?? null,
      race: display?.race ?? null,
      level: display?.level ?? null,
      linkval: display?.linkval ?? null,
      atk: display?.atk ?? null,
      def: display?.def ?? null,
      imageSmall: display?.imageSmall ?? null,
      imageLarge: display?.imageLarge ?? null,
      quantity: row.quantity,
      retired: display ? display.retiredAt !== null : false,
    }
  })

  return { items, total, page, pageSize }
}

/** Total copies across the whole inventory — the public-profile teaser count. */
export function inventoryCardCount(db: Db, ownerUserId: string): number {
  return db
    .select({ count: sql<number>`coalesce(sum(${ownedCard.quantity}), 0)` })
    .from(ownedCard)
    .where(eq(ownedCard.userId, ownerUserId))
    .get()?.count ?? 0
}

/** Whole inventory of `ownerUserId`, aggregated per catalog card. */
export function listSharedInventory(db: Db, ownerUserId: string, options: SharedCardListOptions): SharedCardListPage {
  const clauses: SQL[] = [eq(ownedCard.userId, ownerUserId)]
  const q = options.q?.trim()
  if (q) {
    clauses.push(cardNameMatches(q))
  }

  return listAggregatedCards(db, and(...clauses) as SQL, options)
}

/**
 * One collection of `ownerUserId`, aggregated per catalog card.
 *
 * MUST NOT reuse buildInventorySearchWhere(collectionId): that helper's
 * collection filter is an EXISTS correlated only on catalog_card_id, so it
 * sums a card's copies across *all* collections (documented in
 * server/utils/inventory-search.ts). In a shared view that would disclose
 * quantities from collections the viewer was never granted. Use a strict
 * `and(eq(ownedCard.userId, ownerUserId), eq(ownedCard.collectionId, collectionId))`
 * with `sum(quantity) group by catalog_card_id`.
 */
export function listSharedCollection(
  db: Db,
  ownerUserId: string,
  collectionId: string,
  options: SharedCardListOptions,
): SharedCardListPage {
  const clauses: SQL[] = [eq(ownedCard.userId, ownerUserId), eq(ownedCard.collectionId, collectionId)]
  const q = options.q?.trim()
  if (q) {
    clauses.push(cardNameMatches(q))
  }

  return listAggregatedCards(db, and(...clauses) as SQL, options)
}

/** Decks of `ownerUserId` the viewer may see, for the profile page. */
export function listVisibleDecks(db: Db, ownerUserId: string, viewerUserId: string | null): SharedDeckSummary[] {
  const isOwner = viewerUserId != null && viewerUserId === ownerUserId
  const rows = db.select().from(deck).where(eq(deck.userId, ownerUserId)).all()

  const granted = isOwner ? new Set<string>() : grantedResourceIds(db, viewerUserId, ownerUserId, 'deck')

  // 'link' rows are never listed for a non-owner — that is what "link only"
  // means; they stay reachable through their token URL.
  const visibleRows = isOwner
    ? rows
    : rows.filter(row => row.visibility === 'public' || granted.has(row.id))

  if (visibleRows.length === 0) {
    return []
  }

  const deckIds = visibleRows.map(row => row.id)
  const cardRows = db
    .select({
      deckId: deckCard.deckId,
      catalogCardId: deckCard.catalogCardId,
      section: deckCard.section,
      quantity: deckCard.quantity,
      // For the tile chips (#148); a left join, so the counts never lose a row.
      type: catalogCard.type,
      frameType: catalogCard.frameType,
    })
    .from(deckCard)
    .leftJoin(catalogCard, eq(catalogCard.id, deckCard.catalogCardId))
    .where(inArray(deckCard.deckId, deckIds))
    .all()

  const formats = ruleFormatsById(db, ownerUserId, visibleRows.flatMap(row => (row.formatId ? [row.formatId] : [])))
  const cardData = formats.size > 0
    ? loadCardDataForValidation(db, cardRows.map(row => row.catalogCardId))
    : new Map()

  const entriesByDeck = new Map<string, Array<{ catalogCardId: number, section: DeckSection, quantity: number }>>()
  const countsByDeck = new Map<string, { main: number, extra: number, side: number }>()
  for (const row of cardRows) {
    const entries = entriesByDeck.get(row.deckId) ?? []
    entries.push({ catalogCardId: row.catalogCardId, section: row.section as DeckSection, quantity: row.quantity })
    entriesByDeck.set(row.deckId, entries)

    const counts = countsByDeck.get(row.deckId) ?? { main: 0, extra: 0, side: 0 }
    counts[row.section as DeckSection] += row.quantity
    countsByDeck.set(row.deckId, counts)
  }

  // Only the listed (already visible) decks — no cover leaks a hidden deck.
  const covers = loadDeckCovers(db, deckIds)
  const breakdowns = deckBreakdownsFor(cardRows, deckIds)

  return visibleRows.map((row) => {
    const counts = countsByDeck.get(row.id) ?? { main: 0, extra: 0, side: 0 }
    const format = row.formatId ? formats.get(row.formatId) : undefined
    const legal = format ? evaluateDeck(format.rules, entriesByDeck.get(row.id) ?? [], cardData).legal : null

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mainCount: counts.main,
      extraCount: counts.extra,
      sideCount: counts.side,
      cardCount: counts.main + counts.extra + counts.side,
      formatName: format?.name ?? null,
      legal,
      visibility: isOwner ? row.visibility : null,
      updatedAt: row.updatedAt.toISOString(),
      cover: covers.get(row.id) ?? null,
      breakdown: breakdowns.get(row.id) ?? [],
    }
  })
}

export function listVisibleCollections(db: Db, ownerUserId: string, viewerUserId: string | null): SharedCollectionSummary[] {
  const isOwner = viewerUserId != null && viewerUserId === ownerUserId

  const rows = db
    .select({
      id: collection.id,
      name: collection.name,
      description: collection.description,
      visibility: collection.visibility,
      cardCount: sql<number>`coalesce(sum(${ownedCard.quantity}), 0)`,
    })
    .from(collection)
    .leftJoin(ownedCard, eq(ownedCard.collectionId, collection.id))
    .where(eq(collection.userId, ownerUserId))
    .groupBy(collection.id)
    .orderBy(collection.name)
    .all()

  const granted = isOwner ? new Set<string>() : grantedResourceIds(db, viewerUserId, ownerUserId, 'collection')

  const visible = isOwner
    ? rows
    : rows.filter(row => row.visibility === 'public' || granted.has(row.id))

  return visible.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    cardCount: row.cardCount,
    visibility: isOwner ? row.visibility : null,
  }))
}
