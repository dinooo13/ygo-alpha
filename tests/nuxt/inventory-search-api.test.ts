import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../server/db/schema'
import { addOwnedCard, validateInventoryInput } from '../../server/utils/inventory'
import { assertCollectionOwnedByUser, createCollection } from '../../server/utils/collections'
import {
  buildInventorySearchWhere,
  loadInventoryCardDisplay,
  loadInventorySearchFacets,
  parseInventorySearchQuery,
  UNASSIGNED_COLLECTION_ID,
} from '../../server/utils/inventory-search'
import type { InventorySearchSort } from '../../server/utils/inventory-search'
import { seedGermanNames } from './fixtures/german-names'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function seedUsers(db: TestDb) {
  const now = new Date()
  db.insert(schema.user).values([
    {
      id: 'user-a',
      name: 'User A',
      email: 'a@example.com',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'user-b',
      name: 'User B',
      email: 'b@example.com',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
  ]).run()
}

interface CardSeed {
  id: number
  name: string
  type: string
  desc?: string
  attribute?: string | null
  race?: string | null
  level?: number | null
  atk?: number | null
  def?: number | null
  tcgDate?: string | null
}

function seedCards(db: TestDb, cards: CardSeed[]) {
  const now = new Date()
  db.insert(schema.catalogCard).values(cards.map(card => ({
    id: card.id,
    name: card.name,
    type: card.type,
    desc: card.desc ?? `${card.name} description`,
    attribute: card.attribute ?? null,
    race: card.race ?? null,
    level: card.level ?? null,
    atk: card.atk ?? null,
    def: card.def ?? null,
    tcgDate: card.tcgDate ?? null,
    syncedAt: now,
  }))).run()
}

// Mirrors the aggregation/breakdown query logic that lives inline in
// `server/api/inventory/search/index.get.ts`, built on top of the
// importable, HTTP-free helpers (`parseInventorySearchQuery`,
// `buildInventorySearchWhere`, `loadInventoryCardDisplay`) that the endpoint
// itself uses, so we exercise the same query shape without spinning up an
// HTTP server.
function runInventorySearch(db: TestDb, userId: string, rawQuery: Record<string, unknown>) {
  const filters = parseInventorySearchQuery(rawQuery)

  if (filters.collectionId && filters.collectionId !== UNASSIGNED_COLLECTION_ID) {
    assertCollectionOwnedByUser(db, userId, filters.collectionId)
  }

  const where = buildInventorySearchWhere(userId, filters)
  const totalQuantitySql = sql<number>`sum(${schema.ownedCard.quantity})`

  function buildOrderBy(sort: InventorySearchSort): SQL[] {
    switch (sort) {
      case '-name':
        return [desc(schema.catalogCard.name)]
      case 'quantity':
        return [desc(totalQuantitySql), asc(schema.catalogCard.name)]
      case 'newest':
        return [desc(schema.catalogCard.tcgDate)]
      case 'name':
      default:
        return [asc(schema.catalogCard.name)]
    }
  }

  const pageRows = db
    .select({
      catalogCardId: schema.ownedCard.catalogCardId,
      totalQuantity: totalQuantitySql,
    })
    .from(schema.ownedCard)
    .innerJoin(schema.catalogCard, eq(schema.ownedCard.catalogCardId, schema.catalogCard.id))
    .where(where)
    .groupBy(schema.ownedCard.catalogCardId)
    .orderBy(...buildOrderBy(filters.sort))
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize)
    .all()

  const total = db
    .select({ count: sql<number>`count(distinct ${schema.ownedCard.catalogCardId})` })
    .from(schema.ownedCard)
    .innerJoin(schema.catalogCard, eq(schema.ownedCard.catalogCardId, schema.catalogCard.id))
    .where(where)
    .get()?.count ?? 0

  const catalogCardIds = pageRows.map(row => row.catalogCardId)
  if (catalogCardIds.length === 0) {
    return { items: [], total, page: filters.page, pageSize: filters.pageSize }
  }

  const breakdownRows = db
    .select({
      catalogCardId: schema.ownedCard.catalogCardId,
      collectionId: schema.ownedCard.collectionId,
      collectionName: schema.collection.name,
      quantity: sql<number>`sum(${schema.ownedCard.quantity})`,
    })
    .from(schema.ownedCard)
    .innerJoin(schema.catalogCard, eq(schema.ownedCard.catalogCardId, schema.catalogCard.id))
    .leftJoin(schema.collection, eq(schema.ownedCard.collectionId, schema.collection.id))
    .where(and(where, inArray(schema.ownedCard.catalogCardId, catalogCardIds)))
    .groupBy(schema.ownedCard.catalogCardId, schema.ownedCard.collectionId)
    .all()

  const breakdownByCardId = new Map<
    number,
    Array<{ collectionId: string | null, collectionName: string | null, quantity: number }>
  >()
  for (const row of breakdownRows) {
    const list = breakdownByCardId.get(row.catalogCardId) ?? []
    list.push({ collectionId: row.collectionId, collectionName: row.collectionName, quantity: row.quantity })
    breakdownByCardId.set(row.catalogCardId, list)
  }

  const displayByCardId = loadInventoryCardDisplay(db, catalogCardIds)

  const items = pageRows.map((row) => {
    const display = displayByCardId.get(row.catalogCardId)
    return {
      catalogCardId: row.catalogCardId,
      name: display?.name ?? '',
      type: display?.type ?? '',
      imageSmall: display?.imageSmall ?? null,
      imageLarge: display?.imageLarge ?? null,
      totalQuantity: row.totalQuantity,
      collectionBreakdown: breakdownByCardId.get(row.catalogCardId) ?? [],
    }
  })

  return { items, total, page: filters.page, pageSize: filters.pageSize }
}

describe('parseInventorySearchQuery', () => {
  it('clamps paging and drops invalid level values', () => {
    const filters = parseInventorySearchQuery({
      page: '0',
      pageSize: '999',
      level: 'abc',
    })

    expect(filters.page).toBe(1)
    expect(filters.pageSize).toBe(60)
    expect(filters.level).toEqual([])
  })

  it('parses CSV and repeated multi-value facets', () => {
    const filters = parseInventorySearchQuery({
      type: 'A,B',
      race: ['Dragon', 'Spellcaster'],
    })

    expect(filters.type).toEqual(['A', 'B'])
    expect(filters.race).toEqual(['Dragon', 'Spellcaster'])
  })

  it('ignores the former set and collector filters (ADR 0017)', () => {
    const filters = parseInventorySearchQuery({ condition: 'played', setId: 'lob', language: 'de', edition: 'first' })

    expect(filters).toEqual(parseInventorySearchQuery({}))
    for (const key of ['setId', 'language', 'condition', 'edition']) {
      expect(filters).not.toHaveProperty(key)
    }
  })
})

describe('buildInventorySearchWhere', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsers(db)
  })

  it('escapes LIKE wildcards and scopes results to the given user', async () => {
    seedCards(db, [
      { id: 1, name: 'Sale 50%_off Promo', type: 'Spell Card' },
      { id: 2, name: '500xoff Sale', type: 'Spell Card' },
    ])

    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 1 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 2 }))
    await addOwnedCard(db, 'user-b', validateInventoryInput({ catalog_card_id: 1 }))

    const filters = parseInventorySearchQuery({ q: '50%_off' })
    const where = buildInventorySearchWhere('user-a', filters)

    const rows = db
      .select({ catalogCardId: schema.ownedCard.catalogCardId, userId: schema.ownedCard.userId })
      .from(schema.ownedCard)
      .innerJoin(schema.catalogCard, eq(schema.ownedCard.catalogCardId, schema.catalogCard.id))
      .where(where)
      .all()

    // Only the literally-matching card (1), only for user-a: `%`/`_` are
    // escaped (card 2 would incorrectly match if they were treated as
    // wildcards), and user-b's copy of card 1 is excluded by the user scope.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ catalogCardId: 1, userId: 'user-a' })
  })
})

describe('inventory search aggregation (in-memory db)', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsers(db)
  })

  it('aggregates owned rows by catalog card with total quantity', async () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })

    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      collection_id: box1.id,
      quantity: 3,
    }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
    }))

    const result = runInventorySearch(db, 'user-a', {})

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 46986414, totalQuantity: 5 })
  })

  it('produces a correct per-collection breakdown', async () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })

    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      collection_id: box1.id,
      quantity: 3,
    }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
    }))

    const result = runInventorySearch(db, 'user-a', {})

    const breakdown = result.items[0]!.collectionBreakdown
    expect(breakdown).toHaveLength(2)
    expect(breakdown).toEqual(expect.arrayContaining([
      { collectionId: box1.id, collectionName: 'Box 1', quantity: 3 },
      { collectionId: null, collectionName: null, quantity: 2 },
    ]))
  })

  it('filters by catalog facet (type)', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      { id: 55144522, name: 'Pot of Greed', type: 'Spell Card' },
    ])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 55144522 }))

    const result = runInventorySearch(db, 'user-a', { type: 'Spell Card' })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 55144522, type: 'Spell Card' })
  })

  it('ignores ?condition=, ?setId= and ?language= (ADR 0017)', async () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 2 }))

    const result = runInventorySearch(db, 'user-a', { condition: 'played', setId: 'X', language: 'de' })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 46986414, totalQuantity: 2 })
  })

  it('collectionId filters which cards qualify but keeps the full breakdown', async () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })

    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      collection_id: box1.id,
      quantity: 3,
    }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
    }))

    const result = runInventorySearch(db, 'user-a', { collectionId: box1.id })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.totalQuantity).toBe(5)
    expect(result.items[0]!.collectionBreakdown).toHaveLength(2)
  })

  it('collectionId=__none__ selects only cards with unassigned copies', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      { id: 55144522, name: 'Pot of Greed', type: 'Spell Card' },
    ])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })

    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      collection_id: box1.id,
      quantity: 1,
    }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 55144522,
      quantity: 4,
    }))

    const result = runInventorySearch(db, 'user-a', { collectionId: UNASSIGNED_COLLECTION_ID })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 55144522 })
  })

  it('scoped=1 counts only the chosen collection\'s copies (the deck builder\'s "Quelle")', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      { id: 55144522, name: 'Pot of Greed', type: 'Spell Card' },
    ])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })
    const box2 = await createCollection(db, 'user-a', { name: 'Box 2', description: null })

    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, collection_id: box1.id, quantity: 3 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 2 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 55144522, collection_id: box2.id, quantity: 1 }))

    const scoped = runInventorySearch(db, 'user-a', { collectionId: box1.id, scoped: '1' })
    expect(scoped.total).toBe(1)
    expect(scoped.items[0]).toMatchObject({ catalogCardId: 46986414, totalQuantity: 3 })
    expect(scoped.items[0]!.collectionBreakdown).toEqual([{ collectionId: box1.id, collectionName: 'Box 1', quantity: 3 }])

    // "Ohne Sammlung" is a row filter either way.
    const unassigned = runInventorySearch(db, 'user-a', { collectionId: UNASSIGNED_COLLECTION_ID, scoped: '1' })
    expect(unassigned.items[0]).toMatchObject({ catalogCardId: 46986414, totalQuantity: 2 })

    // Without the flag the inventory page keeps its cross-collection totals.
    const gated = runInventorySearch(db, 'user-a', { collectionId: box1.id })
    expect(gated.items[0]!.totalQuantity).toBe(5)

    // A collection the card is not in: nothing, instead of the card's other copies.
    expect(runInventorySearch(db, 'user-a', { collectionId: box2.id, scoped: '1' }).items.map(item => item.catalogCardId)).toEqual([55144522])
    expect(parseInventorySearchQuery({ scoped: '1' }).scoped).toBe(true)
    expect(parseInventorySearchQuery({}).scoped).toBe(false)
  })

  it('still finds an owned retired card by name (ADR 0019)', async () => {
    seedCards(db, [{ id: 101402013, name: 'Leviathan of Atlantis - Daedalus', type: 'Effect Monster' }])
    db.update(schema.catalogCard).set({ retiredAt: new Date() }).run()
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 101402013, quantity: 1 }))

    const result = runInventorySearch(db, 'user-a', { q: 'Leviathan' })

    expect(result.items.map(item => item.catalogCardId)).toEqual([101402013])
  })

  it('matches names case-insensitively with wildcards escaped', async () => {
    seedCards(db, [{ id: 89631139, name: 'Blue-Eyes White Dragon', type: 'Normal Monster' }])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 89631139 }))

    const result = runInventorySearch(db, 'user-a', { q: 'blue' })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 89631139 })
  })

  it('matches German names folded, and German text with inText (ADR 0015)', async () => {
    seedCards(db, [
      { id: 89631139, name: 'Blue-Eyes White Dragon', type: 'Normal Monster' },
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
    ])
    seedGermanNames(db, { 89631139: 'Blauäugiger w. Drache', 46986414: 'Dunkler Magier' })
    db.update(schema.catalogCardTranslation)
      .set({ desc: 'Der ultimative Hexer.' })
      .where(eq(schema.catalogCardTranslation.cardId, 46986414))
      .run()
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 89631139 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414 }))

    function ids(query: Record<string, unknown>) {
      return runInventorySearch(db, 'user-a', query).items.map(item => item.catalogCardId)
    }

    expect(ids({ q: 'BLAUÄUGIGER' })).toEqual([89631139])
    expect(ids({ q: 'blauaugiger w drache' })).toEqual([89631139])
    expect(ids({ q: 'Hexer' })).toEqual([])
    expect(ids({ q: 'Hexer', inText: '1' })).toEqual([46986414])
  })

  it('sorts by quantity desc and by newest (tcgDate) desc', async () => {
    seedCards(db, [
      { id: 1, name: 'Old Small Card', type: 'Normal Monster', tcgDate: '1999-01-01' },
      { id: 2, name: 'New Big Card', type: 'Normal Monster', tcgDate: '2020-01-01' },
    ])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 1, quantity: 1 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 2, quantity: 9 }))

    const byQuantity = runInventorySearch(db, 'user-a', { sort: 'quantity' })
    expect(byQuantity.items.map(item => item.catalogCardId)).toEqual([2, 1])

    const byNewest = runInventorySearch(db, 'user-a', { sort: 'newest' })
    expect(byNewest.items.map(item => item.catalogCardId)).toEqual([2, 1])
  })

  it('paginates over the aggregated results', async () => {
    const cards: CardSeed[] = Array.from({ length: 30 }, (_, i) => ({
      id: 900000 + i,
      name: `Card ${String(i).padStart(2, '0')}`,
      type: 'Normal Monster',
    }))
    seedCards(db, cards)
    for (const card of cards) {
      await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: card.id }))
    }

    const result = runInventorySearch(db, 'user-a', { pageSize: '10', page: '2' })

    expect(result.items.length).toBeLessThanOrEqual(10)
    expect(result.total).toBe(30)
    expect(result.page).toBe(2)
    expect(result.pageSize).toBe(10)
  })

  it('scopes results to the searching user (ownership boundary)', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster' },
      { id: 55144522, name: 'Pot of Greed', type: 'Spell Card' },
    ])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414 }))
    await addOwnedCard(db, 'user-b', validateInventoryInput({ catalog_card_id: 55144522 }))

    const result = runInventorySearch(db, 'user-a', {})

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 46986414 })
  })

  it('rejects a collectionId that does not belong to the searching user', async () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])
    const bsBox = await createCollection(db, 'user-b', { name: "B's Box", description: null })

    expect(() => runInventorySearch(db, 'user-a', { collectionId: bsBox.id }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => runInventorySearch(db, 'user-a', { collectionId: 'nonexistent' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('loadInventoryCardDisplay', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
  })

  it('takes both image sizes from the primary artwork, the image with the card\'s own id (ADR 0025)', () => {
    seedCards(db, [{
      id: 46986414,
      name: 'Dark Magician',
      type: 'Normal Monster',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 7,
      atk: 2500,
      def: 2100,
    }])
    // Inserted out of order: one alternate art has the lowest id (the old
    // lowest-id rule would have picked it), the other's small URL sorts first
    // alphabetically (the old `min(image_url_small)` would have picked it).
    db.insert(schema.catalogCardImage).values([
      {
        id: 2,
        cardId: 46986414,
        imageUrl: 'https://img/alt-large.jpg',
        imageUrlSmall: 'https://img/a-alt-small.jpg',
      },
      {
        id: 46986414,
        cardId: 46986414,
        imageUrl: 'https://img/main-large.jpg',
        imageUrlSmall: 'https://img/main-small.jpg',
      },
      {
        id: 1,
        cardId: 46986414,
        imageUrl: 'https://img/low-large.jpg',
        imageUrlSmall: 'https://img/low-small.jpg',
      },
    ]).run()

    const display = loadInventoryCardDisplay(db, [46986414])

    expect(display.get(46986414)).toEqual({
      catalogCardId: 46986414,
      name: 'Dark Magician',
      nameDe: null,
      type: 'Normal Monster',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 7,
      linkval: null,
      atk: 2500,
      def: 2100,
      imageSmall: 'https://img/main-small.jpg',
      imageLarge: 'https://img/main-large.jpg',
      retired: false,
    })
  })

  it('flags a card YGOPRODeck no longer lists (ADR 0019)', () => {
    seedCards(db, [{ id: 101402013, name: 'Leviathan of Atlantis - Daedalus', type: 'Effect Monster' }])
    db.update(schema.catalogCard).set({ retiredAt: new Date() }).run()

    expect(loadInventoryCardDisplay(db, [101402013]).get(101402013)).toMatchObject({ retired: true })
  })

  it('returns null images for a card without artwork', () => {
    seedCards(db, [{ id: 55144522, name: 'Pot of Greed', type: 'Spell Card' }])

    const display = loadInventoryCardDisplay(db, [55144522])

    expect(display.get(55144522)).toMatchObject({
      name: 'Pot of Greed',
      imageSmall: null,
      imageLarge: null,
    })
  })

  it('falls back to the large URL when the small one is missing', () => {
    seedCards(db, [{ id: 55144522, name: 'Pot of Greed', type: 'Spell Card' }])
    db.insert(schema.catalogCardImage).values({
      id: 55144522,
      cardId: 55144522,
      imageUrl: 'https://img/pot-large.jpg',
      imageUrlSmall: null,
    }).run()

    const display = loadInventoryCardDisplay(db, [55144522])

    expect(display.get(55144522)).toMatchObject({
      imageSmall: 'https://img/pot-large.jpg',
      imageLarge: 'https://img/pot-large.jpg',
    })
  })

  it('returns an empty map for no ids', () => {
    expect(loadInventoryCardDisplay(db, []).size).toBe(0)
  })
})

describe('inventory search facets', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsers(db)
  })

  it('returns only distinct owned catalog values, scoped to the user', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster', attribute: 'DARK', race: 'Spellcaster', level: 7 },
      { id: 55144522, name: 'Pot of Greed', type: 'Spell Card' },
    ])
    const box1 = await createCollection(db, 'user-a', { name: 'Box 1', description: null })
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, collection_id: box1.id }))
    // Different user — must not leak into user-a's facets.
    await addOwnedCard(db, 'user-b', validateInventoryInput({ catalog_card_id: 55144522 }))

    expect(loadInventorySearchFacets(db, 'user-a')).toEqual({
      types: ['Normal Monster'],
      attributes: ['DARK'],
      races: ['Spellcaster'],
      levels: [7],
    })
  })

  it('leaves the Skill Card character out of the races', async () => {
    seedCards(db, [
      { id: 46986414, name: 'Dark Magician', type: 'Normal Monster', race: 'Spellcaster' },
      { id: 300000001, name: 'Skill', type: 'Skill Card', race: 'Yami Yugi' },
    ])
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 300000001 }))

    const facets = loadInventorySearchFacets(db, 'user-a')
    expect(facets.types).toEqual(['Normal Monster', 'Skill Card'])
    expect(facets.races).toEqual(['Spellcaster'])
  })

  it('returns empty arrays for a user with no owned cards', () => {
    seedCards(db, [{ id: 46986414, name: 'Dark Magician', type: 'Normal Monster' }])

    expect(loadInventorySearchFacets(db, 'user-a')).toEqual({
      types: [],
      attributes: [],
      races: [],
      levels: [],
    })
  })
})

describe('inventory search auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    vi.resetModules()
    vi.doMock('../../server/utils/auth', () => ({
      useAuth: () => ({
        api: {
          getSession: async () => null,
        },
      }),
    }))

    const { requireUser } = await import('../../server/utils/session')
    const fakeEvent = { headers: new Headers(), context: {} } as unknown as Parameters<typeof requireUser>[0]

    await expect(requireUser(fakeEvent)).rejects.toMatchObject({ statusCode: 401 })

    vi.doUnmock('../../server/utils/auth')
    vi.resetModules()
  })
})
