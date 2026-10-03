import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { useDb } from '../db'
import { catalogCard, collection, deckCard, ownedCard } from '../db/schema'
import { UNASSIGNED_COLLECTION_ID } from '../../shared/inventory'
import { primaryImageUrlSql } from './card-image-sql'
import { cardNameDeSql } from './card-translation-sql'
import { assertCollectionOwnedByUser } from './collections'
import { requireOwnDeck } from './decks'
import { moveOwnedCards } from './inventory'
import type { InventoryMoveItemResult } from './inventory'

type Db = ReturnType<typeof useDb>

/**
 * "Sammlung aus Deck befüllen": moves the owned copies a deck needs into one
 * collection. A deck is a list of catalog cards (ADR 0004, 0030), so what it
 * needs is the sum of main, extra and side per card; the copies come from the
 * chosen source collections, in the order given, and collections partition
 * the copies (no copy is in two places), so the move never double counts.
 * Copies already in the target count towards the need.
 */

export interface DeckCollectionFillInput {
  /** The collection that gets the copies (it has to exist already). */
  collectionId: string
  /**
   * Where the copies may come from, in priority order; `UNASSIGNED_COLLECTION_ID`
   * is "ohne Sammlung". Left out: "ohne Sammlung" first, then every other
   * collection by name. The target is never a source.
   */
  sourceCollectionIds?: string[]
  /** Plan only; nothing is moved. */
  dryRun: boolean
}

export interface DeckFillMove {
  ownedCardId: string
  /** `null` = "ohne Sammlung". */
  fromCollectionId: string | null
  quantity: number
}

export interface DeckFillCard {
  catalogCardId: number
  name: string
  nameDe: string | null
  type: string
  imageSmall: string | null
  /** main + extra + side. */
  needed: number
  alreadyInTarget: number
  /** Copies the plan takes from the sources. */
  toMove: number
  /** Still missing after the sources and the target: `needed - alreadyInTarget - toMove`. */
  missing: number
  /** Copies in collections that are no chosen source (neither the target); `missing` could be filled from them. */
  ownedElsewhere: number
  /** Missing even counting the whole inventory: what a wishlist entry should ask for. */
  notOwned: number
  moves: DeckFillMove[]
}

export interface DeckFillPlan {
  deck: { id: string, name: string }
  collection: { id: string, name: string }
  /** The sources in the order they are used. */
  sourceCollectionIds: string[]
  cards: DeckFillCard[]
  totals: {
    cards: number
    needed: number
    alreadyInTarget: number
    toMove: number
    missing: number
    notOwned: number
  }
}

export interface DeckFillResult extends DeckFillPlan {
  /** `false` for a dry run. */
  executed: boolean
  /** Copies actually moved; 0 for a dry run. */
  moved: number
  /** The owned-card moves, with the stacks the copies ended up in; empty for a dry run. */
  items: InventoryMoveItemResult[]
}

function badRequest(message: string, code?: string): never {
  throw createError({ statusCode: 400, statusMessage: message, data: code ? { code } : undefined })
}

export function validateDeckCollectionFillInput(body: unknown): DeckCollectionFillInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    badRequest('Request body must be an object')
  }
  const record = body as Record<string, unknown>

  const collectionId = record.collectionId ?? record.collection_id
  if (typeof collectionId !== 'string' || collectionId.trim() === '' || collectionId === UNASSIGNED_COLLECTION_ID) {
    badRequest('collectionId is required', 'collection_not_found')
  }

  let sourceCollectionIds: string[] | undefined
  const rawSources = record.sourceCollectionIds ?? record.source_collection_ids
  if (rawSources !== undefined && rawSources !== null) {
    if (!Array.isArray(rawSources) || rawSources.some(id => typeof id !== 'string' || id.trim() === '')) {
      badRequest('sourceCollectionIds must be an array of collection ids')
    }
    sourceCollectionIds = [...new Set((rawSources as string[]).map(id => id.trim()))]
  }

  return { collectionId: collectionId.trim(), sourceCollectionIds, dryRun: record.dryRun === true || record.dry_run === true }
}

/** The plan for filling `input.collectionId` from the deck; nothing is written. */
export function planDeckCollectionFill(db: Db, userId: string, deckId: string, input: DeckCollectionFillInput): DeckFillPlan {
  const deckRow = requireOwnDeck(db, userId, deckId)
  assertCollectionOwnedByUser(db, userId, input.collectionId)

  const collections = db
    .select({ id: collection.id, name: collection.name })
    .from(collection)
    .where(eq(collection.userId, userId))
    .orderBy(asc(collection.name))
    .all()
  const targetName = collections.find(entry => entry.id === input.collectionId)!.name

  const known = new Set(collections.map(entry => entry.id))
  const sourceIds = input.sourceCollectionIds
    ? input.sourceCollectionIds.filter(id => id !== input.collectionId)
    : [UNASSIGNED_COLLECTION_ID, ...collections.filter(entry => entry.id !== input.collectionId).map(entry => entry.id)]
  for (const id of sourceIds) {
    if (id !== UNASSIGNED_COLLECTION_ID && !known.has(id)) {
      assertCollectionOwnedByUser(db, userId, id)
    }
  }

  const needs = db
    .select({
      catalogCardId: deckCard.catalogCardId,
      needed: sql<number>`sum(${deckCard.quantity})`,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      imageSmall: primaryImageUrlSql('imageUrlSmall'),
    })
    .from(deckCard)
    .innerJoin(catalogCard, eq(deckCard.catalogCardId, catalogCard.id))
    .where(eq(deckCard.deckId, deckId))
    .groupBy(deckCard.catalogCardId)
    .orderBy(asc(catalogCard.name))
    .all()

  const owned = needs.length === 0
    ? []
    : db
        .select({
          id: ownedCard.id,
          catalogCardId: ownedCard.catalogCardId,
          collectionId: ownedCard.collectionId,
          quantity: ownedCard.quantity,
        })
        .from(ownedCard)
        .where(and(eq(ownedCard.userId, userId), inArray(ownedCard.catalogCardId, needs.map(need => need.catalogCardId))))
        .all()

  const cards: DeckFillCard[] = needs.map((need) => {
    const rows = owned.filter(row => row.catalogCardId === need.catalogCardId)
    const alreadyInTarget = rows.filter(row => row.collectionId === input.collectionId).reduce((sum, row) => sum + row.quantity, 0)
    const total = rows.reduce((sum, row) => sum + row.quantity, 0)

    let stillNeeded = Math.max(0, need.needed - alreadyInTarget)
    const moves: DeckFillMove[] = []
    for (const sourceId of sourceIds) {
      if (stillNeeded === 0) {
        break
      }
      const stack = rows.find(row => (sourceId === UNASSIGNED_COLLECTION_ID ? row.collectionId === null : row.collectionId === sourceId))
      if (!stack) {
        continue
      }
      const quantity = Math.min(stillNeeded, stack.quantity)
      moves.push({ ownedCardId: stack.id, fromCollectionId: stack.collectionId, quantity })
      stillNeeded -= quantity
    }

    const toMove = moves.reduce((sum, move) => sum + move.quantity, 0)
    return {
      catalogCardId: need.catalogCardId,
      name: need.name,
      nameDe: need.nameDe,
      type: need.type,
      imageSmall: need.imageSmall,
      needed: need.needed,
      alreadyInTarget,
      toMove,
      missing: stillNeeded,
      ownedElsewhere: Math.max(0, total - alreadyInTarget - toMove),
      notOwned: Math.max(0, need.needed - total),
      moves,
    }
  })

  const sum = (pick: (card: DeckFillCard) => number) => cards.reduce((total, card) => total + pick(card), 0)
  return {
    deck: { id: deckRow.id, name: deckRow.name },
    collection: { id: input.collectionId, name: targetName },
    sourceCollectionIds: sourceIds,
    cards,
    totals: {
      cards: cards.length,
      needed: sum(card => card.needed),
      alreadyInTarget: sum(card => card.alreadyInTarget),
      toMove: sum(card => card.toMove),
      missing: sum(card => card.missing),
      notOwned: sum(card => card.notOwned),
    },
  }
}

/** Plans the fill and, unless `dryRun`, moves the copies in one transaction. */
export function fillCollectionFromDeck(db: Db, userId: string, deckId: string, input: DeckCollectionFillInput): DeckFillResult {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db
    const plan = planDeckCollectionFill(txDb, userId, deckId, input)
    if (input.dryRun) {
      return { ...plan, executed: false, moved: 0, items: [] }
    }

    const moves = plan.cards.flatMap(card => card.moves)
    if (moves.length === 0) {
      return { ...plan, executed: true, moved: 0, items: [] }
    }
    const result = moveOwnedCards(txDb, userId, moves.map(move => ({
      ownedCardId: move.ownedCardId,
      quantity: move.quantity,
      toCollectionId: input.collectionId,
    })))
    return { ...plan, executed: true, moved: result.moved, items: result.items }
  })
}
