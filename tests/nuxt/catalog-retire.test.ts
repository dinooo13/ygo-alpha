import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  buildReplacementIndex,
  decodeCardNameEntities,
  pickReplacement,
  remapRuleSetCardIds,
  type ReplacementCandidate,
} from '../../server/utils/catalog-retire'
import { syncCatalog } from '../../server/utils/catalog-sync'
import { getCatalogCardDetail } from '../../server/utils/catalog-search'
import { suggestCatalogMatches } from '../../server/utils/card-entry'
import { parseEntryLine } from '../../server/utils/entry-line'
import type { RuleSet } from '../../shared/rule-formats'
import type { TournamentDeckSnapshot } from '../../shared/tournaments'
import type { YgoproCard } from '../../server/utils/ygoprodeck'
import {
  darkMagicianFixture,
  darkMagicianRenumberedFixture,
  droppedFixture,
  entityNameFixture,
  entityNameStaleFixture,
  oddEyesFixture,
  oddEyesStaleFixture,
  placeholderFixture,
  placeholderRealFixture,
} from './fixtures/ygoprodeck-cards'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function sync(db: TestDb, cards: YgoproCard[], retireGuard?: { minimum: number, ratio: number }) {
  return syncCatalog(db, { fetchAllCards: async () => cards, retireGuard })
}

function cardState(db: TestDb, id: number) {
  return db
    .select({ retiredAt: schema.catalogCard.retiredAt, replacedById: schema.catalogCard.replacedById })
    .from(schema.catalogCard)
    .where(eq(schema.catalogCard.id, id))
    .get()
}

function card(id: number, name: string, type: string, konamiId: number | null = null): ReplacementCandidate {
  return { id, name, type, konamiId }
}

describe('decodeCardNameEntities', () => {
  it('decodes the entities YGOPRODeck used in old names, in one pass', () => {
    expect(decodeCardNameEntities('Graceful &amp; Skull Dice')).toBe('Graceful & Skull Dice')
    expect(decodeCardNameEntities('&quot;A&quot; &#039;B&#39; &lt;C&gt;')).toBe('"A" \'B\' <C>')
    expect(decodeCardNameEntities('&amp;quot;')).toBe('&quot;')
    expect(decodeCardNameEntities('Plain Name')).toBe('Plain Name')
  })
})

describe('pickReplacement', () => {
  it('matches the only active row with the same Konami id, whatever its name', () => {
    const real = card(2, 'Renamed Card', 'Effect Monster', 99)
    const index = buildReplacementIndex([real, card(3, 'Old Name', 'Effect Monster')])
    expect(pickReplacement(card(1, 'Old Name', 'Effect Monster', 99), index)).toBe(real)
  })

  it('picks the same-named row when several active rows share the Konami id', () => {
    const same = card(2, 'Card', 'Effect Monster', 99)
    const index = buildReplacementIndex([same, card(3, 'Other', 'Effect Monster', 99)])
    expect(pickReplacement(card(1, 'Card', 'Effect Monster', 99), index)).toBe(same)
  })

  it('matches on the decoded name and the type', () => {
    const real = card(76630812, 'Graceful & Skull Dice', 'Spell Card')
    const index = buildReplacementIndex([real])
    expect(pickReplacement(card(101402053, 'Graceful &amp; Skull Dice', 'Spell Card'), index)).toBe(real)
  })

  it('needs the same type', () => {
    const index = buildReplacementIndex([card(2, 'Card', 'Spell Card')])
    expect(pickReplacement(card(1, 'Card', 'Trap Card'), index)).toBeNull()
  })

  it('gives up when the name is ambiguous', () => {
    const index = buildReplacementIndex([card(2, 'Card', 'Spell Card'), card(3, 'Card', 'Spell Card')])
    expect(pickReplacement(card(1, 'Card', 'Spell Card'), index)).toBeNull()
  })

  it('gives up when nothing matches', () => {
    const index = buildReplacementIndex([card(2, 'Levia-Dragon of Atlantis - Daedalus', 'Effect Monster')])
    expect(pickReplacement(card(1, 'Leviathan of Atlantis - Daedalus', 'Effect Monster'), index)).toBeNull()
  })
})

describe('remapRuleSetCardIds', () => {
  const ruleSet: RuleSet = {
    rules: [
      { kind: 'copies', maxCopies: 3 },
      { kind: 'card_status', status: 'forbidden', cardIds: [1, 5, 2] },
      { kind: 'filter', match: 'matching', filter: { cardIds: [7, 1] }, maxCopies: 1 },
    ],
  }

  it('replaces ids, de-duplicated and in order, without mutating the input', () => {
    const before = structuredClone(ruleSet)
    const result = remapRuleSetCardIds(ruleSet, new Map([[1, 2], [7, 8]]))

    expect(result.changed).toBe(true)
    expect(result.ruleSet.rules).toEqual([
      { kind: 'copies', maxCopies: 3 },
      { kind: 'card_status', status: 'forbidden', cardIds: [2, 5] },
      { kind: 'filter', match: 'matching', filter: { cardIds: [8, 2] }, maxCopies: 1 },
    ])
    expect(ruleSet).toEqual(before)
  })

  it('reports no change when no id is retired', () => {
    const result = remapRuleSetCardIds(ruleSet, new Map([[100, 200]]))
    expect(result).toEqual({ ruleSet, changed: false })
  })
})

describe('applyCatalogRetirement (through syncCatalog)', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
  })

  it('retires dropped cards and finds replacements by Konami id and by name', async () => {
    await sync(db, [darkMagicianFixture, oddEyesStaleFixture, placeholderFixture, entityNameStaleFixture, droppedFixture])
    const result = await sync(db, [darkMagicianFixture, oddEyesFixture, placeholderRealFixture, entityNameFixture])

    expect(result.retirement).toMatchObject({
      retired: 4,
      restored: 0,
      withReplacement: 3,
      withoutReplacement: 1,
      skipped: false,
    })
    expect(cardState(db, placeholderFixture.id)).toMatchObject({ replacedById: placeholderRealFixture.id })
    expect(cardState(db, oddEyesStaleFixture.id)).toMatchObject({ replacedById: oddEyesFixture.id })
    expect(cardState(db, entityNameStaleFixture.id)).toMatchObject({ replacedById: entityNameFixture.id })
    const dropped = cardState(db, droppedFixture.id)!
    expect(dropped.retiredAt).toBeInstanceOf(Date)
    expect(dropped.replacedById).toBeNull()
    expect(cardState(db, darkMagicianFixture.id)).toEqual({ retiredAt: null, replacedById: null })
  })

  it('follows a replacement chain A → B → C', async () => {
    const a = { ...droppedFixture, id: 1, name: 'Old Name', misc_info: [{ konami_id: 500 }] }
    const b = { ...droppedFixture, id: 2, name: 'Middle Name', misc_info: [{ konami_id: 500 }] }
    const c = { ...droppedFixture, id: 3, name: 'Middle Name', misc_info: [{ konami_id: 501 }] }

    await sync(db, [darkMagicianFixture, a])
    await sync(db, [darkMagicianFixture, b])
    expect(cardState(db, 1)).toMatchObject({ replacedById: 2 })

    await sync(db, [darkMagicianFixture, c])
    expect(cardState(db, 1)).toMatchObject({ replacedById: 3 })
    expect(cardState(db, 2)).toMatchObject({ replacedById: 3 })
  })

  it('skips retirement when too many cards are missing', async () => {
    await sync(db, [darkMagicianFixture, droppedFixture, oddEyesStaleFixture])
    const result = await sync(db, [darkMagicianFixture], { minimum: 1, ratio: 0 })

    expect(result.retirement).toMatchObject({ retired: 0, skipped: true })
    expect(cardState(db, droppedFixture.id)).toEqual({ retiredAt: null, replacedById: null })
    expect(cardState(db, oddEyesStaleFixture.id)).toEqual({ retiredAt: null, replacedById: null })
  })

  it('un-retires a card that comes back', async () => {
    await sync(db, [darkMagicianFixture, oddEyesStaleFixture])
    await sync(db, [darkMagicianFixture, oddEyesFixture])
    expect(cardState(db, oddEyesStaleFixture.id)).toMatchObject({ replacedById: oddEyesFixture.id })

    const result = await sync(db, [darkMagicianFixture, oddEyesStaleFixture, oddEyesFixture])
    expect(result.retirement).toMatchObject({ retired: 0, restored: 1 })
    expect(cardState(db, oddEyesStaleFixture.id)).toEqual({ retiredAt: null, replacedById: null })
  })

  describe('remapping references', () => {
    const OLD = placeholderFixture.id
    const NEW = placeholderRealFixture.id
    const earlier = new Date('2026-01-01T00:00:00Z')
    const later = new Date('2026-02-01T00:00:00Z')

    beforeEach(async () => {
      await sync(db, [darkMagicianFixture, placeholderFixture, placeholderRealFixture])

      db.insert(schema.user).values([
        { id: 'user-a', name: 'A', email: 'a@example.com', emailVerified: false, createdAt: earlier, updatedAt: earlier },
        { id: 'user-b', name: 'B', email: 'b@example.com', emailVerified: false, createdAt: earlier, updatedAt: earlier },
      ]).run()
      db.insert(schema.collection).values([
        { id: 'box-1', userId: 'user-a', name: 'Box 1', createdAt: earlier, updatedAt: earlier },
      ]).run()
      db.insert(schema.catalogSet).values({ id: 'set', name: 'Set' }).run()
      db.insert(schema.catalogPrinting).values({ id: 'SET-001', cardId: OLD, setId: 'set', setCode: 'SET-001' }).run()

      db.insert(schema.ownedCard).values([
        // Same (user, card, collection) as a row of the replacement: merged.
        { id: 'own-old', userId: 'user-a', catalogCardId: OLD, quantity: 2, note: 'old note', createdAt: earlier, updatedAt: later },
        { id: 'own-new', userId: 'user-a', catalogCardId: NEW, quantity: 1, note: ' new note ', createdAt: earlier, updatedAt: earlier },
        // Another collection: moved, not merged.
        { id: 'own-box', userId: 'user-a', catalogCardId: OLD, collectionId: 'box-1', printingId: 'SET-001', quantity: 3, createdAt: earlier, updatedAt: earlier },
        // Another user: moved.
        { id: 'own-b', userId: 'user-b', catalogCardId: OLD, quantity: 1, createdAt: earlier, updatedAt: earlier },
      ]).run()

      db.insert(schema.deck).values([
        { id: 'deck-1', userId: 'user-a', name: 'Deck', coverCardId: OLD, createdAt: earlier, updatedAt: earlier },
      ]).run()
      db.insert(schema.deckCard).values([
        { id: 'dc-old-main', deckId: 'deck-1', catalogCardId: OLD, section: 'main', quantity: 60, createdAt: earlier, updatedAt: earlier },
        { id: 'dc-new-main', deckId: 'deck-1', catalogCardId: NEW, section: 'main', quantity: 50, createdAt: earlier, updatedAt: earlier },
        { id: 'dc-old-side', deckId: 'deck-1', catalogCardId: OLD, section: 'side', quantity: 1, createdAt: earlier, updatedAt: earlier },
      ]).run()

      db.insert(schema.wishlistItem).values([
        { id: 'wish-old', userId: 'user-a', catalogCardId: OLD, quantity: 3, note: 'old wish', createdAt: earlier, updatedAt: earlier },
        { id: 'wish-new', userId: 'user-a', catalogCardId: NEW, quantity: 1, createdAt: earlier, updatedAt: earlier },
        { id: 'wish-b', userId: 'user-b', catalogCardId: OLD, quantity: 2, createdAt: earlier, updatedAt: earlier },
      ]).run()

      db.insert(schema.ruleFormat).values([
        {
          id: 'custom',
          userId: 'user-a',
          name: 'Custom',
          rules: {
            rules: [
              { kind: 'card_status', status: 'limited', cardIds: [OLD, NEW] },
              { kind: 'filter', match: 'matching', filter: { cardIds: [OLD] }, maxCopies: 1 },
            ],
          },
          createdAt: earlier,
          updatedAt: earlier,
        },
        {
          id: 'builtin-test',
          name: 'Built-in',
          isBuiltin: true,
          rules: { rules: [{ kind: 'card_status', status: 'forbidden', cardIds: [OLD] }] },
          createdAt: earlier,
          updatedAt: earlier,
        },
      ]).run()

      db.insert(schema.tournament).values({
        id: 't-1', organizerUserId: 'user-a', name: 'Cup', createdAt: earlier, updatedAt: earlier,
      }).run()
      db.insert(schema.tournamentParticipant).values({
        id: 'p-1',
        tournamentId: 't-1',
        userId: 'user-a',
        name: 'A',
        seed: 1,
        deckSnapshot: {
          deckId: 'deck-1',
          name: 'Deck',
          sections: { main: [{ catalogCardId: OLD, name: 'Adamancipator Conductor', quantity: 1 }], extra: [], side: [] },
          counts: { main: 1, extra: 0, side: 0, total: 1 },
          validation: null,
        } as unknown as TournamentDeckSnapshot,
        createdAt: earlier,
        updatedAt: earlier,
      }).run()
    })

    it('moves or merges every reference to the replacement', async () => {
      const result = await sync(db, [darkMagicianFixture, placeholderRealFixture])

      expect(result.retirement.remapped).toEqual({
        ownedCards: 3,
        deckCards: 2,
        deckCovers: 1,
        wishlistItems: 2,
        ruleFormats: 1,
      })

      const owned = db.select().from(schema.ownedCard).all().sort((a, b) => a.id.localeCompare(b.id))
      expect(owned.map(row => row.id)).toEqual(['own-b', 'own-box', 'own-new'])
      expect(owned.every(row => row.catalogCardId === NEW)).toBe(true)
      const merged = owned.find(row => row.id === 'own-new')!
      expect(merged).toMatchObject({ quantity: 3, note: 'new note\nold note' })
      expect(merged.updatedAt).toEqual(later)
      const moved = owned.find(row => row.id === 'own-box')!
      expect(moved).toMatchObject({ collectionId: 'box-1', quantity: 3, printingId: null })
      expect(moved.updatedAt).toEqual(earlier)

      const deckCards = db.select().from(schema.deckCard).all().sort((a, b) => a.id.localeCompare(b.id))
      expect(deckCards.map(row => [row.id, row.catalogCardId, row.section, row.quantity])).toEqual([
        ['dc-new-main', NEW, 'main', 99],
        ['dc-old-side', NEW, 'side', 1],
      ])
      expect(deckCards.every(row => row.updatedAt.getTime() === earlier.getTime())).toBe(true)

      const deckRow = db.select().from(schema.deck).where(eq(schema.deck.id, 'deck-1')).get()!
      expect(deckRow.coverCardId).toBe(NEW)
      expect(deckRow.updatedAt).toEqual(earlier)

      const wishes = db.select().from(schema.wishlistItem).all().sort((a, b) => a.id.localeCompare(b.id))
      expect(wishes.map(row => [row.id, row.catalogCardId, row.quantity, row.note])).toEqual([
        ['wish-b', NEW, 2, null],
        ['wish-new', NEW, 3, 'old wish'],
      ])

      const formats = new Map(db.select().from(schema.ruleFormat).all().map(row => [row.id, row]))
      expect(formats.get('custom')!.rules.rules).toEqual([
        { kind: 'card_status', status: 'limited', cardIds: [NEW] },
        { kind: 'filter', match: 'matching', filter: { cardIds: [NEW] }, maxCopies: 1 },
      ])
      expect(formats.get('custom')!.updatedAt).toEqual(earlier)
      expect(formats.get('builtin-test')!.rules.rules).toEqual([
        { kind: 'card_status', status: 'forbidden', cardIds: [OLD] },
      ])

      const participant = db.select().from(schema.tournamentParticipant).get()!
      expect(participant.deckSnapshot!.sections.main[0]!.catalogCardId).toBe(OLD)
    })

    it('is idempotent: a second sync with the same data changes nothing', async () => {
      await sync(db, [darkMagicianFixture, placeholderRealFixture])
      const snapshot = () => ({
        cards: db.select().from(schema.catalogCard).all().map(row => ({ ...row, syncedAt: null })),
        owned: db.select().from(schema.ownedCard).all(),
        deckCards: db.select().from(schema.deckCard).all(),
        decks: db.select().from(schema.deck).all(),
        wishes: db.select().from(schema.wishlistItem).all(),
        formats: db.select().from(schema.ruleFormat).all(),
      })
      const before = snapshot()

      const second = await sync(db, [darkMagicianFixture, placeholderRealFixture])

      expect(second.retirement).toEqual({
        retired: 0,
        restored: 0,
        withReplacement: 1,
        withoutReplacement: 0,
        remapped: { ownedCards: 0, deckCards: 0, deckCovers: 0, wishlistItems: 0, ruleFormats: 0 },
        skipped: false,
      })
      const after = snapshot()
      // `retired_at` is the time of the first sync that found the card missing.
      expect(after).toEqual(before)
    })
  })
})

describe('#113: Dark Magician renumbered 46986414 → 46986420', () => {
  const OLD = darkMagicianFixture.id
  const NEW = darkMagicianRenumberedFixture.id
  const at = new Date('2026-01-01T00:00:00Z')

  it('retires the old passcode, moves every reference and keeps it resolvable', async () => {
    const db = createTestDb()
    await sync(db, [darkMagicianFixture])

    db.insert(schema.user).values({ id: 'user-a', name: 'A', email: 'a@example.com', emailVerified: false, createdAt: at, updatedAt: at }).run()
    db.insert(schema.ownedCard).values({ id: 'own', userId: 'user-a', catalogCardId: OLD, quantity: 2, createdAt: at, updatedAt: at }).run()
    db.insert(schema.deck).values({ id: 'deck-1', userId: 'user-a', name: 'Deck', coverCardId: OLD, createdAt: at, updatedAt: at }).run()
    db.insert(schema.deckCard).values({ id: 'dc', deckId: 'deck-1', catalogCardId: OLD, section: 'main', quantity: 3, createdAt: at, updatedAt: at }).run()
    db.insert(schema.wishlistItem).values({ id: 'wish', userId: 'user-a', catalogCardId: OLD, quantity: 1, createdAt: at, updatedAt: at }).run()

    const result = await sync(db, [darkMagicianRenumberedFixture])

    // The Konami id rule finds the replacement.
    expect(result.retirement).toMatchObject({ retired: 1, withReplacement: 1, withoutReplacement: 0, skipped: false })
    expect(result.retirement.remapped).toEqual({ ownedCards: 1, deckCards: 1, deckCovers: 1, wishlistItems: 1, ruleFormats: 0 })
    expect(cardState(db, OLD)).toMatchObject({ retiredAt: expect.any(Date), replacedById: NEW })
    expect(cardState(db, NEW)).toEqual({ retiredAt: null, replacedById: null })

    expect(db.select().from(schema.ownedCard).get()!.catalogCardId).toBe(NEW)
    expect(db.select().from(schema.deckCard).get()!.catalogCardId).toBe(NEW)
    expect(db.select().from(schema.deck).get()!.coverCardId).toBe(NEW)
    expect(db.select().from(schema.wishlistItem).get()!.catalogCardId).toBe(NEW)

    // The old passcode is now an artwork of the new card; the printings follow.
    const images = db.select().from(schema.catalogCardImage).all()
    expect(images.map(row => [row.id, row.cardId]).sort()).toEqual([[OLD, NEW], [NEW, NEW]])
    const printings = db.select().from(schema.catalogPrinting).all()
    expect(printings.map(row => [row.id, row.cardId]).sort()).toEqual([['LOB-005', NEW], ['SDY-006', NEW]])
    expect(result.cleanup).toEqual({ printings: 0, images: 0, skipped: false })

    // A card row wins over the artwork with the same id: the retired row.
    const detail = await getCatalogCardDetail(db, OLD)
    expect(detail!.card).toMatchObject({ id: OLD, retired: true, replacedById: NEW })

    // Quick entry takes the printed passcode to the current card.
    expect(suggestCatalogMatches(db, parseEntryLine(String(OLD)))[0]).toMatchObject({ cardId: NEW, matchedBy: 'passcode' })
  })
})

describe('pruneUnlistedCatalogRows (through syncCatalog, ADR 0023)', () => {
  const at = new Date('2026-01-01T00:00:00Z')
  const darkMagicianLobOnly: YgoproCard = {
    ...darkMagicianFixture,
    card_sets: darkMagicianFixture.card_sets!.filter(set => set.set_code === 'LOB-005'),
  }
  const oddEyesWithOldArtwork: YgoproCard = {
    ...oddEyesFixture,
    card_images: [
      { id: oddEyesStaleFixture.id, image_url: 'https://images.ygoprodeck.com/images/cards/16178681.jpg' },
      ...oddEyesFixture.card_images!,
    ],
  }

  function catalogRows(db: TestDb) {
    return {
      printings: db.select().from(schema.catalogPrinting).all().map(row => row.id).sort(),
      images: db.select().from(schema.catalogCardImage).all().map(row => [row.id, row.cardId]).sort(),
    }
  }

  async function seedFirstSync(db: TestDb) {
    await sync(db, [darkMagicianFixture, oddEyesStaleFixture, placeholderFixture, droppedFixture])
    db.insert(schema.user).values({ id: 'user-a', name: 'A', email: 'a@example.com', emailVerified: false, createdAt: at, updatedAt: at }).run()
    // The legacy printing column (hidden since ADR 0017).
    db.insert(schema.ownedCard).values({
      id: 'own', userId: 'user-a', catalogCardId: darkMagicianFixture.id, printingId: 'SDY-006', quantity: 1, createdAt: at, updatedAt: at,
    }).run()
  }

  it('deletes the printings and images the response no longer lists', async () => {
    const db = createTestDb()
    await seedFirstSync(db)

    const result = await sync(db, [darkMagicianLobOnly, oddEyesWithOldArtwork, placeholderRealFixture])

    // SDY-006 and the placeholder's image 101402024.
    expect(result.cleanup).toEqual({ printings: 1, images: 1, skipped: false })
    expect(catalogRows(db)).toEqual({
      printings: ['LOB-005'],
      images: [
        [darkMagicianFixture.id, darkMagicianFixture.id],
        // A retired card without a replacement keeps its only picture.
        [droppedFixture.id, droppedFixture.id],
        // The old passcode, now an artwork of the new card.
        [oddEyesStaleFixture.id, oddEyesFixture.id],
        [oddEyesFixture.id, oddEyesFixture.id],
        [placeholderRealFixture.id, placeholderRealFixture.id],
      ].sort(),
    })
    // The owned row stays; only the legacy printing reference is cleared.
    expect(db.select().from(schema.ownedCard).get()).toMatchObject({ id: 'own', quantity: 1, printingId: null })

    // Idempotent.
    const again = await sync(db, [darkMagicianLobOnly, oddEyesWithOldArtwork, placeholderRealFixture])
    expect(again.cleanup).toEqual({ printings: 0, images: 0, skipped: false })
  })

  it('prunes nothing when the guard skips the retirement', async () => {
    const db = createTestDb()
    await seedFirstSync(db)
    const before = catalogRows(db)

    const result = await sync(db, [darkMagicianLobOnly], { minimum: 1, ratio: 0 })

    expect(result.retirement.skipped).toBe(true)
    expect(result.cleanup).toEqual({ printings: 0, images: 0, skipped: true })
    expect(catalogRows(db)).toEqual(before)
    expect(db.select().from(schema.ownedCard).get()!.printingId).toBe('SDY-006')
  })
})
