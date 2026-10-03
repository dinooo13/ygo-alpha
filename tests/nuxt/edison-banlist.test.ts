import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { loadCardDataForValidation } from '../../server/utils/deck-validation'
import edisonBanlist from '../../server/utils/edison-banlist.json'

const POT_OF_GREED = 55144522
const DARK_MAGICIAN = 46986414

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  const now = new Date()
  db.insert(schema.catalogCard).values([
    { id: POT_OF_GREED, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', banlistInfo: { ban_tcg: 'Forbidden' }, syncedAt: now },
    { id: DARK_MAGICIAN, name: 'Dark Magician', type: 'Normal Monster', frameType: 'normal', desc: 'The ultimate wizard.', syncedAt: now },
  ]).run()
  return db
}

describe('the Edison banlist (ADR 0029)', () => {
  it('is the TCG list of March 2010: 43 forbidden, 70 limited, 19 semi-limited', () => {
    expect(edisonBanlist.forbidden).toHaveLength(43)
    expect(edisonBanlist.limited).toHaveLength(70)
    expect(edisonBanlist.semiLimited).toHaveLength(19)

    const all = [...edisonBanlist.forbidden, ...edisonBanlist.limited, ...edisonBanlist.semiLimited]
    expect(new Set(all).size).toBe(all.length)
    expect(all.every(id => Number.isInteger(id) && id > 0)).toBe(true)
  })

  it('adds the Edison status to the catalog banlist info, keeping the official ones', () => {
    const cards = loadCardDataForValidation(createTestDb(), [POT_OF_GREED, DARK_MAGICIAN])

    // Pot of Greed is on the March 2010 list as well as on today's TCG list.
    expect(edisonBanlist.forbidden).toContain(POT_OF_GREED)
    expect(cards.get(POT_OF_GREED)!.banlistInfo).toMatchObject({ ban_tcg: 'Forbidden', ban_edison: 'Forbidden' })
    expect(cards.get(DARK_MAGICIAN)!.banlistInfo).toBeNull()
  })
})
