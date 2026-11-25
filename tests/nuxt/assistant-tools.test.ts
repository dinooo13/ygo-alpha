import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { addOwnedCard, ownedQuantitiesByCard, validateInventoryInput } from '../../server/utils/inventory'
import { createCollection } from '../../server/utils/collections'
import { createDeck, getDeckDetail, listDecks, updateDeck, upsertDeckCard } from '../../server/utils/decks'
import { createRuleFormat, deleteRuleFormat, seedBuiltinFormats, validateRuleFormatInput } from '../../server/utils/rule-formats'
import { asSchema } from 'ai'
import {
  applyAction,
  ASSISTANT_TOOLS,
  buildAssistantToolSet,
  refreshPackagePreviews,
  rejectAction,
} from '../../server/utils/assistant-tools'
import type { AssistantToolSet, ToolOutcome } from '../../server/utils/assistant-tools'
import { createConversation, resolveDeckNames, toActionView } from '../../server/utils/assistant-chat'
import { AssistantToolError } from '../../server/utils/assistant-model'
import { TOOL_TEXT } from '../../server/utils/assistant-prompts'
import type { AssistantToolOutput } from '../../shared/assistant-ui'
import { getAssistantLimits } from '../../server/utils/assistant-limits'
import type { AssistantActionKind, AssistantActionView } from '../../shared/assistant-chat'
import { seedGermanNames } from './fixtures/german-names'

const CARD = {
  darkMagician: 46986414,
  potOfGreed: 55144522,
  mirrorForce: 44095762,
  stardustDragon: 44508094,
  raigeki: 12580477,
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
      syncedAt: now,
    },
    {
      id: CARD.potOfGreed,
      name: 'Pot of Greed',
      type: 'Spell Card',
      frameType: 'spell',
      desc: 'Draw two cards.',
      race: 'Normal',
      syncedAt: now,
    },
    {
      id: CARD.mirrorForce,
      name: 'Mirror Force',
      type: 'Trap Card',
      frameType: 'trap',
      desc: 'Destroy all attacking monsters your opponent controls.',
      race: 'Normal',
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
      syncedAt: now,
    },
    {
      id: CARD.raigeki,
      name: 'Raigeki',
      type: 'Spell Card',
      frameType: 'spell',
      desc: 'Destroy all monsters your opponent controls.',
      race: 'Normal',
      syncedAt: now,
    },
  ]).run()
}

function own(db: TestDb, userId: string, catalogCardId: number, quantity: number, extra: Record<string, unknown> = {}) {
  return addOwnedCard(db, userId, validateInventoryInput({ catalog_card_id: catalogCardId, quantity, ...extra }))
}

/** The HTTP status a rejected promise carries, or undefined if it resolved. */
async function statusOf(run: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await run()
  }
  catch (error) {
    return (error as { statusCode?: number }).statusCode
  }
  return undefined
}

function tool(name: string) {
  return ASSISTANT_TOOLS.find(candidate => candidate.name === name)!
}

/** A card that is no longer in the catalog (ADR 0019), replaced by Dark Magician. */
const RETIRED_CARD = 101402024

function insertRetiredCard(db: TestDb) {
  db.insert(schema.catalogCard).values({
    id: RETIRED_CARD,
    name: 'Old Magician',
    type: 'Normal Monster',
    frameType: 'normal',
    desc: 'Placeholder.',
    syncedAt: new Date(),
    retiredAt: new Date(),
    replacedById: CARD.darkMagician,
  }).run()
}

const MAIN_BELOW_MIN_1 = 'The Main Deck has 1 card; the usual minimum is 40.'

// A printing of Dark Magician (ADR 0034), seeded where a test needs one.
const DM_LOB = `${CARD.darkMagician}|LOB-005|ur`

function seedDarkMagicianPrinting(db: TestDb) {
  db.insert(schema.catalogSet).values({ id: 'lob', name: 'Legend of Blue Eyes White Dragon' }).run()
  db.insert(schema.catalogPrinting).values({
    id: DM_LOB, cardId: CARD.darkMagician, setId: 'lob', setCode: 'LOB-005', rarity: 'Ultra Rare', rarityKey: 'ur',
  }).run()
}

let db: TestDb

beforeEach(() => {
  db = createTestDb()
  seedUsersAndCatalog(db)
})

describe('search_catalog', () => {
  it('finds cards by a name substring and includes stats', async () => {
    const outcome = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dark Mag' })
    expect(outcome.result).toMatchObject({
      items: [
        expect.objectContaining({ id: CARD.darkMagician, name: 'Dark Magician', type: 'Normal Monster', atk: 2500, def: 2100 }),
      ],
      truncated: false,
    })
  })

  it('shows each card\'s primary artwork: the image whose id is the card\'s, else the lowest id (ADR 0025)', async () => {
    db.insert(schema.catalogCardImage).values([
      { id: 36996508, cardId: CARD.darkMagician, imageUrl: 'alt.jpg', imageUrlSmall: 'alt-small.jpg' },
      { id: CARD.darkMagician, cardId: CARD.darkMagician, imageUrl: 'main.jpg', imageUrlSmall: 'main-small.jpg' },
      { id: 1, cardId: CARD.potOfGreed, imageUrl: 'pot-low.jpg', imageUrlSmall: 'pot-low-small.jpg' },
      { id: 2, cardId: CARD.potOfGreed, imageUrl: 'pot-high.jpg', imageUrlSmall: 'pot-high-small.jpg' },
    ]).run()

    const magician = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dark Magician' })
    expect(magician.result).toMatchObject({ items: [{ id: CARD.darkMagician, imageSmall: 'main-small.jpg' }] })
    const pot = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Pot of Greed' })
    expect(pot.result).toMatchObject({ items: [{ id: CARD.potOfGreed, imageSmall: 'pot-low-small.jpg' }] })
  })

  it('finds cards by their German name, with wildcards literal (ADR 0015)', async () => {
    seedGermanNames(db, { [CARD.darkMagician]: 'Dunkler Magier' })

    const german = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dunkler' })
    expect(german.result).toMatchObject({ items: [expect.objectContaining({ id: CARD.darkMagician, name: 'Dark Magician' })] })

    const wildcard = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: '%' })
    expect(wildcard.result).toMatchObject({ items: [] })
  })

  it('leaves retired cards out (ADR 0019)', async () => {
    db.insert(schema.catalogCard).values({
      id: 101402024,
      name: 'Dark Magician',
      type: 'Normal Monster',
      desc: 'Placeholder.',
      syncedAt: new Date(),
      retiredAt: new Date(),
      replacedById: CARD.darkMagician,
    }).run()

    const outcome = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dark Mag' })
    const result = outcome.result as { items: Array<{ id: number }> }
    expect(result.items.map(item => item.id)).toEqual([CARD.darkMagician])
  })

  it('rejects non-object arguments', async () => {
    expect(await statusOf(() => tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, 'nope'))).toBe(400)
  })

  it('caps the result at getAssistantLimits().toolResultItems and respects a smaller limit', async () => {
    const now = new Date()
    const { toolResultItems } = getAssistantLimits()
    const extraCards = Array.from({ length: toolResultItems + 10 }, (_, i) => ({
      id: 90_000_000 + i,
      name: `Filler Card ${String(i).padStart(3, '0')}`,
      type: 'Normal Monster',
      desc: 'x',
      syncedAt: now,
    }))
    db.insert(schema.catalogCard).values(extraCards).run()

    const full = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Filler Card' })
    const fullResult = full.result as { items: unknown[], truncated: boolean }
    expect(fullResult.items).toHaveLength(toolResultItems)
    expect(fullResult.truncated).toBe(true)

    const limited = await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Filler Card', limit: 3 })
    const limitedResult = limited.result as { items: unknown[], truncated: boolean }
    expect(limitedResult.items).toHaveLength(3)
    expect(limitedResult.truncated).toBe(true)
  })
})

describe('get_card', () => {
  it('returns full card data including printings and banlist info', async () => {
    const outcome = await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: CARD.darkMagician })
    expect(outcome.result).toMatchObject({ id: CARD.darkMagician, name: 'Dark Magician', desc: 'The ultimate wizard.' })
    expect((outcome.result as { printings: unknown[] }).printings).toEqual([])
  })

  it('flags a retired card with its replacement, and only a retired one (ADR 0019)', async () => {
    db.insert(schema.catalogCard).values({
      id: 101402024,
      name: 'Dark Magician',
      type: 'Normal Monster',
      desc: 'Placeholder.',
      syncedAt: new Date(),
      retiredAt: new Date(),
      replacedById: CARD.darkMagician,
    }).run()

    const retired = await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: 101402024 })
    expect(retired.result).toMatchObject({ id: 101402024, retired: true, replacedById: CARD.darkMagician })

    const active = await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: CARD.darkMagician })
    expect(active.result).not.toHaveProperty('retired')
    expect(active.result).not.toHaveProperty('replacedById')
  })

  it('404s for an unknown card id', async () => {
    expect(await statusOf(() => tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: 1 }))).toBe(404)
  })

  it('rejects a missing id', async () => {
    expect(await statusOf(() => tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, {}))).toBe(400)
  })
})

describe('"?" ATK/DEF in tool results (#139)', () => {
  const QUESTION_MARKS = 90000001
  const LINK = 90000002

  beforeEach(() => {
    const now = new Date()
    db.insert(schema.catalogCard).values([
      { id: QUESTION_MARKS, name: 'Qmark Golem', type: 'Effect Monster', frameType: 'effect', desc: '?', race: 'Rock', attribute: 'EARTH', atk: -1, def: -1, level: 4, syncedAt: now },
      { id: LINK, name: 'Qmark Link', type: 'Link Monster', frameType: 'link', desc: 'Link.', race: 'Cyberse', attribute: 'DARK', atk: 2300, def: null, linkval: 2, syncedAt: now },
    ]).run()
  })

  const stats = (item: unknown) => {
    const { atk, def } = item as { atk: unknown, def: unknown }
    return { atk, def }
  }

  it('search_catalog: "?" for a ? stat, null for none, numbers stay numbers', async () => {
    const result = (await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Qmark' })).result as { items: Array<{ id: number }> }
    expect(result.items.map(item => [item.id, stats(item)])).toEqual([
      [QUESTION_MARKS, { atk: '?', def: '?' }],
      [LINK, { atk: 2300, def: null }],
    ])
    const darkMagician = (await tool('search_catalog').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dark Magician' })).result as { items: unknown[] }
    expect(stats(darkMagician.items[0])).toEqual({ atk: 2500, def: 2100 })
  })

  it('get_card: the same', async () => {
    expect(stats((await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: QUESTION_MARKS })).result)).toEqual({ atk: '?', def: '?' })
    expect(stats((await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: LINK })).result)).toEqual({ atk: 2300, def: null })
    expect(stats((await tool('get_card').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: CARD.darkMagician })).result)).toEqual({ atk: 2500, def: 2100 })
  })

  it('search_inventory: the same', async () => {
    await own(db, 'user-a', QUESTION_MARKS, 1)
    await own(db, 'user-a', LINK, 1)
    await own(db, 'user-a', CARD.darkMagician, 1)
    const result = (await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {})).result as { items: Array<{ catalogCardId: number }> }
    expect(result.items.map(item => [item.catalogCardId, stats(item)])).toEqual([
      [CARD.darkMagician, { atk: 2500, def: 2100 }],
      [QUESTION_MARKS, { atk: '?', def: '?' }],
      [LINK, { atk: 2300, def: null }],
    ])
  })
})

describe('search_inventory', () => {
  it('aggregates owned quantities per card across collections', async () => {
    const collectionA = await createCollection(db, 'user-a', { name: 'Box 1', description: null })
    await own(db, 'user-a', CARD.darkMagician, 2, { collection_id: collectionA.id })
    await own(db, 'user-a', CARD.darkMagician, 1)
    await own(db, 'user-a', CARD.potOfGreed, 3)

    const outcome = await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {})
    const { items } = outcome.result as { items: Array<{ catalogCardId: number, quantity: number, collections: unknown[] }> }
    const byCard = new Map(items.map(row => [row.catalogCardId, row]))

    expect(byCard.get(CARD.darkMagician)).toMatchObject({ name: 'Dark Magician', quantity: 3 })
    expect(byCard.get(CARD.darkMagician)!.collections).toEqual([{ id: collectionA.id, name: 'Box 1', quantity: 2 }])
    expect(byCard.get(CARD.potOfGreed)).toMatchObject({ quantity: 3 })
  })

  it('filters by query and by collection, and never sees another user\'s cards', async () => {
    await own(db, 'user-a', CARD.darkMagician, 1)
    await own(db, 'user-b', CARD.potOfGreed, 5)

    const byQuery = await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Dark' })
    expect(byQuery.result).toMatchObject({ items: [expect.objectContaining({ catalogCardId: CARD.darkMagician })] })

    const byQueryMiss = await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Pot of Greed' })
    expect(byQueryMiss.result).toMatchObject({ items: [] })
  })

  it('404s for a collectionId the caller does not own', async () => {
    const foreign = await createCollection(db, 'user-b', { name: 'Foreign', description: null })
    expect(await statusOf(() => tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { collectionId: foreign.id }))).toBe(404)
  })

  it('includes the deck-building card facts (no card text) and the default copy limit', async () => {
    await own(db, 'user-a', CARD.darkMagician, 2)
    await own(db, 'user-a', CARD.stardustDragon, 1)

    const outcome = await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {})
    const { items } = outcome.result as { items: Array<Record<string, unknown>> }
    const byName = Object.fromEntries(items.map(item => [item.name, item]))

    expect(byName['Dark Magician']).toMatchObject({
      type: 'Normal Monster',
      attribute: 'DARK',
      race: 'Spellcaster',
      level: 7,
      atk: 2500,
      def: 2100,
      isExtra: false,
      quantity: 2,
      maxCopies: 3,
    })
    expect(byName['Stardust Dragon']).toMatchObject({ isExtra: true, maxCopies: 3 })
    expect(byName['Dark Magician']).not.toHaveProperty('desc')
  })

  it('with formatId: reports each card\'s maxCopies and leaves out forbidden cards', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Verbot',
      rules: {
        rules: [
          { kind: 'card_status', status: 'forbidden', cardIds: [CARD.potOfGreed] },
          { kind: 'filter', match: 'matching', filter: { types: ['Trap Card'] }, maxCopies: 1, label: 'Fallen limitiert' },
        ],
      },
    }))
    await own(db, 'user-a', CARD.darkMagician, 3)
    await own(db, 'user-a', CARD.potOfGreed, 2)
    await own(db, 'user-a', CARD.mirrorForce, 3)

    const outcome = await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { formatId: format.id })
    const result = outcome.result as { items: Array<{ name: string, maxCopies: number }>, total: number, formatName: string }

    expect(result.formatName).toBe('Verbot')
    expect(result.items.map(item => [item.name, item.maxCopies])).toEqual([
      ['Dark Magician', 3],
      ['Mirror Force', 1],
    ])
    expect(result.total).toBe(2)
  })

  it('404s for a formatId that is not the caller\'s or built in', async () => {
    const foreign = createRuleFormat(db, 'user-b', validateRuleFormatInput({ name: 'Fremd', rules: { rules: [] } }))
    expect(await statusOf(() => tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { formatId: foreign.id }))).toBe(404)
  })

  it('pages with offset past the item cap', async () => {
    const now = new Date()
    const { toolResultItems } = getAssistantLimits()
    const fillerIds = Array.from({ length: toolResultItems + 5 }, (_, i) => 90_000_000 + i)
    db.insert(schema.catalogCard).values(fillerIds.map((id, i) => ({
      id,
      name: `Filler Card ${String(i).padStart(3, '0')}`,
      type: 'Normal Monster',
      desc: 'x',
      syncedAt: now,
    }))).run()
    for (const id of fillerIds) {
      await own(db, 'user-a', id, 1)
    }

    const first = (await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {})).result as { items: Array<{ name: string }>, truncated: boolean, total: number, offset: number }
    expect(first).toMatchObject({ truncated: true, total: toolResultItems + 5, offset: 0 })
    expect(first.items).toHaveLength(toolResultItems)

    const second = (await tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { offset: toolResultItems })).result as { items: Array<{ name: string }>, truncated: boolean }
    expect(second.truncated).toBe(false)
    expect(second.items).toHaveLength(5)
    expect(second.items[0]!.name).toBe(`Filler Card ${String(toolResultItems).padStart(3, '0')}`)

    expect(await statusOf(() => tool('search_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, { offset: -1 }))).toBe(400)
  })
})

describe('list_collections', () => {
  it('lists the caller\'s collections with card counts', async () => {
    const collection = await createCollection(db, 'user-a', { name: 'Box 1', description: null })
    await own(db, 'user-a', CARD.darkMagician, 4, { collection_id: collection.id })
    await createCollection(db, 'user-b', { name: 'Not mine', description: null })

    const outcome = await tool('list_collections').run({ db, userId: 'user-a', cardLocale: 'en' }, {})
    expect(outcome.result).toMatchObject({ items: [{ id: collection.id, name: 'Box 1', cardCount: 4 }], truncated: false })
  })
})

describe('list_decks', () => {
  it('lists the caller\'s decks with counts and legality', async () => {
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    createDeck(db, 'user-b', { name: 'Not mine', description: null })

    const outcome = await tool('list_decks').run({ db, userId: 'user-a', cardLocale: 'en' }, {})
    expect(outcome.result).toMatchObject({
      items: [
        expect.objectContaining({ id: deck.id, name: 'My Deck', formatName: null, legal: null, counts: { main: 1, extra: 0, side: 0, total: 1 } }),
      ],
      truncated: false,
      total: 1,
    })
  })

  it('filters by query', async () => {
    createDeck(db, 'user-a', { name: 'Blue-Eyes Deck', description: null })
    createDeck(db, 'user-a', { name: 'Burn Deck', description: null })

    const outcome = await tool('list_decks').run({ db, userId: 'user-a', cardLocale: 'en' }, { query: 'Blue-Eyes' })
    const { items } = outcome.result as { items: Array<{ name: string }> }
    expect(items.map(item => item.name)).toEqual(['Blue-Eyes Deck'])
  })
})

describe('get_deck', () => {
  it('returns sections, ownership, and a validation summary', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Format',
      rules: { rules: [{ kind: 'copies', maxCopies: 3 }] },
    }))
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })
    updateDeck(db, 'user-a', deck.id, { formatId: format.id })
    await own(db, 'user-a', CARD.darkMagician, 1)

    const outcome = await tool('get_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: deck.id })
    expect(outcome.result).toMatchObject({
      id: deck.id,
      name: 'My Deck',
      formatName: 'Format',
      sections: {
        main: [{ catalogCardId: CARD.darkMagician, name: 'Dark Magician', section: 'main', quantity: 1, owned: 1 }],
        extra: [],
        side: [],
      },
      validation: { legal: true },
    })
  })

  it('lists the deck\'s warnings as their English messages (#148)', async () => {
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })

    const small = await tool('get_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: deck.id })
    expect((small.result as { warnings: string[] }).warnings).toEqual([MAIN_BELOW_MIN_1])

    insertRetiredCard(db)
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 4 })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: RETIRED_CARD, section: 'main', quantity: 1 })
    const outcome = await tool('get_deck').run({ db, userId: 'user-a', cardLocale: 'de' }, { id: deck.id })
    expect((outcome.result as { warnings: string[] }).warnings).toEqual([
      'The Main Deck has 6 cards; the usual minimum is 40.',
      'Pot of Greed: 4 copies in the deck; the usual maximum is 3.',
      'Old Magician is no longer in the catalog; its banlist status and card data are no longer updated.',
    ])
  })

  it('404s for a deck owned by another user', async () => {
    const foreignDeck = createDeck(db, 'user-b', { name: 'Foreign', description: null })
    expect(await statusOf(() => tool('get_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { id: foreignDeck.id }))).toBe(404)
  })
})

describe('list_formats', () => {
  it('lists built-in and the caller\'s own formats', async () => {
    seedBuiltinFormats(db)
    createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Mein Format', rules: { rules: [] } }))
    const outcome = await tool('list_formats').run({ db, userId: 'user-a', cardLocale: 'en' }, {})
    const { items: names } = outcome.result as { items: Array<{ name: string, isBuiltin: boolean }> }
    expect(names.some(item => item.isBuiltin)).toBe(true)
    expect(names.some(item => item.name === 'Mein Format' && !item.isBuiltin)).toBe(true)
  })
})

describe('validate_deck', () => {
  it('validates against the deck\'s own assigned format', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Format',
      rules: { rules: [{ kind: 'copies', maxCopies: 1 }] },
    }))
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    updateDeck(db, 'user-a', deck.id, { formatId: format.id })

    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id })
    expect((outcome.result as { legal: boolean }).legal).toBe(false)
    // The format-independent warnings come along (#148).
    expect((outcome.result as { warnings: string[] }).warnings).toEqual(['The Main Deck has 2 cards; the usual minimum is 40.'])
  })

  it('validates against an explicit formatId even without an assigned format', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Format', rules: { rules: [] } }))
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })

    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id, formatId: format.id })
    expect((outcome.result as { legal: boolean }).legal).toBe(true)
    expect((outcome.result as { warnings: string[] }).warnings).toEqual(['The Main Deck has 0 cards; the usual minimum is 40.'])
  })

  it('lists the warnings of a planned deck: more than 3 copies, too small (#148)', async () => {
    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      cards: [{ catalogCardId: CARD.potOfGreed, section: 'main', quantity: 4 }],
    })
    expect((outcome.result as { warnings: string[] }).warnings).toEqual([
      'The Main Deck has 4 cards; the usual minimum is 40.',
      'Pot of Greed: 4 copies in the deck; the usual maximum is 3.',
    ])
  })

  it('answers a deck without a format (and no formatId) with legal: null, the hint and the warnings (#148)', async () => {
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 4 })

    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id })

    expect(outcome.result).toEqual({
      legal: null,
      issues: [],
      note: TOOL_TEXT.noFormatAssigned,
      warnings: [
        'The Main Deck has 4 cards; the usual minimum is 40.',
        'Dark Magician: 4 copies in the deck; the usual maximum is 3.',
      ],
    })
  })

  it('checks a planned new deck (cards + formatId): counts, legality, and missing cards, without writing', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Format',
      rules: { rules: [{ kind: 'copies', maxCopies: 2 }] },
    }))
    await own(db, 'user-a', CARD.darkMagician, 1)

    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      formatId: format.id,
      cards: [
        { catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 },
        { catalogCardId: CARD.stardustDragon, section: 'extra', quantity: 1 },
      ],
    })

    expect(outcome.result).toMatchObject({
      formatId: format.id,
      formatName: 'Format',
      counts: { main: 3, extra: 1, side: 0, total: 4 },
      validation: { legal: false, issues: [expect.stringContaining('Dark Magician')] },
      missing: [
        { catalogCardId: CARD.darkMagician, name: 'Dark Magician', needed: 3, owned: 1 },
        { catalogCardId: CARD.stardustDragon, name: 'Stardust Dragon', needed: 1, owned: 0 },
      ],
    })
    expect(listDecks(db, 'user-a', {}).items).toEqual([])
  })

  it('checks planned changes to an existing deck (deckId + changes) without applying them', async () => {
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 })

    const outcome = await tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: deck.id,
      changes: [{ catalogCardId: CARD.potOfGreed, section: 'main', quantity: 2 }],
    })

    expect(outcome.result).toMatchObject({
      formatId: null,
      validation: null,
      counts: { main: 3, extra: 0, side: 0, total: 3 },
      missing: [
        { catalogCardId: CARD.darkMagician, needed: 1, owned: 0 },
        { catalogCardId: CARD.potOfGreed, needed: 2, owned: 0 },
      ],
    })
    expect(getDeckDetail(db, 'user-a', deck.id).counts.main).toBe(1)
  })

  it('400s without deckId and cards, for cards together with deckId, and for a card in the wrong section', async () => {
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    expect(await statusOf(() => tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {}))).toBe(400)
    expect(await statusOf(() => tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }],
    }))).toBe(400)
    expect(await statusOf(() => tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: deck.id,
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }],
    }))).toBe(400)
    expect(await statusOf(() => tool('validate_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      cards: [{ catalogCardId: CARD.stardustDragon, section: 'main', quantity: 1 }],
    }))).toBe(400)
  })
})

describe('German card language (ADR 0015)', () => {
  const de = () => ({ db, userId: 'user-a', cardLocale: 'de' as const })
  const en = () => ({ db, userId: 'user-a', cardLocale: 'en' as const })

  beforeEach(() => {
    // Raigeki keeps no German name: the English fallback.
    seedGermanNames(db, { [CARD.darkMagician]: 'Dunkler Magier', [CARD.potOfGreed]: 'Topf der Gier' })
    db.update(schema.catalogCardTranslation)
      .set({ desc: 'Der ultimative Hexer.' })
      .where(eq(schema.catalogCardTranslation.cardId, CARD.darkMagician))
      .run()
  })

  it('search_catalog adds nameDe only in German and only when a card has one', async () => {
    const german = (await tool('search_catalog').run(de(), { query: 'i' })).result as { items: Array<Record<string, unknown>> }
    expect(german.items.find(item => item.id === CARD.darkMagician)).toMatchObject({ name: 'Dark Magician', nameDe: 'Dunkler Magier' })
    expect(german.items.find(item => item.id === CARD.raigeki)).not.toHaveProperty('nameDe')

    const english = (await tool('search_catalog').run(en(), { query: 'i' })).result as { items: Array<Record<string, unknown>> }
    expect(english.items.every(item => !('nameDe' in item))).toBe(true)
  })

  it('get_card adds nameDe and descDe only in German', async () => {
    expect((await tool('get_card').run(de(), { id: CARD.darkMagician })).result)
      .toMatchObject({ name: 'Dark Magician', nameDe: 'Dunkler Magier', desc: 'The ultimate wizard.', descDe: 'Der ultimative Hexer.' })
    // A German name without German text: no descDe.
    const potOfGreed = (await tool('get_card').run(de(), { id: CARD.potOfGreed })).result
    expect(potOfGreed).toMatchObject({ nameDe: 'Topf der Gier' })
    expect(potOfGreed).not.toHaveProperty('descDe')

    const english = (await tool('get_card').run(en(), { id: CARD.darkMagician })).result
    expect(english).not.toHaveProperty('nameDe')
    expect(english).not.toHaveProperty('descDe')
  })

  it('search_inventory and get_deck add nameDe only in German', async () => {
    await own(db, 'user-a', CARD.darkMagician, 2)
    await own(db, 'user-a', CARD.raigeki, 1)
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })

    const inventory = (await tool('search_inventory').run(de(), {})).result as { items: Array<Record<string, unknown>> }
    expect(inventory.items).toEqual([
      expect.objectContaining({ catalogCardId: CARD.darkMagician, name: 'Dark Magician', nameDe: 'Dunkler Magier' }),
      expect.not.objectContaining({ nameDe: expect.anything() }),
    ])
    const englishInventory = (await tool('search_inventory').run(en(), {})).result as { items: Array<Record<string, unknown>> }
    expect(englishInventory.items.every(item => !('nameDe' in item))).toBe(true)

    expect((await tool('get_deck').run(de(), { id: deck.id })).result).toMatchObject({
      sections: { main: [{ catalogCardId: CARD.darkMagician, name: 'Dark Magician', nameDe: 'Dunkler Magier', quantity: 2 }] },
    })
    const englishDeck = (await tool('get_deck').run(en(), { id: deck.id })).result as { sections: { main: object[] } }
    expect(englishDeck.sections.main[0]).not.toHaveProperty('nameDe')
  })

  it('validate_deck keeps the German names of missing cards and issue params only in German', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Format',
      rules: { rules: [{ kind: 'copies', maxCopies: 1 }] },
    }))
    const deck = createDeck(db, 'user-a', { name: 'My Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })

    const planned = { formatId: format.id, cards: [
      { catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 },
      { catalogCardId: CARD.raigeki, section: 'main', quantity: 1 },
    ] }
    const german = (await tool('validate_deck').run(de(), planned)).result as { missing: Array<Record<string, unknown>> }
    expect(german.missing).toEqual([
      { catalogCardId: CARD.darkMagician, name: 'Dark Magician', nameDe: 'Dunkler Magier', needed: 1, owned: 0 },
      { catalogCardId: CARD.raigeki, name: 'Raigeki', needed: 1, owned: 0 },
    ])
    const english = (await tool('validate_deck').run(en(), planned)).result as { missing: Array<Record<string, unknown>> }
    expect(english.missing.every(card => !('nameDe' in card))).toBe(true)

    type Validation = { issues: Array<{ params: Record<string, unknown> }> }
    const germanIssues = ((await tool('validate_deck').run(de(), { deckId: deck.id, formatId: format.id })).result as Validation).issues
    expect(germanIssues[0]!.params).toMatchObject({ cardName: 'Dark Magician', cardNameDe: 'Dunkler Magier' })
    const englishIssues = ((await tool('validate_deck').run(en(), { deckId: deck.id, formatId: format.id })).result as Validation).issues
    expect(englishIssues[0]!.params).toMatchObject({ cardName: 'Dark Magician' })
    expect(englishIssues[0]!.params).not.toHaveProperty('cardNameDe')
  })
})

describe('add_to_inventory (write tool)', () => {
  it('produces a pending action instead of writing directly', async () => {
    const outcome = await tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.darkMagician, quantity: 2 }],
    })

    expect('action' in outcome).toBe(true)
    const withAction = outcome as Extract<ToolOutcome, { action: unknown }>
    expect(withAction.action.kind).toBe('add_to_inventory')
    // The stored summary is canonical English; the UI renders its own.
    expect(withAction.action.summary).toBe('Add 1 card(s) to the inventory: Dark Magician x2')
    // Display-only card names for the action card, next to what gets written.
    expect(withAction.action.payload.items).toEqual([expect.objectContaining({ catalogCardId: CARD.darkMagician, quantity: 2, name: 'Dark Magician' })])
    expect(withAction.result).toMatchObject({ status: 'pending_confirmation', message: 'Proposal created, waiting for the user\'s confirmation.' })
    expect(ownedQuantitiesByCard(db, 'user-a', [CARD.darkMagician]).get(CARD.darkMagician)).toBeUndefined()
  })

  it('400s for an unknown catalog card id', async () => {
    expect(await statusOf(() => tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: 1, quantity: 1 }],
    }))).toBe(400)
  })

  it('takes an optional set code and rarity and labels them for the action card (ADR 0034)', async () => {
    seedDarkMagicianPrinting(db)
    const outcome = await tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [
        { catalogCardId: CARD.darkMagician, quantity: 2, setCode: 'lob-005', rarity: 'ur' },
        // A rarity YGOPRODeck does not list for the card is allowed.
        { catalogCardId: CARD.darkMagician, quantity: 1, rarity: 'qcscr' },
        { catalogCardId: CARD.potOfGreed, quantity: 1 },
      ],
    })

    const withAction = outcome as Extract<ToolOutcome, { action: unknown }>
    expect(withAction.action.payload.items).toEqual([
      expect.objectContaining({ catalogCardId: CARD.darkMagician, setCode: 'LOB-005', rarity: 'ur', printing: 'LOB-005 (UR)' }),
      expect.objectContaining({ catalogCardId: CARD.darkMagician, setCode: null, rarity: 'qcscr', printing: 'Quarter Century Secret Rare' }),
      expect.not.objectContaining({ printing: expect.anything() }),
    ])
    // A set code of another card or an unknown rarity is refused before
    // anything is proposed.
    expect(await statusOf(() => tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.potOfGreed, quantity: 1, setCode: 'LOB-005' }],
    }))).toBe(400)
    expect(await statusOf(() => tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.potOfGreed, quantity: 1, rarity: 'Ultra Rare' }],
    }))).toBe(400)
  })
})

describe('create_deck (write tool)', () => {
  it('produces a pending action and never creates the deck', async () => {
    const outcome = await tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Neues Deck',
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 }],
    })

    const withAction = outcome as Extract<ToolOutcome, { action: unknown }>
    expect(withAction.action.kind).toBe('create_deck')
    expect(withAction.action.payload).toMatchObject({ name: 'Neues Deck' })
    expect(withAction.action.summary).toContain('Neues Deck')
  })

  it('attaches card names, the format name and a preview (legality + missing cards) to payload and result', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({
      name: 'Streng',
      rules: { rules: [{ kind: 'copies', maxCopies: 1 }] },
    }))
    await own(db, 'user-a', CARD.darkMagician, 1)

    const outcome = await tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Neues Deck',
      formatId: format.id,
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 }],
    }) as Extract<ToolOutcome, { action: unknown }>

    const expectedPreview = {
      formatId: format.id,
      formatName: 'Streng',
      counts: { main: 2, extra: 0, side: 0, total: 2 },
      validation: { legal: false, issues: [expect.stringContaining('Dark Magician')] },
      missing: [{ catalogCardId: CARD.darkMagician, name: 'Dark Magician', needed: 2, owned: 1 }],
    }
    expect(outcome.action.payload).toMatchObject({
      formatName: 'Streng',
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2, name: 'Dark Magician' }],
      preview: expectedPreview,
    })
    expect(outcome.result).toMatchObject({ status: 'pending_confirmation', preview: expectedPreview })
    // The preview's format-independent warnings (#148): English text for the model, plus code + params in the stored payload for the action card.
    expect((outcome.result as { preview: { warnings: string[] } }).preview.warnings).toEqual(['The Main Deck has 2 cards; the usual minimum is 40.'])
    expect((outcome.result as { preview: Record<string, unknown> }).preview).not.toHaveProperty('warningDetails')
    expect(outcome.action.payload).toMatchObject({
      preview: {
        warnings: ['The Main Deck has 2 cards; the usual minimum is 40.'],
        warningDetails: [{ code: 'main_below_min', params: { section: 'main', count: 2, min: 40 } }],
      },
    })
  })

  it('400s for a card placed in the wrong section', async () => {
    expect(await statusOf(() => tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Neues Deck',
      cards: [{ catalogCardId: CARD.stardustDragon, section: 'main', quantity: 1 }],
    }))).toBe(400)
  })

  it('400s for an unknown catalog card id', async () => {
    expect(await statusOf(() => tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Neues Deck',
      cards: [{ catalogCardId: 1, section: 'main', quantity: 1 }],
    }))).toBe(400)
  })
})

describe('update_deck_cards (write tool)', () => {
  it('produces a pending action referencing the deck\'s current name', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Mein Deck', description: null })
    const outcome = await tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: deck.id,
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 3 }],
    })

    const withAction = outcome as Extract<ToolOutcome, { action: unknown }>
    expect(withAction.action.kind).toBe('update_deck_cards')
    expect(withAction.action.summary).toContain('Mein Deck')
  })

  it('attaches the deck name, card names and a preview of the resulting deck to payload and result', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Mein Deck', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 })
    await own(db, 'user-a', CARD.potOfGreed, 1)

    const outcome = await tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: deck.id,
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 }],
    }) as Extract<ToolOutcome, { action: unknown }>

    const expectedPreview = {
      formatId: null,
      validation: null,
      counts: { main: 3, extra: 0, side: 0, total: 3 },
      missing: [{ catalogCardId: CARD.darkMagician, name: 'Dark Magician', needed: 2, owned: 0 }],
    }
    expect(outcome.action.payload).toMatchObject({
      deckId: deck.id,
      deckName: 'Mein Deck',
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2, name: 'Dark Magician' }],
      preview: expectedPreview,
    })
    expect(outcome.result).toMatchObject({ preview: expectedPreview })
  })

  it('404s for a deck owned by another user', async () => {
    const foreignDeck = createDeck(db, 'user-b', { name: 'Foreign', description: null })
    expect(await statusOf(() => tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: foreignDeck.id,
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }],
    }))).toBe(404)
  })

  it('400s for an empty changes array', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Mein Deck', description: null })
    expect(await statusOf(() => tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id, changes: [] }))).toBe(400)
  })
})

describe('set_deck_format (write tool)', () => {
  function strictFormat(userId = 'user-a', name = 'Streng') {
    return createRuleFormat(db, userId, validateRuleFormatInput({
      name,
      rules: { rules: [{ kind: 'copies', maxCopies: 1 }] },
    }))
  }

  async function propose(args: Record<string, unknown>, userId = 'user-a') {
    return await tool('set_deck_format').run({ db, userId, cardLocale: 'en' }, args) as Extract<ToolOutcome, { action: unknown }>
  }

  it('produces a pending action with a preview in the new format and leaves the deck untouched', async () => {
    const format = strictFormat()
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })

    const outcome = await propose({ deckId: deck.id, formatId: format.id })

    expect(outcome.action.kind).toBe('set_deck_format')
    expect(outcome.action.payload).toMatchObject({
      deckId: deck.id,
      deckName: 'Magier',
      formatId: format.id,
      formatName: 'Streng',
      previousFormatId: null,
      previousFormatName: null,
    })
    const preview = outcome.action.payload.preview as { formatId: string, validation: { legal: boolean, issues: string[] } }
    expect(preview.formatId).toBe(format.id)
    expect(preview.validation.legal).toBe(false)
    expect(preview.validation.issues.some(issue => issue.includes('Dark Magician'))).toBe(true)
    // The action card renders the issues from code + params (ADR 0014) …
    expect(outcome.action.payload.preview).toMatchObject({
      validation: { issueDetails: [expect.objectContaining({ code: 'card_limit_exceeded', params: expect.objectContaining({ cardName: 'Dark Magician' }) })] },
    })
    // … the model only reads the English text.
    const { issueDetails: _issueDetails, ...modelValidation } = (outcome.action.payload.preview as { validation: Record<string, unknown> }).validation
    // … and the missing cards without their display-only German name (ADR 0015, F3c).
    const payloadMissing = (outcome.action.payload.preview as { missing: Array<Record<string, unknown>> }).missing
    expect(payloadMissing).toEqual([expect.objectContaining({ catalogCardId: CARD.darkMagician, nameDe: null })])
    const modelMissing = payloadMissing.map(({ nameDe: _nameDe, ...card }) => card)
    // … and the warnings as English text only (#148).
    const { warningDetails: _warningDetails, ...modelPreview } = preview as Record<string, unknown>
    expect(outcome.result).toMatchObject({ status: 'pending_confirmation', preview: { ...modelPreview, validation: modelValidation, missing: modelMissing } })
    expect((outcome.result as { preview: object }).preview).not.toHaveProperty('warningDetails')
    expect((outcome.result as { preview: { validation: object } }).preview.validation).not.toHaveProperty('issueDetails')
    expect((outcome.result as { preview: { missing: object[] } }).preview.missing[0]).not.toHaveProperty('nameDe')
    expect(outcome.action.summary).toContain('no format → Streng')

    expect(getDeckDetail(db, 'user-a', deck.id).format).toBeNull()
  })

  it('with formatId null proposes removing the format and previews without one', async () => {
    const format = strictFormat()
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })
    upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
    updateDeck(db, 'user-a', deck.id, { formatId: format.id })

    const outcome = await propose({ deckId: deck.id, formatId: null })

    expect(outcome.action.payload).toMatchObject({
      formatId: null,
      formatName: null,
      previousFormatId: format.id,
      previousFormatName: 'Streng',
      preview: { formatId: null, formatName: null, validation: null, counts: { main: 2 } },
    })
    expect(outcome.action.summary.endsWith('→ no format')).toBe(true)
    expect(getDeckDetail(db, 'user-a', deck.id).format?.id).toBe(format.id)
  })

  it('treats an empty formatId the same as null (what the tool schema asks the model to send)', async () => {
    const format = strictFormat()
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })
    updateDeck(db, 'user-a', deck.id, { formatId: format.id })

    const outcome = await propose({ deckId: deck.id, formatId: '  ' })
    expect(outcome.action.payload).toMatchObject({ formatId: null, formatName: null, preview: { formatId: null, validation: null } })
  })

  it('accepts a built-in format', async () => {
    seedBuiltinFormats(db)
    const builtin = db.select().from(schema.ruleFormat).where(eq(schema.ruleFormat.isBuiltin, true)).get()!
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })

    const outcome = await propose({ deckId: deck.id, formatId: builtin.id })
    expect(outcome.action.payload).toMatchObject({ formatId: builtin.id, formatName: builtin.name })
  })

  it('404s for a deck owned by another user', async () => {
    const format = strictFormat()
    const foreignDeck = createDeck(db, 'user-b', { name: 'Foreign', description: null })
    expect(await statusOf(() => propose({ deckId: foreignDeck.id, formatId: format.id }))).toBe(404)
  })

  it('400s for another user\'s custom format and for an unknown format id', async () => {
    const foreignFormat = strictFormat('user-b', 'Fremd')
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })
    expect(await statusOf(() => propose({ deckId: deck.id, formatId: foreignFormat.id }))).toBe(400)
    expect(await statusOf(() => propose({ deckId: deck.id, formatId: 'does-not-exist' }))).toBe(400)
  })

  it('400s for a missing or non-string formatId and for an unchanged format', async () => {
    const format = strictFormat()
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })

    expect(await statusOf(() => propose({ deckId: deck.id }))).toBe(400)
    expect(await statusOf(() => propose({ deckId: deck.id, formatId: 5 }))).toBe(400)
    // Already without a format.
    expect(await statusOf(() => propose({ deckId: deck.id, formatId: null }))).toBe(400)

    updateDeck(db, 'user-a', deck.id, { formatId: format.id })
    // Already this format.
    expect(await statusOf(() => propose({ deckId: deck.id, formatId: format.id }))).toBe(400)
  })
})

describe('applyAction', () => {
  let pendingActionCounter = 0

  /** Inserts a pending `assistant_action` row directly — the conversation/message it references are incidental to these tests. */
  function insertPendingAction(userId: string, kind: AssistantActionKind, payload: Record<string, unknown>, summary = 'Test') {
    pendingActionCounter += 1
    const n = pendingActionCounter
    const conversation = db.insert(schema.assistantConversation).values({
      id: `conv-${n}`, userId, title: 'Test', createdAt: new Date(), updatedAt: new Date(),
    }).returning().all()[0]!
    const message = db.insert(schema.assistantMessage).values({
      id: `msg-${n}`, conversationId: conversation.id, role: 'assistant', content: '', createdAt: new Date(),
    }).returning().all()[0]!
    return db.insert(schema.assistantAction).values({
      id: `action-${n}`,
      conversationId: conversation.id,
      messageId: message.id,
      userId,
      kind,
      payload,
      summary,
      status: 'pending',
      createdAt: new Date(),
    }).returning().all()[0]!
  }

  async function proposeAddToInventory(userId: string, quantity = 2) {
    const outcome = await tool('add_to_inventory').run({ db, userId, cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.darkMagician, quantity }],
    })
    const action = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    return insertPendingAction(userId, action.kind, action.payload, action.summary)
  }

  it('applies an add_to_inventory action and marks it applied', async () => {
    const action = await proposeAddToInventory('user-a', 2)
    const updated = await applyAction(db, 'user-a', action.id)

    expect(updated.status).toBe('applied')
    expect(ownedQuantitiesByCard(db, 'user-a', [CARD.darkMagician]).get(CARD.darkMagician)).toBe(2)
  })

  it('applies a proposal with a printing into that printing\'s stack (ADR 0034)', async () => {
    seedDarkMagicianPrinting(db)
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: CARD.darkMagician, quantity: 1 }))
    const outcome = await tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.darkMagician, quantity: 2, setCode: 'LOB-005', rarity: 'ur' }],
    })
    const proposed = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    const action = insertPendingAction('user-a', proposed.kind, proposed.payload, proposed.summary)

    await applyAction(db, 'user-a', action.id)

    const rows = db.select().from(schema.ownedCard).where(eq(schema.ownedCard.userId, 'user-a')).all()
    expect(rows.map(row => [row.setCode, row.rarity, row.quantity]).sort()).toEqual([['LOB-005', 'ur', 2], [null, null, 1]].sort())
  })

  it('applies an add_to_inventory action stored with collector fields as default rows (ADR 0017)', async () => {
    await addOwnedCard(db, 'user-a', validateInventoryInput({ catalog_card_id: CARD.darkMagician, quantity: 1 }))
    const action = insertPendingAction('user-a', 'add_to_inventory', {
      items: [
        { catalogCardId: CARD.darkMagician, quantity: 2, printingId: 'LOB-005', language: 'de', condition: 'played', edition: 'first', collectionId: null, note: null, name: 'Dark Magician' },
        { catalogCardId: CARD.potOfGreed, quantity: 1, printingId: null, language: 'ja', condition: 'played', edition: 'limited', collectionId: null, note: null, name: 'Pot of Greed' },
      ],
    })

    const updated = await applyAction(db, 'user-a', action.id)

    expect(updated.status).toBe('applied')
    const rows = db.select().from(schema.ownedCard).where(eq(schema.ownedCard.userId, 'user-a')).all()
    expect(rows).toHaveLength(2)
    // Merged into the existing stack, not a separate German/played row; the
    // old `printingId` is ignored (ADR 0034 stores set code and rarity).
    expect(rows.find(row => row.catalogCardId === CARD.darkMagician)).toMatchObject({ quantity: 3 })
    for (const row of rows) {
      expect(row).toMatchObject({ printingId: null, setCode: null, rarity: null, language: 'en', condition: 'near_mint', edition: 'unlimited' })
    }
  })

  it('applies a stored action whose set code or rarity no longer fits as "unknown" (ADR 0034)', async () => {
    seedDarkMagicianPrinting(db)
    const action = insertPendingAction('user-a', 'add_to_inventory', {
      items: [{ catalogCardId: CARD.darkMagician, quantity: 2, setCode: 'GONE-001', rarity: 'not-a-rarity', collectionId: null, note: null }],
    })

    expect((await applyAction(db, 'user-a', action.id)).status).toBe('applied')
    expect(db.select().from(schema.ownedCard).all()).toEqual([
      expect.objectContaining({ catalogCardId: CARD.darkMagician, setCode: null, rarity: null, quantity: 2 }),
    ])
  })

  it('applies the enriched create_deck / update_deck_cards payloads (names, preview) exactly as proposed', async () => {
    const created = await tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'KI-Deck',
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 }],
    }) as Extract<ToolOutcome, { action: unknown }>
    const createRow = insertPendingAction('user-a', created.action.kind, created.action.payload, created.action.summary)
    const createResult = await applyAction(db, 'user-a', createRow.id)
    expect(createResult.status).toBe('applied')
    const deckId = (createResult.result as { id: string }).id
    expect(getDeckDetail(db, 'user-a', deckId).sections.main).toEqual([
      expect.objectContaining({ catalogCardId: CARD.darkMagician, quantity: 2 }),
    ])

    const updated = await tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId,
      changes: [
        { catalogCardId: CARD.darkMagician, section: 'main', quantity: 0 },
        { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 },
      ],
    }) as Extract<ToolOutcome, { action: unknown }>
    const updateRow = insertPendingAction('user-a', updated.action.kind, updated.action.payload, updated.action.summary)
    expect((await applyAction(db, 'user-a', updateRow.id)).status).toBe('applied')
    expect(getDeckDetail(db, 'user-a', deckId).sections.main.map(row => [row.catalogCardId, row.quantity]))
      .toEqual([[CARD.potOfGreed, 1]])
  })

  it('applies set_deck_format (assign, then remove) and links the deck in the result', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Format', rules: { rules: [] } }))
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })

    const assign = await tool('set_deck_format').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id, formatId: format.id }) as Extract<ToolOutcome, { action: unknown }>
    const assignRow = insertPendingAction('user-a', assign.action.kind, assign.action.payload, assign.action.summary)
    const assigned = await applyAction(db, 'user-a', assignRow.id)
    expect(assigned.status).toBe('applied')
    expect((assigned.result as { id: string }).id).toBe(deck.id)
    expect(getDeckDetail(db, 'user-a', deck.id).format?.id).toBe(format.id)

    const remove = await tool('set_deck_format').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id, formatId: null }) as Extract<ToolOutcome, { action: unknown }>
    const removeRow = insertPendingAction('user-a', remove.action.kind, remove.action.payload, remove.action.summary)
    expect((await applyAction(db, 'user-a', removeRow.id)).status).toBe('applied')
    expect(getDeckDetail(db, 'user-a', deck.id).format).toBeNull()
  })

  it('marks a set_deck_format action failed when the format was deleted after the proposal', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Format', rules: { rules: [] } }))
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })
    const outcome = await tool('set_deck_format').run({ db, userId: 'user-a', cardLocale: 'en' }, { deckId: deck.id, formatId: format.id }) as Extract<ToolOutcome, { action: unknown }>
    const row = insertPendingAction('user-a', outcome.action.kind, outcome.action.payload, outcome.action.summary)

    deleteRuleFormat(db, 'user-a', format.id)

    const updated = await applyAction(db, 'user-a', row.id)
    expect(updated.status).toBe('failed')
    expect(getDeckDetail(db, 'user-a', deck.id).format).toBeNull()
  })

  it('re-validates a tampered set_deck_format payload at apply time and leaves the deck unchanged', async () => {
    const foreignFormat = createRuleFormat(db, 'user-b', validateRuleFormatInput({ name: 'Fremd', rules: { rules: [] } }))
    const deck = createDeck(db, 'user-a', { name: 'Magier', description: null })

    const foreignRow = insertPendingAction('user-a', 'set_deck_format', { deckId: deck.id, formatId: foreignFormat.id })
    expect((await applyAction(db, 'user-a', foreignRow.id)).status).toBe('failed')

    const numberRow = insertPendingAction('user-a', 'set_deck_format', { deckId: deck.id, formatId: 42 })
    expect((await applyAction(db, 'user-a', numberRow.id)).status).toBe('failed')

    const foreignDeck = createDeck(db, 'user-b', { name: 'Foreign', description: null })
    const foreignDeckRow = insertPendingAction('user-a', 'set_deck_format', { deckId: foreignDeck.id, formatId: null })
    expect((await applyAction(db, 'user-a', foreignDeckRow.id)).status).toBe('failed')

    expect(getDeckDetail(db, 'user-a', deck.id).format).toBeNull()
  })

  it('409s when applying an already-resolved action', async () => {
    const action = await proposeAddToInventory('user-a')
    await applyAction(db, 'user-a', action.id)

    expect(await statusOf(() => applyAction(db, 'user-a', action.id))).toBe(409)
  })

  it('404s for an action belonging to another user', async () => {
    const action = await proposeAddToInventory('user-a')
    expect(await statusOf(() => applyAction(db, 'user-b', action.id))).toBe(404)
  })

  it('marks the action failed (not thrown) when the payload can no longer be applied', async () => {
    const action = await proposeAddToInventory('user-a')
    // The catalog card referenced by the payload disappears before it is applied.
    db.delete(schema.catalogCard).where(eq(schema.catalogCard.id, CARD.darkMagician)).run()

    const updated = await applyAction(db, 'user-a', action.id)
    expect(updated.status).toBe('failed')
    expect(updated.result).toMatchObject({ error: expect.any(String) })
  })

  it('a concurrent double apply: exactly one call succeeds, the other 409s, and the write happens once', async () => {
    const action = await proposeAddToInventory('user-a', 2)

    const results = await Promise.allSettled([
      applyAction(db, 'user-a', action.id),
      applyAction(db, 'user-a', action.id),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0]!.reason as { statusCode?: number }).statusCode).toBe(409)

    // Applied exactly once — not twice.
    expect(ownedQuantitiesByCard(db, 'user-a', [CARD.darkMagician]).get(CARD.darkMagician)).toBe(2)
  })

  it('rolls back the whole payload (no orphan deck) when create_deck succeeds but the format assignment fails', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Format', rules: { rules: [] } }))
    const outcome = await tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Rollback Deck',
      formatId: format.id,
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }],
    })
    const action = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    const row = insertPendingAction('user-a', action.kind, action.payload, action.summary)

    // The format is removed after the action was proposed but before it's applied —
    // `createDeck` re-checks the format and fails, leaving no orphan,
    // unassigned deck behind.
    deleteRuleFormat(db, 'user-a', format.id)

    const updated = await applyAction(db, 'user-a', row.id)
    expect(updated.status).toBe('failed')

    const decks = listDecks(db, 'user-a', {}).items
    expect(decks.some(deckItem => deckItem.name === 'Rollback Deck')).toBe(false)
  })

  it('creates a create_deck deck with its format in one write (#148)', async () => {
    const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Format', rules: { rules: [] } }))
    const outcome = await tool('create_deck').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      name: 'Format Deck',
      formatId: format.id,
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }],
    })
    const action = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    const row = insertPendingAction('user-a', action.kind, action.payload, action.summary)

    const applied = await applyAction(db, 'user-a', row.id)
    expect(applied.status).toBe('applied')
    const detail = getDeckDetail(db, 'user-a', (applied.result as { id: string }).id)
    expect(detail.format?.id).toBe(format.id)
    expect(detail.validation).not.toBeNull()
    // No follow-up update: the deck was never touched after its creation.
    expect(detail.updatedAt.getTime()).toBe(detail.createdAt.getTime())
  })

  it('re-validates a create_deck payload at apply time and creates nothing for an out-of-bounds quantity', async () => {
    // Simulates a payload row tampered with (or corrupted) after proposal —
    // the tool layer would never itself produce a quantity this large.
    const row = insertPendingAction('user-a', 'create_deck', {
      name: 'Sneaky Deck',
      description: null,
      formatId: null,
      cards: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 5000 }],
    })

    const updated = await applyAction(db, 'user-a', row.id)
    expect(updated.status).toBe('failed')

    const decks = listDecks(db, 'user-a', {}).items
    expect(decks.some(deckItem => deckItem.name === 'Sneaky Deck')).toBe(false)
  })

  it('re-validates an update_deck_cards payload at apply time and changes nothing for an out-of-bounds quantity', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Mein Deck', description: null })
    const row = insertPendingAction('user-a', 'update_deck_cards', {
      deckId: deck.id,
      changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 5000 }],
    })

    const updated = await applyAction(db, 'user-a', row.id)
    expect(updated.status).toBe('failed')
    expect(getDeckDetail(db, 'user-a', deck.id).sections.main).toEqual([])
  })

  it('does not partially apply a batch of deck-card changes when one entry is invalid', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Mein Deck', description: null })
    const outcome = await tool('update_deck_cards').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      deckId: deck.id,
      changes: [
        { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 },
        { catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 },
      ],
    })
    const action = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    const row = insertPendingAction('user-a', action.kind, action.payload, action.summary)

    // The catalog changes between proposal and apply — Pot of Greed disappears.
    db.delete(schema.catalogCard).where(eq(schema.catalogCard.id, CARD.potOfGreed)).run()

    const updated = await applyAction(db, 'user-a', row.id)
    expect(updated.status).toBe('failed')
    // Dark Magician would have succeeded on its own, but the batch fails
    // together — no partial deck changes.
    expect(getDeckDetail(db, 'user-a', deck.id).sections.main).toEqual([])
  })
})

describe('rejectAction', () => {
  it('marks a pending action rejected', async () => {
    const outcome = await tool('add_to_inventory').run({ db, userId: 'user-a', cardLocale: 'en' }, {
      items: [{ catalogCardId: CARD.darkMagician, quantity: 1 }],
    })
    const action = (outcome as Extract<ToolOutcome, { action: unknown }>).action
    const conversation = db.insert(schema.assistantConversation).values({
      id: 'conv-2', userId: 'user-a', title: 'Test', createdAt: new Date(), updatedAt: new Date(),
    }).returning().all()[0]!
    const message = db.insert(schema.assistantMessage).values({
      id: 'msg-2', conversationId: conversation.id, role: 'assistant', content: '', createdAt: new Date(),
    }).returning().all()[0]!
    const row = db.insert(schema.assistantAction).values({
      id: 'action-2',
      conversationId: conversation.id,
      messageId: message.id,
      userId: 'user-a',
      kind: action.kind,
      payload: action.payload,
      summary: action.summary,
      status: 'pending',
      createdAt: new Date(),
    }).returning().all()[0]!

    const updated = rejectAction(db, 'user-a', row.id)
    expect(updated.status).toBe('rejected')
    expect(await statusOf(async () => rejectAction(db, 'user-a', row.id))).toBe(409)
  })
})

describe('buildAssistantToolSet (the AI SDK engine, ADR 0020)', () => {
  function seedConversation() {
    const conversation = createConversation(db, 'user-a')
    const now = new Date()
    db.insert(schema.assistantMessage).values({ id: 'msg-1', conversationId: conversation.id, role: 'assistant', content: '', parts: [], createdAt: now }).run()
    return conversation.id
  }

  function buildSet(overrides: Partial<Parameters<typeof buildAssistantToolSet>[0]> = {}) {
    const actions: Array<{ toolCallId: string, view: AssistantActionView }> = []
    const conversationId = overrides.conversationId ?? seedConversation()
    const tools = buildAssistantToolSet({
      db,
      userId: 'user-a',
      cardLocale: 'en',
      conversationId,
      messageId: 'msg-1',
      limits: { toolResultChars: 60_000, toolResultItems: 100 },
      actionView: toActionView,
      deckName: deckId => resolveDeckNames(db, 'user-a', [deckId]).get(deckId),
      onAction: (toolCallId, view) => actions.push({ toolCallId, view }),
      ...overrides,
    })
    return { tools, actions }
  }

  const options = (toolCallId = 'call-1') => ({ toolCallId, messages: [], context: {} })

  async function execute(tools: AssistantToolSet, name: keyof AssistantToolSet, input: Record<string, unknown>, toolCallId = 'call-1') {
    return tools[name].execute!(input, options(toolCallId)) as Promise<AssistantToolOutput>
  }

  async function schemaOf(tools: AssistantToolSet, name: keyof AssistantToolSet) {
    return await asSchema(tools[name].inputSchema).jsonSchema as { properties: Record<string, { description?: string, items?: { properties: Record<string, unknown> } }> }
  }

  it('offers every registered tool with its flat schema unchanged — no nullable unions anywhere (#54)', async () => {
    const { tools } = buildSet()
    expect(Object.keys(tools)).toEqual(ASSISTANT_TOOLS.map(definition => definition.name))
    for (const definition of ASSISTANT_TOOLS) {
      const name = definition.name as keyof AssistantToolSet
      expect(tools[name].description).toBe(definition.description)
      if (name !== 'search_catalog') {
        expect(await schemaOf(tools, name)).toEqual(definition.parameters)
      }
    }
    expect(JSON.stringify(await Promise.all(Object.values(tools).map(assistantTool => asSchema(assistantTool.inputSchema).jsonSchema)))).not.toMatch(/"type":\s*\[/)
  })

  it('puts the turn\'s item cap into search_catalog\'s limit description, the rest of its schema unchanged', async () => {
    const { tools } = buildSet({ limits: { toolResultChars: 60_000, toolResultItems: 7 } })
    const schemaJson = await schemaOf(tools, 'search_catalog')
    const registered = ASSISTANT_TOOLS.find(definition => definition.name === 'search_catalog')!.parameters as typeof schemaJson
    expect(schemaJson.properties.limit!.description).toBe('Maximum number of results (default/maximum: 7)')
    expect({ ...schemaJson, properties: { ...schemaJson.properties, limit: registered.properties.limit } }).toEqual(registered)
  })

  it('describes every tool and parameter in English, one version for every locale (ADR 0014)', async () => {
    const { tools } = buildSet()
    const json = JSON.stringify(await Promise.all(Object.values(tools).map(async assistantTool => [assistantTool.description, await asSchema(assistantTool.inputSchema).jsonSchema])))
    expect(json).not.toMatch(/[äöüÄÖÜß]/)
    expect(json).not.toMatch(/\b(?:der|die|das|und|nicht|Karte|Karten|Vorschlag)\b/)
  })

  it('offers add_to_inventory with an optional printing but no other collector fields (ADR 0017, ADR 0034)', async () => {
    const { tools } = buildSet()
    const schemaJson = await schemaOf(tools, 'add_to_inventory')
    expect(Object.keys(schemaJson.properties.items!.items!.properties)).toEqual(['catalogCardId', 'quantity', 'collectionId', 'setCode', 'rarity'])
  })

  it('rejects empty or non-object arguments with the emptyArguments text, but accepts {} where nothing is required', async () => {
    const { tools } = buildSet()
    const validate = (name: keyof AssistantToolSet, value: unknown) => asSchema(tools[name].inputSchema).validate!(value)

    for (const value of [{}, '', null, [1]]) {
      const result = await validate('search_catalog', value)
      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toBe(TOOL_TEXT.emptyArguments)
    }
    expect(await validate('list_formats', {})).toEqual({ success: true, value: {} })
    expect(await validate('search_catalog', { query: 'Dark' })).toEqual({ success: true, value: { query: 'Dark' } })
  })

  it('runs a read tool; the model reads only the result, the chip also gets the deck\'s name (#53)', async () => {
    const deck = createDeck(db, 'user-a', { name: 'Magier-Deck', description: null })
    const { tools } = buildSet()

    const output = await execute(tools, 'get_deck', { id: deck.id })

    expect(output).toMatchObject({ deckName: 'Magier-Deck', result: { id: deck.id, name: 'Magier-Deck' } })
    const modelOutput = await tools.get_deck.toModelOutput!({ toolCallId: 'call-1', input: { id: deck.id }, output })
    expect(modelOutput).toEqual({ type: 'json', value: output.result })
  })

  it('throws an AssistantToolError with the English message a failing tool reports', async () => {
    const { tools } = buildSet()
    const error = await execute(tools, 'get_deck', { id: 'nope' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AssistantToolError)
    expect(JSON.parse(JSON.stringify(error))).toEqual({ error: 'Deck not found' })
  })

  it('caps an over-budget result with the resultTooLarge envelope', async () => {
    const { tools } = buildSet({ limits: { toolResultChars: 10, toolResultItems: 100 } })
    expect(await execute(tools, 'search_catalog', { query: 'a' })).toEqual({ result: TOOL_TEXT.resultTooLarge })
  })

  describe('several proposals for one deck in one turn (#148, ADR 0026)', () => {
    /** A deck with 2x Dark Magician, illegal in a one-copy format. */
    function setup() {
      const format = createRuleFormat(db, 'user-a', validateRuleFormatInput({ name: 'Highlander', rules: { rules: [{ kind: 'copies', maxCopies: 1 }] } }))
      const deck = createDeck(db, 'user-a', { name: 'Magier-Deck', description: null })
      upsertDeckCard(db, 'user-a', deck.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
      return { formatId: format.id, deckId: deck.id }
    }

    function storedPreview(actionId: string) {
      const row = db.select().from(schema.assistantAction).where(eq(schema.assistantAction.id, actionId)).get()!
      return (row.payload as { preview: { validation: { legal: boolean } | null, counts: { main: number }, formatName: string | null, combined?: boolean } }).preview
    }

    function actionRow(actionId: string) {
      return db.select().from(schema.assistantAction).where(eq(schema.assistantAction.id, actionId)).get()!
    }

    /** set_deck_format, then update_deck_cards for the same deck: one package. */
    async function proposePackage(tools: AssistantToolSet = buildSet().tools) {
      const { formatId, deckId } = setup()
      const format = await execute(tools, 'set_deck_format', { deckId, formatId }, 'call-1')
      const cards = await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] }, 'call-2')
      return { formatId, deckId, formatActionId: format.actionId!, cardsActionId: cards.actionId! }
    }

    it('previews set_deck_format with the card changes proposed after it, and updates the earlier card', async () => {
      const { formatId, deckId } = setup()
      const updates: Array<{ toolCallId: string, view: AssistantActionView }> = []
      const { tools, actions } = buildSet({ onActionUpdated: (toolCallId, view) => updates.push({ toolCallId, view }) })

      const format = await execute(tools, 'set_deck_format', { deckId, formatId }, 'call-1')
      expect(format.result).toMatchObject({ preview: { validation: { legal: false } } })

      const cards = await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] }, 'call-2')

      // The later proposal previews the deck with both applied: new format, new cards.
      expect(cards.result).toMatchObject({ preview: { formatName: 'Highlander', counts: { main: 1 }, validation: { legal: true }, combined: true } })
      expect(storedPreview(cards.actionId!)).toMatchObject({ formatName: 'Highlander', validation: { legal: true }, combined: true })
      // The first call's own result previewed it alone.
      expect(format.result).not.toHaveProperty('preview.combined')
      // The earlier format change now previews the same package, stored and handed on as an update.
      expect(storedPreview(format.actionId!)).toMatchObject({ formatName: 'Highlander', counts: { main: 1 }, validation: { legal: true }, combined: true })
      expect(updates).toEqual([{ toolCallId: 'call-2', view: expect.objectContaining({ id: format.actionId, payload: expect.objectContaining({ preview: expect.objectContaining({ validation: expect.objectContaining({ legal: true }) }) }) }) }])
      expect(actions.map(action => action.view.id)).toEqual([format.actionId, cards.actionId])
      // The deck itself is untouched.
      expect(getDeckDetail(db, 'user-a', deckId).counts.main).toBe(2)
    })

    it('previews set_deck_format proposed after the card changes with them, in either order', async () => {
      const { formatId, deckId } = setup()
      const { tools } = buildSet()

      const cards = await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] }, 'call-1')
      expect(cards.result).toMatchObject({ preview: { formatName: null, validation: null } })
      const format = await execute(tools, 'set_deck_format', { deckId, formatId }, 'call-2')

      expect(format.result).toMatchObject({ preview: { counts: { main: 1 }, validation: { legal: true } } })
      expect(storedPreview(cards.actionId!)).toMatchObject({ formatName: 'Highlander', validation: { legal: true } })
    })

    it('leaves proposals for other decks, and resolved proposals, alone', async () => {
      const { formatId, deckId } = setup()
      const other = createDeck(db, 'user-a', { name: 'Anderes Deck', description: null })
      upsertDeckCard(db, 'user-a', other.id, { catalogCardId: CARD.darkMagician, section: 'main', quantity: 2 })
      const updates: AssistantActionView[] = []
      const { tools } = buildSet({ onActionUpdated: (_toolCallId, view) => updates.push(view) })

      const format = await execute(tools, 'set_deck_format', { deckId, formatId }, 'call-1')
      const otherFormat = await execute(tools, 'set_deck_format', { deckId: other.id, formatId }, 'call-2')
      rejectAction(db, 'user-a', format.actionId!)
      await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] }, 'call-3')

      expect(updates).toEqual([])
      expect(storedPreview(format.actionId!)).toMatchObject({ validation: { legal: false } })
      expect(storedPreview(otherFormat.actionId!)).toMatchObject({ counts: { main: 2 }, validation: { legal: false } })
      expect(storedPreview(otherFormat.actionId!)).not.toHaveProperty('combined')
    })

    it('after applying one proposal of a package, previews the rest alone on the deck as it is now', async () => {
      const { deckId, formatActionId, cardsActionId } = await proposePackage()

      const applied = await applyAction(db, 'user-a', formatActionId)
      expect(applied.status).toBe('applied')
      const related = refreshPackagePreviews(db, 'user-a', applied)

      // The deck now has the format; the card changes alone make it legal in it.
      expect(related.map(row => row.id)).toEqual([cardsActionId])
      expect(storedPreview(cardsActionId)).toMatchObject({ formatName: 'Highlander', counts: { main: 1 }, validation: { legal: true } })
      expect(storedPreview(cardsActionId)).not.toHaveProperty('combined')
      expect(getDeckDetail(db, 'user-a', deckId).counts.main).toBe(2)
    })

    it('after rejecting the format change, previews the card changes without the format', async () => {
      const { formatActionId, cardsActionId } = await proposePackage()

      const related = refreshPackagePreviews(db, 'user-a', rejectAction(db, 'user-a', formatActionId))

      expect(related.map(row => row.id)).toEqual([cardsActionId])
      expect(storedPreview(cardsActionId)).toMatchObject({ formatId: null, formatName: null, validation: null, counts: { main: 1 } })
      expect(storedPreview(cardsActionId)).not.toHaveProperty('combined')
    })

    it('after applying the card changes, previews the format change on the changed deck (still one package of the rest)', async () => {
      const { formatId, deckId } = setup()
      const { tools } = buildSet()
      const cards = await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.darkMagician, section: 'main', quantity: 1 }] }, 'call-1')
      const format = await execute(tools, 'set_deck_format', { deckId, formatId }, 'call-2')
      const more = await execute(tools, 'update_deck_cards', { deckId, changes: [{ catalogCardId: CARD.potOfGreed, section: 'main', quantity: 1 }] }, 'call-3')

      const related = refreshPackagePreviews(db, 'user-a', await applyAction(db, 'user-a', cards.actionId!))

      // The two left are still a package, in the order they were made.
      expect(related.map(row => row.id)).toEqual([format.actionId, more.actionId])
      for (const id of [format.actionId!, more.actionId!]) {
        expect(storedPreview(id)).toMatchObject({ formatName: 'Highlander', counts: { main: 2 }, validation: { legal: true }, combined: true })
      }
      expect(actionRow(cards.actionId!).status).toBe('applied')
    })

    it('leaves everything alone for an action outside a package or a resolved package', async () => {
      const { tools } = buildSet()
      const add = await execute(tools, 'add_to_inventory', { items: [{ catalogCardId: CARD.darkMagician, quantity: 1 }] })
      expect(refreshPackagePreviews(db, 'user-a', await applyAction(db, 'user-a', add.actionId!))).toEqual([])

      const { formatActionId, cardsActionId } = await proposePackage(tools)
      rejectAction(db, 'user-a', cardsActionId)
      expect(refreshPackagePreviews(db, 'user-a', rejectAction(db, 'user-a', formatActionId))).toEqual([])
    })
  })

  it('stores a write tool\'s proposal as a pending action of the turn\'s message and hands its view on with the call id', async () => {
    const { tools, actions } = buildSet()

    const output = await execute(tools, 'add_to_inventory', { items: [{ catalogCardId: CARD.darkMagician, quantity: 2 }] }, 'call-7')

    expect(output.result).toMatchObject({ status: 'pending_confirmation' })
    const row = db.select().from(schema.assistantAction).get()!
    expect(row).toMatchObject({ messageId: 'msg-1', userId: 'user-a', status: 'pending', kind: 'add_to_inventory' })
    expect(actions).toEqual([{ toolCallId: 'call-7', view: toActionView(row) }])
    // The proposal's id goes with the part (#116), never to the model.
    expect(output.actionId).toBe(row.id)
    const modelOutput = await tools.add_to_inventory.toModelOutput!({ toolCallId: 'call-7', input: {}, output })
    expect(JSON.stringify(modelOutput)).not.toContain(row.id)
  })

  it('names the card of a get_card call in both languages, whatever the card language (#132)', async () => {
    seedGermanNames(db, { [CARD.darkMagician]: 'Dunkler Magier' })
    const conversationId = seedConversation()
    for (const cardLocale of ['en', 'de'] as const) {
      const { tools } = buildSet({ cardLocale, conversationId })
      const output = await execute(tools, 'get_card', { id: CARD.darkMagician })
      expect(output.card, cardLocale).toEqual({ name: 'Dark Magician', nameDe: 'Dunkler Magier' })
      expect(await tools.get_card.toModelOutput!({ toolCallId: 'call-1', input: {}, output })).toEqual({ type: 'json', value: output.result })
    }
    // A card without a German name; other tools get no card.
    const { tools } = buildSet({ conversationId })
    expect((await execute(tools, 'get_card', { id: CARD.raigeki })).card).toEqual({ name: 'Raigeki' })
    expect(await execute(tools, 'search_catalog', { query: 'Raigeki' })).not.toHaveProperty('card')
    expect(await execute(tools, 'list_formats', {})).not.toHaveProperty('actionId')
  })
})
