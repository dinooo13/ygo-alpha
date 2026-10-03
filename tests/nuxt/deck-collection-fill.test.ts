import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_FIXTURE_IDS, seedCatalogFixture } from '../../server/db/fixtures/catalog-fixture'
import * as schema from '../../server/db/schema'
import { UNASSIGNED_COLLECTION_ID } from '../../shared/inventory'
import { createCollection } from '../../server/utils/collections'
import {
  fillCollectionFromDeck,
  planDeckCollectionFill,
  validateDeckCollectionFillInput,
} from '../../server/utils/deck-collection'
import { createDeck } from '../../server/utils/decks'
import { addOwnedCard, ownedQuantitiesByCard, validateInventoryInput } from '../../server/utils/inventory'

const { darkMagician, potOfGreed, mirrorForce, stardustDragon } = CATALOG_FIXTURE_IDS

function createTestDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

const ME = 'user-a'

async function own(db: TestDb, userId: string, catalogCardId: number, quantity: number, collectionId: string | null = null) {
  return addOwnedCard(db, userId, validateInventoryInput({ catalog_card_id: catalogCardId, quantity, collection_id: collectionId }))
}

function owned(db: TestDb, catalogCardId: number, collectionId: string | null) {
  return db.select().from(schema.ownedCard).all()
    .filter(row => row.catalogCardId === catalogCardId && row.collectionId === collectionId)
    .reduce((sum, row) => sum + row.quantity, 0)
}

describe('"Sammlung aus Deck befüllen"', () => {
  let db: TestDb
  let target: string
  let box: string
  let other: string
  let deckId: string

  beforeEach(async () => {
    db = createTestDb()
    const now = new Date()
    db.insert(schema.user).values([
      { id: ME, name: 'A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now },
      { id: 'user-b', name: 'B', email: 'b@example.com', emailVerified: false, createdAt: now, updatedAt: now },
    ]).run()
    seedCatalogFixture(db)
    // Names sort: Box < Deck-Box < Zielbox, so the default source order is predictable.
    box = (await createCollection(db, ME, { name: 'Box', description: null })).id
    other = (await createCollection(db, ME, { name: 'Deck-Box', description: null })).id
    target = (await createCollection(db, ME, { name: 'Zielbox', description: null })).id
    deckId = createDeck(db, ME, { name: 'Dark Magician Deck', description: null }, [
      { catalogCardId: darkMagician, section: 'main', quantity: 2 },
      { catalogCardId: darkMagician, section: 'side', quantity: 1 },
      { catalogCardId: potOfGreed, section: 'main', quantity: 1 },
      { catalogCardId: mirrorForce, section: 'main', quantity: 3 },
      { catalogCardId: stardustDragon, section: 'extra', quantity: 1 },
    ]).id
  })

  const fill = (input: Partial<Parameters<typeof fillCollectionFromDeck>[3]> = {}) =>
    fillCollectionFromDeck(db, ME, deckId, { collectionId: target, dryRun: false, ...input })

  it('needs main + extra + side per card, counted once per card', async () => {
    const plan = planDeckCollectionFill(db, ME, deckId, { collectionId: target, dryRun: true })

    expect(plan.cards.find(card => card.catalogCardId === darkMagician)).toMatchObject({ needed: 3, toMove: 0, missing: 3, notOwned: 3 })
    expect(plan.totals).toMatchObject({ cards: 4, needed: 8, toMove: 0, missing: 8, notOwned: 8 })
    expect(plan.collection).toEqual({ id: target, name: 'Zielbox' })
  })

  it('moves what the deck needs, "ohne Sammlung" first, then the other collections', async () => {
    await own(db, ME, darkMagician, 2, null)
    await own(db, ME, darkMagician, 5, box)
    await own(db, ME, potOfGreed, 1, other)

    const result = fill()

    // 2 from "ohne Sammlung", the third copy from "Box"; the rest of Box stays.
    expect(result.executed).toBe(true)
    expect(result.cards.find(card => card.catalogCardId === darkMagician)).toMatchObject({
      needed: 3,
      toMove: 3,
      missing: 0,
      moves: [expect.objectContaining({ fromCollectionId: null, quantity: 2 }), expect.objectContaining({ fromCollectionId: box, quantity: 1 })],
    })
    expect(owned(db, darkMagician, target)).toBe(3)
    expect(owned(db, darkMagician, null)).toBe(0)
    expect(owned(db, darkMagician, box)).toBe(4)
    expect(owned(db, potOfGreed, target)).toBe(1)
    expect(result.moved).toBe(4)
    // No copy is created or lost: the inventory total per card is unchanged.
    expect(ownedQuantitiesByCard(db, ME, [darkMagician, potOfGreed])).toEqual(new Map([[darkMagician, 7], [potOfGreed, 1]]))
  })

  it('reports a shortfall for cards the user does not own enough of', async () => {
    await own(db, ME, mirrorForce, 1, null)
    await own(db, ME, darkMagician, 1, box)

    const result = fill()

    expect(result.cards.find(card => card.catalogCardId === mirrorForce)).toMatchObject({ needed: 3, toMove: 1, missing: 2, notOwned: 2 })
    expect(result.cards.find(card => card.catalogCardId === stardustDragon)).toMatchObject({ toMove: 0, missing: 1, notOwned: 1 })
    expect(result.totals).toMatchObject({ needed: 8, toMove: 2, missing: 6, notOwned: 6 })
  })

  it('counts copies already in the target towards the need and never moves them', async () => {
    await own(db, ME, darkMagician, 2, target)
    await own(db, ME, darkMagician, 4, null)

    const result = fill()

    expect(result.cards.find(card => card.catalogCardId === darkMagician)).toMatchObject({ alreadyInTarget: 2, toMove: 1, missing: 0 })
    expect(owned(db, darkMagician, target)).toBe(3)
    expect(owned(db, darkMagician, null)).toBe(3)
  })

  it('only takes from the chosen sources, in the given order, and tells what lies elsewhere', async () => {
    await own(db, ME, darkMagician, 2, null)
    await own(db, ME, darkMagician, 2, box)
    await own(db, ME, darkMagician, 2, other)

    const result = fill({ sourceCollectionIds: [other, UNASSIGNED_COLLECTION_ID] })

    expect(result.sourceCollectionIds).toEqual([other, UNASSIGNED_COLLECTION_ID])
    expect(result.cards.find(card => card.catalogCardId === darkMagician)).toMatchObject({
      toMove: 3,
      missing: 0,
      moves: [expect.objectContaining({ fromCollectionId: other, quantity: 2 }), expect.objectContaining({ fromCollectionId: null, quantity: 1 })],
    })
    expect(owned(db, darkMagician, box)).toBe(2)

    // Box is no source: what the deck still lacks lies there, not nowhere.
    await own(db, ME, mirrorForce, 3, box)
    const second = fill({ sourceCollectionIds: [UNASSIGNED_COLLECTION_ID], dryRun: true })
    expect(second.cards.find(card => card.catalogCardId === mirrorForce)).toMatchObject({ toMove: 0, missing: 3, ownedElsewhere: 3, notOwned: 0 })
  })

  it('a dry run changes nothing', async () => {
    await own(db, ME, darkMagician, 3, null)

    const preview = fill({ dryRun: true })

    expect(preview).toMatchObject({ executed: false, moved: 0, items: [] })
    expect(preview.totals.toMove).toBe(3)
    expect(owned(db, darkMagician, null)).toBe(3)
    expect(owned(db, darkMagician, target)).toBe(0)
    expect(db.select().from(schema.ownedCard).all()).toHaveLength(1)
  })

  it('is idempotent: a second run has nothing left to move', async () => {
    await own(db, ME, darkMagician, 3, null)

    expect(fill().moved).toBe(3)
    const again = fill()

    expect(again).toMatchObject({ executed: true, moved: 0 })
    expect(again.cards.find(card => card.catalogCardId === darkMagician)).toMatchObject({ alreadyInTarget: 3, toMove: 0, missing: 0 })
  })

  it('never lists the target as a source', async () => {
    await own(db, ME, darkMagician, 3, target)

    const plan = planDeckCollectionFill(db, ME, deckId, { collectionId: target, sourceCollectionIds: [target, box], dryRun: true })

    expect(plan.sourceCollectionIds).toEqual([box])
    expect(plan.totals.toMove).toBe(0)
  })

  it('does not reach into another user\'s deck, collections or copies', async () => {
    const theirs = (await createCollection(db, 'user-b', { name: 'Fremd', description: null })).id
    await own(db, 'user-b', darkMagician, 3, null)

    expect(() => fillCollectionFromDeck(db, 'user-b', deckId, { collectionId: theirs, dryRun: false })).toThrow()
    expect(() => fillCollectionFromDeck(db, ME, deckId, { collectionId: theirs, dryRun: false })).toThrow()
    expect(() => fillCollectionFromDeck(db, ME, deckId, { collectionId: target, sourceCollectionIds: [theirs], dryRun: false })).toThrow()
    // Their copies are not mine to move.
    expect(fill().moved).toBe(0)
    expect(owned(db, darkMagician, null)).toBe(3)
  })

  it('an empty deck has nothing to move', async () => {
    const empty = createDeck(db, ME, { name: 'Leer', description: null }).id

    const result = fillCollectionFromDeck(db, ME, empty, { collectionId: target, dryRun: false })

    expect(result).toMatchObject({ executed: true, moved: 0, cards: [] })
  })
})

describe('validateDeckCollectionFillInput', () => {
  it('reads camelCase and snake_case, dedupes the sources and defaults to a real run', () => {
    expect(validateDeckCollectionFillInput({ collectionId: ' c1 ', sourceCollectionIds: ['a', 'a', '__none__'] })).toEqual({
      collectionId: 'c1',
      sourceCollectionIds: ['a', '__none__'],
      dryRun: false,
    })
    expect(validateDeckCollectionFillInput({ collection_id: 'c1', dry_run: true })).toEqual({ collectionId: 'c1', sourceCollectionIds: undefined, dryRun: true })
  })

  it('needs a real target collection', () => {
    expect(() => validateDeckCollectionFillInput(null)).toThrow()
    expect(() => validateDeckCollectionFillInput({})).toThrow()
    expect(() => validateDeckCollectionFillInput({ collectionId: '__none__' })).toThrow()
    expect(() => validateDeckCollectionFillInput({ collectionId: 'c1', sourceCollectionIds: 'a' })).toThrow()
    expect(() => validateDeckCollectionFillInput({ collectionId: 'c1', sourceCollectionIds: [''] })).toThrow()
  })
})
