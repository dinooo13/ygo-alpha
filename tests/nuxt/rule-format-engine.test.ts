import { describe, expect, it } from 'vitest'
import {
  banlistCopies,
  cardHasEffect,
  evaluateDeck,
  matchesCardFilter,
  MAX_COPIES_RULE,
  RuleSetValidationError,
  validateRuleSet,
} from '../../shared/rule-formats'
import type { DeckCardEntry, Rule, ValidationCardData } from '../../shared/rule-formats'
import { BUILTIN_FORMATS } from '../../server/utils/rule-formats'

// Real cards from the E2E catalog fixture (server/db/fixtures/catalog-fixture.ts),
// reduced to the fields the engine reads.
const CARDS = {
  darkMagician: {
    id: 46986414,
    name: 'Dark Magician',
    type: 'Normal Monster',
    frameType: 'normal',
    attribute: 'DARK',
    race: 'Spellcaster',
    archetype: 'Dark Magician',
    level: 7,
    atk: 2500,
    def: 2100,
    banlistInfo: null,
    tcgDate: '2002-03-08',
    ocgDate: '1999-02-04',
    setIds: ['starter-deck-yugi', 'legend-of-blue-eyes-white-dragon'],
  },
  kuriboh: {
    id: 40640057,
    name: 'Kuriboh',
    type: 'Effect Monster',
    frameType: 'effect',
    attribute: 'DARK',
    race: 'Fiend',
    archetype: 'Kuriboh',
    level: 1,
    atk: 300,
    def: 200,
    banlistInfo: null,
    tcgDate: '2002-06-26',
    ocgDate: '2000-01-27',
    setIds: ['metal-raiders'],
  },
  potOfGreed: {
    id: 55144522,
    name: 'Pot of Greed',
    type: 'Spell Card',
    frameType: 'spell',
    attribute: null,
    race: 'Normal',
    archetype: 'Greed',
    level: null,
    atk: null,
    def: null,
    banlistInfo: { ban_tcg: 'Forbidden', ban_ocg: 'Forbidden', ban_goat: 'Limited' },
    tcgDate: '2002-03-08',
    ocgDate: '1999-05-27',
    setIds: ['legend-of-blue-eyes-white-dragon'],
  },
  monsterReborn: {
    id: 83764719,
    name: 'Monster Reborn',
    type: 'Spell Card',
    frameType: 'spell',
    attribute: null,
    race: 'Normal',
    archetype: null,
    level: null,
    atk: null,
    def: null,
    banlistInfo: { ban_tcg: 'Limited', ban_ocg: 'Limited', ban_goat: 'Forbidden' },
    tcgDate: '2002-03-08',
    ocgDate: '1999-03-27',
    setIds: ['legend-of-blue-eyes-white-dragon'],
  },
  raigeki: {
    id: 12580477,
    name: 'Raigeki',
    type: 'Spell Card',
    frameType: 'spell',
    attribute: null,
    race: 'Normal',
    archetype: null,
    level: null,
    atk: null,
    def: null,
    // Unlimited in TCG/OCG today, still Forbidden on the GOAT list.
    banlistInfo: { ban_goat: 'Forbidden' },
    tcgDate: '2002-03-08',
    ocgDate: '1999-03-06',
    setIds: ['legend-of-blue-eyes-white-dragon'],
  },
  stardustDragon: {
    id: 44508094,
    name: 'Stardust Dragon',
    type: 'Synchro Monster',
    frameType: 'synchro',
    attribute: 'WIND',
    race: 'Dragon',
    archetype: 'Stardust',
    level: 8,
    atk: 2500,
    def: 2000,
    banlistInfo: null,
    tcgDate: '2008-09-02',
    ocgDate: '2008-04-19',
    setIds: ['the-duelist-genesis'],
  },
  // OCG-only release: no TCG date at all.
  ocgOnly: {
    id: 999001,
    name: 'Nur im OCG',
    type: 'Effect Monster',
    frameType: 'effect',
    attribute: 'FIRE',
    race: 'Warrior',
    archetype: null,
    level: 4,
    atk: 1800,
    def: 1000,
    banlistInfo: null,
    tcgDate: null,
    ocgDate: '2003-05-15',
    setIds: [],
  },
} as const satisfies Record<string, ValidationCardData>

const ALL_CARDS = Object.values(CARDS) as ValidationCardData[]

function card(name: keyof typeof CARDS, section: DeckCardEntry['section'], quantity: number): DeckCardEntry {
  return { catalogCardId: CARDS[name].id, section, quantity }
}

function codes(issues: Array<{ code: string }>) {
  return issues.map(issue => issue.code)
}

describe('card predicates', () => {
  it('treats every non-Normal monster and all spells/traps as having an effect', () => {
    expect(cardHasEffect({ type: 'Normal Monster' })).toBe(false)
    expect(cardHasEffect({ type: 'Normal Tuner Monster' })).toBe(false)
    expect(cardHasEffect({ type: 'Pendulum Normal Monster' })).toBe(false)

    expect(cardHasEffect({ type: 'Effect Monster' })).toBe(true)
    expect(cardHasEffect({ type: 'Synchro Monster' })).toBe(true)
    // "Normal" here is the *race*, not the type — spells always have an effect.
    expect(cardHasEffect({ type: 'Spell Card' })).toBe(true)
    expect(cardHasEffect({ type: 'Trap Card' })).toBe(true)
    expect(cardHasEffect({ type: 'Skill Card' })).toBe(true)
  })

  it('maps banlist values to copy limits', () => {
    expect(banlistCopies('Forbidden')).toBe(0)
    expect(banlistCopies('Limited')).toBe(1)
    expect(banlistCopies('Semi-Limited')).toBe(2)
    expect(banlistCopies('semi limited')).toBe(2)
    expect(banlistCopies(undefined)).toBeNull()
    expect(banlistCopies('Unlimited')).toBeNull()
  })
})

describe('card filter matching', () => {
  it('ANDs fields and ORs the values inside a field', () => {
    expect(matchesCardFilter({}, CARDS.darkMagician)).toBe(true)

    expect(matchesCardFilter({ types: ['Spell Card', 'Trap Card'] }, CARDS.potOfGreed)).toBe(true)
    expect(matchesCardFilter({ types: ['Spell Card'] }, CARDS.darkMagician)).toBe(false)

    expect(matchesCardFilter({ attributes: ['DARK'], races: ['Spellcaster'] }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ attributes: ['DARK'], races: ['Dragon'] }, CARDS.darkMagician)).toBe(false)

    // A card without the field never matches a filter on it.
    expect(matchesCardFilter({ attributes: ['DARK'] }, CARDS.potOfGreed)).toBe(false)
  })

  it('matches sets by printing, card ids, name, and effect', () => {
    expect(matchesCardFilter({ setIds: ['starter-deck-yugi'] }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ setIds: ['metal-raiders'] }, CARDS.darkMagician)).toBe(false)

    expect(matchesCardFilter({ cardIds: [CARDS.kuriboh.id] }, CARDS.kuriboh)).toBe(true)
    expect(matchesCardFilter({ cardIds: [CARDS.kuriboh.id] }, CARDS.darkMagician)).toBe(false)

    expect(matchesCardFilter({ nameContains: 'magician' }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ nameContains: 'dragon' }, CARDS.darkMagician)).toBe(false)

    expect(matchesCardFilter({ hasEffect: false }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ hasEffect: false }, CARDS.kuriboh)).toBe(false)
    expect(matchesCardFilter({ hasEffect: true }, CARDS.kuriboh)).toBe(true)
  })

  it('matches numeric ranges and skips cards without the value', () => {
    expect(matchesCardFilter({ levelMin: 7 }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ levelMin: 8 }, CARDS.darkMagician)).toBe(false)
    expect(matchesCardFilter({ levelMin: 1, levelMax: 4 }, CARDS.kuriboh)).toBe(true)

    expect(matchesCardFilter({ atkMin: 2500 }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ atkMin: 2000, atkMax: 2400 }, CARDS.darkMagician)).toBe(false)
    // Spells have no ATK, so an ATK filter can never match them.
    expect(matchesCardFilter({ atkMin: 0 }, CARDS.potOfGreed)).toBe(false)
  })

  it('compares release dates strictly and per region, and never matches an unknown date', () => {
    expect(matchesCardFilter({ releasedBefore: '2005-07-01' }, CARDS.darkMagician)).toBe(true)
    expect(matchesCardFilter({ releasedBefore: '2005-07-01' }, CARDS.stardustDragon)).toBe(false)
    expect(matchesCardFilter({ releasedAfter: '2005-07-01' }, CARDS.stardustDragon)).toBe(true)

    // Strictly before/after: the boundary date itself does not match.
    expect(matchesCardFilter({ releasedBefore: '2002-03-08' }, CARDS.darkMagician)).toBe(false)
    expect(matchesCardFilter({ releasedAfter: '2002-03-08' }, CARDS.darkMagician)).toBe(false)

    // Missing TCG date -> no match, whichever direction is asked for.
    expect(matchesCardFilter({ releasedBefore: '2005-07-01' }, CARDS.ocgOnly)).toBe(false)
    expect(matchesCardFilter({ releasedAfter: '1990-01-01' }, CARDS.ocgOnly)).toBe(false)
    // ...but the OCG date is known.
    expect(matchesCardFilter({ releasedBefore: '2005-07-01', region: 'ocg' }, CARDS.ocgOnly)).toBe(true)
    expect(matchesCardFilter({ releasedBefore: '2001-01-01', region: 'ocg' }, CARDS.darkMagician)).toBe(true)
  })
})

// A "?" ATK/DEF (YGOPRODeck stores it as -1). Kept out of ALL_CARDS so the
// deck-level tests stay unchanged.
const tenThousandDragon: ValidationCardData = {
  id: 10000,
  name: 'Ten Thousand Dragon',
  type: 'Effect Monster',
  frameType: 'effect',
  attribute: 'LIGHT',
  race: 'Dragon',
  archetype: null,
  level: 12,
  atk: -1,
  def: -1,
  banlistInfo: null,
  tcgDate: '2020-04-16',
  ocgDate: '2020-02-01',
  setIds: [],
}

describe('"?" ATK/DEF (#140)', () => {
  it('never falls inside an ATK/DEF range', () => {
    expect(matchesCardFilter({ atkMax: 1500 }, tenThousandDragon)).toBe(false)
    expect(matchesCardFilter({ atkMin: 0 }, tenThousandDragon)).toBe(false)
    expect(matchesCardFilter({ defMin: 0, defMax: 100_000 }, tenThousandDragon)).toBe(false)
    // Without a range the stat is irrelevant.
    expect(matchesCardFilter({ races: ['Dragon'] }, tenThousandDragon)).toBe(true)
  })

  it('still matches an ATK of 0', () => {
    const zeroAtk: ValidationCardData = { ...tenThousandDragon, id: 10001, name: 'Null-ATK', atk: 0, def: 0 }
    expect(matchesCardFilter({ atkMax: 1500 }, zeroAtk)).toBe(true)
    expect(matchesCardFilter({ defMin: 0, defMax: 0 }, zeroAtk)).toBe(true)
  })

  it('is not forbidden by a "matching ATK ≤ 1500" rule, but by its not_matching variant', () => {
    const entries: DeckCardEntry[] = [{ catalogCardId: tenThousandDragon.id, section: 'main', quantity: 1 }]
    const cards = [...ALL_CARDS, tenThousandDragon]

    const matching = evaluateDeck([{ kind: 'filter', match: 'matching', filter: { atkMax: 1500 }, maxCopies: 0 }], entries, cards)
    expect(matching.cards[tenThousandDragon.id]!.status).toBe('unrestricted')
    expect(codes(matching.issues)).not.toContain('card_forbidden')

    const notMatching = evaluateDeck([{ kind: 'filter', match: 'not_matching', filter: { atkMax: 1500 }, maxCopies: 0 }], entries, cards)
    expect(notMatching.cards[tenThousandDragon.id]!.status).toBe('forbidden')
    expect(codes(notMatching.issues)).toContain('card_forbidden')
  })
})

describe('deck size rules', () => {
  const rules: Rule[] = [
    { kind: 'deck_size', section: 'main', min: 40, max: 60 },
    { kind: 'deck_size', section: 'extra', max: 15 },
    { kind: 'deck_size', section: 'side', max: 15 },
  ]

  it('reports a section below its minimum and above its maximum', () => {
    const tooSmall = evaluateDeck(rules, [card('darkMagician', 'main', 3)], ALL_CARDS)
    expect(tooSmall.legal).toBe(false)
    expect(codes(tooSmall.issues)).toEqual(['deck_size_min'])
    expect(tooSmall.issues[0]!.section).toBe('main')
    expect(tooSmall.issues[0]!.params).toEqual({ section: 'main', count: 3, min: 40 })
    // `message` is canonical English for the assistant model (ADR 0014).
    expect(tooSmall.issues[0]!.message).toBe('The Main Deck has 3 cards; at least 40 are required.')

    const tooBig = evaluateDeck(rules, [
      card('darkMagician', 'main', 40),
      card('stardustDragon', 'extra', 16),
    ], ALL_CARDS)
    expect(codes(tooBig.issues)).toContain('deck_size_max')
    expect(tooBig.issues.find(issue => issue.code === 'deck_size_max')!.params)
      .toEqual({ section: 'extra', count: 16, max: 15 })
  })

  it('is silent when every section is within range', () => {
    // 10 copies each so the deck reaches 40 main cards with the fixture's
    // handful of cards; the copy limit is raised accordingly.
    const result = evaluateDeck([...rules, { kind: 'copies', maxCopies: 10 }], [
      card('darkMagician', 'main', 10),
      card('kuriboh', 'main', 10),
      card('potOfGreed', 'main', 10),
      card('monsterReborn', 'main', 10),
      card('stardustDragon', 'extra', 3),
      card('raigeki', 'side', 3),
    ], ALL_CARDS)

    expect(result.legal).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('copy limits', () => {
  it('defaults to 3 copies across all sections', () => {
    const legal = evaluateDeck([], [card('kuriboh', 'main', 2), card('kuriboh', 'side', 1)], ALL_CARDS)
    expect(legal.legal).toBe(true)
    expect(legal.cards[CARDS.kuriboh.id]).toEqual({ maxCopies: 3, status: 'unrestricted', reasons: [] })

    const tooMany = evaluateDeck([], [card('kuriboh', 'main', 3), card('kuriboh', 'side', 1)], ALL_CARDS)
    expect(codes(tooMany.issues)).toEqual(['card_limit_exceeded'])
    expect(tooMany.issues[0]!.cardId).toBe(CARDS.kuriboh.id)
    expect(tooMany.issues[0]!.params).toEqual({ cardId: CARDS.kuriboh.id, cardName: 'Kuriboh', copies: 4, maxCopies: 3 })
    expect(tooMany.issues[0]!.message).toBe('Kuriboh: 4 copies in the deck; 3 copies are allowed.')
  })

  it('honours a custom copies rule in both directions', () => {
    const singleton: Rule[] = [{ kind: 'copies', maxCopies: 1 }]
    const result = evaluateDeck(singleton, [card('kuriboh', 'main', 2)], ALL_CARDS)
    expect(codes(result.issues)).toEqual(['card_limit_exceeded'])
    expect(result.cards[CARDS.kuriboh.id]!.status).toBe('limited')

    // A format may also allow *more* than the default three copies.
    const generous = evaluateDeck([{ kind: 'copies', maxCopies: 5 }], [card('kuriboh', 'main', 5)], ALL_CARDS)
    expect(generous.legal).toBe(true)
    expect(generous.cards[CARDS.kuriboh.id]!.maxCopies).toBe(5)
  })

  it('reports an unknown card instead of silently skipping it', () => {
    const result = evaluateDeck([], [{ catalogCardId: 123456, section: 'main', quantity: 1 }], ALL_CARDS)
    expect(codes(result.issues)).toEqual(['unknown_card_data'])
    expect(result.issues[0]!.params).toEqual({ cardId: 123456 })
    expect(result.cards[123456]).toBeUndefined()
  })
})

describe('card_status rules', () => {
  const rules: Rule[] = [
    { kind: 'card_status', status: 'forbidden', cardIds: [CARDS.potOfGreed.id] },
    { kind: 'card_status', status: 'limited', cardIds: [CARDS.monsterReborn.id] },
    { kind: 'card_status', status: 'semi_limited', cardIds: [CARDS.kuriboh.id] },
  ]

  it('forbids, limits, and semi-limits the listed cards', () => {
    const result = evaluateDeck(rules, [
      card('potOfGreed', 'main', 1),
      card('monsterReborn', 'main', 1),
      card('kuriboh', 'main', 2),
    ], ALL_CARDS)

    expect(result.legal).toBe(false)
    expect(codes(result.issues)).toEqual(['card_forbidden'])
    expect(result.issues[0]!.params).toEqual({ cardId: CARDS.potOfGreed.id, cardName: 'Pot of Greed' })

    expect(result.cards[CARDS.potOfGreed.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.monsterReborn.id]).toEqual({
      maxCopies: 1,
      status: 'limited',
      reasons: [{ kind: 'format_rule', status: 'limited' }],
    })
    expect(result.cards[CARDS.kuriboh.id]!.maxCopies).toBe(2)
  })

  it('counts copies of a limited card across main, extra, and side', () => {
    const result = evaluateDeck(rules, [
      card('kuriboh', 'main', 2),
      card('kuriboh', 'side', 1),
    ], ALL_CARDS)

    expect(codes(result.issues)).toEqual(['card_limit_exceeded'])
    expect(result.issues[0]!.params).toEqual({ cardId: CARDS.kuriboh.id, cardName: 'Kuriboh', copies: 3, maxCopies: 2 })
  })
})

describe('banlist rules', () => {
  it('reads the TCG list', () => {
    const result = evaluateDeck([{ kind: 'banlist', source: 'tcg' }], [
      card('potOfGreed', 'main', 1),
      card('monsterReborn', 'main', 2),
      card('raigeki', 'main', 3),
    ], ALL_CARDS)

    expect(result.cards[CARDS.potOfGreed.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.potOfGreed.id]!.reasons).toEqual([{ kind: 'banlist', source: 'tcg', raw: 'Forbidden' }])
    expect(result.cards[CARDS.monsterReborn.id]!.maxCopies).toBe(1)
    // Raigeki is unlimited in the TCG today.
    expect(result.cards[CARDS.raigeki.id]!.status).toBe('unrestricted')

    expect([...codes(result.issues)].sort()).toEqual(['card_forbidden', 'card_limit_exceeded'])
  })

  it('reads the OCG list', () => {
    const result = evaluateDeck([{ kind: 'banlist', source: 'ocg' }], [
      card('potOfGreed', 'main', 1),
      card('monsterReborn', 'main', 1),
    ], ALL_CARDS)

    expect(result.cards[CARDS.potOfGreed.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.monsterReborn.id]!.status).toBe('limited')
    expect(codes(result.issues)).toEqual(['card_forbidden'])
  })

  it('reads the GOAT list, which differs from the TCG list', () => {
    const result = evaluateDeck([{ kind: 'banlist', source: 'goat' }], [
      card('potOfGreed', 'main', 1),
      card('monsterReborn', 'main', 1),
      card('raigeki', 'main', 1),
    ], ALL_CARDS)

    // Limited on GOAT, Forbidden in the TCG.
    expect(result.cards[CARDS.potOfGreed.id]!.status).toBe('limited')
    expect(result.cards[CARDS.monsterReborn.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.raigeki.id]!.status).toBe('forbidden')

    // Sorted by card name.
    expect(result.issues.map(issue => issue.params.cardName)).toEqual(['Monster Reborn', 'Raigeki'])
  })
})

describe('Edison (ADR 0030)', () => {
  const edison = BUILTIN_FORMATS.find(format => format.id === 'edison')!.rules.rules

  // Cards of the Edison card pool's edge: Duelist Pack: Kaiba is the last
  // legal set (2010-04-16), The Shining Darkness is not (2010-05-07).
  const edgeCard = (id: number, tcgDate: string | null, banlistInfo: ValidationCardData['banlistInfo'] = null): ValidationCardData => ({
    id,
    name: `Card ${id}`,
    type: 'Effect Monster',
    frameType: 'effect',
    banlistInfo,
    tcgDate,
    ocgDate: null,
    setIds: [],
  })
  const pool = [
    edgeCard(1, '2010-04-16'),
    edgeCard(2, '2010-04-24'),
    edgeCard(3, '2010-04-25'),
    edgeCard(4, '2010-05-07'),
    edgeCard(5, null),
    edgeCard(6, '2005-01-01', { ban_edison: 'Forbidden' }),
    edgeCard(7, '2005-01-01', { ban_edison: 'Limited', ban_tcg: 'Forbidden' }),
    edgeCard(8, '2005-01-01', { ban_edison: 'Semi-Limited' }),
    edgeCard(9, '2005-01-01', { ban_tcg: 'Forbidden', ban_goat: 'Forbidden' }),
  ]
  const deck = (ids: number[], quantity = 3): DeckCardEntry[] => ids.map(id => ({ catalogCardId: id, section: 'main', quantity }))

  it('allows cards first released in the TCG up to and including 2010-04-24', () => {
    const result = evaluateDeck(edison, deck([1, 2]), pool)

    expect(result.cards[1]!.status).toBe('unrestricted')
    expect(result.cards[2]!.status).toBe('unrestricted')
  })

  it('forbids newer cards (The Shining Darkness) and cards without a TCG date', () => {
    const result = evaluateDeck(edison, deck([3, 4, 5], 1), pool)

    for (const id of [3, 4, 5]) {
      expect(result.cards[id]!.status, String(id)).toBe('forbidden')
    }
    expect(codes(result.issues)).toContain('card_forbidden')
  })

  it('reads the Edison list, not the current TCG or GOAT list', () => {
    const result = evaluateDeck(edison, deck([6, 7, 8, 9]), pool)

    expect(result.cards[6]!.status).toBe('forbidden')
    expect(result.cards[7]).toMatchObject({ maxCopies: 1, status: 'limited' })
    expect(result.cards[7]!.reasons).toContainEqual({ kind: 'banlist', source: 'edison', raw: 'Limited' })
    expect(result.cards[8]).toMatchObject({ maxCopies: 2, status: 'semi_limited' })
    expect(result.cards[9]!.status).toBe('unrestricted')
  })
})

describe('filter rules', () => {
  it('restricts matching cards', () => {
    const rules: Rule[] = [{
      kind: 'filter',
      match: 'matching',
      filter: { types: ['Spell Card'] },
      maxCopies: 1,
      label: 'Zauber nur einmal',
    }]

    const result = evaluateDeck(rules, [card('potOfGreed', 'main', 2), card('darkMagician', 'main', 3)], ALL_CARDS)

    expect(result.cards[CARDS.potOfGreed.id]).toEqual({
      maxCopies: 1,
      status: 'limited',
      reasons: [{ kind: 'filter', label: 'Zauber nur einmal', rule: rules[0] }],
    })
    expect(result.cards[CARDS.darkMagician.id]!.status).toBe('unrestricted')
    expect(codes(result.issues)).toEqual(['card_limit_exceeded'])
  })

  it('restricts everything a filter does not match (GOAT-style release cut-off)', () => {
    const rules: Rule[] = [{
      kind: 'filter',
      match: 'not_matching',
      filter: { releasedBefore: '2005-07-01', region: 'tcg' },
      maxCopies: 0,
      label: 'Nur Karten bis Juni 2005',
    }]

    const result = evaluateDeck(rules, [
      card('darkMagician', 'main', 3),
      card('stardustDragon', 'extra', 1),
      // No TCG date at all -> conservatively forbidden by the same rule.
      card('ocgOnly', 'main', 1),
    ], ALL_CARDS)

    expect(result.cards[CARDS.darkMagician.id]!.status).toBe('unrestricted')
    expect(result.cards[CARDS.stardustDragon.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.ocgOnly.id]!.status).toBe('forbidden')
    expect(result.cards[CARDS.ocgOnly.id]!.reasons).toEqual([{ kind: 'filter', label: 'Nur Karten bis Juni 2005', rule: rules[0] }])
    expect(codes(result.issues)).toEqual(['card_forbidden', 'card_forbidden'])
  })

  it('can use the OCG release date instead', () => {
    const rules: Rule[] = [{
      kind: 'filter',
      match: 'not_matching',
      filter: { releasedBefore: '2005-07-01', region: 'ocg' },
      maxCopies: 0,
    }]

    const result = evaluateDeck(rules, [card('ocgOnly', 'main', 1), card('stardustDragon', 'extra', 1)], ALL_CARDS)

    expect(result.cards[CARDS.ocgOnly.id]!.status).toBe('unrestricted')
    expect(result.cards[CARDS.stardustDragon.id]!.status).toBe('forbidden')
  })

  it('filters on attributes, sets, levels, ATK, and effects', () => {
    const byAttribute = evaluateDeck(
      [{ kind: 'filter', match: 'matching', filter: { attributes: ['DARK'], levelMin: 5 }, maxCopies: 1 }],
      [card('darkMagician', 'main', 2), card('kuriboh', 'main', 3)],
      ALL_CARDS,
    )
    expect(byAttribute.cards[CARDS.darkMagician.id]!.maxCopies).toBe(1)
    expect(byAttribute.cards[CARDS.kuriboh.id]!.maxCopies).toBe(3)

    const bySet = evaluateDeck(
      [{ kind: 'filter', match: 'matching', filter: { setIds: ['metal-raiders'] }, maxCopies: 0 }],
      [card('kuriboh', 'main', 1), card('darkMagician', 'main', 1)],
      ALL_CARDS,
    )
    expect(bySet.cards[CARDS.kuriboh.id]!.status).toBe('forbidden')
    expect(bySet.cards[CARDS.darkMagician.id]!.status).toBe('unrestricted')

    const byAtk = evaluateDeck(
      [{ kind: 'filter', match: 'matching', filter: { atkMin: 2500 }, maxCopies: 2 }],
      [card('darkMagician', 'main', 3), card('kuriboh', 'main', 3)],
      ALL_CARDS,
    )
    expect(byAtk.cards[CARDS.darkMagician.id]!.maxCopies).toBe(2)
    expect(byAtk.cards[CARDS.kuriboh.id]!.maxCopies).toBe(3)

    const byEffect = evaluateDeck(
      [{ kind: 'filter', match: 'matching', filter: { hasEffect: true }, maxCopies: 1 }],
      [card('kuriboh', 'main', 1), card('darkMagician', 'main', 3)],
      ALL_CARDS,
    )
    expect(byEffect.cards[CARDS.kuriboh.id]!.maxCopies).toBe(1)
    expect(byEffect.cards[CARDS.darkMagician.id]!.maxCopies).toBe(3)
  })
})

describe('rule interplay', () => {
  it('takes the lowest limit of every applicable rule and lists all reasons', () => {
    const rules: Rule[] = [
      { kind: 'copies', maxCopies: 3 },
      { kind: 'banlist', source: 'goat' },
      { kind: 'filter', match: 'matching', filter: { types: ['Spell Card'] }, maxCopies: 2, label: 'Zauber semi' },
      { kind: 'card_status', status: 'forbidden', cardIds: [CARDS.raigeki.id] },
    ]

    const result = evaluateDeck(rules, [card('potOfGreed', 'main', 1), card('raigeki', 'main', 1)], ALL_CARDS)

    // GOAT limits Pot of Greed to 1, the filter would allow 2 -> 1 wins.
    expect(result.cards[CARDS.potOfGreed.id]!.maxCopies).toBe(1)
    expect(result.cards[CARDS.potOfGreed.id]!.reasons).toEqual([
      { kind: 'banlist', source: 'goat', raw: 'Limited' },
      { kind: 'filter', label: 'Zauber semi', rule: rules[2] },
    ])

    expect(result.cards[CARDS.raigeki.id]!.maxCopies).toBe(0)
    expect(result.cards[CARDS.raigeki.id]!.reasons).toEqual([
      { kind: 'banlist', source: 'goat', raw: 'Forbidden' },
      { kind: 'filter', label: 'Zauber semi', rule: rules[2] },
      { kind: 'format_rule', status: 'forbidden' },
    ])
  })

  it('is legal when the deck respects every limit', () => {
    const result = evaluateDeck(
      [{ kind: 'banlist', source: 'tcg' }, { kind: 'deck_size', section: 'main', min: 2 }],
      [card('monsterReborn', 'main', 1), card('darkMagician', 'main', 3)],
      ALL_CARDS,
    )

    expect(result.legal).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('validateRuleSet', () => {
  it('normalizes a valid rule set and drops unknown keys', () => {
    const result = validateRuleSet({
      rules: [
        { kind: 'deck_size', section: 'main', min: '40', max: '60', nonsense: true },
        { kind: 'copies', max_copies: 3 },
        { kind: 'card_status', status: 'limited', cardIds: [1, 1, 2] },
        { kind: 'banlist', source: 'tcg' },
        {
          kind: 'filter',
          match: 'not_matching',
          maxCopies: 0,
          label: '  Alte Karten  ',
          filter: { types: ['Spell Card', 'Spell Card'], releasedBefore: '2005-07-01', region: 'ocg', nameContains: '  Dark  ' },
        },
      ],
    })

    expect(result.rules).toEqual([
      { kind: 'deck_size', section: 'main', min: 40, max: 60 },
      { kind: 'copies', maxCopies: 3 },
      { kind: 'card_status', status: 'limited', cardIds: [1, 2] },
      { kind: 'banlist', source: 'tcg' },
      {
        kind: 'filter',
        match: 'not_matching',
        maxCopies: 0,
        label: 'Alte Karten',
        filter: { types: ['Spell Card'], releasedBefore: '2005-07-01', region: 'ocg', nameContains: 'Dark' },
      },
    ])
  })

  it('bounds a copies rule by MAX_COPIES_RULE (#95)', () => {
    expect(validateRuleSet({ rules: [{ kind: 'copies', maxCopies: MAX_COPIES_RULE }] }).rules)
      .toEqual([{ kind: 'copies', maxCopies: MAX_COPIES_RULE }])
    expect(() => validateRuleSet({ rules: [{ kind: 'copies', maxCopies: MAX_COPIES_RULE + 1 }] }))
      .toThrow(RuleSetValidationError)
  })

  it('accepts an empty rule set', () => {
    expect(validateRuleSet({ rules: [] })).toEqual({ rules: [] })
  })

  it('rejects malformed rule sets', () => {
    const invalid: unknown[] = [
      'nope',
      { rules: 'nope' },
      { rules: [{ kind: 'nonsense' }] },
      { rules: [{ kind: 'deck_size', section: 'graveyard', min: 1 }] },
      // min > max
      { rules: [{ kind: 'deck_size', section: 'main', min: 60, max: 40 }] },
      // neither min nor max
      { rules: [{ kind: 'deck_size', section: 'main' }] },
      { rules: [{ kind: 'copies', maxCopies: 0 }] },
      { rules: [{ kind: 'copies', maxCopies: MAX_COPIES_RULE + 1 }] },
      { rules: [{ kind: 'card_status', status: 'banned', cardIds: [1] }] },
      { rules: [{ kind: 'card_status', status: 'forbidden', cardIds: [] }] },
      { rules: [{ kind: 'card_status', status: 'forbidden', cardIds: [-1] }] },
      { rules: [{ kind: 'banlist', source: 'march-2010' }] },
      { rules: [{ kind: 'filter', match: 'sometimes', maxCopies: 0, filter: {} }] },
      { rules: [{ kind: 'filter', match: 'matching', maxCopies: 4, filter: {} }] },
      { rules: [{ kind: 'filter', match: 'matching', maxCopies: 0, filter: { releasedBefore: '01.07.2005' } }] },
      { rules: [{ kind: 'filter', match: 'matching', maxCopies: 0, filter: { releasedBefore: '2005-02-31' } }] },
      { rules: [{ kind: 'filter', match: 'matching', maxCopies: 0, filter: { levelMin: 8, levelMax: 4 } }] },
      { rules: [{ kind: 'filter', match: 'matching', maxCopies: 0, filter: { region: 'eu' } }] },
      // more than 50 rules
      { rules: Array.from({ length: 51 }, () => ({ kind: 'banlist', source: 'tcg' })) },
    ]

    for (const input of invalid) {
      expect(() => validateRuleSet(input), JSON.stringify(input).slice(0, 80)).toThrow(RuleSetValidationError)
    }
  })

  it('bounds list fields', () => {
    expect(() => validateRuleSet({
      rules: [{ kind: 'card_status', status: 'forbidden', cardIds: Array.from({ length: 201 }, (_, index) => index + 1) }],
    })).toThrow(RuleSetValidationError)
  })
})
