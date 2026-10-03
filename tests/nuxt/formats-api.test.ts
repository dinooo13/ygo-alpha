import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import {
  BUILTIN_FORMATS,
  cloneNameFor,
  cloneRuleFormat,
  createRuleFormat,
  deleteRuleFormat,
  getRuleFormat,
  listRuleFormats,
  requireAccessibleFormat,
  seedBuiltinFormats,
  updateRuleFormat,
  validateRuleFormatInput,
  validateRuleFormatUpdateInput,
} from '../../server/utils/rule-formats'
import {
  createDeck,
  getDeckDetail,
  listDecks,
  updateDeck,
  upsertDeckCard,
  validateDeckUpdateInput,
  validateDeckWithRules,
} from '../../server/utils/decks'
import { loadCardDataForValidation } from '../../server/utils/deck-validation'
import { evaluateDeck } from '../../shared/rule-formats'
import type { ValidationCardData } from '../../shared/rule-formats'

const CARD = {
  darkMagician: 46986414,
  potOfGreed: 55144522,
  monsterReborn: 83764719,
  stardustDragon: 44508094,
} as const

function createTestDb() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: './server/db/migrations' })
  return db
}

type TestDb = ReturnType<typeof createTestDb>

function seedUsersAndCatalog(db: TestDb) {
  const now = new Date()

  db.insert(schema.user).values([
    { id: 'user-a', name: 'User A', email: 'a@example.com', emailVerified: false, createdAt: now, updatedAt: now },
    { id: 'user-b', name: 'User B', email: 'b@example.com', emailVerified: false, createdAt: now, updatedAt: now },
  ]).run()

  db.insert(schema.catalogCard).values([
    {
      id: CARD.darkMagician,
      name: 'Dark Magician',
      type: 'Normal Monster',
      frameType: 'normal',
      desc: 'The ultimate wizard.',
      race: 'Spellcaster',
      attribute: 'DARK',
      atk: 2500,
      def: 2100,
      level: 7,
      tcgDate: '2002-03-08',
      ocgDate: '1999-02-04',
      syncedAt: now,
    },
    {
      id: CARD.potOfGreed,
      name: 'Pot of Greed',
      type: 'Spell Card',
      frameType: 'spell',
      desc: 'Draw two cards.',
      race: 'Normal',
      banlistInfo: { ban_tcg: 'Forbidden', ban_ocg: 'Forbidden', ban_goat: 'Limited' },
      tcgDate: '2002-03-08',
      syncedAt: now,
    },
    {
      id: CARD.monsterReborn,
      name: 'Monster Reborn',
      type: 'Spell Card',
      frameType: 'spell',
      desc: 'Special summon a monster.',
      race: 'Normal',
      banlistInfo: { ban_tcg: 'Limited', ban_goat: 'Forbidden' },
      tcgDate: '2002-03-08',
      syncedAt: now,
    },
    {
      id: CARD.stardustDragon,
      name: 'Stardust Dragon',
      type: 'Synchro Monster',
      frameType: 'synchro',
      desc: 'Tuner + 1 or more non-Tuner monsters.',
      race: 'Dragon',
      attribute: 'WIND',
      atk: 2500,
      def: 2000,
      level: 8,
      tcgDate: '2008-09-02',
      syncedAt: now,
    },
  ]).run()

  db.insert(schema.catalogSet).values([
    { id: 'starter-deck-yugi', name: 'Starter Deck: Yugi' },
    { id: 'the-duelist-genesis', name: 'The Duelist Genesis' },
  ]).run()

  db.insert(schema.catalogPrinting).values([
    { id: 'SDY-006', cardId: CARD.darkMagician, setId: 'starter-deck-yugi', setCode: 'SDY-006', rarity: 'Ultra Rare', price: null },
    { id: 'TDGS-EN040', cardId: CARD.stardustDragon, setId: 'the-duelist-genesis', setCode: 'TDGS-EN040', rarity: 'Ultra Rare', price: null },
  ]).run()
}

/** The HTTP status a `createError` from the utils would produce. */
function statusOf(run: () => unknown): number | undefined {
  try {
    run()
  }
  catch (error) {
    return (error as { statusCode?: number }).statusCode
  }
  return undefined
}

const SIMPLE_RULES = {
  rules: [
    { kind: 'deck_size', section: 'main', min: 1, max: 60 },
    { kind: 'card_status', status: 'forbidden', cardIds: [CARD.potOfGreed] },
  ],
}

let db: TestDb

beforeEach(() => {
  db = createTestDb()
  seedUsersAndCatalog(db)
  seedBuiltinFormats(db)
})

describe('built-in formats', () => {
  it('seeds every built-in idempotently and refreshes their rules', () => {
    const first = listRuleFormats(db, 'user-a').items
    expect(first.map(format => format.id)).toEqual(expect.arrayContaining(BUILTIN_FORMATS.map(format => format.id)))
    expect(first.every(format => format.isBuiltin)).toBe(true)

    // A stale/hand-edited built-in is repaired on the next boot.
    db.update(schema.ruleFormat)
      .set({ name: 'Kaputt', rules: { rules: [] } })
      .where(eq(schema.ruleFormat.id, 'tcg-advanced'))
      .run()

    seedBuiltinFormats(db)
    seedBuiltinFormats(db)

    const second = listRuleFormats(db, 'user-a').items
    expect(second).toHaveLength(BUILTIN_FORMATS.length)

    const advanced = second.find(format => format.id === 'tcg-advanced')!
    expect(advanced.name).toBe('TCG Advanced')
    expect(advanced.ruleCount).toBe(5)
  })

  it('models GOAT as banlist plus a release cut-off', () => {
    const goat = getRuleFormat(db, 'user-a', 'goat')

    expect(goat.rules.rules).toContainEqual({ kind: 'banlist', source: 'goat' })
    expect(goat.rules.rules).toContainEqual({
      kind: 'filter',
      match: 'not_matching',
      filter: { releasedBefore: '2005-07-01', region: 'tcg' },
      maxCopies: 0,
      // Canonical English; the UI shows formats.builtin.goat.cutoffLabel.
      label: 'Only cards up to June 2005',
    })
  })

  it('models Edison as banlist plus a release cut-off before 2010-04-25', () => {
    const edison = getRuleFormat(db, 'user-a', 'edison')

    expect(edison.rules.rules).toContainEqual({ kind: 'banlist', source: 'edison' })
    expect(edison.rules.rules).toContainEqual({
      kind: 'filter',
      match: 'not_matching',
      // releasedBefore is strict: 2010-04-24 (SJC Edison) is still before the 25th.
      filter: { releasedBefore: '2010-04-25', region: 'tcg' },
      maxCopies: 0,
      // Canonical English; the UI shows formats.builtin.edison.cutoffLabel.
      label: 'Only cards up to Duelist Pack: Kaiba (April 2010)',
    })
    expect(edison.isBuiltin).toBe(true)
  })

  it('models Classic Plus as deck sizes, its own banlist, and a rule 1 card-type filter', () => {
    const classicPlus = getRuleFormat(db, 'user-a', 'classic-plus')

    expect(classicPlus.rules.rules).toEqual([
      { kind: 'deck_size', section: 'main', min: 40, max: 50 },
      { kind: 'deck_size', section: 'extra', max: 10 },
      { kind: 'deck_size', section: 'side', max: 0 },
      { kind: 'copies', maxCopies: 3 },
      { kind: 'banlist', source: 'classic-plus' },
      expect.objectContaining({
        kind: 'filter',
        match: 'matching',
        filter: { types: expect.arrayContaining(['Synchro Monster', 'XYZ Monster', 'Link Monster', 'Pendulum Effect Monster']) },
        maxCopies: 0,
        label: 'Rule 1: Synchro, Xyz, Pendulum and Link monsters',
      }),
    ])
    // Small enough to pass the validator, so it can be cloned and edited like any format.
    expect(validateRuleFormatInput({ name: 'Copy', rules: classicPlus.rules }).rules).toEqual(classicPlus.rules)
  })

  it('reads the Classic Plus banlist status next to the official ones, and rule 1 by card type', () => {
    const rules = getRuleFormat(db, 'user-a', 'classic-plus').rules
    const cards = new Map<number, ValidationCardData>([
      [1, { id: 1, name: 'Card 1', type: 'Effect Monster', banlistInfo: { ban_tcg: 'Forbidden', ban_classic_plus: 'Semi-Limited' } }],
      [2, { id: 2, name: 'Card 2', type: 'Spell Card', banlistInfo: { ban_classic_plus: 'Limited' } }],
      [3, { id: 3, name: 'Card 3', type: 'Synchro Monster' }],
      [4, { id: 4, name: 'Card 4', type: 'Effect Monster', banlistInfo: { ban_goat: 'Forbidden' } }],
    ])

    const result = evaluateDeck(rules, [1, 2, 3, 4].map(id => ({ catalogCardId: id, section: 'main' as const, quantity: 1 })), cards)

    expect(result.cards[1]!.maxCopies).toBe(2)
    expect(result.cards[1]!.reasons).toEqual([{ kind: 'banlist', source: 'classic-plus', raw: 'Semi-Limited' }])
    expect(result.cards[2]!.maxCopies).toBe(1)
    expect(result.cards[3]!.maxCopies).toBe(0)
    expect(result.cards[4]!.maxCopies).toBe(3)
  })

  it('clones Classic Plus into an editable format', () => {
    const copy = cloneRuleFormat(db, 'user-a', 'classic-plus', validateRuleFormatUpdateInput({ rules: getRuleFormat(db, 'user-a', 'classic-plus').rules }))

    expect(copy.isBuiltin).toBe(false)
    expect(copy.rules).toEqual(getRuleFormat(db, 'user-a', 'classic-plus').rules)
  })

  it('refuses edits and deletes of a built-in with 403', () => {
    expect(statusOf(() => updateRuleFormat(db, 'user-a', 'tcg-advanced', { name: 'Meins' }))).toBe(403)
    expect(statusOf(() => deleteRuleFormat(db, 'user-a', 'goat'))).toBe(403)
    expect(getRuleFormat(db, 'user-a', 'tcg-advanced').name).toBe('TCG Advanced')
  })

  it('clones a built-in into an editable custom format', () => {
    const copy = cloneRuleFormat(db, 'user-a', 'goat')

    expect(copy.name).toBe('GOAT Format (copy)')
    expect(copy.isBuiltin).toBe(false)
    expect(copy.rules).toEqual(getRuleFormat(db, 'user-a', 'goat').rules)

    const renamed = updateRuleFormat(db, 'user-a', copy.id, { name: 'Mein GOAT' })
    expect(renamed.name).toBe('Mein GOAT')

    // The clone is the caller's, not a second built-in.
    expect(listRuleFormats(db, 'user-b').items.map(format => format.id)).not.toContain(copy.id)
  })

  it('names and translates a clone from the optional request overrides', () => {
    // The UI sends the copy's name and, for a built-in, its translated
    // description and rule labels (ADR 0014).
    const overrides = validateRuleFormatUpdateInput({
      name: 'GOAT Format (Kopie)',
      description: 'Retro format',
      rules: {
        rules: getRuleFormat(db, 'user-a', 'goat').rules.rules.map(rule => (
          rule.kind === 'filter' ? { ...rule, label: 'Nur Karten bis Juni 2005' } : rule
        )),
      },
    })
    const copy = cloneRuleFormat(db, 'user-a', 'goat', overrides)

    expect(copy.name).toBe('GOAT Format (Kopie)')
    expect(copy.description).toBe('Retro format')
    expect(copy.rules.rules).toContainEqual(expect.objectContaining({ kind: 'filter', label: 'Nur Karten bis Juni 2005' }))
    // The built-in itself is untouched.
    expect(getRuleFormat(db, 'user-a', 'goat').rules.rules)
      .toContainEqual(expect.objectContaining({ kind: 'filter', label: 'Only cards up to June 2005' }))
  })

  it('stores the built-in names and descriptions in English and answers with error codes', () => {
    expect(listRuleFormats(db, 'user-a').items.find(format => format.id === 'unlimited')).toMatchObject({
      name: 'No banlist',
      description: expect.stringContaining('no Forbidden & Limited List'),
    })

    expect(() => updateRuleFormat(db, 'user-a', 'tcg-advanced', { name: 'Meins' }))
      .toThrow(expect.objectContaining({ statusCode: 403, data: { code: 'format_readonly' } }))
    expect(() => getRuleFormat(db, 'user-a', 'missing'))
      .toThrow(expect.objectContaining({ statusCode: 404, data: { code: 'format_not_found' } }))
    expect(() => validateRuleFormatInput({ name: 'X', rules: { rules: [{ kind: 'deck_size', section: 'main', min: 5, max: 1 }] } }))
      .toThrow(expect.objectContaining({ statusCode: 400, data: { code: 'invalid_rules' } }))
  })

  it('keeps the "(copy)" suffix inside the 80 character name limit', () => {
    expect(cloneNameFor('Kurz')).toBe('Kurz (copy)')
    expect(cloneNameFor('x'.repeat(80))).toHaveLength(80)
    expect(cloneNameFor('x'.repeat(80)).endsWith(' (copy)')).toBe(true)
  })
})

describe('format validation', () => {
  it('normalizes input and rejects malformed formats with 400', () => {
    const input = validateRuleFormatInput({ name: '  Mein Format  ', description: '  ', rules: SIMPLE_RULES })
    expect(input.name).toBe('Mein Format')
    expect(input.description).toBeNull()
    expect(input.rules.rules).toHaveLength(2)

    expect(statusOf(() => validateRuleFormatInput({ name: '' }))).toBe(400)
    expect(statusOf(() => validateRuleFormatInput({ name: 'x'.repeat(81) }))).toBe(400)
    expect(statusOf(() => validateRuleFormatInput({ name: 'ok', rules: { rules: [{ kind: 'nope' }] } }))).toBe(400)
    expect(statusOf(() => validateRuleFormatInput('nope'))).toBe(400)

    expect(validateRuleFormatUpdateInput({})).toEqual({})
    expect(validateRuleFormatUpdateInput({ description: null })).toEqual({ description: null })
    expect(statusOf(() => validateRuleFormatUpdateInput({ name: '   ' }))).toBe(400)
  })

  it('rejects rules that reference unknown catalog cards', () => {
    const input = validateRuleFormatInput({
      name: 'Tippfehler',
      rules: { rules: [{ kind: 'card_status', status: 'forbidden', cardIds: [999999999] }] },
    })

    expect(statusOf(() => createRuleFormat(db, 'user-a', input))).toBe(400)
  })
})

describe('format CRUD and ownership', () => {
  it('creates, reads, updates, and deletes a custom format', () => {
    const created = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Nur alte Karten',
      description: 'Hausregeln',
      rules: SIMPLE_RULES,
    }))

    expect(created.isBuiltin).toBe(false)
    expect(created.cardNames[CARD.potOfGreed]).toBe('Pot of Greed')

    const listed = listRuleFormats(db, 'user-a').items
    // Built-ins come first, own formats after.
    expect(listed[0]!.isBuiltin).toBe(true)
    expect(listed.at(-1)!.id).toBe(created.id)
    expect(listed.at(-1)!.ruleCount).toBe(2)

    const updated = updateRuleFormat(db, 'user-a', created.id, validateRuleFormatUpdateInput({
      name: 'Noch älter',
      rules: { rules: [{ kind: 'copies', maxCopies: 1 }] },
    }))
    expect(updated.name).toBe('Noch älter')
    expect(updated.rules.rules).toEqual([{ kind: 'copies', maxCopies: 1 }])
    expect(updated.description).toBe('Hausregeln')

    deleteRuleFormat(db, 'user-a', created.id)
    expect(statusOf(() => getRuleFormat(db, 'user-a', created.id))).toBe(404)
  })

  it('hides another user\'s format behind a 404', () => {
    const mine = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Privat', rules: SIMPLE_RULES }))

    expect(statusOf(() => getRuleFormat(db, 'user-b', mine.id))).toBe(404)
    expect(statusOf(() => updateRuleFormat(db, 'user-b', mine.id, { name: 'Geklaut' }))).toBe(404)
    expect(statusOf(() => deleteRuleFormat(db, 'user-b', mine.id))).toBe(404)
    expect(statusOf(() => cloneRuleFormat(db, 'user-b', mine.id))).toBe(404)
    expect(statusOf(() => requireAccessibleFormat(db, 'user-b', mine.id))).toBe(404)

    expect(listRuleFormats(db, 'user-b').items.map(format => format.id)).not.toContain(mine.id)
    // Built-ins stay visible to everyone.
    expect(listRuleFormats(db, 'user-b').items.map(format => format.id)).toContain('tcg-advanced')
  })
})

describe('deck ↔ format integration', () => {
  function deckWithCards(userId = 'user-a') {
    const deck = createDeck(db, userId, { name: 'Format-Test', description: null })
    upsertDeckCard(db, userId, deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    upsertDeckCard(db, userId, deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })
    return deck
  }

  it('accepts a format id on update and rejects inaccessible ones', () => {
    const deck = deckWithCards()
    const foreign = createRuleFormat(db, 'user-b', validateRuleFormatInput({ name: 'Fremd', rules: SIMPLE_RULES }))

    expect(validateDeckUpdateInput({ format_id: 'tcg-advanced' })).toEqual({ formatId: 'tcg-advanced' })
    expect(validateDeckUpdateInput({ formatId: null })).toEqual({ formatId: null })
    expect(validateDeckUpdateInput({ formatId: '' })).toEqual({ formatId: null })
    expect(statusOf(() => validateDeckUpdateInput({ formatId: 42 }))).toBe(400)

    expect(statusOf(() => updateDeck(db, 'user-a', deck.id, { formatId: foreign.id }))).toBe(400)
    expect(statusOf(() => updateDeck(db, 'user-a', deck.id, { formatId: 'does-not-exist' }))).toBe(400)

    const assigned = updateDeck(db, 'user-a', deck.id, { formatId: 'tcg-advanced' })
    expect(assigned.format).toEqual({ id: 'tcg-advanced', name: 'TCG Advanced', isBuiltin: true })
  })

  it('returns live validation on the deck detail and after every card change', () => {
    const deck = deckWithCards()
    expect(getDeckDetail(db, 'user-a', deck.id).validation).toBeNull()

    const assigned = updateDeck(db, 'user-a', deck.id, { formatId: 'tcg-advanced' })
    expect(assigned.validation).not.toBeNull()
    expect(assigned.validation!.legal).toBe(false)
    expect(assigned.validation!.cards[CARD.potOfGreed]!.status).toBe('forbidden')
    expect(assigned.validation!.issues.map(issue => issue.code)).toContain('card_forbidden')
    // The main deck is far below 40 as well.
    expect(assigned.validation!.issues.map(issue => issue.code)).toContain('deck_size_min')

    // A write answers with the recomputed validation — no re-read needed.
    const afterRemoval = upsertDeckCard(db, 'user-a', deck.id, {
      catalogCardId: CARD.potOfGreed,
      section: 'main',
      quantity: 0,
    })
    expect(afterRemoval.validation!.cards[CARD.potOfGreed]).toBeUndefined()
    expect(afterRemoval.validation!.issues.map(issue => issue.code)).toEqual(['deck_size_min'])

    // Unassigning the format turns validation off again.
    expect(updateDeck(db, 'user-a', deck.id, { formatId: null }).validation).toBeNull()
  })

  it('keeps the deck but clears its format when the format is deleted', () => {
    const deck = deckWithCards()
    const custom = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Eigen', rules: SIMPLE_RULES }))

    updateDeck(db, 'user-a', deck.id, { formatId: custom.id })
    expect(getDeckDetail(db, 'user-a', deck.id).format?.id).toBe(custom.id)

    deleteRuleFormat(db, 'user-a', custom.id)

    const after = getDeckDetail(db, 'user-a', deck.id)
    expect(after.format).toBeNull()
    expect(after.validation).toBeNull()
    expect(after.counts.total).toBe(2)
  })

  it('validates a deck against unsaved rules without touching it', () => {
    const deck = deckWithCards()

    const preview = validateDeckWithRules(db, 'user-a', deck.id, {
      rules: [{ kind: 'card_status', status: 'forbidden', cardIds: [CARD.darkMagician] }],
    })

    expect(preview.legal).toBe(false)
    expect(preview.issues[0]!).toMatchObject({
      code: 'card_forbidden',
      params: { cardId: CARD.darkMagician, cardName: 'Dark Magician' },
      message: 'Dark Magician is forbidden in this format.',
    })
    // Nothing was stored.
    expect(getDeckDetail(db, 'user-a', deck.id).format).toBeNull()

    // Another user's deck is invisible.
    expect(statusOf(() => validateDeckWithRules(db, 'user-b', deck.id, { rules: [] }))).toBe(404)
  })

  it('loads exactly the card data the engine needs, including printing sets', () => {
    const data = loadCardDataForValidation(db, [CARD.darkMagician, CARD.potOfGreed, 999999])

    expect(data.size).toBe(2)
    expect(data.get(CARD.darkMagician)).toMatchObject({
      name: 'Dark Magician',
      type: 'Normal Monster',
      attribute: 'DARK',
      level: 7,
      tcgDate: '2002-03-08',
      setIds: ['starter-deck-yugi'],
    })
    // The official lists as stored; the Classic Plus status comes from the
    // generated list (tests/nuxt/classic-plus-banlist.test.ts).
    expect(data.get(CARD.potOfGreed)!.banlistInfo).toMatchObject({
      ban_tcg: 'Forbidden',
      ban_ocg: 'Forbidden',
      ban_goat: 'Limited',
    })
  })
})

describe('deck list with formats', () => {
  function deckNamed(name: string, cards: Array<[number, number]>) {
    const deck = createDeck(db, 'user-a', { name, description: null })
    for (const [catalogCardId, quantity] of cards) {
      upsertDeckCard(db, 'user-a', deck.id, {
        catalogCardId,
        section: catalogCardId === CARD.stardustDragon ? 'extra' : 'main',
        quantity,
      })
    }
    return deck
  }

  it('reports the format and legality per deck and filters on both', () => {
    const legalDeck = deckNamed('Sauber', [[CARD.darkMagician, 3]])
    const illegalDeck = deckNamed('Verboten', [[CARD.potOfGreed, 1]])
    const noFormatDeck = deckNamed('Formatlos', [[CARD.darkMagician, 1]])

    const custom = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Nur Erlaubtes',
      rules: { rules: [{ kind: 'banlist', source: 'tcg' }] },
    }))

    updateDeck(db, 'user-a', legalDeck.id, { formatId: custom.id })
    updateDeck(db, 'user-a', illegalDeck.id, { formatId: custom.id })

    const all = listDecks(db, 'user-a', {})
    const byName = Object.fromEntries(all.items.map(item => [item.name, item]))

    expect(byName.Sauber).toMatchObject({ formatId: custom.id, formatName: 'Nur Erlaubtes', legal: true })
    expect(byName.Verboten).toMatchObject({ formatId: custom.id, legal: false })
    expect(byName.Formatlos).toMatchObject({ formatId: null, formatName: null, legal: null })

    const byFormat = listDecks(db, 'user-a', { formatId: custom.id })
    expect(byFormat.total).toBe(2)
    expect(byFormat.items.map(item => item.name).sort()).toEqual(['Sauber', 'Verboten'])

    expect(listDecks(db, 'user-a', { formatId: 'none' }).items.map(item => item.name)).toEqual(['Formatlos'])

    const legalOnly = listDecks(db, 'user-a', { legal: true })
    expect(legalOnly.total).toBe(1)
    expect(legalOnly.items[0]!.name).toBe('Sauber')

    const illegalOnly = listDecks(db, 'user-a', { legal: false })
    expect(illegalOnly.items.map(item => item.name)).toEqual(['Verboten'])

    // Decks without a format are neither legal nor illegal.
    expect([...legalOnly.items, ...illegalOnly.items].map(item => item.name)).not.toContain('Formatlos')

    expect(noFormatDeck.id).toBeTruthy()
  })
})
