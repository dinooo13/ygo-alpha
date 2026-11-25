// Printings and rarities (ADR 0034): one `catalog_printing` row per card, set
// code and rarity, with YGOPRODeck's rarity text mapped onto the rarity list
// (shared/rarity.ts, from Yugipedia). Before, the bare set code was the key
// and the sync kept only the last rarity of a set code (Blue-Eyes White
// Dragon: 78 printings under 69 set codes), and a set code YGOPRODeck lists
// under two cards jumped between them.

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { syncCatalog } from '../../server/utils/catalog-sync'
import { mapCardToRows } from '../../server/utils/ygoprodeck'
import type { YgoproCard } from '../../server/utils/ygoprodeck'
import { printingKey, printingLabel } from '../../shared/printing'
import { RARITIES, normalizeRarity, rarityLabel } from '../../shared/rarity'
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

describe('rarity list', () => {
  it('has 67 rarities with unique keys and abbreviations', () => {
    expect(RARITIES).toHaveLength(67)
    expect(new Set(RARITIES.map(rarity => rarity.key)).size).toBe(67)
    expect(new Set(RARITIES.map(rarity => rarity.abbr)).size).toBe(67)
  })

  it('maps YGOPRODeck\'s names and codes, whatever the spelling', () => {
    expect(normalizeRarity('Ultra Rare')).toBe('ur')
    expect(normalizeRarity('(UR)')).toBe('ur')
    expect(normalizeRarity('Quarter Century Secret Rare')).toBe('qcscr')
    expect(normalizeRarity('(QCScR)')).toBe('qcscr')
    expect(normalizeRarity('PLatinum Secret Rare')).toBe('plscr')
    expect(normalizeRarity('Starfoil')).toBe('sfr')
    expect(normalizeRarity('Starfoil Rare')).toBe('sfr')
    expect(normalizeRarity('Ultra Rare (Pharaoh\'s Rare)')).toBe('urpr')
    expect(normalizeRarity('Collector\'s Rare')).toBe('cr')
    expect(normalizeRarity('10000 Secret Rare')).toBe('10000scr')
    expect(normalizeRarity('Duel Terminal Normal Parallel Rare')).toBe('dnpr')
    expect(normalizeRarity('Common')).toBe('c')
  })

  it('maps what is no rarity to none', () => {
    for (const text of ['New', '2', '3', 'Reprint', 'New artwork', 'European debut', '', null, undefined]) {
      expect(normalizeRarity(text)).toBeNull()
    }
  })

  it('labels rarities and stack printings', () => {
    expect(rarityLabel('qcscr')).toBe('Quarter Century Secret Rare (QCScR)')
    expect(rarityLabel('nope')).toBeNull()
    expect(printingLabel({ setCode: 'LC01-EN004', rarity: 'qcscr' })).toBe('LC01-EN004 (QCScR)')
    expect(printingLabel({ setCode: 'LOB-001', rarity: null })).toBe('LOB-001')
    expect(printingLabel({ setCode: null, rarity: 'ur' })).toBe('Ultra Rare')
    expect(printingLabel({ setCode: null, rarity: null })).toBeNull()
  })
})

describe('printingKey', () => {
  it('is card, set code and rarity key, else YGOPRODeck\'s text', () => {
    expect(printingKey({ cardId: 89631139, setCode: 'LC01-EN004', rarityKey: 'qcscr', rarity: 'Quarter Century Secret Rare' })).toBe('89631139|LC01-EN004|qcscr')
    expect(printingKey({ cardId: 1, setCode: ' SDY-006 ', rarityKey: null, rarity: 'New' })).toBe('1|SDY-006|New')
    expect(printingKey({ cardId: 1, setCode: 'SDY-006' })).toBe('1|SDY-006|')
  })
})

describe('mapCardToRows printings (ADR 0034)', () => {
  it('keeps every rarity of a set code as its own printing, with the rarity key', () => {
    const { printings } = mapCardToRows(blueEyes, new Date())

    expect(printings).toHaveLength(6)
    expect(new Set(printings.map(printing => printing.id)).size).toBe(6)
    expect(printings.filter(printing => printing.setCode === 'LC01-EN004')).toEqual([
      expect.objectContaining({ id: '89631139|LC01-EN004|ur', rarity: 'Ultra Rare', rarityKey: 'ur', setId: 'legendary-collection' }),
      expect.objectContaining({
        id: '89631139|LC01-EN004|qcscr',
        rarity: 'Quarter Century Secret Rare',
        rarityKey: 'qcscr',
        setId: 'legendary-collection-25th-anniversary-edition',
      }),
    ])
    // The name wins over a code the list doesn't know ("(PS)").
    expect(printings.find(printing => printing.rarity === 'Platinum Secret Rare')).toMatchObject({ rarityKey: 'plscr' })
  })

  it('keeps an entry that names no rarity, under its text', () => {
    const { printings } = mapCardToRows({
      ...darkMagicianFixture,
      card_sets: [{ set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'New', set_rarity_code: '', set_price: '0' }],
    }, new Date())
    expect(printings).toEqual([expect.objectContaining({ id: '46986414|SDY-006|New', rarity: 'New', rarityKey: null })])
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
      .map(printing => [printing.cardId, printing.rarityKey])
      .sort()
    expect(bySetCode('BLMM-EN001')).toEqual([[89631139, 'scr'], [89631139, 'str']])
    expect(bySetCode('RA03-EN079')).toEqual([[89631139, 'plscr'], [89631139, 'qcscr']])
    // Both cards keep BLCR-EN015; with the set code as the key it moved to the last one.
    expect(bySetCode('BLCR-EN015')).toEqual([[45236142, 'scr'], [71620241, 'scr']])
  })
})
