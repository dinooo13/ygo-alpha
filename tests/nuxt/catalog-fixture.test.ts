import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  CATALOG_FIXTURE_ALIAS_ARTWORK_ID,
  CATALOG_FIXTURE_CARDS,
  CATALOG_FIXTURE_IDS,
  CATALOG_FIXTURE_RETIRED_CARDS,
  CATALOG_FIXTURE_RETIRED_IDS,
  CATALOG_FIXTURE_TRANSLATIONS,
  seedCatalogFixture,
} from '../../server/db/fixtures/catalog-fixture'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

describe('catalog fixture', () => {
  it('seeds the fixture cards and stays idempotent on repeated seeding', () => {
    const db = createTestDb()

    seedCatalogFixture(db)
    expect(db.select().from(schema.catalogCard).all())
      .toHaveLength(CATALOG_FIXTURE_CARDS.length + CATALOG_FIXTURE_RETIRED_CARDS.length)

    // Re-seeding must upsert (converge to the same rows), not duplicate.
    seedCatalogFixture(db)
    expect(db.select().from(schema.catalogCard).all())
      .toHaveLength(CATALOG_FIXTURE_CARDS.length + CATALOG_FIXTURE_RETIRED_CARDS.length)
  })

  it('joins a printing to its card and set', () => {
    const db = createTestDb()
    seedCatalogFixture(db)

    const rows = db
      .select({
        cardName: schema.catalogCard.name,
        setName: schema.catalogSet.name,
        setCode: schema.catalogPrinting.setCode,
      })
      .from(schema.catalogPrinting)
      .innerJoin(schema.catalogCard, eq(schema.catalogPrinting.cardId, schema.catalogCard.id))
      .innerJoin(schema.catalogSet, eq(schema.catalogPrinting.setId, schema.catalogSet.id))
      .where(eq(schema.catalogPrinting.id, `${CATALOG_FIXTURE_IDS.darkMagician}|LOB-005|UR`))
      .all()

    expect(rows).toEqual([
      {
        cardName: 'Dark Magician',
        setName: 'Legend of Blue Eyes White Dragon',
        setCode: 'LOB-005',
      },
    ])
  })

  it('gives every fixture card at least one image row', () => {
    const db = createTestDb()
    seedCatalogFixture(db)

    for (const id of Object.values(CATALOG_FIXTURE_IDS)) {
      const images = db.select().from(schema.catalogCardImage).where(eq(schema.catalogCardImage.cardId, id)).all()
      expect(images.length).toBeGreaterThan(0)
    }
  })
})

describe('catalog fixture retired rows (ADR 0019, ADR 0023)', () => {
  it('seeds the retired rows as a real sync leaves them', () => {
    const db = createTestDb()
    seedCatalogFixture(db)

    const card = (id: number) => db.select().from(schema.catalogCard).where(eq(schema.catalogCard.id, id)).get()!
    expect(card(CATALOG_FIXTURE_RETIRED_IDS.oddEyesPendulumDragonOld)).toMatchObject({
      retiredAt: expect.any(Date),
      replacedById: CATALOG_FIXTURE_IDS.oddEyesPendulumDragon,
      konamiId: null,
    })
    expect(card(CATALOG_FIXTURE_IDS.oddEyesPendulumDragon)).toMatchObject({ retiredAt: null, replacedById: null })
    expect(card(CATALOG_FIXTURE_RETIRED_IDS.leviathanOfAtlantisDaedalus)).toMatchObject({
      retiredAt: expect.any(Date),
      replacedById: null,
      nameSearch: 'leviathanofatlantisdaedalus',
    })

    const image = (id: number) => db.select().from(schema.catalogCardImage).where(eq(schema.catalogCardImage.id, id)).get()!
    expect(image(CATALOG_FIXTURE_ALIAS_ARTWORK_ID).cardId).toBe(CATALOG_FIXTURE_IDS.darkMagician)
    expect(image(CATALOG_FIXTURE_RETIRED_IDS.oddEyesPendulumDragonOld).cardId).toBe(CATALOG_FIXTURE_IDS.oddEyesPendulumDragon)
    expect(image(CATALOG_FIXTURE_RETIRED_IDS.leviathanOfAtlantisDaedalus).cardId)
      .toBe(CATALOG_FIXTURE_RETIRED_IDS.leviathanOfAtlantisDaedalus)
  })
})

describe('catalog fixture translations', () => {
  it('seeds the German names idempotently, all but Raigeki', () => {
    const db = createTestDb()

    seedCatalogFixture(db)
    seedCatalogFixture(db)

    const rows = db.select().from(schema.catalogCardTranslation).all()
    expect(rows).toHaveLength(CATALOG_FIXTURE_TRANSLATIONS.length)
    expect(rows).toHaveLength(Object.keys(CATALOG_FIXTURE_IDS).length - 1)
    expect(rows.find(row => row.cardId === CATALOG_FIXTURE_IDS.raigeki)).toBeUndefined()
    expect(rows.find(row => row.cardId === CATALOG_FIXTURE_IDS.darkMagician)).toMatchObject({
      locale: 'de',
      name: 'Dunkler Magier',
      nameSearch: 'dunklermagier',
      source: 'ygoresources-git',
    })
    expect(rows.find(row => row.cardId === CATALOG_FIXTURE_IDS.oddEyesPendulumDragon)!.desc)
      .toMatch(/^\[ Pendeleffekt \]\n.+\n\n\[ Monstereffekt \]\n.+$/s)
  })

  it('seeds Ten Thousand Dragon with "?" ATK/DEF, stored as -1 (#140)', () => {
    const db = createTestDb()
    seedCatalogFixture(db)

    const card = db.select().from(schema.catalogCard).where(eq(schema.catalogCard.id, CATALOG_FIXTURE_IDS.tenThousandDragon)).get()
    expect(card).toMatchObject({ name: 'Ten Thousand Dragon', atk: -1, def: -1, level: 10, retiredAt: null })
    const printing = db.select().from(schema.catalogPrinting).where(eq(schema.catalogPrinting.cardId, CATALOG_FIXTURE_IDS.tenThousandDragon)).all()
    expect(printing.map(row => [row.setCode, row.setId])).toEqual([['BLAR-EN10K', 'battles-of-legend-armageddon']])
  })

  it('gives every fixture card a Konami id and a folded search name', () => {
    for (const card of CATALOG_FIXTURE_CARDS) {
      expect(card.konamiId).toEqual(expect.any(Number))
      expect(card.nameSearch).toMatch(/^[a-z0-9]+$/)
    }
    expect(CATALOG_FIXTURE_CARDS.find(card => card.id === CATALOG_FIXTURE_IDS.utopia)!.nameSearch).toBe('number39utopia')
  })
})
