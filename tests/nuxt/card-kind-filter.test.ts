import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import { CARD_KINDS, cardKinds } from '~~/shared/card-kind'
import type { CardKind } from '~~/shared/card-kind'
import * as schema from '../../server/db/schema'
import { buildCardListWhere, parseCardListQuery } from '../../server/utils/catalog-query'
import { searchCatalog } from '../../server/utils/catalog-search'
import { parseInventorySearchQuery } from '../../server/utils/inventory-search'
import { listOwnedCards, parseInventoryListQuery } from '../../server/utils/inventory'

// [name, type line, frameType]: every monster family of the real catalog, once
// with YGOPRODeck's frame_type and, for the same type line, once without (an
// older row, a fixture), which falls back to the type line's keywords.
const CARDS: Array<[string, string, string | null]> = [
  ['Normal', 'Normal Monster', 'normal'],
  ['Normal Tuner', 'Normal Tuner Monster', 'normal'],
  ['Effect', 'Effect Monster', 'effect'],
  ['Flip', 'Flip Effect Monster', 'effect'],
  ['Tuner', 'Tuner Monster', 'effect'],
  ['Spirit', 'Spirit Monster', 'effect'],
  ['Toon', 'Toon Monster', 'effect'],
  ['Union', 'Union Effect Monster', 'effect'],
  ['Gemini', 'Gemini Monster', 'effect'],
  ['Ritual', 'Ritual Monster', 'ritual'],
  ['Ritual Effect', 'Ritual Effect Monster', 'ritual'],
  ['Fusion', 'Fusion Monster', 'fusion'],
  ['Synchro Tuner', 'Synchro Tuner Monster', 'synchro'],
  ['XYZ', 'XYZ Monster', 'xyz'],
  ['Link', 'Link Monster', 'link'],
  ['Pendulum Effect', 'Pendulum Effect Monster', 'effect_pendulum'],
  ['Pendulum Normal', 'Pendulum Normal Monster', 'normal_pendulum'],
  ['Pendulum Flip', 'Pendulum Flip Effect Monster', 'effect_pendulum'],
  ['Pendulum Fusion', 'Pendulum Effect Fusion Monster', 'fusion_pendulum'],
  ['XYZ Pendulum', 'XYZ Pendulum Effect Monster', 'xyz_pendulum'],
  ['Token', 'Token', 'token'],
  ['Spell', 'Spell Card', 'spell'],
  ['Trap', 'Trap Card', 'trap'],
  ['Skill', 'Skill Card', 'skill'],
  // The same type lines without a frame_type, or with one the app doesn't know.
  ['Normal (no frame)', 'Normal Monster', null],
  ['Flip (no frame)', 'Flip Effect Monster', null],
  ['Toon (no frame)', 'Toon Monster', ''],
  ['Ritual Effect (no frame)', 'Ritual Effect Monster', null],
  ['Link (no frame)', 'Link Monster', null],
  ['Pendulum Effect (no frame)', 'Pendulum Effect Monster', null],
  ['Pendulum Normal (no frame)', 'Pendulum Normal Monster', null],
  ['Fusion Pendulum (no frame)', 'Pendulum Effect Fusion Monster', null],
  ['Spell (unknown frame)', 'Spell Card', 'mystery'],
  ['Trap (no frame)', 'Trap Card', null],
  ['Skill (no frame)', 'Skill Card', null],
]

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

const db = createTestDb()
const syncedAt = new Date('2026-01-01T00:00:00Z')

function namesOf(items: Array<{ name: string }>): string[] {
  return items.map(item => item.name).sort()
}

async function catalogNames(query: Record<string, string>): Promise<string[]> {
  const result = await searchCatalog(db, parseCardListQuery({ pageSize: '60', ...query }))
  return namesOf(result.items)
}

beforeAll(() => {
  db.insert(schema.catalogCard).values(CARDS.map(([name, type, frameType], index) => ({
    id: index + 1,
    name,
    type,
    frameType,
    desc: `${name} text`,
    syncedAt,
  }))).run()
  db.insert(schema.user).values({ id: 'u1', name: 'U', email: 'u@example.com', emailVerified: false, createdAt: syncedAt, updatedAt: syncedAt }).run()
  db.insert(schema.ownedCard).values(CARDS.map((_, index) => ({
    id: `oc-${index + 1}`,
    userId: 'u1',
    catalogCardId: index + 1,
    quantity: 1,
    createdAt: syncedAt,
    updatedAt: syncedAt,
  }))).run()
})

describe('cardKinds', () => {
  it('splits a Pendulum frame into its base kind and "pendulum"', () => {
    expect(cardKinds({ type: 'Pendulum Effect Monster', frameType: 'effect_pendulum' })).toEqual(['effect', 'pendulum'])
    expect(cardKinds({ type: 'Flip Effect Monster', frameType: 'effect' })).toEqual(['effect'])
    expect(cardKinds({ type: 'Pendulum Normal Monster' })).toEqual(['normal', 'pendulum'])
  })

  it('has no kind for a Skill Card or a card without a type', () => {
    expect(cardKinds({ type: 'Skill Card', frameType: 'skill' })).toEqual([])
    expect(cardKinds({})).toEqual([])
  })
})

describe('parseCardListQuery / parseInventorySearchQuery: kind', () => {
  it('reads CSV and repeated values and drops unknown kinds', () => {
    expect(parseCardListQuery({ kind: 'effect,ritual' }).kinds).toEqual(['effect', 'ritual'])
    expect(parseCardListQuery({ kind: ['xyz', 'bogus', 'xyz'] }).kinds).toEqual(['xyz'])
    expect(parseCardListQuery({}).kinds).toEqual([])
    expect(parseInventorySearchQuery({ kind: 'link,pendulum' }).kind).toEqual(['link', 'pendulum'])
    expect(parseInventorySearchQuery({ kind: 'nope' }).kind).toEqual([])
    expect(parseInventoryListQuery({ kind: 'spell' }).kind).toEqual(['spell'])
  })

  it('builds a condition even for unknown kinds only (they are ignored)', () => {
    expect(buildCardListWhere(parseCardListQuery({ kind: 'nope' }))).toBeDefined()
  })
})

describe('the SQL "Kartenart" filter', () => {
  it('"Effekt" includes Flip, Tuner, Spirit, Toon, Union and Gemini effect monsters', async () => {
    const effect = await catalogNames({ kind: 'effect' })
    for (const name of ['Effect', 'Flip', 'Tuner', 'Spirit', 'Toon', 'Union', 'Gemini', 'Pendulum Effect', 'Flip (no frame)', 'Toon (no frame)']) {
      expect(effect, name).toContain(name)
    }
    // Not the other frames, not Spell/Trap, not a Ritual Effect Monster.
    for (const name of ['Normal', 'Ritual Effect', 'Fusion', 'Spell', 'Trap', 'Token', 'Skill', 'Link']) {
      expect(effect, name).not.toContain(name)
    }
  })

  it('keeps the exact type filter as the finer one: "Effect Monster" still excludes Flip', async () => {
    expect(await catalogNames({ type: 'Effect Monster' })).toEqual(['Effect'])
    expect(await catalogNames({ kind: 'effect', type: 'Flip Effect Monster' })).toEqual(['Flip', 'Flip (no frame)'])
    // The two filters combine with AND: a Ritual Effect Monster is no "Effekt" kind.
    expect(await catalogNames({ kind: 'effect', type: 'Ritual Effect Monster' })).toEqual([])
    expect(await catalogNames({ kind: 'ritual', type: 'Ritual Effect Monster' })).toEqual(['Ritual Effect', 'Ritual Effect (no frame)'])
  })

  it('"Pendel" is the Pendulum half of any frame', async () => {
    expect(await catalogNames({ kind: 'pendulum' })).toEqual([
      'Fusion Pendulum (no frame)',
      'Pendulum Effect',
      'Pendulum Effect (no frame)',
      'Pendulum Flip',
      'Pendulum Fusion',
      'Pendulum Normal',
      'Pendulum Normal (no frame)',
      'XYZ Pendulum',
    ])
  })

  it('a Pendulum Fusion Monster is "Fusion" and "Pendel" at once', async () => {
    expect(await catalogNames({ kind: 'fusion' })).toEqual(['Fusion', 'Fusion Pendulum (no frame)', 'Pendulum Fusion'])
  })

  it('selecting several kinds matches any of them', async () => {
    expect(await catalogNames({ kind: 'spell,trap' })).toEqual(['Spell', 'Spell (unknown frame)', 'Trap', 'Trap (no frame)'])
    expect(await catalogNames({ kind: 'token,link' })).toEqual(['Link', 'Link (no frame)', 'Token'])
  })

  it('has no kind for Skill Cards', async () => {
    for (const kind of CARD_KINDS) {
      const names = await catalogNames({ kind })
      expect(names).not.toContain('Skill')
      expect(names).not.toContain('Skill (no frame)')
    }
  })

  it.each(CARD_KINDS)('"%s" agrees with cardKinds() for every card', async (kind: CardKind) => {
    const expected = CARDS
      .filter(([, type, frameType]) => cardKinds({ type, frameType }).includes(kind))
      .map(([name]) => name)
      .sort()
    expect(await catalogNames({ kind })).toEqual(expected)
    expect(expected.length).toBeGreaterThan(0)
  })

  it('every card has at most one frame kind', async () => {
    const all = await Promise.all(CARD_KINDS.filter(kind => kind !== 'pendulum').map(kind => catalogNames({ kind })))
    const seen = new Set<string>()
    for (const names of all) {
      for (const name of names) {
        expect(seen.has(name), name).toBe(false)
        seen.add(name)
      }
    }
  })
})

describe('the inventory list with a kind', () => {
  it('filters its rows the same way', () => {
    const rows = listOwnedCards(db, 'u1', { kind: ['effect'], pageSize: 100 })
    const expected = CARDS.filter(([, type, frameType]) => cardKinds({ type, frameType }).includes('effect')).map(([name]) => name).sort()
    expect(rows.items.map(row => row.cardName).sort()).toEqual(expected)
  })

  it('combines with the exact type', () => {
    const rows = listOwnedCards(db, 'u1', { kind: ['effect'], type: ['Toon Monster'], pageSize: 100 })
    expect(rows.items.map(row => row.cardName).sort()).toEqual(['Toon', 'Toon (no frame)'])
  })
})
