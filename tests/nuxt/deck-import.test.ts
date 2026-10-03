import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import { CATALOG_FIXTURE_IDS, seedCatalogFixture } from '../../server/db/fixtures/catalog-fixture'
import * as schema from '../../server/db/schema'
import { parseImportRequest, previewDeckImport } from '../../server/utils/deck-import'
import { seedBuiltinFormats } from '../../server/utils/rule-formats'
import { createDeck, getDeckDetail, validateDeckCreateCardsInput, validateDeckCreateInput } from '../../server/utils/decks'
import { encodeOmegaCode, encodeYdke } from '../../shared/decklist'
import {
  buildImportCards,
  createImportRows,
  importCounts,
  importCoverCardId,
  importSizeWarnings,
  rowSection,
  rowsInSection,
} from '../../app/utils/deck-import'
import type { DeckImportPreview, DeckImportRow } from '../../app/utils/deck-import'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function statusOf(run: () => unknown): number | undefined {
  try {
    run()
  }
  catch (error) {
    return (error as { statusCode?: number }).statusCode
  }
  return undefined
}

describe('previewDeckImport', () => {
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    seedBuiltinFormats(db)
    const now = new Date()
    db.insert(schema.user).values({ id: 'user-a', name: 'User A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now }).run()
  })

  it('matches a recipe with headers by section, and a header is never a row', () => {
    const preview = previewDeckImport(db, 'Monster\n3 Dark Magician\n1 Kuriboh\nSpell\n2 Raigeki\nExtra\n1 Stardust Dragon\nSide\n2 Monster Reborn')

    expect(preview.format).toBe('text')
    const cardIds = (section: 'main' | 'extra' | 'side') => preview.sections[section].map(result => [result.input.quantity, result.candidates[0]!.cardId])
    expect(cardIds('main')).toEqual([
      [3, CATALOG_FIXTURE_IDS.darkMagician],
      [1, CATALOG_FIXTURE_IDS.kuriboh],
      [2, CATALOG_FIXTURE_IDS.raigeki],
    ])
    expect(cardIds('extra')).toEqual([[1, CATALOG_FIXTURE_IDS.stardustDragon]])
    expect(cardIds('side')).toEqual([[2, CATALOG_FIXTURE_IDS.monsterReborn]])
  })

  it('reads the German headers of Omega\'s recipe, "Falle" included', () => {
    const preview = previewDeckImport(db, 'Monster\n3 Dark Magician\nZauber\n2 Raigeki\nFalle\n1 Mirror Force\nExtra-Deck\n1 Stardust Dragon\nSide-Deck\n2 Monster Reborn')

    const cardIds = (section: 'main' | 'extra' | 'side') => preview.sections[section].map(result => result.candidates[0]!.cardId)
    expect(cardIds('main')).toEqual([CATALOG_FIXTURE_IDS.darkMagician, CATALOG_FIXTURE_IDS.raigeki, CATALOG_FIXTURE_IDS.mirrorForce])
    expect(cardIds('extra')).toEqual([CATALOG_FIXTURE_IDS.stardustDragon])
    expect(cardIds('side')).toEqual([CATALOG_FIXTURE_IDS.monsterReborn])
  })

  it('matches a YDK and a ydke link by passcode; an unknown passcode is a row without candidates', () => {
    const ydk = previewDeckImport(db, `#created by x\n#main\n${CATALOG_FIXTURE_IDS.darkMagician}\n${CATALOG_FIXTURE_IDS.darkMagician}\n99999999\n#extra\n${CATALOG_FIXTURE_IDS.stardustDragon}\n!side\n`)

    expect(ydk.format).toBe('ydk')
    expect(ydk.sections.main.map(result => [result.input.quantity, result.candidates[0]?.cardId ?? null])).toEqual([
      [2, CATALOG_FIXTURE_IDS.darkMagician],
      [1, null],
    ])
    expect(ydk.sections.extra[0]!.candidates[0]).toMatchObject({ cardId: CATALOG_FIXTURE_IDS.stardustDragon, matchedBy: 'passcode' })
    expect(ydk.sections.side).toEqual([])

    const link = previewDeckImport(db, encodeYdke({
      main: [CATALOG_FIXTURE_IDS.kuriboh, CATALOG_FIXTURE_IDS.kuriboh],
      extra: [CATALOG_FIXTURE_IDS.stardustDragon],
      side: [CATALOG_FIXTURE_IDS.raigeki],
    }))
    expect(link.format).toBe('ydke')
    expect(link.sections.main[0]).toMatchObject({ input: { quantity: 2 } })
    expect(link.sections.side[0]!.candidates[0]!.cardId).toBe(CATALOG_FIXTURE_IDS.raigeki)
  })

  it('rejects an empty list, too many entries and a broken link', () => {
    expect(statusOf(() => previewDeckImport(db, 'Monster\nSpell\n#main'))).toBe(400)
    expect(statusOf(() => previewDeckImport(db, 'ydke://nope'))).toBe(400)
    const many = Array.from({ length: 101 }, (_, index) => String(10_000_000 + index)).join('\n')
    expect(statusOf(() => previewDeckImport(db, many))).toBe(400)
  })

  it('checks the request body', () => {
    expect(parseImportRequest({ text: 'Kuriboh' })).toBe('Kuriboh')
    expect(statusOf(() => parseImportRequest({}))).toBe(400)
    expect(statusOf(() => parseImportRequest(null))).toBe(400)
    expect(statusOf(() => parseImportRequest({ text: 'a'.repeat(20_001) }))).toBe(400)
  })

  it('feeds POST /api/decks: the reviewed rows create the deck, Extra Deck cards in Main move to Extra', () => {
    // An Omega code or a list without an Extra header has Stardust Dragon in `main`.
    const preview = previewDeckImport(db, '3 Dark Magician\n1 Stardust Dragon\nSide\n1 Raigeki')
    const rows = createImportRows(preview as DeckImportPreview)
    const cards = buildImportCards(rows)

    expect(cards).toEqual([
      { catalog_card_id: CATALOG_FIXTURE_IDS.darkMagician, section: 'main', quantity: 3 },
      { catalog_card_id: CATALOG_FIXTURE_IDS.stardustDragon, section: 'extra', quantity: 1 },
      { catalog_card_id: CATALOG_FIXTURE_IDS.raigeki, section: 'side', quantity: 1 },
    ])

    const body = { name: 'Importiert', format_id: 'tcg-advanced', cards }
    const deck = createDeck(db, 'user-a', validateDeckCreateInput(body), validateDeckCreateCardsInput(body))
    expect(getDeckDetail(db, 'user-a', deck.id).counts).toMatchObject({ main: 3, extra: 1, side: 1 })
  })

  it('makes an Omega code\'s cover card the new deck\'s chosen cover', async () => {
    const code = await encodeOmegaCode({
      main: [CATALOG_FIXTURE_IDS.darkMagician, CATALOG_FIXTURE_IDS.darkMagician, CATALOG_FIXTURE_IDS.kuriboh],
      extra: [CATALOG_FIXTURE_IDS.stardustDragon],
      side: [CATALOG_FIXTURE_IDS.raigeki],
    }, CATALOG_FIXTURE_IDS.stardustDragon)
    const preview = previewDeckImport(db, code)

    expect(preview.format).toBe('omega')
    expect(preview.cover).toBe(CATALOG_FIXTURE_IDS.stardustDragon)

    const rows = createImportRows(preview as DeckImportPreview)
    const body = { name: 'Mit Cover', cards: buildImportCards(rows), cover_card_id: importCoverCardId(rows, preview.cover) }
    const deck = createDeck(db, 'user-a', validateDeckCreateInput(body), validateDeckCreateCardsInput(body))
    const detail = getDeckDetail(db, 'user-a', deck.id)

    expect(detail.cover?.catalogCardId).toBe(CATALOG_FIXTURE_IDS.stardustDragon)
    expect(detail.coverIsChosen).toBe(true)
  })

  it('rejects a cover that is no Main or Extra Deck card, without creating the deck', () => {
    const before = db.select().from(schema.deck).all().length
    const body = {
      name: 'Falsches Cover',
      cards: [
        { catalog_card_id: CATALOG_FIXTURE_IDS.darkMagician, section: 'main', quantity: 1 },
        { catalog_card_id: CATALOG_FIXTURE_IDS.raigeki, section: 'side', quantity: 1 },
      ],
      cover_card_id: CATALOG_FIXTURE_IDS.raigeki,
    }

    expect(statusOf(() => createDeck(db, 'user-a', validateDeckCreateInput(body), validateDeckCreateCardsInput(body)))).toBe(400)
    expect(db.select().from(schema.deck).all()).toHaveLength(before)
    expect(statusOf(() => validateDeckCreateInput({ name: 'x', cover_card_id: -1 }))).toBe(400)
  })
})

describe('deck import rows', () => {
  const candidate = (cardId: number, type: string, frameType: string | null = null) => ({
    cardId, name: `Card ${cardId}`, nameDe: null, type, frameType, imageSmall: null, score: 1, matchedBy: 'exact' as const,
  })

  function preview(): DeckImportPreview {
    return {
      format: 'omega',
      sections: {
        main: [
          { input: { raw: '3 A', quantity: 3, query: 'A' }, candidates: [candidate(1, 'Effect Monster')] },
          { input: { raw: '1 B', quantity: 1, query: 'B' }, candidates: [candidate(2, 'Synchro Monster')] },
          { input: { raw: '1 C', quantity: 1, query: 'C' }, candidates: [] },
        ],
        extra: [
          // Pointed at a Main Deck card in the list: the card decides.
          { input: { raw: '1 D', quantity: 1, query: 'D' }, candidates: [candidate(3, 'Spell Card')] },
        ],
        side: [
          { input: { raw: '2 E', quantity: 2, query: 'E' }, candidates: [candidate(4, 'Link Monster')] },
        ],
      },
      cover: null,
    }
  }

  it('puts each resolved card into the section its type allows; Side stays Side', () => {
    const rows = createImportRows(preview())

    expect(rows.map(row => rowSection(row))).toEqual(['main', 'extra', 'main', 'main', 'side'])
    expect(rowsInSection(rows, 'extra').map(row => row.query)).toEqual(['B'])
    expect(rowsInSection(rows, 'main').map(row => row.query)).toEqual(['A', 'C', 'D'])
  })

  it('counts copies of the resolved rows only, and warns about the usual deck sizes', () => {
    const rows = createImportRows(preview())

    expect(importCounts(rows)).toEqual({ main: 4, extra: 1, side: 2 })
    expect(importSizeWarnings({ main: 40, extra: 15, side: 15 })).toEqual([])
    expect(importSizeWarnings({ main: 39, extra: 16, side: 16 }).map(warning => warning.code)).toEqual(['main_below_min', 'extra_above_max', 'side_above_max'])
    expect(importSizeWarnings({ main: 61, extra: 0, side: 0 }).map(warning => warning.code)).toEqual(['main_above_max'])
  })

  it('builds the create payload from resolved rows, merging a card pointed at twice', () => {
    const rows: DeckImportRow[] = createImportRows(preview())
    rows[2] = { ...rows[2]!, selectedCardId: 1, candidates: [candidate(1, 'Effect Monster')], quantity: 2 }

    expect(buildImportCards(rows)).toEqual([
      { catalog_card_id: 1, section: 'main', quantity: 5 },
      { catalog_card_id: 2, section: 'extra', quantity: 1 },
      { catalog_card_id: 3, section: 'main', quantity: 1 },
      { catalog_card_id: 4, section: 'side', quantity: 2 },
    ])
  })

  it('takes the cover from the resolved row read from its passcode, never a Side Deck row', () => {
    const rows = createImportRows({
      format: 'omega',
      sections: {
        main: [
          { input: { raw: '1', quantity: 2, query: '00000001' }, candidates: [candidate(1, 'Effect Monster')] },
          { input: { raw: '2', quantity: 1, query: '00000002' }, candidates: [candidate(2, 'Synchro Monster')] },
          { input: { raw: '5', quantity: 1, query: '00000005' }, candidates: [] },
        ],
        extra: [],
        side: [{ input: { raw: '4', quantity: 1, query: '00000004' }, candidates: [candidate(4, 'Spell Card')] }],
      },
      cover: 2,
    })

    expect(importCoverCardId(rows, 2)).toBe(2)
    expect(importCoverCardId(rows, 1)).toBe(1)
    expect(importCoverCardId(rows, null)).toBeNull()
    // In the Side Deck, unresolved, or not in the deck: the rule picks.
    expect(importCoverCardId(rows, 4)).toBeNull()
    expect(importCoverCardId(rows, 5)).toBeNull()
    expect(importCoverCardId(rows, 9)).toBeNull()
  })
})
