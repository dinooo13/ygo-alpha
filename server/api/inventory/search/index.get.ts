import { and, asc, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { getQuery } from 'h3'
import { useDb } from '../../../db'
import { catalogCard, collection, ownedCard } from '../../../db/schema'
import { assertCollectionOwnedByUser } from '../../../utils/collections'
import {
  buildInventorySearchWhere,
  loadInventoryCardDisplay,
  parseInventorySearchQuery,
  UNASSIGNED_COLLECTION_ID,
} from '../../../utils/inventory-search'
import type { InventorySearchSort } from '../../../utils/inventory-search'
import { requireUser } from '../../../utils/session'
import { cardSortKey } from '../../../utils/card-translation-sql'
import { resolveCardLocale } from '../../../utils/ui-locale'
import type { AppLocale } from '../../../../shared/locale'

const totalQuantitySql = sql<number>`sum(${ownedCard.quantity})`

// "By name" sorts by the name in the card language (ADR 0015).
function buildOrderBy(sort: InventorySearchSort, cardLocale: AppLocale): SQL[] {
  const nameKey = cardSortKey(cardLocale)
  switch (sort) {
    case '-name':
      return [desc(nameKey)]
    case 'quantity':
      return [desc(totalQuantitySql), asc(nameKey)]
    case 'newest':
      return [desc(catalogCard.tcgDate)]
    case 'name':
    default:
      return [asc(nameKey)]
  }
}

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = useDb()
  const filters = parseInventorySearchQuery(getQuery(event))

  if (filters.collectionId && filters.collectionId !== UNASSIGNED_COLLECTION_ID) {
    assertCollectionOwnedByUser(db, user.id, filters.collectionId)
  }

  const where = buildInventorySearchWhere(user.id, filters)

  const pageRows = db
    .select({
      catalogCardId: ownedCard.catalogCardId,
      totalQuantity: totalQuantitySql,
    })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .groupBy(ownedCard.catalogCardId)
    .orderBy(...buildOrderBy(filters.sort, await resolveCardLocale(event)))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize)
    .all()

  const total = db
    .select({ count: sql<number>`count(distinct ${ownedCard.catalogCardId})` })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .get()?.count ?? 0

  const catalogCardIds = pageRows.map(row => row.catalogCardId)

  if (catalogCardIds.length === 0) {
    return { items: [], total, page: filters.page, pageSize: filters.pageSize }
  }

  // Breakdown reuses the full search `where` (not just a user/id scope) so a
  // per-collection quantity always sums to the same total as query 1 — the
  // `collectionId` gate (when present) is an EXISTS check that doesn't
  // itself exclude rows from other collections, by design (see
  // buildInventorySearchWhere's doc comment).
  const breakdownRows = db
    .select({
      catalogCardId: ownedCard.catalogCardId,
      collectionId: ownedCard.collectionId,
      collectionName: collection.name,
      quantity: sql<number>`sum(${ownedCard.quantity})`,
    })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .leftJoin(collection, eq(ownedCard.collectionId, collection.id))
    .where(and(where, inArray(ownedCard.catalogCardId, catalogCardIds)))
    .groupBy(ownedCard.catalogCardId, ownedCard.collectionId)
    .all()

  // The printings behind each tile (ADR 0034): the stacks with a known set
  // code or rarity, with the copies under the same `where`, so they add up
  // within the total.
  const printingRows = db
    .select({
      catalogCardId: ownedCard.catalogCardId,
      setCode: ownedCard.setCode,
      rarity: ownedCard.rarity,
      quantity: sql<number>`sum(${ownedCard.quantity})`,
    })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(and(
      where,
      inArray(ownedCard.catalogCardId, catalogCardIds),
      or(isNotNull(ownedCard.setCode), isNotNull(ownedCard.rarity)),
    ))
    .groupBy(ownedCard.catalogCardId, ownedCard.setCode, ownedCard.rarity)
    .orderBy(sql`${ownedCard.setCode} IS NULL`, asc(ownedCard.setCode), asc(ownedCard.rarity))
    .all()
  const printingsByCardId = new Map<number, Array<{ setCode: string | null, rarity: string | null, quantity: number }>>()
  for (const { catalogCardId, ...printing } of printingRows) {
    const list = printingsByCardId.get(catalogCardId) ?? []
    list.push(printing)
    printingsByCardId.set(catalogCardId, list)
  }

  const displayByCardId = loadInventoryCardDisplay(db, catalogCardIds)

  const breakdownByCardId = new Map<
    number,
    Array<{ collectionId: string | null, collectionName: string | null, quantity: number }>
  >()
  for (const row of breakdownRows) {
    const list = breakdownByCardId.get(row.catalogCardId) ?? []
    list.push({ collectionId: row.collectionId, collectionName: row.collectionName, quantity: row.quantity })
    breakdownByCardId.set(row.catalogCardId, list)
  }

  const items = pageRows.map((row) => {
    const display = displayByCardId.get(row.catalogCardId)
    return {
      catalogCardId: row.catalogCardId,
      name: display?.name ?? '',
      nameDe: display?.nameDe ?? null,
      type: display?.type ?? '',
      attribute: display?.attribute ?? null,
      race: display?.race ?? null,
      level: display?.level ?? null,
      linkval: display?.linkval ?? null,
      atk: display?.atk ?? null,
      def: display?.def ?? null,
      imageSmall: display?.imageSmall ?? null,
      imageLarge: display?.imageLarge ?? null,
      retired: display?.retired ?? false,
      totalQuantity: row.totalQuantity,
      collectionBreakdown: breakdownByCardId.get(row.catalogCardId) ?? [],
      printingBreakdown: printingsByCardId.get(row.catalogCardId) ?? [],
    }
  })

  return { items, total, page: filters.page, pageSize: filters.pageSize }
})
