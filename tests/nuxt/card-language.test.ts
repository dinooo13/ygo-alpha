// The card language (ADR 0015, #34 F3c): payloads carry `nameDe` / `descDe`
// next to the English values, "by name" sorts in the card language, and the
// request's card language is the profile's choice or else the interface
// language.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { CATALOG_FIXTURE_IDS, seedCatalogFixture } from '../../server/db/fixtures/catalog-fixture'
import * as schema from '../../server/db/schema'
import { parseCardListQuery } from '../../server/utils/catalog-query'
import { getCatalogCardDetail, searchCatalog } from '../../server/utils/catalog-search'
import { loadCardDataForValidation, loadCardNameRecords } from '../../server/utils/deck-validation'
import { createDeck, getDeckDetail, inCardLocale, sortDeckSections, upsertDeckCard } from '../../server/utils/decks'
import { addOwnedCard, listOwnedCards, searchCatalogCards } from '../../server/utils/inventory'
import { addWishlistItem, listWishlist } from '../../server/utils/wishlist'
import { buildSharedDeckView, listSharedInventory } from '../../server/utils/shared-views'
import { ensureProfile, toPublicProfile, updateProfile } from '../../server/utils/profiles'
import { evaluateDeck } from '../../shared/rule-formats'
import { compareCardNames, pickCardDesc, pickCardName } from '../../shared/card-text'

const testDb = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../server/db', () => ({ useDb: () => testDb.current }))

const { resolveCardLocale, resolveCardLocaleChoice, resolveUiLocale } = await import('../../server/utils/ui-locale')

const ID = CATALOG_FIXTURE_IDS

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function seedUser(db: TestDb, id = 'user-a') {
  const now = new Date('2025-01-01T00:00:00Z')
  db.insert(schema.user).values({ id, name: 'Fabian', email: `${id}@example.com`, emailVerified: false, createdAt: now, updatedAt: now }).run()
}

describe('pickCardName / pickCardDesc', () => {
  it('picks the German name and text in German, the English ones otherwise', () => {
    const card = { name: 'Dark Magician', nameDe: 'Dunkler Magier', desc: 'The ultimate wizard.', descDe: 'Der ultimative Hexer.' }
    expect(pickCardName(card, 'de')).toBe('Dunkler Magier')
    expect(pickCardName(card, 'en')).toBe('Dark Magician')
    expect(pickCardDesc(card, 'de')).toBe('Der ultimative Hexer.')
    expect(pickCardDesc(card, 'en')).toBe('The ultimate wizard.')
  })

  it('falls back to English when a card has no German data', () => {
    expect(pickCardName({ name: 'Raigeki', nameDe: null }, 'de')).toBe('Raigeki')
    expect(pickCardName({ name: 'Raigeki' }, 'de')).toBe('Raigeki')
    expect(pickCardName({ name: 'Raigeki', nameDe: '' }, 'de')).toBe('Raigeki')
    expect(pickCardDesc({ desc: 'Destroy all monsters.', descDe: null }, 'de')).toBe('Destroy all monsters.')
  })

  it('compares by the display name in the card language', () => {
    const cards = [
      { name: 'Monster Reborn', nameDe: 'Wiedergeburt' },
      { name: 'Dark Magician', nameDe: 'Dunkler Magier' },
      { name: 'Blue-Eyes White Dragon', nameDe: 'Blauäugiger w. Drache' },
    ]
    expect([...cards].sort((a, b) => compareCardNames(a, b, 'de')).map(card => card.nameDe))
      .toEqual(['Blauäugiger w. Drache', 'Dunkler Magier', 'Wiedergeburt'])
    expect([...cards].sort((a, b) => compareCardNames(a, b, 'en')).map(card => card.name))
      .toEqual(['Blue-Eyes White Dragon', 'Dark Magician', 'Monster Reborn'])
  })
})

describe('catalog payloads with German names (fixture)', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedCatalogFixture(db)
  })

  it('adds nameDe to every list item, null for Raigeki (no translation)', async () => {
    const result = await searchCatalog(db, parseCardListQuery({ pageSize: '60' }))
    const byId = new Map(result.items.map(card => [card.id, card]))

    expect(byId.get(ID.darkMagician)).toMatchObject({ name: 'Dark Magician', nameDe: 'Dunkler Magier' })
    expect(byId.get(ID.raigeki)).toMatchObject({ name: 'Raigeki', nameDe: null })
  })

  it('sorts by the German name in German and by the English name in English', async () => {
    const ids: number[] = [ID.blueEyesWhiteDragon, ID.darkMagician, ID.monsterReborn]
    const names = async (cardLocale: 'de' | 'en', sort = 'name') => {
      const result = await searchCatalog(db, parseCardListQuery({ pageSize: '60', sort }), cardLocale)
      return result.items.filter(card => ids.includes(card.id)).map(card => cardLocale === 'de' ? card.nameDe : card.name)
    }

    expect(await names('de')).toEqual(['Blauäugiger w. Drache', 'Dunkler Magier', 'Wiedergeburt'])
    expect(await names('de', '-name')).toEqual(['Wiedergeburt', 'Dunkler Magier', 'Blauäugiger w. Drache'])
    expect(await names('en')).toEqual(['Blue-Eyes White Dragon', 'Dark Magician', 'Monster Reborn'])
  })

  it('sorts a card without a German name by its English name among the German ones', async () => {
    const result = await searchCatalog(db, parseCardListQuery({ pageSize: '60' }), 'de')
    const shown = result.items.map(card => card.nameDe ?? card.name)
    // "Raigeki" (English fallback) sits between "Nummer 39: Utopia" and "Spiegelkraft".
    expect(shown.indexOf('Raigeki')).toBe(shown.indexOf('Nummer 39: Utopia') + 1)
    expect(shown.indexOf('Spiegelkraft')).toBe(shown.indexOf('Raigeki') + 1)
  })

  it('returns the German text in the detail and only the documented columns', async () => {
    const detail = await getCatalogCardDetail(db, ID.darkMagician)

    expect(detail?.card).toMatchObject({ name: 'Dark Magician', nameDe: 'Dunkler Magier' })
    expect(detail?.card.desc).toContain('ultimate wizard')
    expect(detail?.card.descDe).toContain('Hexer')
    expect(Object.keys(detail!.card).sort()).toEqual([
      'archetype', 'atk', 'attribute', 'banlistInfo', 'cardPrices', 'def', 'desc', 'descDe', 'frameType', 'id',
      'level', 'linkMarkers', 'linkval', 'name', 'nameDe', 'ocgDate', 'race', 'replacedById', 'retired', 'scale',
      'syncedAt', 'tcgDate', 'type', 'ygoprodeckUrl',
    ])

    const raigeki = await getCatalogCardDetail(db, ID.raigeki)
    expect(raigeki?.card).toMatchObject({ nameDe: null, descDe: null })
  })

  it('names and sorts the inventory picker in the card language', () => {
    const cards = searchCatalogCards(db, 'drache', 'de')
    expect(cards.map(card => card.nameDe)).toEqual([
      'Blauäugiger ultimativer Drache',
      'Blauäugiger w. Drache',
      'Buntäugiger Pendeldrache',
      'Sternenstaubdrache',
      'Zehntausend-Drache',
    ])
  })

  it('loads English and German names by id', () => {
    expect(loadCardNameRecords(db, [ID.darkMagician, ID.raigeki])).toEqual({
      cardNames: { [ID.darkMagician]: 'Dark Magician', [ID.raigeki]: 'Raigeki' },
      cardNamesDe: { [ID.darkMagician]: 'Dunkler Magier' },
    })
  })

  it('puts the German name into validation issue params (display only)', () => {
    const cardData = loadCardDataForValidation(db, [ID.darkMagician, ID.raigeki])
    const validation = evaluateDeck(
      { rules: [{ kind: 'card_status', cardIds: [ID.darkMagician, ID.raigeki], status: 'forbidden' }] },
      [
        { catalogCardId: ID.darkMagician, section: 'main', quantity: 1 },
        { catalogCardId: ID.raigeki, section: 'main', quantity: 1 },
      ],
      cardData,
    )
    const params = validation.issues.map(issue => issue.params)

    expect(params).toContainEqual({ cardId: ID.darkMagician, cardName: 'Dark Magician', cardNameDe: 'Dunkler Magier' })
    expect(params).toContainEqual({ cardId: ID.raigeki, cardName: 'Raigeki' })
    // The canonical English message the assistant reads doesn't change.
    expect(validation.issues.map(issue => issue.message)).toContain('Dark Magician is forbidden in this format.')
  })
})

describe('owner and shared views with German names', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    seedUser(db)
    ensureProfile(db, 'user-a')
  })

  function deckWithCards() {
    const deck = createDeck(db, 'user-a', { name: 'Deck', description: null })
    for (const catalogCardId of [ID.monsterReborn, ID.potOfGreed, ID.raigeki, ID.darkMagician, ID.blueEyesWhiteDragon]) {
      upsertDeckCard(db, 'user-a', deck.id, { catalogCardId, section: 'main', quantity: 1 })
    }
    return deck
  }

  it('sorts deck sections by the English name by default and by the German name in German', () => {
    const deck = deckWithCards()
    const detail = getDeckDetail(db, 'user-a', deck.id)

    expect(detail.sections.main.map(row => row.name)).toEqual([
      'Blue-Eyes White Dragon', 'Dark Magician', 'Monster Reborn', 'Pot of Greed', 'Raigeki',
    ])
    expect(detail.sections.main.find(row => row.catalogCardId === ID.raigeki)?.nameDe).toBeNull()

    // Monsters first, then spells — each group by the German name.
    expect(inCardLocale(detail, 'de').sections.main.map(row => row.nameDe ?? row.name)).toEqual([
      'Blauäugiger w. Drache', 'Dunkler Magier', 'Raigeki', 'Topf der Gier', 'Wiedergeburt',
    ])
  })

  it('sorts the shared deck view in the viewer\'s card language', () => {
    const deck = deckWithCards()
    const row = db.select().from(schema.deck).all().find(entry => entry.id === deck.id)!
    const owner = toPublicProfile(ensureProfile(db, 'user-a'))

    const view = buildSharedDeckView(db, row, owner, false, 'de')
    expect(view.sections.main.map(card => card.nameDe ?? card.name)).toEqual([
      'Blauäugiger w. Drache', 'Dunkler Magier', 'Raigeki', 'Topf der Gier', 'Wiedergeburt',
    ])
  })

  it('sortDeckSections keeps the monster / spell / trap order', () => {
    const sections = sortDeckSections({
      main: [
        { type: 'Trap Card', name: 'Mirror Force', nameDe: 'Spiegelkraft' },
        { type: 'Spell Card', name: 'Pot of Greed', nameDe: 'Topf der Gier' },
        { type: 'Normal Monster', name: 'Dark Magician', nameDe: 'Dunkler Magier' },
      ],
      extra: [],
      side: [],
    }, 'de')
    expect(sections.main.map(row => row.nameDe)).toEqual(['Dunkler Magier', 'Topf der Gier', 'Spiegelkraft'])
  })

  it('adds the German name to inventory rows, wishlist rows and shared lists, sorted in German', () => {
    for (const catalogCardId of [ID.monsterReborn, ID.darkMagician, ID.raigeki]) {
      addOwnedCard(db, 'user-a', { catalogCardId, collectionId: null, printingId: null, quantity: 1, note: null })
      addWishlistItem(db, 'user-a', { catalogCardId, quantity: 1, note: null })
    }

    const owned = listOwnedCards(db, 'user-a')
    expect(owned.items.find(item => item.catalogCardId === ID.darkMagician)?.cardNameDe).toBe('Dunkler Magier')
    expect(owned.items.find(item => item.catalogCardId === ID.raigeki)?.cardNameDe).toBeNull()
    // The "Liste" row's card text excerpt in both languages (#135).
    expect(owned.items.find(item => item.catalogCardId === ID.darkMagician)?.cardTextExcerptDe).toContain('Hexer')
    expect(owned.items.find(item => item.catalogCardId === ID.darkMagician)?.cardTextExcerpt).toContain('ultimate wizard')
    expect(owned.items.find(item => item.catalogCardId === ID.raigeki)?.cardTextExcerptDe).toBeNull()

    expect(listWishlist(db, 'user-a', { cardLocale: 'de' }).items.map(item => item.nameDe ?? item.name))
      .toEqual(['Dunkler Magier', 'Raigeki', 'Wiedergeburt'])
    expect(listWishlist(db, 'user-a').items.map(item => item.name))
      .toEqual(['Dark Magician', 'Monster Reborn', 'Raigeki'])

    expect(listSharedInventory(db, 'user-a', { cardLocale: 'de' }).items.map(item => item.nameDe ?? item.name))
      .toEqual(['Dunkler Magier', 'Raigeki', 'Wiedergeburt'])
  })
})

describe('resolveCardLocale', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    testDb.current = db
    seedUser(db)
    ensureProfile(db, 'user-a')
  })

  function event(authUser: { id: string } | null, headers: Record<string, string> = {}): H3Event {
    return { context: { authUser }, node: { req: { headers } }, headers: new Headers(headers) } as unknown as H3Event
  }

  it('follows the interface language when the profile has no card language', async () => {
    expect(await resolveCardLocale(event(null, { cookie: 'ui_locale=en' }))).toBe('en')
    expect(await resolveCardLocale(event(null))).toBe('de')
    expect(await resolveCardLocale(event({ id: 'user-a' }, { 'accept-language': 'en-US' }))).toBe('en')
    expect(await resolveCardLocaleChoice(event({ id: 'user-a' }))).toBeNull()
  })

  it('prefers the profile\'s card language over the interface language', async () => {
    updateProfile(db, 'user-a', { locale: 'en', cardLocale: 'de' })
    const request = event({ id: 'user-a' }, { cookie: 'ui_locale=en' })

    expect(await resolveUiLocale(request)).toBe('en')
    expect(await resolveCardLocale(request)).toBe('de')
    expect(await resolveCardLocaleChoice(request)).toBe('de')
  })

  it('reads the profile once and caches the choice on the event', async () => {
    updateProfile(db, 'user-a', { cardLocale: 'en' })
    const request = event({ id: 'user-a' })

    expect(await resolveCardLocale(request)).toBe('en')
    expect(request.context.localeChoices).toEqual({ locale: null, cardLocale: 'en' })
    expect(request.context.cardLocaleChoice).toBe('en')

    // A later profile change doesn't affect this request any more.
    updateProfile(db, 'user-a', { cardLocale: 'de' })
    expect(await resolveCardLocale(request)).toBe('en')
    expect(await resolveUiLocale(request)).toBe('de')
  })
})
