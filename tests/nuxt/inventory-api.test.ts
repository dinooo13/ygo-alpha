import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { CARD_TEXT_EXCERPT_LENGTH } from '../../shared/inventory'
import {
  addOwnedCard,
  deleteOwnedCard,
  joinNotes,
  listOwnedCards,
  parseInventoryListQuery,
  searchCatalogCards,
  updateOwnedCard,
  validateInventoryInput,
  validateInventoryUpdateInput,
} from '../../server/utils/inventory'
import { seedGermanNames } from './fixtures/german-names'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

const COLLECTOR_KEYS = ['printingId', 'language', 'condition', 'edition']

function seedCatalog(db: TestDb) {
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

  db.insert(schema.catalogCard).values([
    {
      id: 46986414,
      name: 'Dark Magician',
      type: 'Normal Monster',
      attribute: 'DARK',
      desc: 'The ultimate wizard.',
      syncedAt: now,
    },
    {
      id: 55144522,
      name: 'Pot of Greed',
      type: 'Spell Card',
      desc: 'Draw two cards.',
      syncedAt: now,
    },
  ]).run()

  db.insert(schema.catalogSet).values({
    id: 'legend-of-blue-eyes-white-dragon',
    name: 'Legend of Blue Eyes White Dragon',
  }).run()

  db.insert(schema.catalogPrinting).values({
    id: 'LOB-005',
    cardId: 46986414,
    setId: 'legend-of-blue-eyes-white-dragon',
    setCode: 'LOB-005',
    rarity: 'Ultra Rare',
  }).run()

  db.insert(schema.catalogCardImage).values({
    id: 46986414,
    cardId: 46986414,
    imageUrl: 'https://images.example/dm.jpg',
    imageUrlSmall: 'https://images.example/dm-small.jpg',
    imageUrlCropped: 'https://images.example/dm-crop.jpg',
  }).run()
}

describe('inventory validation', () => {
  it('normalizes valid inventory input with defaults', () => {
    expect(validateInventoryInput({ catalog_card_id: '46986414' })).toEqual({
      catalogCardId: 46986414,
      collectionId: null,
      quantity: 1,
      note: null,
    })
  })

  it('ignores the former collector fields (ADR 0017)', () => {
    const input = validateInventoryInput({
      catalog_card_id: 46986414,
      printing_id: 'NOPE-001',
      printingId: 'LOB-005',
      language: 'xx',
      condition: 'played',
      edition: 'first',
      quantity: 2,
    })
    expect(input).toEqual({ catalogCardId: 46986414, collectionId: null, quantity: 2, note: null })

    const patch = validateInventoryUpdateInput({ printing_id: 'LOB-005', language: 'de', condition: 'played', edition: 'first', quantity: 3 })
    expect(patch).toEqual({ quantity: 3 })
  })

  it('rejects invalid quantity and a missing card id', () => {
    expect(() => validateInventoryInput({ catalog_card_id: 46986414, quantity: 0 })).toThrow()
    expect(() => validateInventoryInput({ quantity: 1 })).toThrow()
  })

  it('gives the user-typed quantity errors a translatable code', () => {
    expect(() => validateInventoryInput({ catalog_card_id: 46986414, quantity: 0 }))
      .toThrow(expect.objectContaining({ statusCode: 400, data: expect.objectContaining({ code: 'quantity_invalid' }) }))
    expect(() => validateInventoryInput({ catalog_card_id: 46986414, quantity: 1000 }))
      .toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'quantity_too_large', params: { max: 999 } } }))
  })

  it('parses the list query, ignoring a catalogCardId that is not a positive integer', () => {
    expect(parseInventoryListQuery({ q: 'dark', page: '2', pageSize: '10', collectionId: '__none__', catalogCardId: '46986414' })).toEqual({
      q: 'dark',
      page: 2,
      pageSize: 10,
      collectionId: '__none__',
      catalogCardId: 46986414,
      inText: false,
      kind: [],
      type: [],
      attribute: [],
      race: [],
      level: [],
    })
    for (const catalogCardId of ['abc', '0', '-3', '1.5', '']) {
      expect(parseInventoryListQuery({ catalogCardId }).catalogCardId).toBeUndefined()
    }
    expect(parseInventoryListQuery({ collectionId: '' }).collectionId).toBeUndefined()
  })

  it('parses the list\'s card filters like the search (CSV or repeated, #145)', () => {
    expect(parseInventoryListQuery({ type: 'Normal Monster,Spell Card', level: '4,7', inText: '1' })).toMatchObject({
      type: ['Normal Monster', 'Spell Card'],
      level: [4, 7],
      inText: true,
    })
    expect(parseInventoryListQuery({ attribute: ['DARK', 'LIGHT'], race: 'Spellcaster', level: 'x' })).toMatchObject({
      attribute: ['DARK', 'LIGHT'],
      race: ['Spellcaster'],
      level: [],
      inText: false,
    })
  })

  it('reads `inText` like the catalog: `1` and `true` are on (#148)', () => {
    expect(parseInventoryListQuery({ inText: 'true' }).inText).toBe(true)
    expect(parseInventoryListQuery({ inText: '1' }).inText).toBe(true)
    expect(parseInventoryListQuery({ inText: '0' }).inText).toBe(false)
    expect(parseInventoryListQuery({ inText: 'false' }).inText).toBe(false)
  })
})

describe('inventory persistence helpers', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedCatalog(db)
  })

  it('adds and upserts owned cards by card and collection only (ADR 0017)', async () => {
    const first = await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      printing_id: 'LOB-005',
      quantity: 1,
      language: 'en',
    }))
    // A different printing and language used to be a separate row; now it merges.
    const updated = await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
      language: 'de',
      edition: 'first',
    }))

    const rows = db.select().from(schema.ownedCard).all()
    expect(rows).toHaveLength(1)
    expect(updated.id).toBe(first.id)
    expect(updated.quantity).toBe(3)
    expect(rows[0]).toMatchObject({ printingId: null, language: 'en', condition: 'near_mint', edition: 'unlimited' })
  })

  it('returns owned cards without the collector columns', async () => {
    const created = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, note: 'Binder' }))
    const patched = await updateOwnedCard(db, 'user-a', created.id, validateInventoryUpdateInput({ quantity: 4 }))

    for (const row of [created, patched]) {
      for (const key of COLLECTOR_KEYS) {
        expect(row).not.toHaveProperty(key)
      }
      expect(row).toMatchObject({ catalogCardId: 46986414, note: 'Binder' })
    }
    expect(patched.quantity).toBe(4)
  })

  it('rejects unknown catalog cards', async () => {
    await expect(addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 1,
    }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('lists only the current user inventory with catalog display data', async () => {
    await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
      note: 'Binder',
    }))
    await addOwnedCard(db, 'user-b', validateInventoryInput({
      catalog_card_id: 55144522,
      quantity: 1,
    }))

    const result = listOwnedCards(db, 'user-a')

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      cardName: 'Dark Magician',
      imageUrlSmall: 'https://images.example/dm-small.jpg',
      quantity: 2,
      note: 'Binder',
    })
    for (const key of [...COLLECTOR_KEYS, 'setName', 'rarity']) {
      expect(result.items[0]).not.toHaveProperty(key)
    }
    expect(result.items[0]).toMatchObject({ cardRetired: false })
    expect(result.items[0]).not.toHaveProperty('cardRetiredAt')
  })

  it('lists the attribute and the start of the card text for the "Liste" rows (#135)', async () => {
    const long = `${'Draw two cards. '.repeat(20)}End.`
    db.update(schema.catalogCard).set({ desc: long }).where(eq(schema.catalogCard.id, 55144522)).run()
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 1 }))
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 55144522, quantity: 1 }))

    const byCard = new Map(listOwnedCards(db, 'user-a').items.map(item => [item.catalogCardId, item]))

    expect(byCard.get(46986414)).toMatchObject({
      cardAttribute: 'DARK',
      cardTextExcerpt: 'The ultimate wizard.',
      cardTextExcerptDe: null,
    })
    // A spell has no attribute; a long text is cut to exactly the excerpt length.
    const pot = byCard.get(55144522)!
    expect(pot.cardAttribute).toBeNull()
    expect(long.length).toBeGreaterThan(CARD_TEXT_EXCERPT_LENGTH)
    expect(pot.cardTextExcerpt).toBe(long.slice(0, CARD_TEXT_EXCERPT_LENGTH))
  })

  it('keeps an owned retired card in the list, flagged (ADR 0019)', async () => {
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 1 }))
    db.update(schema.catalogCard).set({ retiredAt: new Date() }).where(eq(schema.catalogCard.id, 46986414)).run()

    const result = listOwnedCards(db, 'user-a', { q: 'Dark Magician' })

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({ catalogCardId: 46986414, cardRetired: true })
  })

  describe('list filters', () => {
    beforeEach(async () => {
      const now = new Date()
      db.insert(schema.collection).values({ id: 'col-1', userId: 'user-a', name: 'Box 1', createdAt: now, updatedAt: now }).run()
      // Dark Magician: one row in Box 1, one without a collection.
      await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, collection_id: 'col-1', quantity: 2 }))
      await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 1 }))
      // Pot of Greed: in Box 1 only.
      await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 55144522, collection_id: 'col-1', quantity: 1 }))
      // Another user's unassigned row never leaks in.
      await addOwnedCard(db, 'user-b', validateInventoryInput({ catalog_card_id: 55144522, quantity: 1 }))
    })

    function rows(result: ReturnType<typeof listOwnedCards>) {
      return result.items.map(item => `${item.cardName}/${item.collectionId ?? '-'}`).sort()
    }

    it('searches English and German names, wildcards literal (ADR 0015)', () => {
      seedGermanNames(db, { 46986414: 'Dunkler Magier', 55144522: 'Topf der Gier' })

      expect(rows(listOwnedCards(db, 'user-a', { q: 'dark' }))).toEqual(['Dark Magician/-', 'Dark Magician/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { q: 'TOPF' }))).toEqual(['Pot of Greed/col-1'])
      expect(listOwnedCards(db, 'user-a', { q: '%' }).total).toBe(0)
    })

    it('finds catalog cards for the picker by German name or passcode', () => {
      seedGermanNames(db, { 46986414: 'Dunkler Magier' })

      expect(searchCatalogCards(db, 'dunkler').map(card => card.name)).toEqual(['Dark Magician'])
      expect(searchCatalogCards(db, '5514452').map(card => card.name)).toEqual(['Pot of Greed'])
      expect(searchCatalogCards(db, '_')).toEqual([])
    })

    it('returns picker cards without printings (#75)', () => {
      const [card] = searchCatalogCards(db, 'Dark Magician')
      expect(Object.keys(card!).sort()).toEqual(['id', 'imageUrlSmall', 'name', 'nameDe', 'type'])
    })

    it('leaves retired cards out of the picker, but a retired passcode finds its replacement (ADR 0019, #110)', () => {
      db.insert(schema.catalogCard).values([
        {
          id: 101402024,
          name: 'Dark Magician',
          type: 'Normal Monster',
          desc: 'Placeholder.',
          syncedAt: new Date(),
          retiredAt: new Date(),
          replacedById: 46986414,
        },
        {
          id: 99999901,
          name: 'Gone Card',
          type: 'Spell Card',
          desc: 'Placeholder.',
          syncedAt: new Date(),
          retiredAt: new Date(),
        },
      ]).run()

      expect(searchCatalogCards(db, 'Dark Magician').map(card => card.id)).toEqual([46986414])
      expect(searchCatalogCards(db, '101402024').map(card => card.id)).toEqual([46986414])
      // Without a replacement, a retired passcode finds nothing.
      expect(searchCatalogCards(db, '99999901')).toEqual([])
      expect(searchCatalogCards(db, 'Gone Card')).toEqual([])
      expect(searchCatalogCards(db).map(card => card.id)).not.toContain(101402024)
    })

    it('sorts an exact passcode before cards whose passcode only contains it (#110)', () => {
      // Sorts before "Dark Magician" by name, and its id contains 46986414.
      db.insert(schema.catalogCard).values({
        id: 146986414,
        name: 'Axe Raider',
        type: 'Normal Monster',
        desc: 'Placeholder.',
        syncedAt: new Date(),
      }).run()

      expect(searchCatalogCards(db, '46986414').map(card => card.id)).toEqual([46986414, 146986414])
      expect(searchCatalogCards(db, '4698641').map(card => card.id)).toEqual([146986414, 46986414])
    })

    it('finds the card of an alternate-artwork passcode first (ADR 0023)', () => {
      // Sorts before "Dark Magician" by name, and its id contains the artwork id.
      db.insert(schema.catalogCard).values({
        id: 146986420,
        name: 'Axe Raider',
        type: 'Normal Monster',
        desc: 'Placeholder.',
        syncedAt: new Date(),
      }).run()
      db.insert(schema.catalogCardImage).values({ id: 46986420, cardId: 46986414, imageUrl: 'https://img/46986420.jpg' }).run()

      expect(searchCatalogCards(db, '46986420').map(card => card.id)).toEqual([46986414, 146986420])
    })

    it('filters rows by type, attribute, race and level (#145)', () => {
      db.update(schema.catalogCard).set({ race: 'Spellcaster', level: 7 }).where(eq(schema.catalogCard.id, 46986414)).run()
      db.update(schema.catalogCard).set({ race: 'Normal' }).where(eq(schema.catalogCard.id, 55144522)).run()

      expect(rows(listOwnedCards(db, 'user-a', { type: ['Spell Card'] }))).toEqual(['Pot of Greed/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { type: ['Normal Monster', 'Spell Card'] }))).toHaveLength(3)
      expect(rows(listOwnedCards(db, 'user-a', { attribute: ['DARK'] }))).toEqual(['Dark Magician/-', 'Dark Magician/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { race: ['Normal'] }))).toEqual(['Pot of Greed/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { level: [4, 7] }))).toEqual(['Dark Magician/-', 'Dark Magician/col-1'])
      expect(listOwnedCards(db, 'user-a', { level: [4] }).total).toBe(0)
      // The total counts the filtered rows too.
      expect(listOwnedCards(db, 'user-a', { attribute: ['DARK'] }).total).toBe(2)
    })

    it('searches the card text with inText (#145)', () => {
      expect(listOwnedCards(db, 'user-a', { q: 'wizard' }).total).toBe(0)
      expect(rows(listOwnedCards(db, 'user-a', { q: 'wizard', inText: true }))).toEqual(['Dark Magician/-', 'Dark Magician/col-1'])
    })

    it('combines the card filters with a collection (#145)', () => {
      expect(rows(listOwnedCards(db, 'user-a', { attribute: ['DARK'], collectionId: 'col-1' }))).toEqual(['Dark Magician/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { attribute: ['DARK'], collectionId: '__none__' }))).toEqual(['Dark Magician/-'])
      expect(listOwnedCards(db, 'user-a', { type: ['Spell Card'], collectionId: '__none__' }).total).toBe(0)
    })

    it('lists only unassigned rows for "__none__"', () => {
      const result = listOwnedCards(db, 'user-a', { collectionId: '__none__' })
      expect(result.total).toBe(1)
      expect(rows(result)).toEqual(['Dark Magician/-'])
    })

    it('filters rows by collection (row-level, unlike the aggregated search)', () => {
      expect(rows(listOwnedCards(db, 'user-a', { collectionId: 'col-1' }))).toEqual(['Dark Magician/col-1', 'Pot of Greed/col-1'])
    })

    it('filters rows by catalog card, alone and combined with a collection', () => {
      expect(rows(listOwnedCards(db, 'user-a', { catalogCardId: 46986414 }))).toEqual(['Dark Magician/-', 'Dark Magician/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { catalogCardId: 46986414, collectionId: 'col-1' }))).toEqual(['Dark Magician/col-1'])
      expect(rows(listOwnedCards(db, 'user-a', { catalogCardId: 46986414, collectionId: '__none__' }))).toEqual(['Dark Magician/-'])
      expect(listOwnedCards(db, 'user-a', { catalogCardId: 55144522, collectionId: '__none__' }).total).toBe(0)
    })
  })

  it('updates own rows, merges collisions, and rejects quantity below one', async () => {
    const now = new Date()
    db.insert(schema.collection).values({ id: 'col-1', userId: 'user-a', name: 'Box 1', createdAt: now, updatedAt: now }).run()
    const first = await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      collection_id: 'col-1',
      quantity: 1,
    }))
    const second = await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 2,
    }))

    await expect(updateOwnedCard(db, 'user-a', first.id, { quantity: 0 })).rejects.toMatchObject({ statusCode: 400 })

    // A language change is ignored now; moving the stack out of Box 1 collides and merges.
    const unchanged = await updateOwnedCard(db, 'user-a', first.id, validateInventoryUpdateInput({ language: 'de' }))
    expect(unchanged.id).toBe(first.id)

    const merged = await updateOwnedCard(db, 'user-a', first.id, validateInventoryUpdateInput({ collectionId: null }))
    expect(merged.id).toBe(second.id)
    expect(merged.quantity).toBe(3)
    expect(db.select().from(schema.ownedCard).where(eq(schema.ownedCard.userId, 'user-a')).all()).toHaveLength(1)
  })

  describe('joining notes when adding to an existing row (#146)', () => {
    async function addTwice(firstNote: string | null, secondNote: string | null) {
      const first = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 1, note: firstNote }))
      const second = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 2, note: secondNote }))
      expect(second.id).toBe(first.id)
      return second
    }

    it('keeps both notes, the existing one first', async () => {
      expect((await addTwice('A', 'B')).note).toBe('A\nB')
    })

    it('does not repeat an equal note', async () => {
      expect((await addTwice('Binder', ' Binder ')).note).toBe('Binder')
    })

    it('does not repeat a note that is already one line of the joined note', async () => {
      await addTwice('Binder', 'From the trade')
      const third = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 1, note: 'Binder' }))
      expect(third).toMatchObject({ note: 'Binder\nFrom the trade', quantity: 4 })
    })

    it('keeps the existing note when the new copies have none', async () => {
      expect((await addTwice('A', null)).note).toBe('A')
    })

    it('takes the new note when the row had none', async () => {
      expect((await addTwice(null, 'B')).note).toBe('B')
    })

    it('sums the quantity', async () => {
      expect((await addTwice('A', 'B')).quantity).toBe(3)
      expect(db.select().from(schema.ownedCard).all()).toHaveLength(1)
    })
  })

  describe('merging notes when a move collides (#135, like migration 0014)', () => {
    async function moveOnto(targetNote: string | null, movedNote: string | null) {
      const now = new Date()
      db.insert(schema.collection).values({ id: 'col-1', userId: 'user-a', name: 'Box 1', createdAt: now, updatedAt: now }).run()
      const target = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, quantity: 2, note: targetNote }))
      const moved = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: 46986414, collection_id: 'col-1', quantity: 1, note: movedNote }))
      const merged = await updateOwnedCard(db, 'user-a', moved.id, validateInventoryUpdateInput({ collectionId: null }))
      expect(merged.id).toBe(target.id)
      return merged.note
    }

    it('keeps both notes, the target\'s first', async () => {
      expect(await moveOnto('A', 'B')).toBe('A\nB')
    })

    it('does not repeat an equal note', async () => {
      expect(await moveOnto('Binder', ' Binder ')).toBe('Binder')
    })

    it('keeps the one note there is', async () => {
      expect(await moveOnto(null, 'B')).toBe('B')
      db.delete(schema.ownedCard).run()
      db.delete(schema.collection).run()
      expect(await moveOnto('A', null)).toBe('A')
    })

    it('joins distinct, trimmed, non-blank notes', () => {
      expect(joinNotes('A', '  ', null, undefined, 'B', 'A')).toBe('A\nB')
      expect(joinNotes(null, ' ')).toBeNull()
    })

    it('does not repeat a note that is already one line of a joined note', () => {
      expect(joinNotes('Binder\nFrom the trade', 'Binder')).toBe('Binder\nFrom the trade')
      expect(joinNotes('Binder\n From the trade ', ' From the trade')).toBe('Binder\n From the trade')
      expect(joinNotes('Binder\nFrom the trade', 'Binder\nFrom the trade')).toBe('Binder\nFrom the trade')
      // A line is not a substring match.
      expect(joinNotes('Binder 2', 'Binder')).toBe('Binder 2\nBinder')
    })

    it('does not repeat a joined note\'s line when a row moves onto it', async () => {
      expect(await moveOnto('Binder\nFrom the trade', 'Binder')).toBe('Binder\nFrom the trade')
    })
  })

  it('returns 404 when patching or deleting another user row', async () => {
    const owned = await addOwnedCard(db, 'user-a', validateInventoryInput({
      catalog_card_id: 46986414,
      quantity: 1,
    }))

    await expect(updateOwnedCard(db, 'user-b', owned.id, { quantity: 2 }))
      .rejects.toMatchObject({ statusCode: 404, data: { code: 'owned_card_not_found' } })
    await expect(deleteOwnedCard(db, 'user-b', owned.id))
      .rejects.toMatchObject({ statusCode: 404, data: { code: 'owned_card_not_found' } })

    await deleteOwnedCard(db, 'user-a', owned.id)
    expect(db.select().from(schema.ownedCard).all()).toHaveLength(0)
  })
})
