import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { and, eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  createDeck,
  DECK_LIMITS,
  duplicateNameFor,
  defaultSectionForCard,
  deleteDeck,
  duplicateDeck,
  getDeckDetail,
  validateDuplicateDeckInput,
  isExtraDeckCard,
  listDecks,
  loadDeckCovers,
  MAX_DECK_CARD_QUANTITY,
  moveDeckCard,
  parseDeckListQuery,
  pickDeckCover,
  removeDeckCard,
  updateDeck,
  upsertDeckCard,
  validateDeckCardInput,
  validateDeckCardMoveInput,
  validateDeckCreateCardsInput,
  validateDeckCreateInput,
  validateDeckInput,
  validateDeckUpdateInput,
} from '../../server/utils/decks'
import type { DeckCoverCandidate } from '../../server/utils/decks'
import { createCollection } from '../../server/utils/collections'
import { addOwnedCard, validateInventoryInput } from '../../server/utils/inventory'
import { createRuleFormat, seedBuiltinFormats, validateRuleFormatInput } from '../../server/utils/rule-formats'
import { setShareState } from '../../server/utils/sharing'
import { seedGermanNames } from './fixtures/german-names'

const CARD = {
  darkMagician: 46986414,
  potOfGreed: 55144522,
  mirrorForce: 44095762,
  stardustDragon: 44508094,
  decodeTalker: 1861629,
  blueEyesUltimateDragon: 23995346,
  utopia: 84013237,
} as const

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function seedUsersAndCatalog(db: TestDb) {
  const now = new Date()

  db.insert(schema.user).values([
    { id: 'user-a', name: 'User A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now },
    { id: 'user-b', name: 'User B', email: 'b@example.com', emailVerified: false, createdAt: now, updatedAt: now },
  ]).run()

  db.insert(schema.catalogCard).values([
    {
      id: CARD.darkMagician,
      name: 'Dark Magician',
      type: 'Normal Monster',
      frameType: 'normal',
      desc: 'The ultimate wizard.',
      attribute: 'DARK',
      level: 7,
      syncedAt: now,
    },
    {
      id: CARD.potOfGreed,
      name: 'Pot of Greed',
      type: 'Spell Card',
      frameType: 'spell',
      desc: 'Draw two cards.',
      syncedAt: now,
    },
    {
      id: CARD.mirrorForce,
      name: 'Mirror Force',
      type: 'Trap Card',
      frameType: 'trap',
      desc: 'Destroy all attacking monsters.',
      syncedAt: now,
    },
    {
      id: CARD.stardustDragon,
      name: 'Stardust Dragon',
      type: 'Synchro Monster',
      frameType: 'synchro',
      desc: 'Tuner + 1 or more non-Tuner monsters.',
      attribute: 'WIND',
      level: 8,
      syncedAt: now,
    },
    {
      id: CARD.decodeTalker,
      name: 'Decode Talker',
      type: 'Link Monster',
      frameType: 'link',
      desc: '2+ Effect Monsters.',
      attribute: 'DARK',
      syncedAt: now,
    },
    {
      id: CARD.blueEyesUltimateDragon,
      name: 'Blue-Eyes Ultimate Dragon',
      type: 'Fusion Monster',
      frameType: 'fusion',
      desc: 'Blue-Eyes White Dragon + Blue-Eyes White Dragon + Blue-Eyes White Dragon',
      attribute: 'LIGHT',
      level: 12,
      syncedAt: now,
    },
    {
      id: CARD.utopia,
      name: 'Number 39: Utopia',
      type: 'XYZ Monster',
      frameType: 'xyz',
      desc: '2 Level 4 monsters.',
      attribute: 'LIGHT',
      syncedAt: now,
    },
  ]).run()
}

function own(db: TestDb, userId: string, catalogCardId: number, quantity: number, extra: Record<string, unknown> = {}) {
  return addOwnedCard(db, userId, validateInventoryInput({
    catalog_card_id: catalogCardId,
    quantity,
    ...extra,
  }))
}

describe('deck section rules', () => {
  it('routes fusion/synchro/xyz/link monsters to the extra deck', () => {
    expect(isExtraDeckCard({ type: 'Fusion Monster', frameType: 'fusion' })).toBe(true)
    expect(isExtraDeckCard({ type: 'Synchro Tuner Monster', frameType: 'synchro' })).toBe(true)
    expect(isExtraDeckCard({ type: 'XYZ Monster', frameType: 'xyz' })).toBe(true)
    expect(isExtraDeckCard({ type: 'Link Monster', frameType: 'link' })).toBe(true)
    expect(isExtraDeckCard({ type: 'Pendulum Effect Fusion Monster', frameType: 'fusion_pendulum' })).toBe(true)

    expect(isExtraDeckCard({ type: 'Normal Monster', frameType: 'normal' })).toBe(false)
    expect(isExtraDeckCard({ type: 'Effect Monster', frameType: 'effect' })).toBe(false)
    expect(isExtraDeckCard({ type: 'Ritual Monster', frameType: 'ritual' })).toBe(false)
    expect(isExtraDeckCard({ type: 'Spell Card', frameType: 'spell' })).toBe(false)
    expect(isExtraDeckCard({ type: 'Trap Card', frameType: 'trap' })).toBe(false)
  })

  it('derives the default section from the card type', () => {
    expect(defaultSectionForCard({ type: 'Synchro Monster' })).toBe('extra')
    expect(defaultSectionForCard({ type: 'Spell Card' })).toBe('main')
  })
})

describe('deck validation', () => {
  it('normalizes and rejects deck input', () => {
    expect(validateDeckInput({ name: '  Blue-Eyes  ' })).toEqual({ name: 'Blue-Eyes', description: null })
    expect(validateDeckInput({ name: 'Deck', description: '  schnell  ' })).toEqual({ name: 'Deck', description: 'schnell' })

    expect(() => validateDeckInput({ name: '' })).toThrow()
    expect(() => validateDeckInput({ name: '   ' })).toThrow()
    expect(() => validateDeckInput({ name: 'a'.repeat(81) })).toThrow()
    expect(() => validateDeckInput({ name: 'Deck', description: 'x'.repeat(501) })).toThrow()
    expect(() => validateDeckInput('nope')).toThrow()
  })

  it('only validates provided fields on update', () => {
    expect(validateDeckUpdateInput({})).toEqual({})
    expect(validateDeckUpdateInput({ name: 'Neu' })).toEqual({ name: 'Neu' })
    expect(validateDeckUpdateInput({ description: null })).toEqual({ description: null })
    expect(() => validateDeckUpdateInput({ name: '' })).toThrow()
  })

  it('accepts snake_case and camelCase deck card input', () => {
    expect(validateDeckCardInput({ catalog_card_id: 1, section: 'main', quantity: 2 }))
      .toEqual({ catalogCardId: 1, section: 'main', quantity: 2 })
    expect(validateDeckCardInput({ catalogCardId: 1, section: 'side' }))
      .toEqual({ catalogCardId: 1, section: 'side', quantity: 1 })
    // 0 is the documented "remove this row" quantity.
    expect(validateDeckCardInput({ catalogCardId: 1, section: 'side', quantity: 0 }).quantity).toBe(0)

    expect(() => validateDeckCardInput({ catalogCardId: 1, section: 'graveyard' })).toThrow()
    expect(() => validateDeckCardInput({ catalogCardId: 0, section: 'main' })).toThrow()
    expect(() => validateDeckCardInput({ catalogCardId: 1, section: 'main', quantity: -1 })).toThrow()
  })

  it('caps a deck card quantity and rejects unsafe numbers', () => {
    expect(validateDeckCardInput({ catalogCardId: 1, section: 'main', quantity: MAX_DECK_CARD_QUANTITY }).quantity)
      .toBe(MAX_DECK_CARD_QUANTITY)

    expect(() => validateDeckCardInput({ catalogCardId: 1, section: 'main', quantity: MAX_DECK_CARD_QUANTITY + 1 })).toThrow()
    expect(() => validateDeckCardInput({ catalogCardId: 1, section: 'main', quantity: 1e20 })).toThrow()
    expect(() => validateDeckCardInput({ catalogCardId: 1, section: 'main', quantity: 1.5 })).toThrow()
    expect(() => validateDeckCardInput({ catalogCardId: 1e20, section: 'main' })).toThrow()
    expect(() => validateDeckCardMoveInput({ catalogCardId: 1, from: 'main', to: 'side', quantity: 1e20 })).toThrow()
  })

  it('keeps the "(copy)" suffix inside the 80 character name limit', () => {
    expect(duplicateNameFor('Kurz')).toBe('Kurz (copy)')

    const longName = 'D'.repeat(80)
    const copyName = duplicateNameFor(longName)
    expect(copyName).toHaveLength(80)
    expect(copyName.endsWith(' (copy)')).toBe(true)
  })

  it('rejects a move between identical sections', () => {
    expect(validateDeckCardMoveInput({ catalogCardId: 1, from: 'main', to: 'side' }))
      .toEqual({ catalogCardId: 1, from: 'main', to: 'side', quantity: undefined })
    expect(() => validateDeckCardMoveInput({ catalogCardId: 1, from: 'main', to: 'main' })).toThrow()
    expect(() => validateDeckCardMoveInput({ catalogCardId: 1, from: 'main', to: 'side', quantity: 0 })).toThrow()
  })

  it('parses and clamps the list query', () => {
    expect(parseDeckListQuery({ q: '  Blue  ', sort: 'name', page: '2', pageSize: '5', contains: '46986414' }))
      .toEqual({ q: 'Blue', sort: 'name', page: 2, pageSize: 5, contains: 46986414 })
    expect(parseDeckListQuery({ sort: 'bogus', page: '-1' }))
      .toEqual({ q: undefined, sort: undefined, page: undefined, pageSize: undefined, contains: undefined })
  })

  it('validates the optional cards array on deck creation', () => {
    expect(validateDeckCreateCardsInput({ name: 'Deck' })).toBeUndefined()

    expect(validateDeckCreateCardsInput({
      cards: [
        { catalog_card_id: CARD.darkMagician, section: 'main', quantity: 2 },
        { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 },
      ],
    })).toEqual([
      { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 },
      { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 },
    ])

    expect(() => validateDeckCreateCardsInput({ cards: 'nope' })).toThrow(expect.objectContaining({ statusCode: 400 }))
    // Unlike the upsert endpoint, quantity 0 is not a valid "remove" here.
    expect(() => validateDeckCreateCardsInput({ cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 0 }] }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('deck creation with cards', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('creates the deck and its cards in one call', () => {
    const cards = validateDeckCreateCardsInput({
      cards: [
        { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 },
        { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 },
        { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 },
      ],
    })!

    const created = createDeck(db, 'user-a', validateDeckInput({ name: 'KI-Vorschlag' }), cards)

    // Duplicate (catalogCardId, section) entries are merged.
    expect(created.sections.main).toEqual([expect.objectContaining({ catalogCardId: CARD.darkMagician, quantity: 3 })])
    expect(created.sections.extra).toEqual([expect.objectContaining({ catalogCardId: CARD.stardustDragon, quantity: 1 })])
    expect(getDeckDetail(db, 'user-a', created.id).counts).toMatchObject({ main: 3, extra: 1, total: 4 })
  })

  it('rejects an unknown catalog card and rolls back the whole deck', () => {
    const cards = [{ catalogCardId: 999999999, section: 'main' as const, quantity: 1 }]

    expect(() => createDeck(db, 'user-a', validateDeckInput({ name: 'Kaputt' }), cards))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(listDecks(db, 'user-a').items).toEqual([])
  })

  it('rejects a card placed in a section its type forbids', () => {
    const cards = [{ catalogCardId: CARD.stardustDragon, section: 'main' as const, quantity: 1 }]

    expect(() => createDeck(db, 'user-a', validateDeckInput({ name: 'Kaputt' }), cards))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(listDecks(db, 'user-a').items).toEqual([])
  })

  it('ignores a cards field on update, same as any other unknown key', () => {
    const created = createDeck(db, 'user-a', validateDeckInput({ name: 'Deck' }))

    const patch = validateDeckUpdateInput({ name: 'Umbenannt', cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] })
    expect(patch).toEqual({ name: 'Umbenannt' })

    const updated = updateDeck(db, 'user-a', created.id, patch)
    expect(updated.counts.total).toBe(0)
  })
})

describe('deck persistence', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('creates, reads, renames, and deletes a deck', () => {
    const created = createDeck(db, 'user-a', { name: 'Blue-Eyes', description: 'Beatdown' })

    expect(created).toMatchObject({ name: 'Blue-Eyes', description: 'Beatdown' })
    expect(created.sections).toEqual({ main: [], extra: [], side: [] })
    expect(created.counts).toEqual({ main: 0, extra: 0, side: 0, total: 0 })
    expect(created.limits).toEqual(DECK_LIMITS)

    expect(getDeckDetail(db, 'user-a', created.id).name).toBe('Blue-Eyes')

    const renamed = updateDeck(db, 'user-a', created.id, { name: 'Blue-Eyes Control' })
    expect(renamed.name).toBe('Blue-Eyes Control')
    expect(renamed.description).toBe('Beatdown')

    deleteDeck(db, 'user-a', created.id)
    expect(() => getDeckDetail(db, 'user-a', created.id)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it('hides another user deck behind a 404 for reads and writes', () => {
    const deck = createDeck(db, 'user-a', { name: 'Privat', description: null })

    expect(() => getDeckDetail(db, 'user-b', deck.id)).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => updateDeck(db, 'user-b', deck.id, { name: 'Geklaut' })).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => deleteDeck(db, 'user-b', deck.id)).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => duplicateDeck(db, 'user-b', deck.id)).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => upsertDeckCard(db, 'user-b', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => moveDeckCard(db, 'user-b', deck.id, { catalogCardId: CARD.darkMagician, from: 'main', to: 'side' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => removeDeckCard(db, 'user-b', deck.id, CARD.darkMagician, 'main'))
      .toThrow(expect.objectContaining({ statusCode: 404 }))

    // The deck itself is untouched.
    expect(getDeckDetail(db, 'user-a', deck.id).name).toBe('Privat')
  })

  it('rejects cards in a section their type forbids', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })

    expect(() => upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'main', quantity: 1 }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'extra', quantity: 1 }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: 999999, section: 'main', quantity: 1 }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))

    // 'side' takes both, 'extra' takes extra-deck monsters.
    const withSide = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'side', quantity: 1 })
    expect(withSide.counts.side).toBe(1)
    const withExtra = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.utopia, section: 'extra', quantity: 1 })
    expect(withExtra.counts.extra).toBe(1)
  })

  it('upserts a card quantity and removes the row on quantity 0', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })

    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    let detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })

    expect(detail.sections.main).toHaveLength(1)
    expect(detail.sections.main[0]).toMatchObject({ catalogCardId: CARD.darkMagician, quantity: 3 })
    expect(detail.counts.main).toBe(3)

    detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 0 })
    expect(detail.sections.main).toHaveLength(0)
    expect(db.select().from(schema.deckCard).where(eq(schema.deckCard.deckId, deck.id)).all()).toHaveLength(0)
  })

  it('removes a card explicitly and 404s on a row that is not there', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })

    const detail = removeDeckCard(db, 'user-a', deck.id, CARD.potOfGreed, 'main')
    expect(detail.counts.total).toBe(0)

    expect(() => removeDeckCard(db, 'user-a', deck.id, CARD.potOfGreed, 'main'))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it('moves copies between sections, merging into an existing target row', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'side', quantity: 1 })

    // Partial move merges into the existing side row.
    let detail = moveDeckCard(db, 'user-a', deck.id, {
      catalogCardId: CARD.darkMagician,
      from: 'main',
      to: 'side',
      quantity: 2,
    })
    expect(detail.counts).toMatchObject({ main: 1, side: 3 })

    // Full move empties the source section.
    detail = moveDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, from: 'main', to: 'side' })
    expect(detail.sections.main).toHaveLength(0)
    expect(detail.counts.side).toBe(4)

    expect(() => moveDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, from: 'main', to: 'side' }))
      .toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => moveDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, from: 'side', to: 'extra' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => moveDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, from: 'side', to: 'main', quantity: 99 }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('duplicates a deck with its cards under a "(copy)" name', () => {
    const deck = createDeck(db, 'user-a', { name: 'Original', description: 'Notiz' })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 })

    const copy = duplicateDeck(db, 'user-a', deck.id)

    expect(copy.id).not.toBe(deck.id)
    expect(copy.name).toBe('Original (copy)')
    expect(copy.description).toBe('Notiz')
    expect(copy.counts).toMatchObject({ main: 3, extra: 1, total: 4 })

    // Editing the copy leaves the original alone.
    upsertDeckCard(db, 'user-a', copy.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    expect(getDeckDetail(db, 'user-a', deck.id).counts.main).toBe(3)
  })

  it('names the copy from the optional request body', () => {
    const deck = createDeck(db, 'user-a', { name: 'Original', description: null })

    // The UI names the copy in the interface language (ADR 0014).
    const copy = duplicateDeck(db, 'user-a', deck.id, validateDuplicateDeckInput({ name: '  Original (Kopie)  ' }))
    expect(copy.name).toBe('Original (Kopie)')

    expect(validateDuplicateDeckInput(undefined)).toEqual({})
    expect(validateDuplicateDeckInput({})).toEqual({})
    expect(() => validateDuplicateDeckInput({ name: '' })).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => validateDuplicateDeckInput({ name: 'x'.repeat(81) })).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => getDeckDetail(db, 'user-a', 'missing'))
      .toThrow(expect.objectContaining({ statusCode: 404, data: { code: 'deck_not_found' } }))
  })

  it('never inherits the source deck\'s share — the copy is always private with no token', () => {
    const deck = createDeck(db, 'user-a', { name: 'Shared', description: null })
    setShareState(db, 'user-a', 'deck', deck.id, { visibility: 'link' })

    const copy = duplicateDeck(db, 'user-a', deck.id)

    expect(copy.visibility).toBe('private')

    const copyRow = db.select().from(schema.deck).where(eq(schema.deck.id, copy.id)).get()
    expect(copyRow?.shareToken).toBeNull()
  })

  it('removes the deck cards when the deck is deleted', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 })

    expect(db.select().from(schema.deckCard).where(eq(schema.deckCard.deckId, deck.id)).all()).toHaveLength(2)

    deleteDeck(db, 'user-a', deck.id)

    expect(db.select().from(schema.deckCard).where(eq(schema.deckCard.deckId, deck.id)).all()).toHaveLength(0)
  })

  it('does not touch updatedAt for an empty patch', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    const before = db.select().from(schema.deck).where(eq(schema.deck.id, deck.id)).get()!.updatedAt

    const unchanged = updateDeck(db, 'user-a', deck.id, {})
    expect(unchanged.updatedAt).toEqual(before)
    expect(db.select().from(schema.deck).where(eq(schema.deck.id, deck.id)).get()!.updatedAt).toEqual(before)
  })

  it('sorts the main deck monsters, spells, traps, then by name', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.mirrorForce, section: 'main', quantity: 1 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })

    expect(detail.sections.main.map(row => row.name)).toEqual(['Dark Magician', 'Pot of Greed', 'Mirror Force'])
  })
})

describe('deck availability', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('sums owned copies across collections, conditions, and languages', async () => {
    const box = await createCollection(db, 'user-a', { name: 'Box 1', description: null })
    await own(db, 'user-a', CARD.darkMagician, 1, { collection_id: box.id })
    await own(db, 'user-a', CARD.darkMagician, 1, { language: 'de' })
    await own(db, 'user-a', CARD.darkMagician, 1, { condition: 'played' })
    // Another user's copies never count.
    await own(db, 'user-b', CARD.darkMagician, 10)

    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })

    expect(detail.sections.main[0]).toMatchObject({ owned: 3, usedInDeck: 3, shortfall: 0 })
  })

  it('counts usage across sections and reports the shortfall per row', async () => {
    await own(db, 'user-a', CARD.darkMagician, 2)

    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'side', quantity: 1 })

    expect(detail.sections.main[0]).toMatchObject({ quantity: 2, owned: 2, usedInDeck: 3, shortfall: 1 })
    expect(detail.sections.side[0]).toMatchObject({ quantity: 1, owned: 2, usedInDeck: 3, shortfall: 1 })
  })

  it('reports owned 0 for a card that is only in the catalog', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })

    expect(detail.sections.main[0]).toMatchObject({ owned: 0, usedInDeck: 1, shortfall: 1 })
  })

  it('still loads a retired card in a deck, flagged (ADR 0019)', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })
    db.update(schema.catalogCard).set({ retiredAt: new Date() }).where(eq(schema.catalogCard.id, CARD.potOfGreed)).run()

    const detail = getDeckDetail(db, 'user-a', deck.id)

    expect(detail.sections.main.map(row => [row.catalogCardId, row.retired])).toEqual(expect.arrayContaining([
      [CARD.darkMagician, false],
      [CARD.potOfGreed, true],
    ]))
    expect(detail.sections.main[0]).not.toHaveProperty('retiredAt')
  })

  it('does not reserve owned copies across decks', async () => {
    await own(db, 'user-a', CARD.darkMagician, 3)

    const deckOne = createDeck(db, 'user-a', { name: 'Deck 1', description: null })
    const deckTwo = createDeck(db, 'user-a', { name: 'Deck 2', description: null })
    const detailOne = upsertDeckCard(db, 'user-a', deckOne.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })
    const detailTwo = upsertDeckCard(db, 'user-a', deckTwo.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })

    expect(detailOne.sections.main[0]!.shortfall).toBe(0)
    expect(detailTwo.sections.main[0]!.shortfall).toBe(0)
  })
})

describe('deck warnings', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('warns about an undersized main deck', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })

    expect(detail.warnings.map(warning => warning.code)).toContain('main_below_min')
    expect(detail.warnings[0]!.message).toContain('40')
  })

  it('warns about an oversized main, extra, and side deck', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 61 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 16 })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.mirrorForce, section: 'side', quantity: 16 })

    const codes = detail.warnings.map(warning => warning.code)
    expect(codes).toContain('main_above_max')
    expect(codes).toContain('extra_above_max')
    expect(codes).toContain('side_above_max')
    expect(codes).not.toContain('main_below_min')
  })

  it('warns about more than three copies of a card across the whole deck', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'side', quantity: 2 })
    // Extra deck copies count towards the same limit.
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 5 })

    const copyWarnings = detail.warnings.filter(warning => warning.code === 'copies_above_max')
    expect(copyWarnings.map(warning => warning.cardId).sort())
      .toEqual([CARD.stardustDragon, CARD.darkMagician].sort())
    expect(copyWarnings.find(warning => warning.cardId === CARD.darkMagician)!.params)
      .toEqual({ cardId: CARD.darkMagician, cardName: 'Dark Magician', copies: 4, maxCopies: 3 })

    // Over-limit quantities are warnings, never hard errors: the write stuck.
    expect(detail.counts).toMatchObject({ main: 2, side: 2, extra: 5 })
  })

  it('warns about a retired card, with a format assigned too (ADR 0019, #109)', () => {
    const RETIRED = 101402013
    db.insert(schema.catalogCard).values({
      id: RETIRED,
      name: 'Leviathan of Atlantis - Daedalus',
      type: 'Effect Monster',
      desc: 'Placeholder.',
      syncedAt: new Date(),
      retiredAt: new Date(),
    }).run()
    seedBuiltinFormats(db)
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: RETIRED, section: 'main', quantity: 1 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: RETIRED, section: 'side', quantity: 1 })
    const detail = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })

    // One warning per card, not per row.
    const retired = detail.warnings.filter(warning => warning.code === 'card_retired')
    expect(retired).toEqual([{
      code: 'card_retired',
      cardId: RETIRED,
      params: { cardId: RETIRED, cardName: 'Leviathan of Atlantis - Daedalus' },
      message: 'Leviathan of Atlantis - Daedalus is no longer in the catalog; its banlist status and card data are no longer updated.',
    }])

    const withFormat = updateDeck(db, 'user-a', deck.id, { formatId: 'unlimited' })
    expect(withFormat.warnings.filter(warning => warning.code === 'card_retired')).toHaveLength(1)
  })

  it('accepts at most 99 copies in one row', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })

    const detail = upsertDeckCard(db, 'user-a', deck.id, {
      catalogCardId: CARD.potOfGreed,
      section: 'main',
      quantity: MAX_DECK_CARD_QUANTITY,
    })
    expect(detail.counts.main).toBe(MAX_DECK_CARD_QUANTITY)

    expect(() => validateDeckCardInput({
      catalogCardId: CARD.potOfGreed,
      section: 'main',
      quantity: MAX_DECK_CARD_QUANTITY + 1,
    })).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('deck list', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('returns per-section counts, completeness, and missing copies', async () => {
    await own(db, 'user-a', CARD.darkMagician, 2)
    await own(db, 'user-a', CARD.stardustDragon, 1)

    const deck = createDeck(db, 'user-a', { name: 'Test Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 })

    const result = listDecks(db, 'user-a')
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      name: 'Test Deck',
      mainCount: 3,
      extraCount: 1,
      sideCount: 0,
      cardCount: 4,
      complete: false,
      missingCount: 1,
    })

    // Buying the third copy completes the deck.
    await own(db, 'user-a', CARD.darkMagician, 1)
    expect(listDecks(db, 'user-a').items[0]).toMatchObject({ complete: true, missingCount: 0 })
  })

  it('does not call an empty deck complete', () => {
    createDeck(db, 'user-a', { name: 'Leeres Deck', description: null })

    expect(listDecks(db, 'user-a').items[0]).toMatchObject({
      cardCount: 0,
      complete: false,
      missingCount: 0,
    })
  })

  it('counts missing copies per card across sections, not per row', async () => {
    await own(db, 'user-a', CARD.darkMagician, 3)

    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'side', quantity: 2 })

    // 4 copies used, 3 owned -> exactly 1 missing (not 1 per section).
    expect(listDecks(db, 'user-a').items[0]).toMatchObject({ cardCount: 4, missingCount: 1, complete: false })
  })

  it('scopes the list to the requesting user', () => {
    createDeck(db, 'user-a', { name: 'A-Deck', description: null })
    createDeck(db, 'user-b', { name: 'B-Deck', description: null })

    expect(listDecks(db, 'user-a').items.map(item => item.name)).toEqual(['A-Deck'])
    expect(listDecks(db, 'user-b').items.map(item => item.name)).toEqual(['B-Deck'])
  })

  it('searches by deck name and by the name of a contained card', () => {
    const dragons = createDeck(db, 'user-a', { name: 'Drachen', description: null })
    upsertDeckCard(db, 'user-a', dragons.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 })
    const magicians = createDeck(db, 'user-a', { name: 'Magier', description: null })
    upsertDeckCard(db, 'user-a', magicians.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 })

    expect(listDecks(db, 'user-a', { q: 'drach' }).items.map(item => item.name)).toEqual(['Drachen'])
    expect(listDecks(db, 'user-a', { q: 'stardust' }).items.map(item => item.name)).toEqual(['Drachen'])
    expect(listDecks(db, 'user-a', { q: 'Dark Magician' }).items.map(item => item.name)).toEqual(['Magier'])
    expect(listDecks(db, 'user-a', { q: 'nichts' }).items).toEqual([])
    // LIKE wildcards in the term are matched literally.
    expect(listDecks(db, 'user-a', { q: '%' }).items).toEqual([])
  })

  it('finds a deck by the German name of a contained card (ADR 0015)', () => {
    seedGermanNames(db, { [CARD.stardustDragon]: 'Sternenstaubdrache' })
    const dragons = createDeck(db, 'user-a', { name: 'Synchro', description: null })
    upsertDeckCard(db, 'user-a', dragons.id, { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 })
    createDeck(db, 'user-a', { name: 'Leer', description: null })

    expect(listDecks(db, 'user-a', { q: 'STERNENSTAUB' }).items.map(item => item.name)).toEqual(['Synchro'])
  })

  it('never matches a card that is only in another user deck', () => {
    const foreign = createDeck(db, 'user-b', { name: 'B-Deck', description: null })
    upsertDeckCard(db, 'user-b', foreign.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    createDeck(db, 'user-a', { name: 'A-Deck', description: null })

    expect(listDecks(db, 'user-a', { q: 'Dark Magician' }).items).toEqual([])
    expect(listDecks(db, 'user-a', { contains: CARD.darkMagician }).items).toEqual([])
  })

  it('filters by a contained catalog card', () => {
    const withCard = createDeck(db, 'user-a', { name: 'Mit Karte', description: null })
    upsertDeckCard(db, 'user-a', withCard.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    createDeck(db, 'user-a', { name: 'Ohne Karte', description: null })

    expect(listDecks(db, 'user-a', { contains: CARD.darkMagician }).items.map(item => item.name))
      .toEqual(['Mit Karte'])
    expect(listDecks(db, 'user-a', { contains: CARD.potOfGreed }).items).toEqual([])
  })

  it('sorts by name and paginates', () => {
    createDeck(db, 'user-a', { name: 'Charlie', description: null })
    createDeck(db, 'user-a', { name: 'Alpha', description: null })
    createDeck(db, 'user-a', { name: 'Bravo', description: null })

    expect(listDecks(db, 'user-a', { sort: 'name' }).items.map(item => item.name))
      .toEqual(['Alpha', 'Bravo', 'Charlie'])
    expect(listDecks(db, 'user-a', { sort: '-name' }).items.map(item => item.name))
      .toEqual(['Charlie', 'Bravo', 'Alpha'])

    const firstPage = listDecks(db, 'user-a', { sort: 'name', page: 1, pageSize: 2 })
    expect(firstPage.items.map(item => item.name)).toEqual(['Alpha', 'Bravo'])
    expect(firstPage.total).toBe(3)
    expect(listDecks(db, 'user-a', { sort: 'name', page: 2, pageSize: 2 }).items.map(item => item.name))
      .toEqual(['Charlie'])

    // Past the last page: no items, but the unpaged total stays intact.
    const beyond = listDecks(db, 'user-a', { sort: 'name', page: 9, pageSize: 2 })
    expect(beyond.items).toEqual([])
    expect(beyond).toMatchObject({ total: 3, page: 9, pageSize: 2 })
  })

  it('sorts by last update, most recent first', () => {
    const first = createDeck(db, 'user-a', { name: 'Zuerst', description: null })
    createDeck(db, 'user-a', { name: 'Danach', description: null })

    // Touching the older deck moves it to the top of the "updated" sort.
    db.update(schema.deck)
      .set({ updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.deck.id, first.id))
      .run()

    expect(listDecks(db, 'user-a', { sort: 'updated' }).items.map(item => item.name))
      .toEqual(['Zuerst', 'Danach'])
  })
})

describe('deck cover', () => {
  let db: TestDb

  const IMAGE = {
    darkMagicianSmall: 'https://images.example/cards_small/46986414.jpg',
    darkMagicianLarge: 'https://images.example/cards/46986414.jpg',
    potOfGreedSmall: 'https://images.example/cards_small/55144522.jpg',
    stardustSmall: 'https://images.example/cards_small/44508094.jpg',
  }

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
    db.insert(schema.catalogCardImage).values([
      { id: 46986414, cardId: CARD.darkMagician, imageUrl: IMAGE.darkMagicianLarge, imageUrlSmall: IMAGE.darkMagicianSmall },
      // A second artwork: the cover must still resolve to a single image.
      { id: 46986415, cardId: CARD.darkMagician, imageUrl: 'https://images.example/cards/46986415.jpg', imageUrlSmall: 'https://images.example/cards_small/46986415.jpg' },
      { id: 55144522, cardId: CARD.potOfGreed, imageUrl: 'https://images.example/cards/55144522.jpg', imageUrlSmall: IMAGE.potOfGreedSmall },
      { id: 44508094, cardId: CARD.stardustDragon, imageUrl: 'https://images.example/cards/44508094.jpg', imageUrlSmall: IMAGE.stardustSmall },
    ]).run()
  })

  /** `deck_card.created_at` has second precision — pin it so "first added" is deterministic. */
  function addCard(deckId: string, catalogCardId: number, section: 'main' | 'extra' | 'side', addedAt: string) {
    upsertDeckCard(db, 'user-a', deckId, { catalogCardId, section, quantity: 1 })
    db.update(schema.deckCard)
      .set({ createdAt: new Date(addedAt) })
      .where(and(
        eq(schema.deckCard.deckId, deckId),
        eq(schema.deckCard.catalogCardId, catalogCardId),
        eq(schema.deckCard.section, section),
      ))
      .run()
  }

  function coverOf(deckId: string) {
    return listDecks(db, 'user-a').items.find(item => item.id === deckId)?.cover
  }

  it('prefers the first-added Main Deck monster over an earlier spell', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    addCard(deck.id, CARD.potOfGreed, 'main', '2025-01-01T10:00:00Z')
    addCard(deck.id, CARD.darkMagician, 'main', '2025-01-01T11:00:00Z')
    seedGermanNames(db, { [CARD.darkMagician]: 'Dunkler Magier' })

    expect(coverOf(deck.id)).toEqual({
      catalogCardId: CARD.darkMagician,
      name: 'Dark Magician',
      nameDe: 'Dunkler Magier',
      imageSmall: IMAGE.darkMagicianSmall,
      imageLarge: IMAGE.darkMagicianLarge,
    })
  })

  it('falls back to the first-added Main Deck card when there is no monster', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    addCard(deck.id, CARD.mirrorForce, 'main', '2025-01-01T11:00:00Z')
    addCard(deck.id, CARD.potOfGreed, 'main', '2025-01-01T10:00:00Z')

    expect(coverOf(deck.id)).toMatchObject({ catalogCardId: CARD.potOfGreed, imageSmall: IMAGE.potOfGreedSmall })
  })

  it('falls back to the first-added Extra Deck card for an Extra-only deck', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    addCard(deck.id, CARD.decodeTalker, 'extra', '2025-01-01T11:00:00Z')
    addCard(deck.id, CARD.stardustDragon, 'extra', '2025-01-01T10:00:00Z')

    expect(coverOf(deck.id)).toMatchObject({ catalogCardId: CARD.stardustDragon, imageSmall: IMAGE.stardustSmall })
  })

  it('ignores the Side Deck and returns null for a deck without Main/Extra cards', () => {
    const empty = createDeck(db, 'user-a', { name: 'Leer', description: null })
    const sideOnly = createDeck(db, 'user-a', { name: 'Nur Side', description: null })
    addCard(sideOnly.id, CARD.darkMagician, 'side', '2025-01-01T09:00:00Z')
    const sideMonsterMainSpell = createDeck(db, 'user-a', { name: 'Side + Main', description: null })
    addCard(sideMonsterMainSpell.id, CARD.darkMagician, 'side', '2025-01-01T09:00:00Z')
    addCard(sideMonsterMainSpell.id, CARD.potOfGreed, 'main', '2025-01-01T10:00:00Z')

    expect(coverOf(empty.id)).toBeNull()
    expect(coverOf(sideOnly.id)).toBeNull()
    expect(coverOf(sideMonsterMainSpell.id)).toMatchObject({ catalogCardId: CARD.potOfGreed })
  })

  it('returns a null image for a cover card without a scan', () => {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    addCard(deck.id, CARD.decodeTalker, 'extra', '2025-01-01T10:00:00Z')

    expect(coverOf(deck.id)).toEqual({ catalogCardId: CARD.decodeTalker, name: 'Decode Talker', nameDe: null, imageSmall: null, imageLarge: null })
  })

  it('loads covers for several decks at once and skips decks without one', () => {
    const withCover = createDeck(db, 'user-a', { name: 'A', description: null })
    addCard(withCover.id, CARD.darkMagician, 'main', '2025-01-01T10:00:00Z')
    const without = createDeck(db, 'user-a', { name: 'B', description: null })

    const covers = loadDeckCovers(db, [withCover.id, without.id])
    expect(covers.get(withCover.id)?.catalogCardId).toBe(CARD.darkMagician)
    expect(covers.has(without.id)).toBe(false)
    expect(loadDeckCovers(db, []).size).toBe(0)
  })

  it('keeps the cover on a duplicated deck', () => {
    const deck = createDeck(db, 'user-a', { name: 'Original', description: null })
    addCard(deck.id, CARD.darkMagician, 'main', '2025-01-01T11:00:00Z')
    addCard(deck.id, CARD.potOfGreed, 'main', '2025-01-01T10:00:00Z')
    addCard(deck.id, CARD.mirrorForce, 'main', '2025-01-01T09:00:00Z')

    const copy = duplicateDeck(db, 'user-a', deck.id)

    expect(coverOf(copy.id)).toEqual(coverOf(deck.id))
  })

  describe('chosen cover card (#49)', () => {
    /** A deck whose rule pick is Dark Magician (Main monster), with a Main spell, an Extra card and a Side-only card. */
    function seededDeck(name = 'Deck') {
      const deck = createDeck(db, 'user-a', { name, description: null })
      addCard(deck.id, CARD.darkMagician, 'main', '2025-01-01T10:00:00Z')
      addCard(deck.id, CARD.potOfGreed, 'main', '2025-01-01T11:00:00Z')
      addCard(deck.id, CARD.stardustDragon, 'extra', '2025-01-01T12:00:00Z')
      addCard(deck.id, CARD.mirrorForce, 'side', '2025-01-01T13:00:00Z')
      return deck
    }

    function storedCoverCardId(deckId: string) {
      return db.select({ coverCardId: schema.deck.coverCardId })
        .from(schema.deck)
        .where(eq(schema.deck.id, deckId))
        .get()?.coverCardId
    }

    it('validates coverCardId / cover_card_id in the update input', () => {
      expect(validateDeckUpdateInput({ coverCardId: 5 })).toEqual({ coverCardId: 5 })
      expect(validateDeckUpdateInput({ cover_card_id: '7' })).toEqual({ coverCardId: 7 })
      expect(validateDeckUpdateInput({ coverCardId: null })).toEqual({ coverCardId: null })
      expect(validateDeckUpdateInput({ cover_card_id: '' })).toEqual({ coverCardId: null })
      expect(validateDeckUpdateInput({ name: 'Neu', coverCardId: 5 })).toEqual({ name: 'Neu', coverCardId: 5 })
      expect(validateDeckUpdateInput({})).toEqual({})

      for (const invalid of [0, -1, 1.5, 'abc', {}]) {
        expect(() => validateDeckUpdateInput({ coverCardId: invalid }), String(invalid))
          .toThrow('cover_card_id must be a positive integer or null')
      }
    })

    it('uses a chosen Main Deck spell over the rule\'s monster, in the list and the detail', () => {
      const deck = seededDeck()
      const before = getDeckDetail(db, 'user-a', deck.id)
      expect(before.cover?.catalogCardId).toBe(CARD.darkMagician)
      expect(before.coverIsChosen).toBe(false)

      const updated = updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.potOfGreed })

      expect(updated.cover).toEqual({
        catalogCardId: CARD.potOfGreed,
        name: 'Pot of Greed',
        nameDe: null,
        imageSmall: IMAGE.potOfGreedSmall,
        imageLarge: 'https://images.example/cards/55144522.jpg',
      })
      expect(updated.coverIsChosen).toBe(true)
      expect(coverOf(deck.id)).toMatchObject({ catalogCardId: CARD.potOfGreed })
      expect(getDeckDetail(db, 'user-a', deck.id)).toMatchObject({
        cover: { catalogCardId: CARD.potOfGreed },
        coverIsChosen: true,
      })
    })

    it('uses a chosen Extra Deck card over a Main Deck monster', () => {
      const deck = seededDeck()
      const updated = updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.stardustDragon })

      expect(updated.cover).toMatchObject({ catalogCardId: CARD.stardustDragon, imageSmall: IMAGE.stardustSmall })
      expect(updated.coverIsChosen).toBe(true)
      expect(coverOf(deck.id)).toMatchObject({ catalogCardId: CARD.stardustDragon })
    })

    it('rejects a card that is not in the deck, or only in its Side Deck, without writing', () => {
      const deck = seededDeck()
      const updatedAt = getDeckDetail(db, 'user-a', deck.id).updatedAt

      expect(() => updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.decodeTalker }))
        .toThrow('cover_card_id must be a Main or Extra Deck card of this deck')
      expect(() => updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.mirrorForce }))
        .toThrow('cover_card_id must be a Main or Extra Deck card of this deck')
      // A rejected cover also blocks the rest of the patch.
      expect(() => updateDeck(db, 'user-a', deck.id, { name: 'Umbenannt', coverCardId: CARD.mirrorForce }))
        .toThrow('cover_card_id must be a Main or Extra Deck card of this deck')

      const after = getDeckDetail(db, 'user-a', deck.id)
      expect(after.name).toBe('Deck')
      expect(after.updatedAt).toEqual(updatedAt)
      expect(storedCoverCardId(deck.id)).toBeNull()
    })

    it('returns 404 for another user\'s deck', () => {
      const deck = seededDeck()

      expect(() => updateDeck(db, 'user-b', deck.id, { coverCardId: CARD.potOfGreed }))
        .toThrow('Deck not found')
      expect(storedCoverCardId(deck.id)).toBeNull()
    })

    it('goes back to the rule with coverCardId null', () => {
      const deck = seededDeck()
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.potOfGreed })

      const reset = updateDeck(db, 'user-a', deck.id, { coverCardId: null })

      expect(reset.cover?.catalogCardId).toBe(CARD.darkMagician)
      expect(reset.coverIsChosen).toBe(false)
      expect(storedCoverCardId(deck.id)).toBeNull()
    })

    it('falls back to the rule while the chosen card is removed or in the Side Deck, and returns when it is back', () => {
      const deck = seededDeck()
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.potOfGreed })

      const removed = removeDeckCard(db, 'user-a', deck.id, CARD.potOfGreed, 'main')
      expect(removed.cover?.catalogCardId).toBe(CARD.darkMagician)
      expect(removed.coverIsChosen).toBe(false)
      expect(coverOf(deck.id)?.catalogCardId).toBe(CARD.darkMagician)
      // The choice itself is kept, and the detail reports it as inactive (#57) …
      expect(storedCoverCardId(deck.id)).toBe(CARD.potOfGreed)
      expect(removed.inactiveCoverChoice).toEqual({
        catalogCardId: CARD.potOfGreed,
        name: 'Pot of Greed',
        nameDe: null,
        imageSmall: IMAGE.potOfGreedSmall,
        imageLarge: 'https://images.example/cards/55144522.jpg',
      })

      // … so re-adding the card brings it back.
      const readded = upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })
      expect(readded.cover?.catalogCardId).toBe(CARD.potOfGreed)
      expect(readded.coverIsChosen).toBe(true)
      expect(readded.inactiveCoverChoice).toBeNull()

      const moved = moveDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, from: 'main', to: 'side' })
      expect(moved.cover?.catalogCardId).toBe(CARD.darkMagician)
      expect(moved.coverIsChosen).toBe(false)
      expect(moved.inactiveCoverChoice).toMatchObject({ catalogCardId: CARD.potOfGreed, name: 'Pot of Greed' })
      expect(coverOf(deck.id)?.catalogCardId).toBe(CARD.darkMagician)
    })

    it('drops the inactive choice once it is cleared with coverCardId null (#57)', () => {
      const deck = seededDeck()
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.potOfGreed })
      const removed = removeDeckCard(db, 'user-a', deck.id, CARD.potOfGreed, 'main')
      expect(removed.inactiveCoverChoice).toMatchObject({ catalogCardId: CARD.potOfGreed })

      const cleared = updateDeck(db, 'user-a', deck.id, { coverCardId: null })

      expect(cleared).toMatchObject({ cover: { catalogCardId: CARD.darkMagician }, coverIsChosen: false, inactiveCoverChoice: null })
      expect(storedCoverCardId(deck.id)).toBeNull()
    })

    it('reports the choice as inactive when no Main/Extra card is left (#57)', () => {
      const deck = seededDeck()
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.stardustDragon })

      removeDeckCard(db, 'user-a', deck.id, CARD.darkMagician, 'main')
      removeDeckCard(db, 'user-a', deck.id, CARD.potOfGreed, 'main')
      const emptied = removeDeckCard(db, 'user-a', deck.id, CARD.stardustDragon, 'extra')

      expect(emptied.cover).toBeNull()
      expect(emptied.coverIsChosen).toBe(false)
      expect(emptied.inactiveCoverChoice).toMatchObject({ catalogCardId: CARD.stardustDragon, imageSmall: IMAGE.stardustSmall })
    })

    it('moves updatedAt for a cover-only change', () => {
      const deck = seededDeck()
      const stale = new Date('2024-01-01T00:00:00Z')
      db.update(schema.deck).set({ updatedAt: stale }).where(eq(schema.deck.id, deck.id)).run()

      const updated = updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.potOfGreed })

      expect(updated.updatedAt.getTime()).toBeGreaterThan(stale.getTime())
    })

    it('copies the choice to a duplicate', () => {
      const deck = seededDeck('Original')
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.stardustDragon })

      const copy = duplicateDeck(db, 'user-a', deck.id)

      expect(copy.cover?.catalogCardId).toBe(CARD.stardustDragon)
      expect(copy.coverIsChosen).toBe(true)
      expect(coverOf(copy.id)?.catalogCardId).toBe(CARD.stardustDragon)
    })

    it('honors each deck\'s own choice when loading several covers', () => {
      const chosenSpell = seededDeck('A')
      const chosenExtra = seededDeck('B')
      const byRule = seededDeck('C')
      updateDeck(db, 'user-a', chosenSpell.id, { coverCardId: CARD.potOfGreed })
      updateDeck(db, 'user-a', chosenExtra.id, { coverCardId: CARD.stardustDragon })

      const covers = loadDeckCovers(db, [chosenSpell.id, chosenExtra.id, byRule.id])

      expect(covers.get(chosenSpell.id)?.catalogCardId).toBe(CARD.potOfGreed)
      expect(covers.get(chosenExtra.id)?.catalogCardId).toBe(CARD.stardustDragon)
      expect(covers.get(byRule.id)?.catalogCardId).toBe(CARD.darkMagician)
    })

    it('clears the choice when the catalog card is deleted (ON DELETE SET NULL)', () => {
      const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
      addCard(deck.id, CARD.utopia, 'extra', '2025-01-01T10:00:00Z')
      addCard(deck.id, CARD.darkMagician, 'main', '2025-01-01T11:00:00Z')
      updateDeck(db, 'user-a', deck.id, { coverCardId: CARD.utopia })
      expect(storedCoverCardId(deck.id)).toBe(CARD.utopia)

      // better-sqlite3 enables foreign keys by default; the migration's
      // hand-written ON DELETE clause must hold there. (deck_card rows of the
      // card cascade away with it.)
      expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1)
      db.delete(schema.catalogCard).where(eq(schema.catalogCard.id, CARD.utopia)).run()

      expect(storedCoverCardId(deck.id)).toBeNull()
      expect(getDeckDetail(db, 'user-a', deck.id)).toMatchObject({
        cover: { catalogCardId: CARD.darkMagician },
        coverIsChosen: false,
        inactiveCoverChoice: null,
      })
    })

    it('reports the rule\'s pick as not chosen, and no cover for an empty deck', () => {
      const deck = seededDeck()
      expect(getDeckDetail(db, 'user-a', deck.id)).toMatchObject({
        cover: { catalogCardId: CARD.darkMagician, imageSmall: IMAGE.darkMagicianSmall },
        coverIsChosen: false,
        inactiveCoverChoice: null,
      })

      const empty = createDeck(db, 'user-a', { name: 'Leer', description: null })
      expect(empty.cover).toBeNull()
      expect(empty.coverIsChosen).toBe(false)
      expect(empty.inactiveCoverChoice).toBeNull()
    })
  })
})

describe('pickDeckCover', () => {
  function candidate(overrides: Partial<DeckCoverCandidate>): DeckCoverCandidate {
    return {
      catalogCardId: 1,
      name: 'Karte',
      nameDe: null,
      imageSmall: null,
      imageLarge: null,
      section: 'main',
      type: 'Effect Monster',
      createdAt: new Date('2025-01-01T10:00:00Z'),
      ...overrides,
    }
  }

  it('returns null without candidates', () => {
    expect(pickDeckCover([])).toBeNull()
  })

  it('breaks a "first added" tie by the lower catalog card id', () => {
    const cover = pickDeckCover([
      candidate({ catalogCardId: 30, name: 'C' }),
      candidate({ catalogCardId: 10, name: 'A' }),
      candidate({ catalogCardId: 20, name: 'B' }),
    ])
    expect(cover).toEqual({ catalogCardId: 10, name: 'A', nameDe: null, imageSmall: null, imageLarge: null })
  })

  it('ranks Main monsters over Main spells/traps over Extra cards, regardless of order', () => {
    const extra = candidate({ catalogCardId: 1, section: 'extra', type: 'Synchro Monster', createdAt: new Date('2025-01-01T08:00:00Z') })
    const trap = candidate({ catalogCardId: 2, type: 'Trap Card', createdAt: new Date('2025-01-01T09:00:00Z') })
    const monster = candidate({ catalogCardId: 3, type: 'Normal Monster', createdAt: new Date('2025-01-01T12:00:00Z') })

    expect(pickDeckCover([extra, trap, monster])?.catalogCardId).toBe(3)
    expect(pickDeckCover([extra, trap])?.catalogCardId).toBe(2)
    expect(pickDeckCover([extra])?.catalogCardId).toBe(1)
  })

  it('never picks a Side Deck card', () => {
    expect(pickDeckCover([candidate({ section: 'side' })])).toBeNull()
  })

  it('prefers the chosen card among the candidates', () => {
    const monster = candidate({ catalogCardId: 1, type: 'Normal Monster' })
    const spell = candidate({ catalogCardId: 2, type: 'Spell Card', createdAt: new Date('2025-01-02T10:00:00Z') })

    expect(pickDeckCover([monster, spell], 2)?.catalogCardId).toBe(2)
    expect(pickDeckCover([monster, spell], null)?.catalogCardId).toBe(1)
  })

  it('falls back to the rule when the chosen card is not a candidate', () => {
    const monster = candidate({ catalogCardId: 1, type: 'Normal Monster' })
    expect(pickDeckCover([monster], 99)?.catalogCardId).toBe(1)
  })

  it('falls back to the rule when the chosen card is only a Side Deck candidate', () => {
    const monster = candidate({ catalogCardId: 1, type: 'Normal Monster' })
    const sideSpell = candidate({ catalogCardId: 2, section: 'side', type: 'Spell Card' })
    expect(pickDeckCover([monster, sideSpell], 2)?.catalogCardId).toBe(1)
  })
})

// POST /api/decks takes the format right away (#148).
describe('validateDeckCreateInput', () => {
  it('reads format_id or formatId, and null or an empty string as no format', () => {
    expect(validateDeckCreateInput({ name: 'Deck', format_id: 'unlimited' })).toEqual({ name: 'Deck', description: null, formatId: 'unlimited', coverCardId: null })
    expect(validateDeckCreateInput({ name: 'Deck', formatId: 'goat' }).formatId).toBe('goat')
    expect(validateDeckCreateInput({ name: 'Deck', format_id: null }).formatId).toBeNull()
    expect(validateDeckCreateInput({ name: 'Deck', formatId: '' }).formatId).toBeNull()
    expect(validateDeckCreateInput({ name: 'Deck' }).formatId).toBeNull()
  })

  it('reads cover_card_id or coverCardId', () => {
    expect(validateDeckCreateInput({ name: 'Deck', cover_card_id: 46986414 }).coverCardId).toBe(46986414)
    expect(validateDeckCreateInput({ name: 'Deck', coverCardId: '46986414' }).coverCardId).toBe(46986414)
    expect(validateDeckCreateInput({ name: 'Deck', cover_card_id: null }).coverCardId).toBeNull()
    expect(() => validateDeckCreateInput({ name: 'Deck', cover_card_id: 'x' })).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('400s for a format id that is not a string, and still checks the name', () => {
    expect(() => validateDeckCreateInput({ name: 'Deck', format_id: 5 })).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => validateDeckCreateInput({ format_id: 'unlimited' })).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => validateDeckCreateInput(null)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })
})

describe('deck creation with a format', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
    seedBuiltinFormats(db)
  })

  it('assigns a built-in format at once', () => {
    const created = createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: 'unlimited' })

    expect(created.format?.id).toBe('unlimited')
    expect(created.validation).not.toBeNull()
    expect(listDecks(db, 'user-a', { formatId: 'unlimited' }).items.map(item => item.id)).toEqual([created.id])
  })

  it('assigns the caller\'s own format', () => {
    const own = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Eigenes', rules: { rules: [] } }))
    expect(createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: own.id }).format?.id).toBe(own.id)
  })

  it('400s for an unknown or someone else\'s format and writes nothing', () => {
    const foreign = createRuleFormat(db, 'user-b', validateRuleFormatInput({ name: 'Fremd', rules: { rules: [] } }))

    expect(() => createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: 'does-not-exist' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: foreign.id }, [
      { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 },
    ])).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(listDecks(db, 'user-a').items).toEqual([])
    expect(db.select().from(schema.deckCard).all()).toEqual([])
  })

  it('stores the cards and the format together', () => {
    const created = createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: 'unlimited' }, [
      { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 },
    ])

    expect(created.format?.id).toBe('unlimited')
    expect(getDeckDetail(db, 'user-a', created.id).sections.main).toEqual([
      expect.objectContaining({ catalogCardId: CARD.darkMagician, quantity: 2 }),
    ])
  })

  it('keeps a deck without a format when none is given', () => {
    expect(createDeck(db, 'user-a', { name: 'Deck', description: null }).format).toBeNull()
    expect(createDeck(db, 'user-a', { name: 'Deck', description: null, formatId: null }).format).toBeNull()
  })
})

// The deck tiles' card-kind chips (#148).
describe('deck list card-kind breakdown', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedUsersAndCatalog(db)
  })

  it('counts the copies per kind in Main and Extra, never the Side Deck', () => {
    createDeck(db, 'user-a', { name: 'Deck', description: null }, [
      { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 },
      { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 2 },
      { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 },
      { catalogCardId: CARD.mirrorForce, section: 'side', quantity: 2 },
    ])

    expect(listDecks(db, 'user-a').items[0]!.breakdown).toEqual([
      { section: 'main', kinds: [{ kind: 'normal', count: 3 }, { kind: 'spell', count: 2 }] },
      { section: 'extra', kinds: [{ kind: 'synchro', count: 1 }] },
    ])
  })

  it('is empty for an empty deck or one with only Side Deck cards', () => {
    createDeck(db, 'user-a', { name: 'Leer', description: null })
    createDeck(db, 'user-a', { name: 'Nur Side', description: null }, [
      { catalogCardId: CARD.mirrorForce, section: 'side', quantity: 1 },
    ])

    expect(listDecks(db, 'user-a', { sort: 'name' }).items.map(item => [item.name, item.breakdown])).toEqual([
      ['Leer', []],
      ['Nur Side', []],
    ])
  })
})
