import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_FIXTURE_IDS, seedCatalogFixture } from '../../server/db/fixtures/catalog-fixture'
import * as schema from '../../server/db/schema'
import {
  INVENTORY_MOVE_MAX_ITEMS,
  addOwnedCard,
  moveOwnedCards,
  validateInventoryInput,
  validateInventoryMoveInput,
} from '../../server/utils/inventory'

const { darkMagician, potOfGreed } = CATALOG_FIXTURE_IDS

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function seed(db: TestDb) {
  const now = new Date()
  db.insert(schema.user).values([
    { id: 'user-a', name: 'User A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now },
    { id: 'user-b', name: 'User B', email: 'b@example.com', emailVerified: false, createdAt: now, updatedAt: now },
  ]).run()
  db.insert(schema.collection).values([
    { id: 'box-1', userId: 'user-a', name: 'Box 1', description: null, createdAt: now, updatedAt: now },
    { id: 'box-2', userId: 'user-a', name: 'Box 2', description: null, createdAt: now, updatedAt: now },
    { id: 'box-b', userId: 'user-b', name: 'Fremde Box', description: null, createdAt: now, updatedAt: now },
  ]).run()
  seedCatalogFixture(db)
}

async function own(db: TestDb, userId: string, catalogCardId: number, quantity: number, collectionId: string | null = null, note: string | null = null) {
  return addOwnedCard(db, userId, validateInventoryInput({ catalog_card_id: catalogCardId, quantity, collection_id: collectionId, note }))
}

function move(db: TestDb, userId: string, items: unknown[]) {
  return moveOwnedCards(db, userId, validateInventoryMoveInput({ items }))
}

function stacks(db: TestDb, userId = 'user-a') {
  return db.select().from(schema.ownedCard).all()
    .filter(row => row.userId === userId)
    .map(row => ({ id: row.id, card: row.catalogCardId, collection: row.collectionId, quantity: row.quantity, note: row.note }))
    .sort((a, b) => `${a.card}${a.collection}`.localeCompare(`${b.card}${b.collection}`))
}

function thrownOf(run: () => unknown) {
  try {
    run()
  }
  catch (error) {
    return error as { statusCode?: number, data?: { code?: string, errors?: Array<{ index: number, message: string, code?: string, params?: Record<string, unknown> }> } }
  }
  return undefined
}

describe('moveOwnedCards', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seed(db)
  })

  it('splits a stack on a partial move and creates the target stack', async () => {
    const source = await own(db, 'user-a', darkMagician, 5, null, 'Binder')

    const result = move(db, 'user-a', [{ ownedCardId: source.id, quantity: 2, toCollectionId: 'box-1' }])

    expect(result.moved).toBe(2)
    expect(result.items).toEqual([
      expect.objectContaining({ ownedCardId: source.id, catalogCardId: darkMagician, fromCollectionId: null, toCollectionId: 'box-1', quantity: 2, remaining: 3 }),
    ])
    const rows = stacks(db)
    expect(rows).toHaveLength(2)
    // The note stays with the stack it was written on; copies are not duplicated.
    expect(rows.find(row => row.collection === null)).toMatchObject({ id: source.id, quantity: 3, note: 'Binder' })
    expect(rows.find(row => row.collection === 'box-1')).toMatchObject({ id: result.items[0]!.resultId, quantity: 2, note: null })
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(5)
  })

  it('adds a partial move to the stack the target already has', async () => {
    const source = await own(db, 'user-a', darkMagician, 3, 'box-1')
    const target = await own(db, 'user-a', darkMagician, 1, 'box-2', 'Deck')

    const result = move(db, 'user-a', [{ ownedCardId: source.id, quantity: 2, toCollectionId: 'box-2' }])

    expect(result.items[0]).toMatchObject({ resultId: target.id, remaining: 1 })
    expect(stacks(db)).toEqual([
      { id: source.id, card: darkMagician, collection: 'box-1', quantity: 1, note: null },
      { id: target.id, card: darkMagician, collection: 'box-2', quantity: 3, note: 'Deck' },
    ])
  })

  it('re-points a stack that moves as a whole and takes its note along', async () => {
    const source = await own(db, 'user-a', darkMagician, 2, null, 'Binder')

    const result = move(db, 'user-a', [{ ownedCardId: source.id, quantity: 2, toCollectionId: 'box-1' }])

    expect(result.items[0]).toMatchObject({ resultId: source.id, quantity: 2, remaining: 0 })
    expect(stacks(db)).toEqual([{ id: source.id, card: darkMagician, collection: 'box-1', quantity: 2, note: 'Binder' }])
  })

  it('moves the whole stack when the quantity is left out', async () => {
    const source = await own(db, 'user-a', darkMagician, 4, 'box-1')

    const result = move(db, 'user-a', [{ ownedCardId: source.id, toCollectionId: null }])

    expect(result.moved).toBe(4)
    expect(stacks(db)).toEqual([{ id: source.id, card: darkMagician, collection: null, quantity: 4, note: null }])
  })

  it('merges a whole move into the target\'s stack and joins the notes, target first', async () => {
    const source = await own(db, 'user-a', darkMagician, 2, null, 'From trade')
    const target = await own(db, 'user-a', darkMagician, 3, 'box-1', 'Binder')

    const result = move(db, 'user-a', [{ ownedCardId: source.id, toCollectionId: 'box-1' }])

    expect(result.items[0]).toMatchObject({ ownedCardId: source.id, resultId: target.id, quantity: 2, remaining: 0 })
    expect(stacks(db)).toEqual([{ id: target.id, card: darkMagician, collection: 'box-1', quantity: 5, note: 'Binder\nFrom trade' }])
  })

  it('moves a batch in one go, in order, and may take from one stack twice', async () => {
    const dm = await own(db, 'user-a', darkMagician, 3)
    const pot = await own(db, 'user-a', potOfGreed, 2, 'box-2')

    const result = move(db, 'user-a', [
      { ownedCardId: dm.id, quantity: 1, toCollectionId: 'box-1' },
      { ownedCardId: pot.id, toCollectionId: 'box-1' },
      { ownedCardId: dm.id, quantity: 2, toCollectionId: 'box-2' },
    ])

    expect(result.moved).toBe(5)
    expect(result.items.map(item => [item.catalogCardId, item.quantity, item.toCollectionId])).toEqual([
      [darkMagician, 1, 'box-1'],
      [potOfGreed, 2, 'box-1'],
      [darkMagician, 2, 'box-2'],
    ])
    expect(stacks(db).map(row => [row.card, row.collection, row.quantity])).toEqual([
      [darkMagician, 'box-1', 1],
      [darkMagician, 'box-2', 2],
      [potOfGreed, 'box-1', 2],
    ])
  })

  it('does not touch another user\'s stacks or collections', async () => {
    const mine = await own(db, 'user-a', darkMagician, 1)
    const theirs = await own(db, 'user-b', darkMagician, 1)

    const foreignStack = thrownOf(() => move(db, 'user-a', [{ ownedCardId: theirs.id, toCollectionId: 'box-1' }]))
    expect(foreignStack?.statusCode).toBe(400)
    expect(foreignStack?.data?.errors).toEqual([expect.objectContaining({ index: 0, code: 'owned_card_not_found' })])

    const foreignCollection = thrownOf(() => move(db, 'user-a', [{ ownedCardId: mine.id, toCollectionId: 'box-b' }]))
    expect(foreignCollection?.data?.errors).toEqual([expect.objectContaining({ index: 0, code: 'collection_not_found' })])

    expect(stacks(db, 'user-a')).toEqual([{ id: mine.id, card: darkMagician, collection: null, quantity: 1, note: null }])
    expect(stacks(db, 'user-b')).toEqual([{ id: theirs.id, card: darkMagician, collection: null, quantity: 1, note: null }])
  })

  it('rejects more copies than the stack has, also across items of one batch', async () => {
    const source = await own(db, 'user-a', darkMagician, 3)

    const tooMany = thrownOf(() => move(db, 'user-a', [{ ownedCardId: source.id, quantity: 4, toCollectionId: 'box-1' }]))
    expect(tooMany?.data?.errors).toEqual([expect.objectContaining({ index: 0, code: 'move_quantity_exceeds', params: { max: 3 } })])

    const acrossItems = thrownOf(() => move(db, 'user-a', [
      { ownedCardId: source.id, quantity: 2, toCollectionId: 'box-1' },
      { ownedCardId: source.id, quantity: 2, toCollectionId: 'box-2' },
    ]))
    expect(acrossItems?.data?.errors).toEqual([expect.objectContaining({ index: 1, code: 'move_quantity_exceeds', params: { max: 1 } })])
  })

  it('rejects a target equal to the stack\'s collection', async () => {
    const inBox = await own(db, 'user-a', darkMagician, 1, 'box-1')
    const loose = await own(db, 'user-a', potOfGreed, 1)

    const error = thrownOf(() => move(db, 'user-a', [
      { ownedCardId: inBox.id, toCollectionId: 'box-1' },
      { ownedCardId: loose.id, toCollectionId: null },
    ]))

    expect(error?.data?.errors?.map(entry => [entry.index, entry.code])).toEqual([[0, 'move_same_collection'], [1, 'move_same_collection']])
  })

  it('writes nothing when any item is invalid', async () => {
    const source = await own(db, 'user-a', darkMagician, 2)

    expect(thrownOf(() => move(db, 'user-a', [
      { ownedCardId: source.id, quantity: 1, toCollectionId: 'box-1' },
      { ownedCardId: 'does-not-exist', toCollectionId: 'box-1' },
    ]))?.data?.errors?.map(entry => entry.index)).toEqual([1])

    expect(stacks(db)).toEqual([{ id: source.id, card: darkMagician, collection: null, quantity: 2, note: null }])
  })

  it('rolls the batch back when a write fails midway', async () => {
    const source = await own(db, 'user-a', darkMagician, 2)
    const pot = await own(db, 'user-a', potOfGreed, 1)
    // A collection deleted between validation and the write cannot happen in one
    // synchronous transaction; make the second write fail on purpose instead.
    db.$client.exec(`create trigger fail_second before update on owned_card when new.id = '${pot.id}' begin select raise(abort, 'boom'); end`)

    expect(() => move(db, 'user-a', [
      { ownedCardId: source.id, quantity: 1, toCollectionId: 'box-1' },
      { ownedCardId: pot.id, toCollectionId: 'box-1' },
    ])).toThrow('boom')

    expect(stacks(db).map(row => [row.card, row.collection, row.quantity])).toEqual([
      [darkMagician, null, 2],
      [potOfGreed, null, 1],
    ])
  })
})

describe('validateInventoryMoveInput', () => {
  it('accepts camelCase and snake_case items; a missing quantity means all', () => {
    expect(validateInventoryMoveInput({
      items: [
        { ownedCardId: 'a', quantity: 2, toCollectionId: 'box-1' },
        { owned_card_id: ' b ', to_collection_id: null },
        { ownedCardId: 'c', quantity: '3', toCollectionId: '' },
      ],
    })).toEqual([
      { ownedCardId: 'a', quantity: 2, toCollectionId: 'box-1' },
      { ownedCardId: 'b', quantity: null, toCollectionId: null },
      { ownedCardId: 'c', quantity: 3, toCollectionId: null },
    ])
  })

  it('rejects a malformed envelope and more than the item cap', () => {
    expect(() => validateInventoryMoveInput(null)).toThrow()
    expect(() => validateInventoryMoveInput({ items: 'nope' })).toThrow()
    expect(() => validateInventoryMoveInput({ items: [] })).toThrow()
    expect(() => validateInventoryMoveInput({
      items: Array.from({ length: INVENTORY_MOVE_MAX_ITEMS + 1 }, () => ({ ownedCardId: 'a', toCollectionId: null })),
    })).toThrow()
    expect(validateInventoryMoveInput({
      items: Array.from({ length: INVENTORY_MOVE_MAX_ITEMS }, () => ({ ownedCardId: 'a', toCollectionId: null })),
    })).toHaveLength(INVENTORY_MOVE_MAX_ITEMS)
  })

  it('reports every bad item with its index', () => {
    const error = thrownOf(() => validateInventoryMoveInput({
      items: [
        { ownedCardId: 'a', toCollectionId: null },
        { toCollectionId: null },
        { ownedCardId: 'b' },
        { ownedCardId: 'c', quantity: 0, toCollectionId: null },
        { ownedCardId: 'd', quantity: 1000, toCollectionId: null },
        'nope',
      ],
    }))

    expect(error?.statusCode).toBe(400)
    expect(error?.data?.code).toBe('items_invalid')
    expect(error?.data?.errors?.map(entry => entry.index)).toEqual([1, 2, 3, 4, 5])
  })
})
