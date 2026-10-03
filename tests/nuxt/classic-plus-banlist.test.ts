import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import * as schema from '../../server/db/schema'
import { loadCardDataForValidation } from '../../server/utils/deck-validation'

// The generated list is empty until the classification runs (ADR 0022);
// these ids stand in for it.
vi.mock('../../server/utils/classic-plus-banlist.json', () => ({
  default: { forbidden: [], limited: [55144522], semiLimited: [83764719] },
}))

// Edison's list (tests/nuxt/edison-banlist.test.ts) isn't under test here.
vi.mock('../../server/utils/edison-banlist.json', () => ({
  default: { forbidden: [], limited: [], semiLimited: [] },
}))

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  const now = new Date()
  db.insert(schema.catalogCard).values([
    { id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', banlistInfo: { ban_tcg: 'Forbidden', ban_goat: 'Limited' }, syncedAt: now },
    { id: 83764719, name: 'Monster Reborn', type: 'Spell Card', frameType: 'spell', desc: 'Special Summon it.', syncedAt: now },
    { id: 46986414, name: 'Dark Magician', type: 'Normal Monster', frameType: 'normal', desc: 'The ultimate wizard.', syncedAt: now },
  ]).run()
  return db
}

describe('Classic Plus banlist in the validation card data', () => {
  it('adds the Classic Plus status to the catalog banlist info, keeping the official ones', () => {
    const cards = loadCardDataForValidation(createTestDb(), [55144522, 83764719, 46986414])

    expect(cards.get(55144522)!.banlistInfo).toEqual({ ban_tcg: 'Forbidden', ban_goat: 'Limited', ban_classic_plus: 'Limited' })
    expect(cards.get(83764719)!.banlistInfo).toEqual({ ban_classic_plus: 'Semi-Limited' })
    expect(cards.get(46986414)!.banlistInfo).toBeNull()
  })
})
