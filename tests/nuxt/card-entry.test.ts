import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  CATALOG_FIXTURE_ALIAS_ARTWORK_ID,
  CATALOG_FIXTURE_IDS,
  CATALOG_FIXTURE_RETIRED_IDS,
  seedCatalogFixture,
} from '../../server/db/fixtures/catalog-fixture'
import * as schema from '../../server/db/schema'
import {
  MAX_ENTRY_LINES,
  normalizeCardName,
  parseEntryText,
  parseSuggestLimit,
  parseSuggestRequest,
  resolveEntryLine,
  similarity,
  suggestCatalogMatches,
  suggestForRequest,
} from '../../server/utils/card-entry'
import { parseEntryLine } from '../../server/utils/entry-line'

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

const SYNCED_AT = new Date('2025-01-01T00:00:00.000Z')

// Cards whose names collide with the quantity/comma parsing rules, plus a
// non-ASCII name, are not in the shared E2E fixture — they only matter here.
function seedTrickyNames(db: TestDb) {
  db.insert(schema.catalogCard).values([
    { id: 23771716, name: '7 Colored Fish', type: 'Normal Monster', desc: 'A fish.', syncedAt: SYNCED_AT },
    { id: 11714098, name: '30,000-Year White Turtle', type: 'Normal Monster', desc: 'A turtle.', syncedAt: SYNCED_AT },
    { id: 89631140, name: '青眼の白龍', type: 'Normal Monster', desc: 'Blue-Eyes, OCG name.', syncedAt: SYNCED_AT },
  ]).run()
}

// A pool far larger than CANDIDATE_POOL_LIMIT that all share one token.
function seedDragonFlood(db: TestDb) {
  db.insert(schema.catalogCard).values([
    { id: 900000, name: 'Dragon', type: 'Normal Monster', desc: 'Just a dragon.', syncedAt: SYNCED_AT },
    ...Array.from({ length: 250 }, (_, index) => ({
      id: 900001 + index,
      name: `Dragon Filler ${String(index).padStart(3, '0')}`,
      type: 'Normal Monster',
      desc: 'Filler.',
      syncedAt: SYNCED_AT,
    })),
  ]).run()
}

describe('parseEntryLine', () => {
  it('reads a leading multiplier', () => {
    expect(parseEntryLine('3x Dark Magician')).toMatchObject({
      raw: '3x Dark Magician',
      quantity: 3,
      query: 'Dark Magician',
    })
  })

  it('reads a trailing multiplier', () => {
    expect(parseEntryLine('Dark Magician x3')).toMatchObject({ quantity: 3, query: 'Dark Magician' })
  })

  it('reads a bare leading count', () => {
    expect(parseEntryLine('3 Dark Magician')).toMatchObject({ quantity: 3, query: 'Dark Magician' })
  })

  it('defaults the quantity to 1 and caps it at 99', () => {
    expect(parseEntryLine('Pot of Greed')).toMatchObject({ quantity: 1, query: 'Pot of Greed' })
    expect(parseEntryLine('250x Kuriboh')).toMatchObject({ quantity: 99, query: 'Kuriboh' })
    expect(parseEntryLine('0x Kuriboh')).toMatchObject({ quantity: 1, query: 'Kuriboh' })
  })

  it('extracts a parenthesized set code and keeps the name as the query', () => {
    expect(parseEntryLine('2x Dark Magician (SDY-006)')).toMatchObject({
      quantity: 2,
      query: 'Dark Magician',
      setCode: 'SDY-006',
    })
  })

  it('extracts a lowercase parenthesized set code', () => {
    expect(parseEntryLine('dark magician (sdy-006)')).toMatchObject({
      quantity: 1,
      query: 'dark magician',
      setCode: 'SDY-006',
    })
  })

  it('treats a bare set code as both query and set code', () => {
    expect(parseEntryLine('sdy-006')).toMatchObject({ quantity: 1, query: 'SDY-006', setCode: 'SDY-006' })
    expect(parseEntryLine('LDS2-EN018')).toMatchObject({ query: 'LDS2-EN018', setCode: 'LDS2-EN018' })
  })

  it('recognizes a bare 8-digit passcode', () => {
    expect(parseEntryLine(' 46986414 ')).toMatchObject({ quantity: 1, query: '46986414', passcode: 46986414 })
    expect(parseEntryLine('2 46986414')).toMatchObject({ quantity: 2, passcode: 46986414 })
    expect(parseEntryLine('4698641')).not.toHaveProperty('passcode')
  })

  it('normalizes whitespace, tabs, and commas', () => {
    expect(parseEntryLine('\t2\tPot of Greed  ')).toMatchObject({ quantity: 2, query: 'Pot of Greed' })
    expect(parseEntryLine('3,Dark Magician')).toMatchObject({ quantity: 3, query: 'Dark Magician' })
    expect(parseEntryLine('   ')).toMatchObject({ quantity: 1, query: '' })
  })

  it('ignores a line that is only a quantity', () => {
    expect(parseEntryLine('3x')).toMatchObject({ quantity: 1, query: '' })
    expect(parseEntryLine('12')).toMatchObject({ quantity: 1, query: '' })
    expect(parseEntryText('3x\n2\nKuriboh')).toHaveLength(1)
  })

  it('keeps a dangling multiplier letter and trailing digits in the name', () => {
    expect(parseEntryLine('Kuriboh x')).toMatchObject({ quantity: 1, query: 'Kuriboh x' })
    expect(parseEntryLine('Ojama Trio 2')).toMatchObject({ quantity: 1, query: 'Ojama Trio 2' })
  })
})

describe('parseEntryText', () => {
  it('parses one card per line and skips blank lines', () => {
    const parsed = parseEntryText('2x Dark Magician\n\n  \nPot of Greed\r\nSDY-006')

    expect(parsed).toHaveLength(3)
    expect(parsed.map(line => line.query)).toEqual(['Dark Magician', 'Pot of Greed', 'SDY-006'])
    expect(parsed[0]!.quantity).toBe(2)
  })
})

describe('similarity', () => {
  it('scores OCR-style typos high and unrelated names low', () => {
    expect(similarity('darkmagician', 'darkmagician')).toBe(1)
    expect(similarity('darkmagican', 'darkmagician')).toBeGreaterThan(0.85)
    expect(similarity('blueeyeswhitedragen', 'blueeyeswhitedragon')).toBeGreaterThan(0.85)
    expect(similarity('potofgreed', 'darkmagician')).toBeLessThan(0.2)
  })
})

describe('suggestCatalogMatches', () => {
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    seedTrickyNames(db)
  })

  it('matches an exact name with full confidence, without printings (ADR 0017)', () => {
    const [best, ...rest] = suggestCatalogMatches(db, parseEntryLine('Dark Magician'))

    expect(best).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      name: 'Dark Magician',
      type: 'Normal Monster',
      matchedBy: 'exact',
      score: 1,
    })
    expect(best!.imageSmall).toContain(String(CATALOG_FIXTURE_IDS.darkMagician))
    expect(best).not.toHaveProperty('printings')
    expect(rest.every(candidate => candidate.score <= best!.score)).toBe(true)
  })

  it('matches a set code case-insensitively', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('sdy-006'))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      matchedBy: 'set_code',
      score: 1,
    })
  })

  it('matches a passcode to the exact catalog id', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine(String(CATALOG_FIXTURE_IDS.potOfGreed)))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.potOfGreed,
      name: 'Pot of Greed',
      matchedBy: 'passcode',
      score: 1,
    })
  })

  it('prefers the set code over a name hit when both are present', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('2x Dark Magician (SDY-006)'))

    expect(candidates[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      matchedBy: 'set_code',
      score: 1,
    })
  })

  it('keeps both cards when the set code contradicts the name', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('Pot of Greed (SDY-006)'))

    expect(candidates.find(candidate => candidate.matchedBy === 'set_code')?.cardId)
      .toBe(CATALOG_FIXTURE_IDS.darkMagician)
    expect(candidates.find(candidate => candidate.matchedBy === 'exact')?.cardId)
      .toBe(CATALOG_FIXTURE_IDS.potOfGreed)
  })

  it('still finds misspelled names from OCR or speech input', () => {
    const misspelled = suggestCatalogMatches(db, parseEntryLine('Dark Magican'))
    expect(misspelled[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      matchedBy: 'fuzzy',
    })
    expect(misspelled[0]!.score).toBeGreaterThanOrEqual(0.85)

    const dictated = suggestCatalogMatches(db, parseEntryLine('Blue Eyes White Dragen'))
    expect(dictated[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.blueEyesWhiteDragon,
      name: 'Blue-Eyes White Dragon',
    })
    expect(dictated[0]!.score).toBeGreaterThanOrEqual(0.85)
  })

  it('ranks the closer card first for a shared prefix', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('Blue-Eyes'))

    expect(candidates.length).toBeGreaterThan(1)
    expect(candidates[0]!.name).toBe('Blue-Eyes White Dragon')
    expect(candidates.map(candidate => candidate.name)).toContain('Blue-Eyes Ultimate Dragon')
    expect(candidates[0]!.score).toBeGreaterThanOrEqual(candidates[1]!.score)
    expect(candidates.every(candidate => candidate.matchedBy === 'prefix')).toBe(true)
  })

  it('returns no candidates for an unknown card', () => {
    expect(suggestCatalogMatches(db, parseEntryLine('Zzyzx Nonexistent Whatsit'))).toEqual([])
  })

  it('honours the limit', () => {
    expect(suggestCatalogMatches(db, parseEntryLine('Dragon'), { limit: 2 })).toHaveLength(2)
  })

  it('treats LIKE wildcards as literal characters', () => {
    expect(suggestCatalogMatches(db, parseEntryLine('%'))).toEqual([])
    expect(suggestCatalogMatches(db, parseEntryLine('_'))).toEqual([])
    expect(suggestCatalogMatches(db, parseEntryLine('%%%'))).toEqual([])
    expect(suggestCatalogMatches(db, parseEntryLine('\\'))).toEqual([])
  })

  it('searches names that normalize to an empty ASCII string', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('青眼の白龍'))

    expect(candidates[0]).toMatchObject({ name: '青眼の白龍', matchedBy: 'exact', score: 1 })
  })
})

describe('suggestCatalogMatches with German names (ADR 0015)', () => {
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
  })

  it('matches a German name exactly, with the English and German names in the candidate', () => {
    const [best] = suggestCatalogMatches(db, parseEntryLine('2x Dunkler Magier'))

    expect(best).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      name: 'Dark Magician',
      nameDe: 'Dunkler Magier',
      matchedBy: 'exact',
      score: 1,
    })
  })

  it('folds umlauts and punctuation in German names', () => {
    for (const line of ['Blauäugiger w. Drache', 'blauaugiger w drache', 'BLAUÄUGIGER W. DRACHE']) {
      expect(suggestCatalogMatches(db, parseEntryLine(line))[0], line).toMatchObject({
        cardId: CATALOG_FIXTURE_IDS.blueEyesWhiteDragon,
        matchedBy: 'exact',
        score: 1,
      })
    }
  })

  it('still finds misspelled German names', () => {
    const [best] = suggestCatalogMatches(db, parseEntryLine('Dunkler Magir'))

    expect(best).toMatchObject({ cardId: CATALOG_FIXTURE_IDS.darkMagician, matchedBy: 'fuzzy' })
    expect(best!.score).toBeGreaterThanOrEqual(0.85)
  })

  it('ranks German prefix hits like English ones', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine('Blauäugiger'))

    expect(candidates.map(candidate => candidate.cardId)).toEqual([
      CATALOG_FIXTURE_IDS.blueEyesWhiteDragon,
      CATALOG_FIXTURE_IDS.blueEyesUltimateDragon,
    ])
    expect(candidates.every(candidate => candidate.matchedBy === 'prefix')).toBe(true)
  })

  it('reports nameDe as null for a card without German data', () => {
    const [best] = suggestCatalogMatches(db, parseEntryLine('Raigeki'))

    expect(best).toMatchObject({ cardId: CATALOG_FIXTURE_IDS.raigeki, nameDe: null, matchedBy: 'exact' })
  })
})

describe('suggestCatalogMatches with retired cards (ADR 0019)', () => {
  const RETIRED_RENUMBERED = 12345678
  const RETIRED_DROPPED = 87654321
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    const retiredAt = new Date('2026-01-01T00:00:00.000Z')
    db.insert(schema.catalogCard).values([
      {
        id: RETIRED_RENUMBERED,
        name: 'Dark Magician',
        nameSearch: 'darkmagician',
        type: 'Normal Monster',
        desc: 'Old passcode.',
        syncedAt: SYNCED_AT,
        retiredAt,
        replacedById: CATALOG_FIXTURE_IDS.darkMagician,
      },
      { id: RETIRED_DROPPED, name: 'Retired Nobody', nameSearch: 'retirednobody', type: 'Normal Monster', desc: 'Gone.', syncedAt: SYNCED_AT, retiredAt },
    ]).run()
    db.insert(schema.catalogPrinting).values({
      id: 'RET-001', cardId: RETIRED_DROPPED, setId: 'starter-deck-yugi', setCode: 'RET-001',
    }).run()
    db.insert(schema.catalogCardTranslation).values({
      cardId: RETIRED_RENUMBERED,
      locale: 'de',
      name: 'Dunkler Magier',
      nameSearch: 'dunklermagier',
      source: 'ygoresources-git',
      syncedAt: SYNCED_AT,
    }).run()
  })

  function ids(line: string) {
    return suggestCatalogMatches(db, parseEntryLine(line), { limit: 20 }).map(candidate => candidate.cardId)
  }

  it('leaves retired cards out of the English and German name pools', () => {
    expect(ids('Dark Magician')).toContain(CATALOG_FIXTURE_IDS.darkMagician)
    expect(ids('Dark Magician')).not.toContain(RETIRED_RENUMBERED)
    expect(ids('Dunkler Magier')).toContain(CATALOG_FIXTURE_IDS.darkMagician)
    expect(ids('Dunkler Magier')).not.toContain(RETIRED_RENUMBERED)
    expect(ids('Retired Nobody')).not.toContain(RETIRED_DROPPED)
  })

  it('leaves retired cards out of set code matches', () => {
    expect(ids('RET-001')).toEqual([])
  })

  it('resolves the passcode of a renumbered card to its replacement', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine(String(RETIRED_RENUMBERED)))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      cardId: CATALOG_FIXTURE_IDS.darkMagician,
      matchedBy: 'passcode',
      score: 1,
    })
  })

  it('gives no candidate for the passcode of a retired card without a replacement', () => {
    expect(ids(String(RETIRED_DROPPED))).toEqual([])
    expect(ids(String(CATALOG_FIXTURE_RETIRED_IDS.leviathanOfAtlantisDaedalus))).toEqual([])
  })

  it('resolves the passcode of an alternate artwork to its card (ADR 0023)', () => {
    const candidates = suggestCatalogMatches(db, parseEntryLine(String(CATALOG_FIXTURE_ALIAS_ARTWORK_ID)))

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ cardId: CATALOG_FIXTURE_IDS.darkMagician, matchedBy: 'passcode', score: 1 })
    // The fixture's old Odd-Eyes passcode: a retired card row wins over its artwork.
    expect(ids(String(CATALOG_FIXTURE_RETIRED_IDS.oddEyesPendulumDragonOld)))
      .toEqual([CATALOG_FIXTURE_IDS.oddEyesPendulumDragon])
  })
})

describe('suggestCatalogMatches candidate pool', () => {
  it('still surfaces the exact match when a token floods the catalog', () => {
    const db = createTestDb()
    seedCatalogFixture(db)
    seedDragonFlood(db)

    const candidates = suggestCatalogMatches(db, parseEntryLine('Dragon'))

    expect(candidates[0]).toMatchObject({ name: 'Dragon', matchedBy: 'exact', score: 1 })
  })
})

describe('resolveEntryLine', () => {
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    seedTrickyNames(db)
  })

  it('keeps a leading number that belongs to the card name', () => {
    const resolved = resolveEntryLine(db, parseEntryLine('7 Colored Fish'))

    expect(resolved).toMatchObject({ quantity: 1, query: '7 Colored Fish' })
    expect(suggestCatalogMatches(db, resolved)[0]).toMatchObject({ name: '7 Colored Fish', matchedBy: 'exact' })
  })

  it('keeps a comma that belongs to the card name', () => {
    const resolved = resolveEntryLine(db, parseEntryLine('30,000-Year White Turtle'))

    expect(resolved).toMatchObject({ quantity: 1, query: '30,000-Year White Turtle' })
    expect(suggestCatalogMatches(db, resolved)[0]).toMatchObject({
      name: '30,000-Year White Turtle',
      matchedBy: 'exact',
    })
  })

  it('leaves a real quantity alone', () => {
    expect(resolveEntryLine(db, parseEntryLine('3 Dark Magician'))).toMatchObject({
      quantity: 3,
      query: 'Dark Magician',
    })
    expect(resolveEntryLine(db, parseEntryLine('2x Kuriboh'))).toMatchObject({ quantity: 2, query: 'Kuriboh' })
  })

  it('keeps a leading number that belongs to a German card name', () => {
    // Hypothetical German name, only to give "7 Colored Fish" a German twin
    // that starts with a number as well.
    db.insert(schema.catalogCardTranslation).values({
      cardId: 23771716,
      locale: 'de',
      name: '7 bunte Fische',
      nameSearch: '7buntefische',
      source: 'ygoresources-git',
      syncedAt: SYNCED_AT,
    }).run()

    const resolved = resolveEntryLine(db, parseEntryLine('7 Bunte Fische'))

    expect(resolved).toMatchObject({ quantity: 1, query: '7 Bunte Fische' })
    expect(suggestCatalogMatches(db, resolved)[0]).toMatchObject({ cardId: 23771716, matchedBy: 'exact' })
  })
})

describe('normalizeCardName', () => {
  it('uses the shared folding, so ß and umlauts compare', () => {
    expect(normalizeCardName('Straße')).toBe('strasse')
    expect(normalizeCardName('STRASSE')).toBe('strasse')
    expect(normalizeCardName('Blauäugiger w. Drache')).toBe('blauaugigerwdrache')
  })
})

describe('parseSuggestRequest', () => {
  it('merges the text and item list into parsed lines', () => {
    const request = parseSuggestRequest({
      text: '2x Dark Magician\n\nPot of Greed',
      items: ['SDY-006'],
      limit: 3,
    })

    expect(request.lines.map(line => line.query)).toEqual(['Dark Magician', 'Pot of Greed', 'SDY-006'])
    expect(request.lines[0]!.quantity).toBe(2)
    expect(request.limit).toBe(3)
  })

  it('rejects payloads that exceed the line or size limits before parsing', () => {
    const tooManyLines = Array.from({ length: MAX_ENTRY_LINES + 1 }, (_, i) => `Card ${i}`).join('\n')

    expect(() => parseSuggestRequest({ text: tooManyLines })).toThrow()
    expect(() => parseSuggestRequest({ items: Array.from({ length: MAX_ENTRY_LINES + 1 }, () => 'Kuriboh') })).toThrow()
    expect(() => parseSuggestRequest({ text: 'a'.repeat(20_001) })).toThrow()
    expect(parseSuggestRequest({ text: Array.from({ length: MAX_ENTRY_LINES }, (_, i) => `Card ${i}`).join('\n') })
      .lines).toHaveLength(MAX_ENTRY_LINES)
  })

  it('rejects empty and malformed input', () => {
    expect(() => parseSuggestRequest({ text: '   \n\n' })).toThrow()
    expect(() => parseSuggestRequest({})).toThrow()
    expect(() => parseSuggestRequest('nope')).toThrow()
    expect(() => parseSuggestRequest({ items: [42] })).toThrow()
    expect(() => parseSuggestRequest({ text: 42 })).toThrow()
  })

  it('clamps the requested limit', () => {
    expect(parseSuggestLimit(undefined)).toBe(5)
    expect(parseSuggestLimit(3)).toBe(3)
    expect(parseSuggestLimit(500)).toBe(20)
    expect(() => parseSuggestLimit(0)).toThrow()
  })
})

// A real deck code copied from YGO Omega's "Export" (43 Main + Extra cards, 10 Side cards).
const OMEGA_CODE = '0+a6LjWfEYbv/L/MAMIXps0AY4kjoiww/PbQdlYYFuz7zgDDKmaXWGB4zsmPjCC8uMSeGYRfys5kheHgpcuZQXj3GXs4XnDhIQscP7oGx/ll7xlguPCSLrM1cx1L/+bXjBYbk1k0uaWYg753MQcD8Ub3TWD8MGIuGIPsBNkBAA=='

const OMEGA_RECIPE = `Monster
3 Tearlaments Havnis
1 Danger!? Jackalope?
Spell
2 Polymerization
Trap
2 Tearlaments Sulliek
Extra
2 Spright Elf
Side
2 Cosmic Cyclone`

function queries(text: string) {
  return parseSuggestRequest({ text }).lines.map(line => `${line.quantity} ${line.query}`)
}

describe('quick capture reads deck lists (header and comment lines are no cards)', () => {
  const HEADERS = [
    'Monster', 'Monsters', 'Monster Cards', 'Monsterkarten',
    'Spell', 'Spells', 'Spell Cards', 'Zauber', 'Zauberkarten',
    'Trap', 'Traps', 'Trap Cards', 'Fallen', 'Fallenkarten',
    'Main', 'Main Deck', 'Maindeck', 'Hauptdeck',
    'Extra', 'Extra Deck', 'Extradeck',
    'Side', 'Side Deck', 'Sidedeck',
  ]

  it.each(HEADERS)('does not turn the header "%s" into a row', (header) => {
    for (const variant of [header, header.toUpperCase(), `${header}:`, `${header} (21)`, `${header}: 21`]) {
      expect(queries(`${variant}\n3 Kuriboh`), variant).toEqual(['3 Kuriboh'])
      expect(parseEntryText(`${variant}\n3 Kuriboh`), variant).toHaveLength(1)
    }
  })

  it('does not turn YDK markers and comments into rows', () => {
    expect(queries('#created by Fabian\n#main\n!side\n#extra\n#whatever\nKuriboh')).toEqual(['1 Kuriboh'])
  })

  it('reads the Omega recipe sample', () => {
    expect(queries(OMEGA_RECIPE)).toEqual([
      '3 Tearlaments Havnis',
      '1 Danger!? Jackalope?',
      '2 Polymerization',
      '2 Tearlaments Sulliek',
      '2 Spright Elf',
      '2 Cosmic Cyclone',
    ])
  })

  it('reads a YDK as passcodes, a 7-digit one included, and merges the lines of a card', () => {
    const lines = parseSuggestRequest({ text: '#created by x\n#main\n46986414\n46986414\n5318639\n#extra\n44508094\n!side\n46986414\n' }).lines

    expect(lines).toEqual([
      { raw: '46986414', quantity: 3, query: '46986414', passcode: 46986414 },
      { raw: '5318639', quantity: 1, query: '05318639', passcode: 5318639 },
      { raw: '44508094', quantity: 1, query: '44508094', passcode: 44508094 },
    ])
  })

  it('reads the ydke sample', () => {
    const lines = parseSuggestRequest({ text: 'ydke://o6lXBZyFNAI=!viOnAg==!7ydRAA==!' }).lines

    expect(lines.map(line => line.passcode)).toEqual([89631139, 36996508, 44508094, 5318639])
    expect(lines.every(line => line.quantity === 1)).toBe(true)
  })

  it('reads the Omega code sample', () => {
    const lines = parseSuggestRequest({ text: OMEGA_CODE }).lines

    expect(lines[0]).toMatchObject({ passcode: 27204311, quantity: 3 })
    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(53)
    expect(lines.every(line => line.passcode !== undefined)).toBe(true)
  })

  it('merges before it counts: a 40-card YDK with one line per copy fits the line cap', () => {
    const ydk = [
      '#main',
      ...Array.from({ length: 40 }, (_, index) => String(10_000_000 + (index % 14))),
      '#extra',
      ...Array.from({ length: 15 }, (_, index) => String(20_000_000 + (index % 5))),
      '!side',
    ].join('\n')

    expect(ydk.split('\n').length).toBeGreaterThan(MAX_ENTRY_LINES)
    const { lines } = parseSuggestRequest({ text: ydk })
    expect(lines).toHaveLength(19)
    expect(lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(55)
  })

  it('still rejects more distinct cards than the line cap, with a code for the UI', () => {
    const text = Array.from({ length: MAX_ENTRY_LINES + 1 }, (_, index) => String(10_000_000 + index)).join('\n')

    expect(() => parseSuggestRequest({ text })).toThrow(expect.objectContaining({ data: { code: 'too_many_lines', params: { max: MAX_ENTRY_LINES } } }))
  })

  it('keeps the character cap and rejects a broken ydke link', () => {
    expect(() => parseSuggestRequest({ text: `ydke://${'A'.repeat(20_000)}` })).toThrow()
    expect(() => parseSuggestRequest({ text: 'ydke://nope' })).toThrow()
    expect(() => parseSuggestRequest({ items: ['x'.repeat(20_001)] })).toThrow()
  })

  it('merges equal lines across sections and items', () => {
    expect(queries('Monster\n2x Kuriboh\nSide\nKuriboh x1\nExtra\nKuriboh')).toEqual(['4 Kuriboh'])
    expect(parseSuggestRequest({ text: 'Kuriboh', items: ['2x Kuriboh'] }).lines).toHaveLength(1)
  })
})

describe('quick capture resolution of deck lists', () => {
  let db: TestDb

  beforeAll(() => {
    db = createTestDb()
    seedCatalogFixture(db)
    seedTrickyNames(db)
    db.insert(schema.catalogCard).values([
      { id: 5318639, name: 'Mystical Space Typhoon', type: 'Spell Card', frameType: 'spell', desc: 'Destroy 1 Spell/Trap.', syncedAt: SYNCED_AT },
      { id: 36996508, name: 'Gravity Bind', type: 'Trap Card', frameType: 'trap', desc: 'Level 4 or higher monsters cannot attack.', syncedAt: SYNCED_AT },
      { id: 90000001, name: 'Monster Egg', type: 'Normal Monster', frameType: 'normal', desc: 'An egg.', syncedAt: SYNCED_AT },
    ]).run()
    db.insert(schema.catalogCardTranslation).values({
      cardId: 90000001, locale: 'de', name: 'Monster-Ei', nameSearch: 'monsterei', source: 'ygoresources-git', syncedAt: SYNCED_AT,
    }).run()
  })

  function lookup(text: string) {
    return suggestForRequest(db, parseSuggestRequest({ text }))
  }

  it('never looks up a header: "Monster" no longer finds Monster-Ei', () => {
    const results = lookup('Monster\n3 Dark Magician\nZauber\nPot of Greed\nFallen\nExtra Deck\nSide Deck')

    expect(results.map(result => result.input.query)).toEqual(['Dark Magician', 'Pot of Greed'])
    expect(results.map(result => result.candidates[0]!.matchedBy)).toEqual(['exact', 'exact'])
    // The bug: it was a row, auto-selected at 0.857.
    expect(suggestCatalogMatches(db, parseEntryLine('Monster'))[0]).toMatchObject({ cardId: 90000001 })
  })

  it('resolves the Omega recipe lines that exist in the catalog', () => {
    const results = lookup('Monster\n3 Dark Magician\n1 Kuriboh\nSpell\n2 Raigeki\nExtra\n1 Stardust Dragon\nSide\n2 Monster Reborn')

    expect(results.map(result => [result.input.quantity, result.candidates[0]!.cardId])).toEqual([
      [3, CATALOG_FIXTURE_IDS.darkMagician],
      [1, CATALOG_FIXTURE_IDS.kuriboh],
      [2, CATALOG_FIXTURE_IDS.raigeki],
      [1, CATALOG_FIXTURE_IDS.stardustDragon],
      [2, CATALOG_FIXTURE_IDS.monsterReborn],
    ])
  })

  it('resolves a YDK by passcode, the 7-digit one too, and merges the copies', () => {
    const results = lookup('#main\n46986414\n46986414\n5318639\n#extra\n44508094\n!side\n46986414\n99999999')

    expect(results.map(result => [result.input.quantity, result.candidates[0]?.cardId ?? null, result.candidates[0]?.matchedBy ?? null])).toEqual([
      [3, CATALOG_FIXTURE_IDS.darkMagician, 'passcode'],
      [1, 5318639, 'passcode'],
      [1, CATALOG_FIXTURE_IDS.stardustDragon, 'passcode'],
      // An unknown passcode is a row without a candidate, never a crash.
      [1, null, null],
    ])
  })

  it('resolves a ydke link by passcode', () => {
    const results = lookup('ydke://o6lXBZyFNAI=!viOnAg==!7ydRAA==!')

    expect(results.map(result => result.candidates[0]?.cardId ?? null)).toEqual([
      CATALOG_FIXTURE_IDS.blueEyesWhiteDragon,
      36996508,
      CATALOG_FIXTURE_IDS.stardustDragon,
      5318639,
    ])
  })

  it('turns the unknown passcodes of an Omega code into unresolved rows', () => {
    const results = lookup(OMEGA_CODE)

    expect(results.length).toBeGreaterThan(10)
    expect(results.every(result => result.input.passcode !== undefined)).toBe(true)
    expect(results.every(result => result.candidates.length === 0)).toBe(true)
  })

  it('counts two "7 Colored Fish" lines as 7 + 7 copies of one card after the lookup', () => {
    const results = lookup('7 Colored Fish\n7 Colored Fish')

    expect(results).toHaveLength(1)
    expect(results[0]!.input).toMatchObject({ quantity: 2, query: '7 Colored Fish' })
    expect(results[0]!.candidates[0]).toMatchObject({ name: '7 Colored Fish', matchedBy: 'exact' })
  })
})
