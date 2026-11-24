// The printing key (ADR 0034): one `catalog_printing` row per card, set code
// and rarity. Before, the bare set code was the key and the sync kept only
// the last rarity of a set code (Blue-Eyes White Dragon: 78 printings under
// 69 set codes), and a set code YGOPRODeck lists under two cards jumped
// between them.

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { syncCatalog } from '../../server/utils/catalog-sync'
import { mapCardToRows } from '../../server/utils/ygoprodeck'
import type { YgoproCard } from '../../server/utils/ygoprodeck'
import {
  normalizeRarityCode,
  printingKey,
  printingRarityLabel,
  printingShortLabel,
} from '../../shared/printing'
import { darkMagicianFixture } from './fixtures/ygoprodeck-cards'

// Real YGOPRODeck entries of Blue-Eyes White Dragon (2026-11-24): three set
// codes that come in two rarities each, one of them without a rarity code.
const blueEyes: YgoproCard = {
  id: 89631139,
  name: 'Blue-Eyes White Dragon',
  type: 'Normal Monster',
  desc: 'This legendary dragon is a powerful engine of destruction.',
  card_sets: [
    { set_name: 'Legendary Collection', set_code: 'LC01-EN004', set_rarity: 'Ultra Rare', set_rarity_code: '(UR)', set_price: '0' },
    { set_name: 'Legendary Collection: 25th Anniversary Edition', set_code: 'LC01-EN004', set_rarity: 'Quarter Century Secret Rare', set_rarity_code: '', set_price: '0' },
    { set_name: 'Battles of Legend: Monster Mayhem', set_code: 'BLMM-EN001', set_rarity: 'Secret Rare', set_rarity_code: '(ScR)', set_price: '0' },
    { set_name: 'Battles of Legend: Monster Mayhem', set_code: 'BLMM-EN001', set_rarity: 'Starlight Rare', set_rarity_code: '(StR)', set_price: '0' },
    { set_name: 'Quarter Century Bonanza', set_code: 'RA03-EN079', set_rarity: 'Platinum Secret Rare', set_rarity_code: '(PS)', set_price: '0' },
    { set_name: 'Quarter Century Bonanza', set_code: 'RA03-EN079', set_rarity: 'Quarter Century Secret Rare', set_rarity_code: '', set_price: '0' },
  ],
}

// Two real cards YGOPRODeck lists under the same set code and rarity.
const cobaltEagle: YgoproCard = {
  id: 45236142,
  name: 'Advanced Crystal Beast Cobalt Eagle',
  type: 'Effect Monster',
  desc: '…',
  card_sets: [{ set_name: 'Battles of Legend: Crystal Revenge', set_code: 'BLCR-EN015', set_rarity: 'Secret Rare', set_rarity_code: '(ScR)', set_price: '0' }],
}
const sapphirePegasus: YgoproCard = {
  ...cobaltEagle,
  id: 71620241,
  name: 'Advanced Crystal Beast Sapphire Pegasus',
}

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

describe('printingKey', () => {
  it('keys a printing by card, set code and rarity code, else rarity name', () => {
    expect(printingKey({ cardId: 89631139, setCode: 'LC01-EN004', rarityCode: '(UR)', rarity: 'Ultra Rare' })).toBe('89631139|LC01-EN004|UR')
    expect(printingKey({ cardId: 89631139, setCode: 'LC01-EN004', rarityCode: '', rarity: 'Quarter Century Secret Rare' }))
      .toBe('89631139|LC01-EN004|Quarter Century Secret Rare')
    expect(printingKey({ cardId: 1, setCode: ' SDY-006 ', rarityCode: null, rarity: null })).toBe('1|SDY-006|')
  })

  it('normalizes the rarity code', () => {
    expect(normalizeRarityCode('(UR)')).toBe('UR')
    expect(normalizeRarityCode(' (10000ScR) ')).toBe('10000ScR')
    expect(normalizeRarityCode('ScR')).toBe('ScR')
    expect(normalizeRarityCode('')).toBeNull()
    expect(normalizeRarityCode('()')).toBeNull()
    expect(normalizeRarityCode(undefined)).toBeNull()
  })

  it('labels a printing short and long', () => {
    expect(printingShortLabel({ setCode: 'LC01-EN004', rarity: 'Ultra Rare', rarityCode: 'UR' })).toBe('LC01-EN004 (UR)')
    expect(printingShortLabel({ setCode: 'LC01-EN004', rarity: 'Quarter Century Secret Rare', rarityCode: null })).toBe('LC01-EN004 Quarter Century Secret Rare')
    expect(printingShortLabel({ setCode: 'LOB-001' })).toBe('LOB-001')
    expect(printingRarityLabel({ setCode: 'LC01-EN004', rarity: 'Ultra Rare', rarityCode: 'UR' })).toBe('Ultra Rare (UR)')
    expect(printingRarityLabel({ setCode: 'X', rarity: null, rarityCode: 'C' })).toBe('(C)')
  })
})

describe('mapCardToRows printings (ADR 0034)', () => {
  it('keeps every rarity of a set code as its own printing, with the rarity code', () => {
    const { printings } = mapCardToRows(blueEyes, new Date())

    expect(printings).toHaveLength(6)
    expect(new Set(printings.map(printing => printing.id)).size).toBe(6)
    expect(printings.filter(printing => printing.setCode === 'LC01-EN004')).toEqual([
      expect.objectContaining({ id: '89631139|LC01-EN004|UR', rarity: 'Ultra Rare', rarityCode: 'UR', setId: 'legendary-collection' }),
      expect.objectContaining({
        id: '89631139|LC01-EN004|Quarter Century Secret Rare',
        rarity: 'Quarter Century Secret Rare',
        rarityCode: null,
        setId: 'legendary-collection-25th-anniversary-edition',
      }),
    ])
  })

  it('keys a printing without a rarity code by its rarity name (the old fixtures)', () => {
    const { printings } = mapCardToRows(darkMagicianFixture, new Date())
    expect(printings.map(printing => [printing.id, printing.rarityCode])).toEqual([
      ['46986414|LOB-005|Ultra Rare', null],
      ['46986414|SDY-006|Common', null],
    ])
  })
})

describe('syncCatalog printings (ADR 0034)', () => {
  it('stores every printing: several rarities under one set code, one set code under two cards', async () => {
    const db = createTestDb()
    const fetchAllCards = async () => [blueEyes, cobaltEagle, sapphirePegasus]

    await syncCatalog(db, { fetchAllCards })
    const first = db.select().from(schema.catalogPrinting).all()
    // A second run converges to the same rows.
    await syncCatalog(db, { fetchAllCards })
    const second = db.select().from(schema.catalogPrinting).all()

    expect(first).toHaveLength(8)
    expect(second).toEqual(first)
    const bySetCode = (setCode: string) => second
      .filter(printing => printing.setCode === setCode)
      .map(printing => [printing.cardId, printing.rarity, printing.rarityCode])
      .sort()
    expect(bySetCode('BLMM-EN001')).toEqual([[89631139, 'Secret Rare', 'ScR'], [89631139, 'Starlight Rare', 'StR']])
    expect(bySetCode('RA03-EN079')).toEqual([[89631139, 'Platinum Secret Rare', 'PS'], [89631139, 'Quarter Century Secret Rare', null]])
    // Both cards keep BLCR-EN015; with the set code as the key it moved to the last one.
    expect(bySetCode('BLCR-EN015')).toEqual([[45236142, 'Secret Rare', 'ScR'], [71620241, 'Secret Rare', 'ScR']])
  })
})
