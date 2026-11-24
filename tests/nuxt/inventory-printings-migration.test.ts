// Migration 0019 (#176, ADR 0034): `catalog_printing` gets `rarity_code`,
// `owned_card.printing_id` an index, and the printings are re-keyed from the
// bare set code to `<card id>|<set code>|<rarity>`. No table rebuild: the
// migrator runs every migration inside one transaction, where
// `PRAGMA foreign_keys=OFF` does nothing, so a rebuild's DROP TABLE would
// cascade. This runs 0000–0018 on an in-memory DB (the state production is
// in: every `printing_id` NULL since ADR 0017), seeds an inventory, applies
// 0019 the way the migrator does, and checks that every row and quantity
// survives — also through the first catalog sync after it.

import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { syncCatalog } from '../../server/utils/catalog-sync'
import { addOwnedCard, listOwnedCards, validateInventoryInput } from '../../server/utils/inventory'
import { darkMagicianFixture, potOfGreedFixture } from './fixtures/ygoprodeck-cards'

const MIGRATIONS = './server/db/migrations'
const PRINTINGS_IDX = 19

interface JournalEntry { idx: number, tag: string }

const journal = (JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] }).entries
const printingsMigration = journal.find(entry => entry.idx === PRINTINGS_IDX)!

function migrationSql(entry: JournalEntry): string {
  return readFileSync(`${MIGRATIONS}/${entry.tag}.sql`, 'utf8')
}

function statements(sql: string): string[] {
  return sql.split('--> statement-breakpoint').map(statement => statement.trim()).filter(statement => statement !== '')
}

function withoutComments(sql: string): string {
  return sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n')
}

/** An in-memory DB at migration 0018, foreign keys on as in the app. */
function databaseBefore() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const entry of journal.filter(entry => entry.idx < PRINTINGS_IDX)) {
    for (const statement of statements(migrationSql(entry))) {
      sqlite.prepare(statement).run()
    }
  }
  return sqlite
}

/** Applies 0019 like drizzle's migrator: every statement inside one transaction. */
function applyPrintingsMigration(sqlite: Database.Database) {
  sqlite.exec('BEGIN')
  try {
    for (const statement of statements(migrationSql(printingsMigration))) {
      sqlite.prepare(statement).run()
    }
    sqlite.exec('COMMIT')
  }
  catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

const DM = darkMagicianFixture.id
const POG = potOfGreedFixture.id

function seed(sqlite: Database.Database) {
  const now = Date.now()
  sqlite.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run('user-a', 'User A', 'a@example.com', now, now)
  sqlite.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run('user-b', 'User B', 'b@example.com', now, now)
  const card = sqlite.prepare('INSERT INTO catalog_card (id, name, type, desc, synced_at) VALUES (?, ?, ?, ?, ?)')
  card.run(DM, 'Dark Magician', 'Normal Monster', 'The ultimate wizard.', now)
  card.run(POG, 'Pot of Greed', 'Spell Card', 'Draw 2 cards.', now)
  sqlite.prepare('INSERT INTO catalog_set (id, name) VALUES (?, ?)').run('legend-of-blue-eyes-white-dragon', 'Legend of Blue Eyes White Dragon')
  sqlite.prepare('INSERT INTO catalog_set (id, name) VALUES (?, ?)').run('dark-magician-structure-deck', 'Dark Magician Structure Deck')
  // The old key: the bare set code, one row per set code.
  const printing = sqlite.prepare('INSERT INTO catalog_printing (id, card_id, set_id, set_code, rarity, price) VALUES (?, ?, ?, ?, ?, ?)')
  printing.run('LOB-005', DM, 'legend-of-blue-eyes-white-dragon', 'LOB-005', 'Ultra Rare', '5.00')
  printing.run('SDY-006', DM, 'dark-magician-structure-deck', 'SDY-006', 'Common', '2.00')
  printing.run('LOB-119', POG, 'legend-of-blue-eyes-white-dragon', 'LOB-119', 'Common', '0.30')
  sqlite.prepare('INSERT INTO collection (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('box-1', 'user-a', 'Box 1', now, now)
  // Every `printing_id` is NULL since ADR 0017 (migration 0014).
  const owned = sqlite.prepare('INSERT INTO owned_card (id, user_id, catalog_card_id, collection_id, quantity, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  owned.run('own-1', 'user-a', DM, null, 3, 'Binder', now, now)
  owned.run('own-2', 'user-a', DM, 'box-1', 2, null, now, now + 1)
  owned.run('own-3', 'user-a', POG, 'box-1', 999, null, now, now + 2)
  owned.run('own-4', 'user-b', DM, null, 1, null, now, now + 3)
}

function ownedRows(sqlite: Database.Database) {
  return sqlite.prepare('SELECT * FROM owned_card ORDER BY id').all()
}

describe('migration 0019: printings in the inventory (#176, ADR 0034)', () => {
  it('is plain SQL: ADD COLUMN, CREATE INDEX and a re-key, no table rebuild', () => {
    expect(printingsMigration.tag).toBe('0019_inventory_printings')
    const sql = withoutComments(migrationSql(printingsMigration))
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|RENAME/i)
    expect(sql).not.toContain('__new_')
    expect(statements(sql).map(statement => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'ALTER TABLE `catalog_printing`',
      'CREATE INDEX `idx_owned_card_printing`',
      'UPDATE `catalog_printing` SET',
    ])
  })

  it('keeps every owned row and quantity unchanged and re-keys the printings', () => {
    const sqlite = databaseBefore()
    seed(sqlite)
    const before = ownedRows(sqlite)

    applyPrintingsMigration(sqlite)

    expect(ownedRows(sqlite)).toEqual(before)
    expect(before).toHaveLength(4)
    expect((sqlite.prepare('SELECT sum(quantity) AS total FROM owned_card').get() as { total: number }).total).toBe(1005)
    expect(sqlite.prepare('SELECT id, card_id, set_code, rarity, rarity_code FROM catalog_printing ORDER BY id').all()).toEqual([
      { id: `${DM}|LOB-005|Ultra Rare`, card_id: DM, set_code: 'LOB-005', rarity: 'Ultra Rare', rarity_code: null },
      { id: `${DM}|SDY-006|Common`, card_id: DM, set_code: 'SDY-006', rarity: 'Common', rarity_code: null },
      { id: `${POG}|LOB-119|Common`, card_id: POG, set_code: 'LOB-119', rarity: 'Common', rarity_code: null },
    ])
    expect(sqlite.prepare('SELECT name FROM sqlite_master WHERE type = \'index\' AND name = \'idx_owned_card_printing\'').all())
      .toEqual([{ name: 'idx_owned_card_printing' }])
    // The foreign key still points at catalog_printing(id), ON DELETE SET NULL.
    expect(sqlite.prepare('SELECT * FROM pragma_foreign_key_list(\'owned_card\')').all())
      .toContainEqual(expect.objectContaining({ table: 'catalog_printing', from: 'printing_id', to: 'id', on_delete: 'SET NULL' }))
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('leaves a printing alone that an owned card references, so the foreign key holds', () => {
    const sqlite = databaseBefore()
    seed(sqlite)
    sqlite.prepare('UPDATE owned_card SET printing_id = ? WHERE id = ?').run('LOB-005', 'own-1')

    applyPrintingsMigration(sqlite)

    expect(sqlite.prepare('SELECT id FROM catalog_printing ORDER BY id').all()).toEqual([
      { id: `${DM}|SDY-006|Common` },
      { id: `${POG}|LOB-119|Common` },
      { id: 'LOB-005' },
    ])
    expect(sqlite.prepare('SELECT printing_id FROM owned_card WHERE id = ?').get('own-1')).toEqual({ printing_id: 'LOB-005' })
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps every row and quantity through the first sync, and old rows stay "printing unknown"', async () => {
    const sqlite = databaseBefore()
    seed(sqlite)
    const before = ownedRows(sqlite)
    applyPrintingsMigration(sqlite)
    const db = drizzle(sqlite, { schema })

    const result = await syncCatalog(db, {
      fetchAllCards: async () => [
        { ...darkMagicianFixture, card_sets: darkMagicianFixture.card_sets!.map(set => ({ ...set, set_rarity_code: set.set_code === 'LOB-005' ? '(UR)' : '(C)' })) },
        potOfGreedFixture,
      ],
      retireGuard: { minimum: 10, ratio: 1 },
    })

    // The re-keyed rows without a rarity code made way for the final keys.
    expect(result.cleanup.printings).toBe(2)
    expect(db.select({ id: schema.catalogPrinting.id }).from(schema.catalogPrinting).all().map(row => row.id).sort()).toEqual([
      `${DM}|LOB-005|UR`,
      `${DM}|SDY-006|C`,
      `${POG}|LOB-119|Common`,
    ])
    expect(ownedRows(sqlite)).toEqual(before)

    // Existing stacks are "printing unknown": a copy without a printing joins
    // them, a copy with one gets a stack of its own.
    const plain = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: DM, quantity: 1 }))
    const printed = await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: DM, printingId: `${DM}|LOB-005|UR` }))
    expect(plain).toMatchObject({ id: 'own-1', quantity: 4, printingId: null })
    expect(printed.id).not.toBe('own-1')
    expect(listOwnedCards(db, 'user-a').total).toBe(4)
  })
})
