// One primary artwork rule everywhere (ADR 0025): the image whose id is the
// card's id, else the lowest image id. Every list, cover, the card detail and
// the card entry candidates show the same picture.
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { getCatalogCardDetail, searchCatalog } from '../../server/utils/catalog-search'
import { parseCardListQuery } from '../../server/utils/catalog-query'
import { createDeck, getDeckDetail, loadDeckCovers } from '../../server/utils/decks'
import { addOwnedCard, listOwnedCards, searchCatalogCards } from '../../server/utils/inventory'
import { loadInventoryCardDisplay } from '../../server/utils/inventory-search'
import { addWishlistItem, listWishlist } from '../../server/utils/wishlist'
import { buildSharedDeckView, listSharedInventory } from '../../server/utils/shared-views'
import { suggestCatalogMatches } from '../../server/utils/card-entry'
import { parseEntryLine } from '../../server/utils/entry-line'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

const DARK_MAGICIAN = 46986420
const ALT_LOW = 36996508
const ALT_PRINTED = 46986414
const NO_OWN_IMAGE = 5000
const NO_IMAGE = 6000
const ODD_EYES = 16178683
const ODD_EYES_OLD = 16178681
const USER = 'user-a'

const small = (id: number) => `https://img/small/${id}.jpg`
const large = (id: number) => `https://img/large/${id}.jpg`
const image = (id: number, cardId: number) => ({ id, cardId, imageUrl: large(id), imageUrlSmall: small(id) })

function seed(db: TestDb) {
  const now = new Date()
  db.insert(schema.user).values({ id: USER, name: 'User A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now }).run()
  db.insert(schema.catalogCard).values([
    { id: DARK_MAGICIAN, name: 'Dark Magician', type: 'Normal Monster', desc: 'Wizard.', level: 7, atk: 2500, def: 2100, syncedAt: now },
    { id: NO_OWN_IMAGE, name: 'Dark Hole', type: 'Spell Card', desc: 'Destroy.', syncedAt: now },
    { id: NO_IMAGE, name: 'Dark Blank', type: 'Spell Card', desc: 'Nothing.', syncedAt: now },
    { id: ODD_EYES, name: 'Odd-Eyes Pendulum Dragon', type: 'Pendulum Effect Monster', desc: 'Dragon.', level: 7, scale: 4, syncedAt: now },
    // The renumbered card's old row (ADR 0019/0024): its artwork belongs to the new card.
    { id: ODD_EYES_OLD, name: 'Odd-Eyes Pendulum Dragon', type: 'Pendulum Effect Monster', desc: 'Dragon.', level: 7, scale: 4, syncedAt: now, retiredAt: now, replacedById: ODD_EYES },
  ]).run()
  // Inserted out of order: the lowest id is an alternate artwork.
  db.insert(schema.catalogCardImage).values([
    image(DARK_MAGICIAN, DARK_MAGICIAN),
    image(ALT_LOW, DARK_MAGICIAN),
    image(ALT_PRINTED, DARK_MAGICIAN),
    image(5002, NO_OWN_IMAGE),
    image(5001, NO_OWN_IMAGE),
    image(ODD_EYES, ODD_EYES),
    image(ODD_EYES_OLD, ODD_EYES),
  ]).run()
}

describe('primary artwork (ADR 0025)', () => {
  let db: TestDb

  beforeEach(() => {
    db = createTestDb()
    seed(db)
  })

  it('picks the own-id image, else the lowest id, else none, in the catalog search', async () => {
    const result = await searchCatalog(db, parseCardListQuery({ pageSize: '50' }))
    const byId = new Map(result.items.map(item => [item.id, item.imageSmall]))

    expect(byId.get(DARK_MAGICIAN)).toBe(small(DARK_MAGICIAN))
    expect(byId.get(NO_OWN_IMAGE)).toBe(small(5001))
    expect(byId.get(NO_IMAGE)).toBeNull()
    expect(byId.get(ODD_EYES)).toBe(small(ODD_EYES))
    // One row per card, however many images it has.
    expect(result.items.filter(item => item.id === DARK_MAGICIAN)).toHaveLength(1)
  })

  it('puts the primary artwork first in the card detail', async () => {
    const detail = await getCatalogCardDetail(db, DARK_MAGICIAN)
    expect(detail?.images.map(row => row.id)).toEqual([DARK_MAGICIAN, ALT_LOW, ALT_PRINTED])

    const oldOddEyes = await getCatalogCardDetail(db, ODD_EYES_OLD)
    expect(oldOddEyes?.card.id).toBe(ODD_EYES_OLD)
    expect(oldOddEyes?.images).toEqual([])
  })

  it('shows it in the deck rows and the deck cover', () => {
    const deck = createDeck(db, USER, { name: 'Magier', description: null }, [
      { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 3 },
      { catalogCardId: NO_OWN_IMAGE, section: 'main', quantity: 1 },
    ])

    const detail = getDeckDetail(db, USER, deck.id)
    expect(detail.sections.main.map(row => [row.catalogCardId, row.imageSmall])).toEqual(expect.arrayContaining([
      [DARK_MAGICIAN, small(DARK_MAGICIAN)],
      [NO_OWN_IMAGE, small(5001)],
    ]))
    expect(detail.sections.main).toHaveLength(2)

    const cover = loadDeckCovers(db, [deck.id]).get(deck.id)
    expect(cover).toMatchObject({ catalogCardId: DARK_MAGICIAN, imageSmall: small(DARK_MAGICIAN), imageLarge: large(DARK_MAGICIAN) })
  })

  it('shows it in the inventory list, the card picker and the inventory search display', async () => {
    await addOwnedCard(db, USER, { catalogCardId: DARK_MAGICIAN, collectionId: null, quantity: 2, note: null })

    const owned = listOwnedCards(db, USER)
    expect(owned.items).toHaveLength(1)
    expect(owned.items[0]!.imageUrlSmall).toBe(small(DARK_MAGICIAN))

    const picker = searchCatalogCards(db, 'Dark')
    expect(picker.find(card => card.id === DARK_MAGICIAN)?.imageUrlSmall).toBe(small(DARK_MAGICIAN))
    expect(picker.filter(card => card.id === DARK_MAGICIAN)).toHaveLength(1)

    const display = loadInventoryCardDisplay(db, [DARK_MAGICIAN, NO_IMAGE])
    expect(display.get(DARK_MAGICIAN)).toMatchObject({ imageSmall: small(DARK_MAGICIAN), imageLarge: large(DARK_MAGICIAN) })
    expect(display.get(NO_IMAGE)).toMatchObject({ imageSmall: null, imageLarge: null })
  })

  it('shows it in the wishlist list and the item view', () => {
    const item = addWishlistItem(db, USER, { catalogCardId: DARK_MAGICIAN, quantity: 1, note: null })
    expect(item.imageSmall).toBe(small(DARK_MAGICIAN))

    const page = listWishlist(db, USER)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.imageSmall).toBe(small(DARK_MAGICIAN))
  })

  it('shows it in the shared deck view and the shared inventory list', async () => {
    const deck = createDeck(db, USER, { name: 'Magier', description: null }, [
      { catalogCardId: DARK_MAGICIAN, section: 'main', quantity: 3 },
    ])
    const deckRow = db.select().from(schema.deck).where(eq(schema.deck.id, deck.id)).get()!
    const view = buildSharedDeckView(db, deckRow, { handle: 'a', displayName: 'A', bio: null })
    expect(view.sections.main).toHaveLength(1)
    expect(view.sections.main[0]).toMatchObject({ imageSmall: small(DARK_MAGICIAN), imageLarge: large(DARK_MAGICIAN) })

    await addOwnedCard(db, USER, { catalogCardId: DARK_MAGICIAN, collectionId: null, quantity: 2, note: null })
    const list = listSharedInventory(db, USER, {})
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ imageSmall: small(DARK_MAGICIAN), imageLarge: large(DARK_MAGICIAN) })
  })

  it('shows it in the card entry candidates', () => {
    const [best] = suggestCatalogMatches(db, parseEntryLine('Dark Magician'))
    expect(best).toMatchObject({ cardId: DARK_MAGICIAN, imageSmall: small(DARK_MAGICIAN) })
  })
})
