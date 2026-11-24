import { and, asc, count, desc, eq, isNotNull, ne, sql } from 'drizzle-orm'
import type { useDb } from '../db'
import { catalogCard, catalogCardImage, catalogPrinting, catalogSet } from '../db/schema'
import type { AppLocale } from '../../shared/locale'
import { activeCatalogCard } from './card-name-search'
import { resolveCatalogCardId } from './card-passcode'
import { primaryImageFirst, primaryImageUrlSql } from './card-image-sql'
import { cardDescDeSql, cardNameDeSql, cardSortKey } from './card-translation-sql'
import { buildCardListWhere, type CardListQuery } from './catalog-query'

type Db = ReturnType<typeof useDb>

export interface CatalogCardSummary {
  id: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  /** A Link monster's rating ("Link 3"); null for other cards. */
  linkval: number | null
  atk: number | null
  def: number | null
  /** The primary artwork (ADR 0025). */
  imageSmall: string | null
}

/**
 * One page of catalog cards. `cardLocale` is the card language the names are
 * shown in (ADR 0015): "by name" sorts by the German name in `de`.
 */
export async function searchCatalog(db: Db, filters: CardListQuery, cardLocale: AppLocale = 'en') {
  const where = buildCardListWhere(filters)
  const offset = (filters.page - 1) * filters.pageSize
  const nameKey = cardSortKey(cardLocale)
  const orderBy = filters.sort === '-name'
    ? [desc(nameKey)]
    : filters.sort === 'newest'
      ? [sql`${catalogCard.tcgDate} is null`, desc(catalogCard.tcgDate), asc(nameKey)]
      : [asc(nameKey)]

  const totalRows = await db
    .select({ total: count() })
    .from(catalogCard)
    .where(where)

  const items: CatalogCardSummary[] = await db
    .select({
      id: catalogCard.id,
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
    })
    .from(catalogCard)
    .where(where)
    .orderBy(...orderBy)
    .limit(filters.pageSize)
    .offset(offset)

  return {
    items,
    total: totalRows[0]?.total ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  }
}

/**
 * Every printing of a card (ADR 0034: one per set code and rarity), by set
 * name, set code and rarity. For the card detail and the inventory's
 * printing picker.
 */
export function listCardPrintings(db: Db, cardId: number) {
  return db
    .select({
      id: catalogPrinting.id,
      setCode: catalogPrinting.setCode,
      setName: catalogSet.name,
      rarity: catalogPrinting.rarity,
      rarityCode: catalogPrinting.rarityCode,
      price: catalogPrinting.price,
    })
    .from(catalogPrinting)
    .innerJoin(catalogSet, eq(catalogPrinting.setId, catalogSet.id))
    .where(eq(catalogPrinting.cardId, cardId))
    .orderBy(asc(catalogSet.name), asc(catalogPrinting.setCode), asc(catalogPrinting.rarity))
    .all()
}

export async function getCatalogCardDetail(db: Db, id: number) {
  // A printed passcode YGOPRODeck keeps as an alternate artwork resolves to
  // its card (ADR 0023), so the returned `card.id` can differ from `id`. A
  // card row wins over an artwork with the same id.
  const cardId = resolveCatalogCardId(db, id)
  if (cardId === null) {
    return null
  }

  // An explicit column list: the internal join/search columns (`konamiId`,
  // `nameSearch`, ADR 0015) stay out of the API. A retired card (ADR 0019)
  // still resolves by id; only the flag and its replacement are exposed.
  const row = await db
    .select({
      id: catalogCard.id,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      frameType: catalogCard.frameType,
      desc: catalogCard.desc,
      descDe: cardDescDeSql(),
      race: catalogCard.race,
      archetype: catalogCard.archetype,
      attribute: catalogCard.attribute,
      atk: catalogCard.atk,
      def: catalogCard.def,
      level: catalogCard.level,
      linkval: catalogCard.linkval,
      scale: catalogCard.scale,
      linkMarkers: catalogCard.linkMarkers,
      banlistInfo: catalogCard.banlistInfo,
      cardPrices: catalogCard.cardPrices,
      tcgDate: catalogCard.tcgDate,
      ocgDate: catalogCard.ocgDate,
      ygoprodeckUrl: catalogCard.ygoprodeckUrl,
      syncedAt: catalogCard.syncedAt,
      retiredAt: catalogCard.retiredAt,
      replacedById: catalogCard.replacedById,
    })
    .from(catalogCard)
    .where(eq(catalogCard.id, cardId))
    .get()

  if (!row) {
    return null
  }
  const { retiredAt, ...rest } = row
  const card = { ...rest, retired: retiredAt !== null }

  const printings = listCardPrintings(db, cardId)

  const images = await db
    .select({
      id: catalogCardImage.id,
      imageUrl: catalogCardImage.imageUrl,
      imageUrlSmall: catalogCardImage.imageUrlSmall,
      imageUrlCropped: catalogCardImage.imageUrlCropped,
    })
    .from(catalogCardImage)
    .where(eq(catalogCardImage.cardId, cardId))
    // Primary artwork first (ADR 0025): the overlay shows `images[0]`, the
    // same picture as every list.
    .orderBy(...primaryImageFirst())

  return { card, printings, images }
}

export async function getCatalogFacets(db: Db) {
  const [types, attributes, races, levels, sets] = await Promise.all([
    db
      .selectDistinct({ value: catalogCard.type })
      .from(catalogCard)
      .where(activeCatalogCard())
      .orderBy(asc(catalogCard.type)),
    db
      .selectDistinct({ value: catalogCard.attribute })
      .from(catalogCard)
      .where(and(activeCatalogCard(), isNotNull(catalogCard.attribute)))
      .orderBy(asc(catalogCard.attribute)),
    db
      .selectDistinct({ value: catalogCard.race })
      .from(catalogCard)
      // Skill Cards store the story character's name in `race` (truncated to
      // 13 chars by the ygoprodeck sync, e.g. "Abidos the Th") — not a real
      // monster race, so it doesn't belong in the "Monsterart" facet (UX
      // review #17).
      .where(and(activeCatalogCard(), isNotNull(catalogCard.race), ne(catalogCard.type, 'Skill Card')))
      .orderBy(asc(catalogCard.race)),
    db
      .selectDistinct({ value: catalogCard.level })
      .from(catalogCard)
      .where(and(activeCatalogCard(), isNotNull(catalogCard.level)))
      .orderBy(asc(catalogCard.level)),
    db
      .select({
        id: catalogSet.id,
        name: catalogSet.name,
        // Nested, so drizzle keeps the table names in this single-table
        // select (see card-image-sql.ts).
        hasCards: sql<number>`exists (${sql`
          select 1 from ${catalogPrinting}
          inner join ${catalogCard} on ${catalogCard.id} = ${catalogPrinting.cardId}
          where ${catalogPrinting.setId} = ${catalogSet.id} and ${activeCatalogCard()}
        `})`,
      })
      .from(catalogSet)
      .orderBy(asc(catalogSet.name)),
  ])

  // A set without a printing of an active card would find nothing in the set
  // filter, so the facet leaves it out. The rows stay because a format's
  // `setIds` can still name one, and the format editor needs its name
  // (`setsWithoutCards`, ADR 0024/0025).
  const toOption = ({ id, name }: { id: string, name: string }) => ({ id, name })

  return {
    types: types.map(item => item.value),
    attributes: attributes.flatMap(item => item.value ? [item.value] : []),
    races: races.flatMap(item => item.value ? [item.value] : []),
    levels: levels.flatMap(item => item.value === null ? [] : [item.value]),
    sets: sets.filter(set => set.hasCards).map(toOption),
    setsWithoutCards: sets.filter(set => !set.hasCards).map(toOption),
  }
}
