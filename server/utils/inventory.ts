import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { useDb } from '../db'
import { catalogCard, ownedCard } from '../db/schema'
import { CARD_TEXT_EXCERPT_LENGTH, MAX_OWNED_QUANTITY, UNASSIGNED_COLLECTION_ID } from '../../shared/inventory'
import type { CardKind } from '../../shared/card-kind'
import type { AppLocale } from '../../shared/locale'
import { activeCatalogCard, cardNameMatches, escapedLike, escapeLikeTerm } from './card-name-search'
import { primaryImageUrlSql } from './card-image-sql'
import { resolvePasscode } from './card-passcode'
import { cardDescDeSql, cardNameDeSql, cardSortKey } from './card-translation-sql'
import { assertCollectionOwnedByUser } from './collections'
import { inventoryCardFilterClauses, parseInventorySearchQuery } from './inventory-search'

type Db = ReturnType<typeof useDb>

// Upper bound for a single owned-card stack (`MAX_OWNED_QUANTITY`, shared
// with the UI's quantity steppers).
export const MAX_QUANTITY = MAX_OWNED_QUANTITY

/**
 * One owned-card stack (ADR 0017): a catalog card in a collection (or none),
 * with a quantity and a note. No printing, language, condition or edition.
 */
export interface InventoryInput {
  catalogCardId: number
  collectionId: string | null
  quantity: number
  note: string | null
}

export interface InventoryListOptions {
  q?: string
  page?: number
  pageSize?: number
  // A collection id owned by the caller, or `UNASSIGNED_COLLECTION_ID`.
  collectionId?: string
  // Only the rows of this catalog card, for the inventory's detail panel
  // (`InventoryOwnedCardEditor`).
  catalogCardId?: number
  // The search panel's card filters, as in the aggregated search (#145).
  inText?: boolean
  kind?: CardKind[]
  type?: string[]
  attribute?: string[]
  race?: string[]
  level?: number[]
}

// `code` (+ `params`) is what the UI translates (`errors.api.<code>`, ADR
// 0014); the English statusMessage stays technical. Only errors a user can
// actually run into through the UI carry a code.
function badRequest(message: string, code?: string, params?: Record<string, unknown>): never {
  throw createError({ statusCode: 400, statusMessage: message, data: code ? { code, params } : undefined })
}

function ownedCardNotFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Owned card not found', data: { code: 'owned_card_not_found' } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePositiveInteger(value: unknown, field: string, fallback?: number, max?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) {
      return fallback
    }
    badRequest(`${field} is required`)
  }

  // Only the quantity is typed by hand in the UI; the ids come from pickers.
  const isQuantity = field === 'quantity'
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    badRequest(`${field} must be a positive integer`, isQuantity ? 'quantity_invalid' : undefined)
  }
  if (max !== undefined && numberValue > max) {
    badRequest(`${field} must be at most ${max}`, isQuantity ? 'quantity_too_large' : undefined, { max })
  }

  return numberValue
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    badRequest(`${field} must be a string`)
  }

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Validates a create body. Unknown keys are silently ignored — in particular
 * the former collector fields (`printing_id`/`printingId`, `language`,
 * `condition`, `edition`; ADR 0017), which old PWA clients, E2E seeds and
 * already stored `add_to_inventory` assistant actions may still send.
 */
export function validateInventoryInput(body: unknown): InventoryInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  return {
    catalogCardId: normalizePositiveInteger(body.catalog_card_id ?? body.catalogCardId, 'catalog_card_id'),
    collectionId: normalizeOptionalString(body.collection_id ?? body.collectionId, 'collection_id'),
    quantity: normalizePositiveInteger(body.quantity, 'quantity', 1, MAX_QUANTITY),
    note: normalizeOptionalString(body.note, 'note'),
  }
}

/**
 * Validates a PATCH body. Like `validateInventoryInput`, unknown keys —
 * including the former collector fields — are silently ignored.
 */
export function validateInventoryUpdateInput(body: unknown): Partial<InventoryInput> {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const input: Partial<InventoryInput> = {}
  if (body.catalog_card_id !== undefined || body.catalogCardId !== undefined) {
    input.catalogCardId = normalizePositiveInteger(body.catalog_card_id ?? body.catalogCardId, 'catalog_card_id')
  }
  if (body.collection_id !== undefined || body.collectionId !== undefined) {
    input.collectionId = normalizeOptionalString(body.collection_id ?? body.collectionId, 'collection_id')
  }
  if (body.quantity !== undefined) {
    input.quantity = normalizePositiveInteger(body.quantity, 'quantity', undefined, MAX_QUANTITY)
  }
  if (body.note !== undefined) {
    input.note = normalizeOptionalString(body.note, 'note')
  }

  return input
}

export function ensureCatalogCardExists(db: Db, catalogCardId: number) {
  const card = db.select({ id: catalogCard.id }).from(catalogCard).where(eq(catalogCard.id, catalogCardId)).get()
  if (!card) {
    badRequest('catalog_card_id does not exist')
  }
}

// The owned-card grain (ADR 0017): one row per (user, catalog card, collection).
function sameTupleWhere(userId: string, input: InventoryInput, exceptId?: string) {
  const clauses = [
    eq(ownedCard.userId, userId),
    eq(ownedCard.catalogCardId, input.catalogCardId),
    input.collectionId ? eq(ownedCard.collectionId, input.collectionId) : isNull(ownedCard.collectionId),
  ]

  if (exceptId) {
    clauses.push(ne(ownedCard.id, exceptId))
  }

  return and(...clauses)
}

export type OwnedCardRow = typeof ownedCard.$inferSelect

/** An owned-card row as the API returns it: without the unused collector columns (ADR 0017). */
export type OwnedCardView = Omit<OwnedCardRow, 'printingId' | 'language' | 'condition' | 'edition'>

export function toOwnedCardView(row: OwnedCardRow): OwnedCardView {
  const { printingId: _printingId, language: _language, condition: _condition, edition: _edition, ...view } = row
  return view
}

/**
 * The distinct, trimmed, non-blank notes in order, one per line; `null` when
 * none is left. A note equal to a line of an earlier note is dropped too. Used whenever two notes meet on one row (ADR 0017 §3): adding
 * copies to an existing row (`addOwnedCard`, the bulk and assistant paths,
 * #146) and an edit that moves a row into another row's tuple.
 */
export function joinNotes(...notes: Array<string | null | undefined>): string | null {
  const distinct: string[] = []
  // Every trimmed line kept so far: a note already stored as one line of a
  // joined note ("Binder" in "Binder\nFrom the trade") is not added again.
  const lines = new Set<string>()
  for (const note of notes) {
    const trimmed = note?.trim()
    if (!trimmed || lines.has(trimmed)) {
      continue
    }
    distinct.push(trimmed)
    lines.add(trimmed)
    for (const line of trimmed.split('\n')) {
      lines.add(line.trim())
    }
  }
  return distinct.length > 0 ? distinct.join('\n') : null
}

/**
 * Writes one owned-card row, merging into an existing row with the same
 * ownership tuple instead of creating a duplicate. Assumes the input was
 * already validated (catalog card existence, collection ownership) —
 * `addOwnedCard` does that per request, the bulk endpoint does it for every
 * item up front so the whole batch can run inside one transaction.
 */
function upsertOwnedCardRow(
  db: Db,
  userId: string,
  input: InventoryInput,
): { row: OwnedCardRow, merged: boolean } {
  const now = new Date()
  const existing = db.select().from(ownedCard).where(sameTupleWhere(userId, input)).get()

  if (existing) {
    const [updated] = db
      .update(ownedCard)
      .set({
        quantity: existing.quantity + input.quantity,
        // The existing note first, then the new one (#146); the new note
        // used to overwrite it.
        note: joinNotes(existing.note, input.note),
        updatedAt: now,
      })
      .where(eq(ownedCard.id, existing.id))
      .returning()
      .all()
    return { row: updated!, merged: true }
  }

  const [created] = db
    .insert(ownedCard)
    .values({
      id: randomUUID(),
      userId,
      catalogCardId: input.catalogCardId,
      collectionId: input.collectionId,
      quantity: input.quantity,
      note: input.note,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()

  return { row: created!, merged: false }
}

export async function addOwnedCard(db: Db, userId: string, input: InventoryInput): Promise<OwnedCardView> {
  ensureCatalogCardExists(db, input.catalogCardId)
  if (input.collectionId) {
    assertCollectionOwnedByUser(db, userId, input.collectionId)
  }

  return toOwnedCardView(upsertOwnedCardRow(db, userId, input).row)
}

export const INVENTORY_BULK_MAX_ITEMS = 200

export interface InventoryBulkItemError {
  index: number
  message: string
  /** Translatable reason (`errors.api.<code>`), when the item error has one. */
  code?: string
  params?: Record<string, unknown>
}

export interface InventoryBulkResult {
  created: number
  merged: number
  items: OwnedCardView[]
}

/**
 * Per-item validation failures are client errors and get reported with their
 * index. Anything else (a bug, a database failure) is not the caller's fault
 * and must not be flattened into a 400 with a leaked internal message.
 */
function clientItemError(error: unknown): Omit<InventoryBulkItemError, 'index'> | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  const candidate = error as { statusCode?: unknown, statusMessage?: unknown, data?: unknown }
  if (typeof candidate.statusCode !== 'number' || candidate.statusCode < 400 || candidate.statusCode >= 500) {
    return undefined
  }

  const message = typeof candidate.statusMessage === 'string' && candidate.statusMessage !== ''
    ? candidate.statusMessage
    : 'Invalid item'
  const data = candidate.data && typeof candidate.data === 'object'
    ? candidate.data as { code?: unknown, params?: unknown }
    : undefined
  if (typeof data?.code !== 'string') {
    return { message }
  }
  return data.params && typeof data.params === 'object'
    ? { message, code: data.code, params: data.params as Record<string, unknown> }
    : { message, code: data.code }
}

/**
 * Validates a whole bulk payload before anything is written: shape, per-item
 * fields (same validators as the single-card endpoint), catalog card
 * existence, and collection ownership. Fails with a single 400 carrying every
 * offending item's index, so the review UI can mark the exact rows.
 */
export function validateInventoryBulkInput(db: Db, userId: string, body: unknown): InventoryInput[] {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const rawItems = body.items
  if (!Array.isArray(rawItems)) {
    badRequest('items must be an array')
  }
  if (rawItems.length === 0) {
    badRequest('items must contain at least one entry')
  }
  if (rawItems.length > INVENTORY_BULK_MAX_ITEMS) {
    badRequest(`items must contain at most ${INVENTORY_BULK_MAX_ITEMS} entries`)
  }

  const inputs: InventoryInput[] = []
  const errors: InventoryBulkItemError[] = []

  rawItems.forEach((rawItem, index) => {
    try {
      const input = validateInventoryInput(rawItem)
      ensureCatalogCardExists(db, input.catalogCardId)
      if (input.collectionId) {
        assertCollectionOwnedByUser(db, userId, input.collectionId)
      }
      inputs.push(input)
    }
    catch (error) {
      const itemError = clientItemError(error)
      if (itemError === undefined) {
        throw error
      }
      errors.push({ index, ...itemError })
    }
  })

  if (errors.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Some items are invalid',
      data: { code: 'items_invalid', errors },
    })
  }

  return inputs
}

/**
 * Synchronous core of `addOwnedCardsBulk`, without opening its own
 * transaction — for a caller (e.g. the chat assistant's `applyAction`) that
 * needs to run this alongside other writes inside one transaction of its
 * own. Assumes `db` already is (or stands in for) that transaction.
 */
export function addOwnedCardsBulkSync(
  db: Db,
  userId: string,
  inputs: InventoryInput[],
): InventoryBulkResult {
  const items: OwnedCardView[] = []
  let created = 0
  let merged = 0

  for (const input of inputs) {
    const result = upsertOwnedCardRow(db, userId, input)
    items.push(toOwnedCardView(result.row))
    if (result.merged) {
      merged += 1
    }
    else {
      created += 1
    }
  }

  return { created, merged, items }
}

/**
 * Writes every already-validated item in a single transaction (all or
 * nothing), reusing the same dedup semantics as `addOwnedCard`.
 */
export async function addOwnedCardsBulk(
  db: Db,
  userId: string,
  inputs: InventoryInput[],
): Promise<InventoryBulkResult> {
  // better-sqlite3 transactions are synchronous; `tx` exposes the same query
  // builder surface as the root client here.
  return db.transaction(tx => addOwnedCardsBulkSync(tx as unknown as Db, userId, inputs))
}

export async function updateOwnedCard(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<InventoryInput>,
): Promise<OwnedCardView> {
  return updateOwnedCardSync(db, userId, id, patch)
}

/** The synchronous core of `updateOwnedCard`, for callers inside a transaction (`moveOwnedCards`). */
function updateOwnedCardSync(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<InventoryInput>,
): OwnedCardView {
  if (patch.quantity !== undefined && patch.quantity < 1) {
    badRequest('quantity must be a positive integer', 'quantity_invalid')
  }

  const current = db
    .select()
    .from(ownedCard)
    .where(and(eq(ownedCard.id, id), eq(ownedCard.userId, userId)))
    .get()

  if (!current) {
    ownedCardNotFound()
  }

  const input: InventoryInput = {
    catalogCardId: patch.catalogCardId ?? current.catalogCardId,
    collectionId: patch.collectionId !== undefined ? patch.collectionId : current.collectionId,
    quantity: patch.quantity ?? current.quantity,
    note: patch.note !== undefined ? patch.note : current.note,
  }

  ensureCatalogCardExists(db, input.catalogCardId)
  if (input.collectionId) {
    assertCollectionOwnedByUser(db, userId, input.collectionId)
  }

  const colliding = db.select().from(ownedCard).where(sameTupleWhere(userId, input, id)).get()
  const now = new Date()

  if (colliding) {
    const [merged] = db
      .update(ownedCard)
      .set({
        quantity: colliding.quantity + input.quantity,
        // Both notes survive, the target's first (like migration 0014's
        // merge, ADR 0017 §3); the moved row's note used to overwrite it.
        note: joinNotes(colliding.note, input.note),
        updatedAt: now,
      })
      .where(eq(ownedCard.id, colliding.id))
      .returning()
      .all()
    db.delete(ownedCard).where(eq(ownedCard.id, id)).run()
    return toOwnedCardView(merged!)
  }

  const [updated] = db
    .update(ownedCard)
    .set({
      catalogCardId: input.catalogCardId,
      collectionId: input.collectionId,
      quantity: input.quantity,
      note: input.note,
      updatedAt: now,
    })
    .where(eq(ownedCard.id, id))
    .returning()
    .all()

  return toOwnedCardView(updated!)
}

export async function deleteOwnedCard(db: Db, userId: string, id: string) {
  const deleted = db
    .delete(ownedCard)
    .where(and(eq(ownedCard.id, id), eq(ownedCard.userId, userId)))
    .returning({ id: ownedCard.id })
    .all()

  if (deleted.length === 0) {
    ownedCardNotFound()
  }
}

export const INVENTORY_MOVE_MAX_ITEMS = 200

/** One move: `quantity` copies of an owned-card stack into another collection (`null` = none). */
export interface InventoryMoveInput {
  ownedCardId: string
  /** `null` moves what is left of the stack. */
  quantity: number | null
  toCollectionId: string | null
}

export interface InventoryMoveItemResult {
  /** The stack the copies came from. */
  ownedCardId: string
  catalogCardId: number
  fromCollectionId: string | null
  toCollectionId: string | null
  /** How many copies moved. */
  quantity: number
  /** The stack the copies are in now: the source itself (whole stack, no stack in the target yet), a new one, or the one they merged into. */
  resultId: string
  /** Copies left in the source stack; 0 = the stack is gone or moved as a whole. */
  remaining: number
}

export interface InventoryMoveResult {
  /** Total copies moved. */
  moved: number
  items: InventoryMoveItemResult[]
}

/**
 * Validates a move body's shape: `{ items: [{ ownedCardId, quantity?,
 * toCollectionId }] }`. `toCollectionId` has to be given; `null` means "ohne
 * Sammlung". Ownership and quantities are checked against the database in
 * `moveOwnedCards`.
 */
export function validateInventoryMoveInput(body: unknown): InventoryMoveInput[] {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const rawItems = body.items
  if (!Array.isArray(rawItems)) {
    badRequest('items must be an array')
  }
  if (rawItems.length === 0) {
    badRequest('items must contain at least one entry')
  }
  if (rawItems.length > INVENTORY_MOVE_MAX_ITEMS) {
    badRequest(`items must contain at most ${INVENTORY_MOVE_MAX_ITEMS} entries`)
  }

  const inputs: InventoryMoveInput[] = []
  const errors: InventoryBulkItemError[] = []

  rawItems.forEach((rawItem, index) => {
    try {
      if (!isRecord(rawItem)) {
        badRequest('Item must be an object')
      }
      const ownedCardId = rawItem.ownedCardId ?? rawItem.owned_card_id
      if (typeof ownedCardId !== 'string' || ownedCardId.trim() === '') {
        badRequest('ownedCardId is required')
      }
      if (!('toCollectionId' in rawItem) && !('to_collection_id' in rawItem)) {
        badRequest('toCollectionId is required (null for no collection)')
      }
      inputs.push({
        ownedCardId: ownedCardId.trim(),
        quantity: rawItem.quantity === undefined || rawItem.quantity === null
          ? null
          : normalizePositiveInteger(rawItem.quantity, 'quantity', undefined, MAX_QUANTITY),
        toCollectionId: normalizeOptionalString(rawItem.toCollectionId ?? rawItem.to_collection_id, 'toCollectionId'),
      })
    }
    catch (error) {
      const itemError = clientItemError(error)
      if (itemError === undefined) {
        throw error
      }
      errors.push({ index, ...itemError })
    }
  })

  if (errors.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Some items are invalid',
      data: { code: 'items_invalid', errors },
    })
  }

  return inputs
}

/**
 * Moves copies between collections in one transaction (all or nothing): the
 * source stack loses them (a stack that moves as a whole is re-pointed or, if
 * the target already has a stack of the card, merged into it like
 * `updateOwnedCard` does), the target stack gains them. Collections partition
 * the copies, so nothing is counted twice: the inventory's total per card
 * does not change. A note stays with the stack it was written on; a stack
 * that moves as a whole takes it along.
 *
 * Items are checked first and reported per index like the bulk endpoint:
 * a stack the user doesn't own, a target collection the user doesn't own,
 * a target equal to the stack's collection, or more copies than the stack has
 * (counting earlier items of the same batch that take from the same stack).
 */
export function moveOwnedCards(db: Db, userId: string, inputs: InventoryMoveInput[]): InventoryMoveResult {
  return db.transaction((tx) => {
    const txDb = tx as unknown as Db
    const stackIds = [...new Set(inputs.map(input => input.ownedCardId))]
    const stacks = new Map(
      txDb
        .select()
        .from(ownedCard)
        .where(and(eq(ownedCard.userId, userId), inArray(ownedCard.id, stackIds)))
        .all()
        .map(row => [row.id, row]),
    )

    const available = new Map<string, number>()
    const errors: InventoryBulkItemError[] = []
    const plan: Array<{ input: InventoryMoveInput, quantity: number }> = []

    inputs.forEach((input, index) => {
      try {
        const stack = stacks.get(input.ownedCardId)
        if (!stack) {
          ownedCardNotFound()
        }
        if (input.toCollectionId) {
          assertCollectionOwnedByUser(txDb, userId, input.toCollectionId)
        }
        if (input.toCollectionId === stack.collectionId) {
          badRequest('The copies are already in this collection', 'move_same_collection')
        }
        const left = available.get(stack.id) ?? stack.quantity
        const quantity = input.quantity ?? left
        if (quantity < 1 || quantity > left) {
          badRequest(`quantity must be at most ${left}`, 'move_quantity_exceeds', { max: left })
        }
        available.set(stack.id, left - quantity)
        plan.push({ input, quantity })
      }
      catch (error) {
        const itemError = clientItemError(error)
        if (itemError === undefined) {
          throw error
        }
        errors.push({ index, ...itemError })
      }
    })

    if (errors.length > 0) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Some items are invalid',
        data: { code: 'items_invalid', errors },
      })
    }

    const items: InventoryMoveItemResult[] = []
    let moved = 0

    for (const { input, quantity } of plan) {
      // Read again: an earlier item of the batch may have taken from this stack.
      const source = txDb.select().from(ownedCard).where(eq(ownedCard.id, input.ownedCardId)).get()!
      let resultId: string
      let remaining = 0

      if (quantity === source.quantity) {
        resultId = updateOwnedCardSync(txDb, userId, source.id, { collectionId: input.toCollectionId }).id
      }
      else {
        remaining = source.quantity - quantity
        txDb.update(ownedCard).set({ quantity: remaining, updatedAt: new Date() }).where(eq(ownedCard.id, source.id)).run()
        resultId = upsertOwnedCardRow(txDb, userId, {
          catalogCardId: source.catalogCardId,
          collectionId: input.toCollectionId,
          quantity,
          note: null,
        }).row.id
      }

      moved += quantity
      items.push({
        ownedCardId: source.id,
        catalogCardId: source.catalogCardId,
        fromCollectionId: source.collectionId,
        toCollectionId: input.toCollectionId,
        quantity,
        resultId,
        remaining,
      })
    }

    return { moved, items }
  })
}

/**
 * Parses `GET /api/inventory`'s query string. `catalogCardId` (the rows of
 * one card, for the inventory's detail panel) is ignored unless it is a
 * positive integer, so a malformed value never turns into a 400.
 */
export function parseInventoryListQuery(query: Record<string, unknown>): InventoryListOptions {
  const catalogCardId = typeof query.catalogCardId === 'string' ? Number(query.catalogCardId) : Number.NaN
  // The card filters parse like the aggregated search's (CSV and/or
  // repeated params).
  const { inText, kind, type, attribute, race, level } = parseInventorySearchQuery(query)
  return {
    q: typeof query.q === 'string' ? query.q : undefined,
    page: typeof query.page === 'string' ? Number(query.page) : undefined,
    pageSize: typeof query.pageSize === 'string' ? Number(query.pageSize) : undefined,
    collectionId: typeof query.collectionId === 'string' && query.collectionId ? query.collectionId : undefined,
    catalogCardId: Number.isInteger(catalogCardId) && catalogCardId > 0 ? catalogCardId : undefined,
    inText,
    kind,
    type,
    attribute,
    race,
    level,
  }
}

export function listOwnedCards(db: Db, userId: string, options: InventoryListOptions = {}) {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20))
  const q = options.q?.trim()
  const clauses = [
    eq(ownedCard.userId, userId),
    ...inventoryCardFilterClauses({
      q,
      inText: options.inText ?? false,
      kind: options.kind ?? [],
      type: options.type ?? [],
      attribute: options.attribute ?? [],
      race: options.race ?? [],
      level: options.level ?? [],
    }),
  ]
  // Row-level filters: unlike the aggregated search (inventory-search.ts),
  // which keeps every copy of a card that has at least one copy in the
  // collection, the list shows only the rows actually assigned to it.
  if (options.collectionId === UNASSIGNED_COLLECTION_ID) {
    clauses.push(isNull(ownedCard.collectionId))
  }
  else if (options.collectionId) {
    clauses.push(eq(ownedCard.collectionId, options.collectionId))
  }
  if (options.catalogCardId !== undefined) {
    clauses.push(eq(ownedCard.catalogCardId, options.catalogCardId))
  }
  const where = and(...clauses)

  const rows = db
    .select({
      id: ownedCard.id,
      catalogCardId: ownedCard.catalogCardId,
      collectionId: ownedCard.collectionId,
      quantity: ownedCard.quantity,
      note: ownedCard.note,
      createdAt: ownedCard.createdAt,
      updatedAt: ownedCard.updatedAt,
      cardName: catalogCard.name,
      cardNameDe: cardNameDeSql(),
      cardType: catalogCard.type,
      cardAttribute: catalogCard.attribute,
      // The start of the card text for the "Liste" row, in both languages
      // (ADR 0015; the client picks one). `substr` counts characters.
      cardTextExcerpt: sql<string>`substr(${catalogCard.desc}, 1, ${CARD_TEXT_EXCERPT_LENGTH})`,
      cardTextExcerptDe: sql<string | null>`substr(${cardDescDeSql()}, 1, ${CARD_TEXT_EXCERPT_LENGTH})`,
      cardRetiredAt: catalogCard.retiredAt,
      imageUrlSmall: primaryImageUrlSql('imageUrlSmall'),
    })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .orderBy(desc(ownedCard.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const total = db
    .select({ count: sql<number>`count(distinct ${ownedCard.id})` })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .where(where)
    .get()?.count ?? 0

  // `cardRetired`: YGOPRODeck no longer lists the card (ADR 0019).
  const items = rows.map(({ cardRetiredAt, ...row }) => ({ ...row, cardRetired: cardRetiredAt !== null }))

  return { items, total, page, pageSize }
}

/**
 * Total owned copies per catalog card for one user, summed across every
 * collection (see docs/adr/0002 and 0017: deck availability is "a simple
 * sum by catalog_card_id"). Cards the user does not own at all are absent
 * from the map.
 */
export function ownedQuantitiesByCard(db: Db, userId: string, catalogCardIds: number[]): Map<number, number> {
  if (catalogCardIds.length === 0) {
    return new Map()
  }

  const rows = db
    .select({
      catalogCardId: ownedCard.catalogCardId,
      owned: sql<number>`sum(${ownedCard.quantity})`,
    })
    .from(ownedCard)
    .where(and(eq(ownedCard.userId, userId), inArray(ownedCard.catalogCardId, catalogCardIds)))
    .groupBy(ownedCard.catalogCardId)
    .all()

  return new Map(rows.map(row => [row.catalogCardId, row.owned ?? 0]))
}

/**
 * Up to 20 catalog cards by name (English or German) or passcode, sorted by
 * the name in `cardLocale` (ADR 0015), for the inventory's card picker.
 */
export function searchCatalogCards(db: Db, q = '', cardLocale: AppLocale = 'en') {
  const term = q.trim()
  // A typed passcode resolves like in quick entry: an alternate artwork to
  // its card (ADR 0023), a retired one to its replacement (ADR 0019, #110).
  // The exact card sorts first.
  const passcode = /^\d+$/.test(term) && Number.isSafeInteger(Number(term)) ? Number(term) : null
  const exactId = passcode !== null ? resolvePasscode(db, passcode) : null
  // Catalog-wide: retired cards are not offered (ADR 0019).
  const where = and(
    activeCatalogCard(),
    term
      ? or(
          cardNameMatches(term),
          escapedLike(sql`${catalogCard.id}`, `%${escapeLikeTerm(term)}%`),
          exactId !== null ? eq(catalogCard.id, exactId) : undefined,
        )
      : undefined,
  )

  return db
    .select({
      id: catalogCard.id,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      imageUrlSmall: primaryImageUrlSql('imageUrlSmall'),
    })
    .from(catalogCard)
    .where(where)
    .orderBy(...(exactId !== null ? [sql`${catalogCard.id} = ${exactId} desc`] : []), cardSortKey(cardLocale))
    .limit(20)
    .all()
}
