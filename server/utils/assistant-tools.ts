// The tool layer for the chat assistant (Phase 8, see
// docs/adr/0010-chat-assistant-with-tools.md): every fact the model can pull
// about the user's catalog/inventory/decks, plus the four write tools that
// never mutate directly — they validate their arguments (same
// hand-rolled `validate*Input` style as the rest of the server) and return a
// **pending action** description instead. `buildAssistantToolSet` (the tools
// as the AI SDK turn uses them, ADR 0020) persists that as an
// `assistantAction` row, and only `applyAction` below actually calls the
// existing, already-tested write utils (`addOwnedCardsBulkSync`,
// `createDeck`, `updateDeck`, `upsertDeckCard`), re-validating the stored
// payload and running every write of one action inside a single transaction.
//
// Every tool is user-scoped: `run(ctx, args)` only ever touches `ctx.userId`'s
// own rows, and a referenced deck/collection/action that belongs to someone
// else is reported as missing (404), never as forbidden.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { jsonSchema, tool } from 'ai'
import type { JSONSchema7, JSONValue, Tool } from 'ai'
import type { useDb } from '../db'
import { assistantAction, catalogCard, catalogCardImage, catalogPrinting, collection, ownedCard } from '../db/schema'
import { activeCatalogCard, cardNameMatches } from './card-name-search'
import { getCatalogCardDetail } from './catalog-search'
import { requireCollectionOwnedByUser, listCollections } from './collections'
import {
  addOwnedCardsBulkSync,
  INVENTORY_BULK_MAX_ITEMS,
  validateInventoryBulkInput,
} from './inventory'
import type { InventoryInput } from './inventory'
import { getAssistantLimits } from './assistant-limits'
import {
  createDeck,
  DECK_NAME_MAX_LENGTH,
  getDeckDetail,
  listDecks,
  updateDeck,
  upsertDeckCard,
  validateDeckCardInput,
  validateDeckCreateCardsInput,
  validateDeckWithRules,
} from './decks'
import type { DeckCardInput, DeckCardRow, DeckDetail, DeckSection, DeckWarning } from './decks'
import { isExtraDeckCard, isSectionAllowedForCard } from '../../shared/deck-sections'
import { listRuleFormats, requireAccessibleFormat, requireAssignableFormat } from './rule-formats'
import { loadCardDataForValidation, loadCardNameRecords, maxCopiesByCard, missingCatalogCardIds } from './deck-validation'
import { previewDeckProposal } from './deck-proposal'
import { ACTION_SUMMARY, TOOL_DESCRIPTIONS, TOOL_PARAM_DESCRIPTIONS, TOOL_TEXT } from './assistant-prompts'
import { toolCallCardId, toolCallDeckId } from '../../shared/assistant-chat'
import type { AssistantActionKind, AssistantActionView, AssistantDeckPreview, AssistantToolName } from '../../shared/assistant-chat'
import type { AssistantToolOutput } from '../../shared/assistant-ui'
import { AssistantToolError } from './assistant-model'
import { resolveCardNames } from './assistant-chat'
import type { DeckValidation } from '../../shared/rule-formats'
import type { AppLocale } from '../../shared/locale'
import { printingShortLabel } from '../../shared/printing'
import { primaryImageFirst } from './card-image-sql'
import { cardNameDeSql } from './card-translation-sql'

type Db = ReturnType<typeof useDb>

const GET_CARD_PRINTINGS_MAX = 10
/**
 * Row-scan bound for `search_inventory`'s per-card aggregation (see its
 * query) — a multiple of the configured item cap (`getAssistantLimits()
 * .toolResultItems`), well above what any real collection needs to answer a
 * name/collection-filtered lookup, since the final result is capped to that
 * same item cap anyway. Bounds the worst case (a huge inventory, scanned
 * again on every tool call in a loop).
 */
const SEARCH_INVENTORY_ROW_SCAN_MULTIPLIER = 25

export interface ToolRunContext {
  db: Db
  userId: string
  /**
   * The card language of the turn (ADR 0015). In German, card rows in the
   * tool results also carry the official German name (`nameDe`, plus
   * `descDe` in get_card) where there is one; in English they are unchanged.
   */
  cardLocale: AppLocale
}

export interface AssistantProposedAction {
  kind: AssistantActionKind
  payload: Record<string, unknown>
  summary: string
}

export type ToolOutcome =
  | { result: unknown }
  | { action: AssistantProposedAction, result: unknown }

export interface AssistantTool {
  name: string
  /** Description shown to the model (English, assistant-prompts.ts); the tool name is the wire format. */
  description: string
  parameters: Record<string, unknown>
  kind: 'read' | 'write'
  run: (ctx: ToolRunContext, args: unknown) => Promise<ToolOutcome>
}

function badRequest(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message })
}

function notFound(message: string): never {
  throw createError({ statusCode: 404, statusMessage: message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) {
    badRequest('Tool arguments must be an object')
  }
  return args
}

function optionalString(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string') {
    badRequest(`${field} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function requireNonEmptyString(args: Record<string, unknown>, field: string): string {
  const value = optionalString(args, field)
  if (value === undefined) {
    badRequest(`${field} is required`)
  }
  return value
}

function requirePositiveInt(args: Record<string, unknown>, field: string): number {
  const value = args[field]
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    badRequest(`${field} must be a positive integer`)
  }
  return numberValue
}

function optionalOffset(args: Record<string, unknown>): number {
  const value = args.offset
  if (value === undefined || value === null || value === '') {
    return 0
  }
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    badRequest('offset must be a non-negative integer')
  }
  return numberValue
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback
  }
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    return fallback
  }
  return Math.min(numberValue, max)
}

function capItems<T>(items: T[], max = getAssistantLimits().toolResultItems): T[] {
  return items.slice(0, max)
}

/**
 * Caps an already fully-materialized array *before* serialization and
 * reports whether it was cut, plus the true total — so the model can say
 * "mindestens N" instead of quietly treating the capped count as complete.
 */
function capResult<T>(items: T[], max = getAssistantLimits().toolResultItems): { items: T[], truncated: boolean, total: number } {
  return { items: items.slice(0, max), truncated: items.length > max, total: items.length }
}

/**
 * `{ nameDe }` for a card row the model reads, only in German card language
 * and only when the card has a German name — English turns see exactly what
 * they saw before F3d, and a missing key costs no tokens.
 */
function germanNameField(nameDe: string | null | undefined, cardLocale: AppLocale): { nameDe?: string } {
  return cardLocale === 'de' && nameDe ? { nameDe } : {}
}

/**
 * An ATK/DEF value as the model reads it (#139): YGOPRODeck's -1 for a "?"
 * stat becomes "?", null (no such stat, e.g. a Link monster's DEF) stays
 * null. The model-facing twin of `formatCardStat` (shared/card-stats.ts),
 * which the UI uses; numbers stay numbers here.
 */
function statForModel(value: number | null): number | '?' | null {
  return value !== null && value < 0 ? '?' : value
}

// --- Read tools ----------------------------------------------------------------

function toolSearchCatalog(db: Db, cardLocale: AppLocale, args: unknown) {
  const record = requireArgs(args)
  const query = optionalString(record, 'query') ?? ''
  const itemsCap = getAssistantLimits().toolResultItems
  const limit = clampLimit(record.limit, itemsCap, itemsCap)

  const where = query !== '' ? sqlLikeName(query) : undefined
  // Fetch one row past the limit so we can report `truncated` without a
  // separate COUNT query — the exact total beyond that isn't needed, only
  // whether there is more.
  const rows = db
    .select({
      id: catalogCard.id,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      attribute: catalogCard.attribute,
      race: catalogCard.race,
      level: catalogCard.level,
      atk: catalogCard.atk,
      def: catalogCard.def,
      archetype: catalogCard.archetype,
    })
    .from(catalogCard)
    // Catalog-wide: retired cards are not offered (ADR 0019).
    .where(and(activeCatalogCard(), where))
    .orderBy(asc(catalogCard.name))
    .limit(limit + 1)
    .all()

  const truncated = rows.length > limit
  const capped = truncated ? rows.slice(0, limit) : rows

  if (capped.length === 0) {
    return { items: [], truncated: false }
  }

  const ids = capped.map(row => row.id)
  const images = db
    .select({ cardId: catalogCardImage.cardId, imageSmall: catalogCardImage.imageUrlSmall })
    .from(catalogCardImage)
    .where(inArray(catalogCardImage.cardId, ids))
    // The card's primary artwork first (ADR 0025), like every list.
    .orderBy(asc(catalogCardImage.cardId), ...primaryImageFirst())
    .all()

  const imageByCard = new Map<number, string | null>()
  for (const image of images) {
    if (!imageByCard.has(image.cardId)) {
      imageByCard.set(image.cardId, image.imageSmall)
    }
  }

  return {
    items: capped.map(({ id, name, nameDe, ...row }) => ({
      id,
      name,
      ...germanNameField(nameDe, cardLocale),
      ...row,
      atk: statForModel(row.atk),
      def: statForModel(row.def),
      imageSmall: imageByCard.get(id) ?? null,
    })),
    truncated,
  }
}

// The same bilingual name search as the catalog (ADR 0015): English or German
// name, a literal substring (wildcards escaped), folded for case and accents.
function sqlLikeName(query: string) {
  return cardNameMatches(query)
}

async function toolGetCard(db: Db, cardLocale: AppLocale, args: unknown) {
  const record = requireArgs(args)
  const id = requirePositiveInt(record, 'id')

  const detail = await getCatalogCardDetail(db, id)
  if (!detail) {
    notFound(TOOL_TEXT.cardNotFound)
  }

  return {
    id: detail.card.id,
    name: detail.card.name,
    ...germanNameField(detail.card.nameDe, cardLocale),
    type: detail.card.type,
    desc: detail.card.desc,
    ...(cardLocale === 'de' && detail.card.descDe ? { descDe: detail.card.descDe } : {}),
    attribute: detail.card.attribute,
    race: detail.card.race,
    level: detail.card.level,
    atk: statForModel(detail.card.atk),
    def: statForModel(detail.card.def),
    archetype: detail.card.archetype,
    banlistInfo: detail.card.banlistInfo,
    printings: capItems(detail.printings, GET_CARD_PRINTINGS_MAX),
    printingsTruncated: detail.printings.length > GET_CARD_PRINTINGS_MAX,
    // Only for a retired card (ADR 0019), so an active card's output is unchanged.
    ...(detail.card.retired ? { retired: true, replacedById: detail.card.replacedById } : {}),
  }
}

/**
 * The caller's owned cards, aggregated per catalog card, with the card facts
 * a deck-building model needs to pick from them (type, attribute, race,
 * level, ATK/DEF, archetype, Extra Deck or not — no card text; `get_card`
 * has that) and, per card, the copy limit `maxCopies` under `formatId` (3
 * without a format). A card the format forbids is left out entirely, so the
 * model never proposes it from the inventory — ported from the one-shot deck
 * assistant's candidate pool (ADR 0006 → ADR 0011). `offset` pages through a
 * result larger than the item cap.
 */
function toolSearchInventory(db: Db, userId: string, cardLocale: AppLocale, args: unknown) {
  const record = requireArgs(args)
  const query = optionalString(record, 'query')
  const collectionId = optionalString(record, 'collectionId')
  const formatId = optionalString(record, 'formatId')
  const offset = optionalOffset(record)
  if (collectionId) {
    requireCollectionOwnedByUser(db, userId, collectionId)
  }
  const format = formatId ? requireAccessibleFormat(db, userId, formatId) : null

  const clauses = [eq(ownedCard.userId, userId)]
  if (query) {
    clauses.push(sqlLikeName(query))
  }
  if (collectionId) {
    clauses.push(eq(ownedCard.collectionId, collectionId))
  }

  const rows = db
    .select({
      catalogCardId: ownedCard.catalogCardId,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      frameType: catalogCard.frameType,
      attribute: catalogCard.attribute,
      race: catalogCard.race,
      level: catalogCard.level,
      atk: catalogCard.atk,
      def: catalogCard.def,
      archetype: catalogCard.archetype,
      quantity: ownedCard.quantity,
      collectionId: ownedCard.collectionId,
      collectionName: collection.name,
    })
    .from(ownedCard)
    .innerJoin(catalogCard, eq(ownedCard.catalogCardId, catalogCard.id))
    .leftJoin(collection, eq(ownedCard.collectionId, collection.id))
    .where(and(...clauses))
    // Ordered so the row-scan bound below (and `offset` paging on top of it)
    // cuts deterministically rather than by insertion order.
    .orderBy(asc(catalogCard.name), asc(ownedCard.id))
    .limit(getAssistantLimits().toolResultItems * SEARCH_INVENTORY_ROW_SCAN_MULTIPLIER)
    .all()

  type Row = typeof rows[number]
  interface Aggregate {
    card: Row
    quantity: number
    collections: Map<string, { id: string, name: string, quantity: number }>
  }

  const byCard = new Map<number, Aggregate>()
  for (const row of rows) {
    const entry = byCard.get(row.catalogCardId) ?? {
      card: row,
      quantity: 0,
      collections: new Map(),
    }
    entry.quantity += row.quantity
    if (row.collectionId) {
      const collectionEntry = entry.collections.get(row.collectionId)
        ?? { id: row.collectionId, name: row.collectionName ?? '', quantity: 0 }
      collectionEntry.quantity += row.quantity
      entry.collections.set(row.collectionId, collectionEntry)
    }
    byCard.set(row.catalogCardId, entry)
  }

  const maxCopies = maxCopiesByCard(db, format?.rules ?? null, [...byCard.keys()])

  const items = [...byCard.values()]
    .sort((a, b) => a.card.name.localeCompare(b.card.name))
    .map(({ card, quantity, collections }) => ({
      catalogCardId: card.catalogCardId,
      name: card.name,
      ...germanNameField(card.nameDe, cardLocale),
      type: card.type,
      attribute: card.attribute,
      race: card.race,
      level: card.level,
      atk: statForModel(card.atk),
      def: statForModel(card.def),
      archetype: card.archetype,
      isExtra: isExtraDeckCard(card),
      quantity,
      maxCopies: maxCopies.get(card.catalogCardId) ?? 0,
      collections: [...collections.values()],
    }))
    .filter(item => item.maxCopies > 0)

  const { toolResultItems } = getAssistantLimits()
  const page = items.slice(offset, offset + toolResultItems)
  return {
    items: page,
    truncated: offset + page.length < items.length,
    total: items.length,
    offset,
    ...(format ? { formatName: format.name } : {}),
  }
}

function toolListCollections(db: Db, userId: string) {
  const { items } = listCollections(db, userId)
  return capResult(items.map(item => ({ id: item.id, name: item.name, cardCount: item.cardCount })))
}

function toolListDecks(db: Db, userId: string, args: unknown) {
  const record = requireArgs(args)
  const query = optionalString(record, 'query')
  const { items, total } = listDecks(db, userId, { q: query, pageSize: getAssistantLimits().toolResultItems })

  const mapped = items.map(item => ({
    id: item.id,
    name: item.name,
    formatName: item.formatName,
    counts: { main: item.mainCount, extra: item.extraCount, side: item.sideCount, total: item.cardCount },
    legal: item.legal,
  }))

  return { items: mapped, truncated: total > mapped.length, total }
}

function deckRowView(row: DeckCardRow, section: DeckSection, cardLocale: AppLocale) {
  return {
    catalogCardId: row.catalogCardId,
    name: row.name,
    ...germanNameField(row.nameDe, cardLocale),
    section,
    quantity: row.quantity,
    owned: row.owned,
  }
}

function toolGetDeck(db: Db, userId: string, cardLocale: AppLocale, args: unknown) {
  const record = requireArgs(args)
  const deckId = requireNonEmptyString(record, 'id')
  const detail = getDeckDetail(db, userId, deckId)

  return {
    id: detail.id,
    name: detail.name,
    formatName: detail.format?.name ?? null,
    counts: detail.counts,
    sections: {
      main: detail.sections.main.map(row => deckRowView(row, 'main', cardLocale)),
      extra: detail.sections.extra.map(row => deckRowView(row, 'extra', cardLocale)),
      side: detail.sections.side.map(row => deckRowView(row, 'side', cardLocale)),
    },
    validation: detail.validation
      ? { legal: detail.validation.legal, issues: detail.validation.issues.map(issue => issue.message) }
      : null,
    warnings: warningMessages(detail.warnings),
  }
}

/** A deck's format-independent warnings as the model reads them: their canonical English messages (#148). */
function warningMessages(warnings: DeckWarning[]): string[] {
  return warnings.map(warning => warning.message)
}

function toolListFormats(db: Db, userId: string) {
  const { items } = listRuleFormats(db, userId)
  return capResult(items.map(item => ({ id: item.id, name: item.name, isBuiltin: item.isBuiltin })))
}

/** Validates the model's `cards` array (a complete planned deck): same per-row rules as `POST /api/decks`, plus known catalog ids and legal sections. */
function parseProposalCards(db: Db, rawCards: unknown): DeckCardInput[] {
  const cards: DeckCardInput[] = validateDeckCreateCardsInput({ cards: rawCards ?? [] }) ?? []
  assertKnownCardsInSections(db, cards)
  return cards
}

/** Validates the model's `changes` array (absolute quantities, 0 removes): same per-row rules as `PUT /api/decks/:id/cards`. */
function parseProposalChanges(db: Db, rawChanges: unknown): DeckCardInput[] {
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    badRequest('changes must be a non-empty array')
  }
  // Matches (and never exceeds) the bulk inventory endpoint's own cap
  // (`INVENTORY_BULK_MAX_ITEMS`, server/utils/inventory.ts) — a deck-cards
  // write is no less bounded than an inventory one.
  if (rawChanges.length > INVENTORY_BULK_MAX_ITEMS) {
    badRequest(`changes must contain at most ${INVENTORY_BULK_MAX_ITEMS} entries`)
  }
  const changes: DeckCardInput[] = rawChanges.map(raw => validateDeckCardInput(raw))
  assertKnownCardsInSections(db, changes)
  return changes
}

function assertKnownCardsInSections(db: Db, cards: DeckCardInput[]) {
  const missingIds = missingCatalogCardIds(db, cards.map(card => card.catalogCardId))
  if (missingIds.length > 0) {
    badRequest(TOOL_TEXT.unknownCardIds(missingIds))
  }
  assertCardsFitSections(db, cards)
}

/**
 * Three shapes. `deckId` alone (optionally with `formatId`) checks a saved
 * deck exactly as before (the rule engine's `DeckValidation`). `cards`
 * checks a planned new deck and `deckId` + `changes` a deck with proposed
 * changes applied — both return the same preview a write tool attaches to
 * its pending action (counts, legality, missing cards), so the model can fix
 * problems *before* proposing anything.
 */
function toolValidateDeck(db: Db, userId: string, cardLocale: AppLocale, args: unknown) {
  const record = requireArgs(args)
  const deckId = optionalString(record, 'deckId')
  const formatId = optionalString(record, 'formatId')
  const hasCards = record.cards !== undefined && record.cards !== null
  const hasChanges = record.changes !== undefined && record.changes !== null

  if (hasCards) {
    if (deckId) {
      badRequest(TOOL_TEXT.cardsWithDeckId)
    }
    return previewForModel(previewDeckProposal(db, userId, { cards: parseProposalCards(db, record.cards), formatId }), cardLocale)
  }
  if (!deckId) {
    badRequest(TOOL_TEXT.deckIdOrCards)
  }
  if (hasChanges) {
    return previewForModel(previewDeckProposal(db, userId, { deckId, changes: parseProposalChanges(db, record.changes), formatId }), cardLocale)
  }

  if (formatId) {
    const format = requireAccessibleFormat(db, userId, formatId)
    return {
      ...validationForModel(validateDeckWithRules(db, userId, deckId, format.rules), cardLocale),
      warnings: warningMessages(getDeckDetail(db, userId, deckId).warnings),
    }
  }

  const detail = getDeckDetail(db, userId, deckId)
  if (!detail.validation) {
    // No format to check against: no legality statement, but the warnings still apply (#148).
    return { legal: null, issues: [], note: TOOL_TEXT.noFormatAssigned, warnings: warningMessages(detail.warnings) }
  }
  return { ...validationForModel(detail.validation, cardLocale), warnings: warningMessages(detail.warnings) }
}

// --- Write tools (propose a pending action; never mutate directly) ------------

/**
 * A preview as the model reads it: the issues and warnings as canonical
 * English text only — `issueDetails` and `warningDetails` (code + params) are
 * for the UI's action card and would just repeat them in the tool result —
 * and the missing cards with their German name only in German card language
 * (ADR 0015).
 */
function previewForModel(fullPreview: AssistantDeckPreview, cardLocale: AppLocale): AssistantDeckPreview {
  const { warningDetails: _warningDetails, ...preview } = fullPreview
  const missing = preview.missing.map(({ catalogCardId, name, nameDe, ...card }) => ({
    catalogCardId,
    name,
    ...germanNameField(nameDe, cardLocale),
    ...card,
  }))
  if (!preview.validation) {
    return { ...preview, missing }
  }
  const { issueDetails: _issueDetails, ...validation } = preview.validation
  return { ...preview, validation, missing }
}

/** A deck validation as the model reads it: an issue's German card name (`params.cardNameDe`) only in German card language (ADR 0015). */
function validationForModel(validation: DeckValidation, cardLocale: AppLocale): DeckValidation {
  if (cardLocale === 'de') {
    return validation
  }
  return {
    ...validation,
    issues: validation.issues.map(({ params: { cardNameDe: _cardNameDe, ...params }, ...issue }) => ({ ...issue, params })),
  }
}

function pendingOutcome(
  kind: AssistantActionKind,
  payload: Record<string, unknown>,
  summary: string,
  extraResult: Record<string, unknown> = {},
): ToolOutcome {
  return {
    action: { kind, payload, summary },
    result: { status: 'pending_confirmation', message: TOOL_TEXT.pending, summary, ...extraResult },
  }
}

/**
 * The proposal's rows plus each card's English and German (ADR 0015) name —
 * for the action card's table and summary only (see `executeActionPayload`);
 * the model never reads the payload.
 */
function withCardNames<T extends { catalogCardId: number }>(db: Db, cards: T[]): Array<T & { name: string, nameDe: string | null }> {
  const { cardNames, cardNamesDe } = loadCardNameRecords(db, cards.map(card => card.catalogCardId))
  return cards.map(card => ({
    ...card,
    name: cardNames[card.catalogCardId] ?? `#${card.catalogCardId}`,
    nameDe: cardNamesDe[card.catalogCardId] ?? null,
  }))
}

/** Adds the display-only `printing` label ("LOB-001 (UR)") to rows with a printing. */
function withPrintingLabels<T extends { printingId: string | null }>(db: Db, rows: T[]): Array<T & { printing?: string }> {
  const ids = [...new Set(rows.map(row => row.printingId).filter((id): id is string => id !== null))]
  if (ids.length === 0) {
    return rows
  }
  const printings = new Map(
    db.select({ id: catalogPrinting.id, setCode: catalogPrinting.setCode, rarity: catalogPrinting.rarity, rarityCode: catalogPrinting.rarityCode })
      .from(catalogPrinting)
      .where(inArray(catalogPrinting.id, ids))
      .all()
      .map(printing => [printing.id, printingShortLabel(printing)]),
  )
  return rows.map(row => row.printingId && printings.has(row.printingId) ? { ...row, printing: printings.get(row.printingId)! } : row)
}

async function toolAddToInventory(db: Db, userId: string, args: unknown): Promise<ToolOutcome> {
  const record = requireArgs(args)
  const inputs: InventoryInput[] = validateInventoryBulkInput(db, userId, { items: record.items })
  // The payload items carry `{ catalogCardId, collectionId, printingId,
  // quantity, note }` (ADR 0034; no language, condition or edition, ADR 0017)
  // plus a display-only `name`/`nameDe` and `printing` label, like the deck
  // tools' rows: `validateInventoryInput` reads only the fields it knows, so
  // the display fields never reach the write.
  const items = withPrintingLabels(db, withCardNames(db, inputs))

  const summary = ACTION_SUMMARY.addToInventory(items.length, items.map(item => `${item.name} x${item.quantity}`).join(', '))

  return pendingOutcome('add_to_inventory', { items }, summary)
}

function assertCardsFitSections(db: Db, cards: Array<{ catalogCardId: number, section: DeckSection }>) {
  const cardData = loadCardDataForValidation(db, cards.map(card => card.catalogCardId))
  for (const card of cards) {
    const info = cardData.get(card.catalogCardId)
    if (info && !isSectionAllowedForCard(info, card.section)) {
      badRequest(TOOL_TEXT.sectionNotAllowed(card.catalogCardId, card.section))
    }
  }
}

async function toolCreateDeck(db: Db, userId: string, cardLocale: AppLocale, args: unknown): Promise<ToolOutcome> {
  const record = requireArgs(args)
  const name = requireNonEmptyString(record, 'name')
  if (name.length > DECK_NAME_MAX_LENGTH) {
    badRequest(`name must be at most ${DECK_NAME_MAX_LENGTH} characters`)
  }
  const formatId = optionalString(record, 'formatId')
  if (formatId) {
    requireAssignableFormat(db, userId, formatId)
  }

  const cards = parseProposalCards(db, record.cards)
  const preview = previewDeckProposal(db, userId, { cards, formatId })

  const totalQuantity = cards.reduce((sum, card) => sum + card.quantity, 0)
  const summary = ACTION_SUMMARY.createDeck(name, totalQuantity)

  // `formatName`, the rows' `name` and `preview` are display-only extras for
  // the action card (a snapshot from proposal time) — `executeActionPayload`
  // reads only the keys it needs and re-validates those, so the extras never
  // influence what gets written.
  return pendingOutcome('create_deck', {
    name,
    description: null,
    formatId: formatId ?? null,
    formatName: preview.formatName,
    cards: withCardNames(db, cards),
    preview,
  }, summary, { preview: previewForModel(preview, cardLocale) })
}

async function toolUpdateDeckCards(db: Db, userId: string, cardLocale: AppLocale, args: unknown): Promise<ToolOutcome> {
  const record = requireArgs(args)
  const deckId = requireNonEmptyString(record, 'deckId')
  const detail = getDeckDetail(db, userId, deckId)

  const changes = parseProposalChanges(db, record.changes)
  const preview = previewDeckProposal(db, userId, { deckId, changes })

  const summary = ACTION_SUMMARY.updateDeckCards(changes.length, detail.name)

  // `deckName`, the rows' `name` and `preview` are display-only (see create_deck above).
  return pendingOutcome('update_deck_cards', {
    deckId,
    deckName: detail.name,
    changes: withCardNames(db, changes),
    preview,
  }, summary, { preview: previewForModel(preview, cardLocale) })
}

/** `formatId` for set_deck_format: required key; `''` (or `null`) = remove the format. */
function parseTargetFormatId(record: Record<string, unknown>): string | null {
  if (!('formatId' in record) || record.formatId === undefined) {
    badRequest(TOOL_TEXT.formatIdRequired)
  }
  const value = record.formatId
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    badRequest('formatId must be a string or null')
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

async function toolSetDeckFormat(db: Db, userId: string, cardLocale: AppLocale, args: unknown): Promise<ToolOutcome> {
  const record = requireArgs(args)
  const deckId = requireNonEmptyString(record, 'deckId')
  const detail = getDeckDetail(db, userId, deckId)

  const formatId = parseTargetFormatId(record)
  // Same check `updateDeck` runs again at apply time.
  const format = formatId ? requireAssignableFormat(db, userId, formatId) : null

  if ((detail.format?.id ?? null) === formatId) {
    badRequest(formatId ? TOOL_TEXT.sameFormat : TOOL_TEXT.alreadyNoFormat)
  }

  const preview = previewDeckProposal(db, userId, { deckId, formatId })

  const summary = ACTION_SUMMARY.setDeckFormat(detail.name, detail.format?.name ?? null, format?.name ?? null)

  // Only `deckId`/`formatId` are ever written; `deckName`, `formatName`,
  // `previousFormat*` and `preview` are display-only (see create_deck above).
  return pendingOutcome('set_deck_format', {
    deckId,
    deckName: detail.name,
    formatId,
    formatName: format?.name ?? null,
    previousFormatId: detail.format?.id ?? null,
    previousFormatName: detail.format?.name ?? null,
    preview,
  }, summary, { preview: previewForModel(preview, cardLocale) })
}

// --- Registry --------------------------------------------------------------------
//
// The parameter schemas are hand-written, flat JSON Schema on purpose (#54,
// ADR 0020): plain `type`s, no `['string', 'null']` unions, no `anyOf`, no
// `$ref`. The configured OpenAI-compatible model (MiMo) garbled calls against
// union types into empty arguments. Don't generate them from zod either — its
// `.nullable()`/`.optional()` conversion brings those unions back. Every
// value is validated again by the tool's own `validate*` code anyway.

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: 'search_catalog',
    description: TOOL_DESCRIPTIONS.search_catalog,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.cardNameQuery },
        // The real number is filled in by `toolParameters()` below, from the
        // turn's limits — this array is built once at module load, so the
        // live (possibly overridden) limit can't be baked in here.
        limit: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.searchCatalogLimit(0) },
      },
    },
    run: async (ctx, args) => ({ result: toolSearchCatalog(ctx.db, ctx.cardLocale, args) }),
  },
  {
    name: 'get_card',
    description: TOOL_DESCRIPTIONS.get_card,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.catalogCardId } },
    },
    run: async (ctx, args) => ({ result: await toolGetCard(ctx.db, ctx.cardLocale, args) }),
  },
  {
    name: 'search_inventory',
    description: TOOL_DESCRIPTIONS.search_inventory,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.cardNameQuery },
        collectionId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.collectionId },
        formatId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.inventoryFormatId },
        offset: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.offset },
      },
    },
    run: async (ctx, args) => ({ result: toolSearchInventory(ctx.db, ctx.userId, ctx.cardLocale, args) }),
  },
  {
    name: 'list_collections',
    description: TOOL_DESCRIPTIONS.list_collections,
    kind: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: async (ctx) => ({ result: toolListCollections(ctx.db, ctx.userId) }),
  },
  {
    name: 'list_decks',
    description: TOOL_DESCRIPTIONS.list_decks,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.deckQuery } },
    },
    run: async (ctx, args) => ({ result: toolListDecks(ctx.db, ctx.userId, args) }),
  },
  {
    name: 'get_deck',
    description: TOOL_DESCRIPTIONS.get_deck,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.deckId } },
    },
    run: async (ctx, args) => ({ result: toolGetDeck(ctx.db, ctx.userId, ctx.cardLocale, args) }),
  },
  {
    name: 'list_formats',
    description: TOOL_DESCRIPTIONS.list_formats,
    kind: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    run: async (ctx) => ({ result: toolListFormats(ctx.db, ctx.userId) }),
  },
  {
    name: 'validate_deck',
    description: TOOL_DESCRIPTIONS.validate_deck,
    kind: 'read',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deckId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.validateDeckId },
        formatId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.validateFormatId },
        cards: {
          type: 'array',
          description: TOOL_PARAM_DESCRIPTIONS.validateCards,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['catalogCardId', 'section', 'quantity'],
            properties: {
              catalogCardId: { type: 'integer' },
              section: { type: 'string', enum: ['main', 'extra', 'side'] },
              quantity: { type: 'integer' },
            },
          },
        },
        changes: {
          type: 'array',
          description: TOOL_PARAM_DESCRIPTIONS.validateChanges,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['catalogCardId', 'section', 'quantity'],
            properties: {
              catalogCardId: { type: 'integer' },
              section: { type: 'string', enum: ['main', 'extra', 'side'] },
              quantity: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.absoluteQuantity },
            },
          },
        },
      },
    },
    run: async (ctx, args) => ({ result: toolValidateDeck(ctx.db, ctx.userId, ctx.cardLocale, args) }),
  },
  {
    name: 'add_to_inventory',
    description: TOOL_DESCRIPTIONS.add_to_inventory,
    kind: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['catalogCardId', 'quantity'],
            properties: {
              catalogCardId: { type: 'integer' },
              quantity: { type: 'integer' },
              collectionId: { type: 'string' },
              printingId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.printingId },
            },
          },
        },
      },
    },
    run: async (ctx, args) => toolAddToInventory(ctx.db, ctx.userId, args),
  },
  {
    name: 'create_deck',
    description: TOOL_DESCRIPTIONS.create_deck,
    kind: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        formatId: { type: 'string' },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['catalogCardId', 'section', 'quantity'],
            properties: {
              catalogCardId: { type: 'integer' },
              section: { type: 'string', enum: ['main', 'extra', 'side'] },
              quantity: { type: 'integer' },
            },
          },
        },
      },
    },
    run: async (ctx, args) => toolCreateDeck(ctx.db, ctx.userId, ctx.cardLocale, args),
  },
  {
    name: 'update_deck_cards',
    description: TOOL_DESCRIPTIONS.update_deck_cards,
    kind: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['deckId', 'changes'],
      properties: {
        deckId: { type: 'string' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['catalogCardId', 'section', 'quantity'],
            properties: {
              catalogCardId: { type: 'integer' },
              section: { type: 'string', enum: ['main', 'extra', 'side'] },
              quantity: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.absoluteQuantity },
            },
          },
        },
      },
    },
    run: async (ctx, args) => toolUpdateDeckCards(ctx.db, ctx.userId, ctx.cardLocale, args),
  },
  {
    name: 'set_deck_format',
    description: TOOL_DESCRIPTIONS.set_deck_format,
    kind: 'write',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['deckId', 'formatId'],
      properties: {
        deckId: { type: 'string' },
        // A plain string, not `['string', 'null']`: the configured
        // OpenAI-compatible provider garbled calls against the union type
        // (empty arguments). The server still accepts null too.
        formatId: { type: 'string', description: TOOL_PARAM_DESCRIPTIONS.setFormatId },
      },
    },
    run: async (ctx, args) => toolSetDeckFormat(ctx.db, ctx.userId, ctx.cardLocale, args),
  },
]

/** Patches `search_catalog`'s `limit` param description with the live configured cap — the rest of `ASSISTANT_TOOLS` needs no per-call values. */
function toolParameters(tool: AssistantTool, toolResultItems: number): Record<string, unknown> {
  if (tool.name !== 'search_catalog') {
    return tool.parameters
  }
  const properties = tool.parameters.properties as Record<string, unknown>
  return {
    ...tool.parameters,
    properties: {
      ...properties,
      limit: { type: 'integer', description: TOOL_PARAM_DESCRIPTIONS.searchCatalogLimit(toolResultItems) },
    },
  }
}

// --- The tool set for the AI SDK engine (ADR 0020) ----------------------------------

/** An error's technical (English) `statusMessage` — what the model reads as a tool error. */
export function toolErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.statusMessage === 'string' && error.statusMessage !== '') {
    return error.statusMessage
  }
  return TOOL_TEXT.unexpectedError
}

// A result over budget is replaced with a small, valid JSON envelope instead
// of being cut off mid-string — a truncated JSON document is not just
// unreadable for a human, it's not parseable at all, so a model asked to
// reason about "the tool result" gets a syntax-broken blob instead of data.
export function serializeToolResult(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value ?? null)
  if (json.length <= maxChars) {
    return json
  }
  return JSON.stringify(TOOL_TEXT.resultTooLarge)
}

type AssistantActionRow = typeof assistantAction.$inferSelect

/** Persists a write tool's proposal as a pending `assistant_action` of `messageId` (an existing assistant message — the FK is enforced). */
export function insertPendingAction(
  db: Db,
  fields: { conversationId: string, messageId: string, userId: string, action: AssistantProposedAction },
): AssistantActionRow {
  const [row] = db
    .insert(assistantAction)
    .values({
      id: randomUUID(),
      conversationId: fields.conversationId,
      messageId: fields.messageId,
      userId: fields.userId,
      kind: fields.action.kind,
      payload: fields.action.payload,
      summary: fields.action.summary,
      status: 'pending',
      createdAt: new Date(),
    })
    .returning()
    .all()
  return row!
}

/**
 * The AI SDK's input validation for one tool: the input must be an object,
 * and not an empty one when the schema has required fields (#54: a model
 * that writes the call into its text often sends `{}` or `""` as the
 * arguments). A failure becomes a tool error the model reads, and the turn
 * goes on. Everything beyond that is checked by the tool's own validators.
 */
export function validateToolInput(schema: Record<string, unknown>, value: unknown):
  | { success: true, value: Record<string, unknown> }
  | { success: false, error: Error } {
  const required = Array.isArray(schema.required) ? schema.required : []
  if (!isRecord(value) || (required.length > 0 && Object.keys(value).length === 0)) {
    return { success: false, error: new AssistantToolError(TOOL_TEXT.emptyArguments) }
  }
  return { success: true, value }
}

export interface AssistantToolSetContext extends ToolRunContext {
  conversationId: string
  /** The assistant message the turn streams into — `assistant_action.message_id` of a proposal. */
  messageId: string
  /** `getAssistantLimits()` of the turn: `toolResultChars` caps a serialized result, `toolResultItems` goes into search_catalog's `limit` description. */
  limits: { toolResultChars: number, toolResultItems: number }
  /** The view a proposal's `data-action` part carries (injected by the turn: assistant-chat.ts `hydrateActionViews`). */
  actionView: (row: AssistantActionRow) => AssistantActionView
  /** The current name of one of the caller's decks, or undefined (#53) — for a tool part's display-only `deckName`. */
  deckName: (deckId: string) => string | undefined
  /** Receives a proposal's view with the id of the tool call that made it; the turn writes it as a `data-action` part after that call's result. */
  onAction: (toolCallId: string, view: AssistantActionView) => void
  /**
   * Receives the new view of an earlier proposal of this turn whose preview
   * changed (a later proposal for the same deck, see
   * `combineTurnDeckPreviews`), with the id of the tool call that changed it.
   * The turn replaces a view it hasn't written yet, else writes the new view
   * after that call's result (a `data-action` part with the same id replaces
   * the earlier one). Defaults to `onAction`.
   */
  onActionUpdated?: (toolCallId: string, view: AssistantActionView) => void
}

// --- Several proposals for one deck in one turn -----------------------------------

/** A deck proposal of this turn: update_deck_cards (its changes) or set_deck_format (its format). */
interface TurnDeckProposal {
  actionId: string
  deckId: string
  changes: DeckCardInput[]
  /** Only set_deck_format: the new format (null = none). */
  formatId?: string | null
}

/** The deck-affecting part of an update_deck_cards / set_deck_format proposal's payload, or null for any other proposal. */
function turnDeckProposalOf(action: Pick<AssistantProposedAction, 'kind' | 'payload'>): Omit<TurnDeckProposal, 'actionId'> | null {
  const { kind, payload } = action
  if (typeof payload.deckId !== 'string') {
    return null
  }
  if (kind === 'update_deck_cards' && Array.isArray(payload.changes)) {
    const changes = (payload.changes as DeckCardInput[]).map(({ catalogCardId, section, quantity }) => ({ catalogCardId, section, quantity }))
    return { deckId: payload.deckId, changes }
  }
  if (kind === 'set_deck_format') {
    return { deckId: payload.deckId, changes: [], formatId: typeof payload.formatId === 'string' ? payload.formatId : null }
  }
  return null
}

/**
 * The preview of a deck once all of `proposals` (one deck, in call order)
 * are applied: every card change on top of the deck's current cards (a later
 * change of the same card and section wins), checked against the last
 * proposed format, or the deck's own when none was proposed.
 */
function combinedDeckPreview(db: Db, userId: string, deckId: string, proposals: Array<Omit<TurnDeckProposal, 'actionId'>>): AssistantDeckPreview {
  const formatProposals = proposals.filter(proposal => proposal.formatId !== undefined)
  const preview = previewDeckProposal(db, userId, {
    deckId,
    changes: proposals.flatMap(proposal => proposal.changes),
    ...(formatProposals.length > 0 ? { formatId: formatProposals.at(-1)!.formatId } : {}),
  })
  return proposals.length > 1 ? { ...preview, combined: true } : preview
}

/**
 * After one proposal of a package was applied, rejected or failed (ADR 0026):
 * recomputes the previews of the package's remaining pending proposals — the
 * same answer's pending update_deck_cards / set_deck_format proposals for
 * the same deck — on the deck as it is now, together (in the order they were
 * made) or, for the last one, alone. Returns the updated rows; none when the
 * action wasn't part of a package or its deck is gone.
 */
export function refreshPackagePreviews(db: Db, userId: string, resolved: AssistantActionRow): AssistantActionRow[] {
  const resolvedProposal = turnDeckProposalOf(resolved)
  if (!resolvedProposal) {
    return []
  }
  const remaining = db.select().from(assistantAction)
    .where(and(
      eq(assistantAction.messageId, resolved.messageId),
      eq(assistantAction.userId, userId),
      eq(assistantAction.status, 'pending'),
    ))
    // Insertion order (the order the model made the calls): `created_at` has whole seconds only.
    .orderBy(sql`rowid`)
    .all()
    .flatMap((row) => {
      const proposal = turnDeckProposalOf(row)
      return proposal && proposal.deckId === resolvedProposal.deckId ? [{ ...proposal, actionId: row.id }] : []
    })
  if (remaining.length === 0) {
    return []
  }
  let preview: AssistantDeckPreview
  try {
    preview = combinedDeckPreview(db, userId, resolvedProposal.deckId, remaining)
  }
  catch {
    // The deck (or a format) is gone: applying the rest fails anyway, with its own message.
    return []
  }
  return remaining.flatMap(proposal => updatePendingActionPreview(db, proposal.actionId, preview) ?? [])
}

/** The proposals of `proposals` the user hasn't applied or rejected yet (they can while the turn still runs). */
function stillPending(db: Db, proposals: TurnDeckProposal[]): TurnDeckProposal[] {
  if (proposals.length === 0) {
    return []
  }
  const pending = new Set(db.select({ id: assistantAction.id }).from(assistantAction)
    .where(and(inArray(assistantAction.id, proposals.map(proposal => proposal.actionId)), eq(assistantAction.status, 'pending')))
    .all()
    .map(row => row.id))
  return proposals.filter(proposal => pending.has(proposal.actionId))
}

/** Replaces the stored preview of a still pending proposal; returns the updated row, or null when it isn't pending any more. */
function updatePendingActionPreview(db: Db, actionId: string, preview: AssistantDeckPreview): AssistantActionRow | null {
  const row = db.select().from(assistantAction)
    .where(and(eq(assistantAction.id, actionId), eq(assistantAction.status, 'pending')))
    .get()
  if (!row) {
    return null
  }
  const [updated] = db.update(assistantAction)
    .set({ payload: { ...row.payload, preview } })
    .where(and(eq(assistantAction.id, actionId), eq(assistantAction.status, 'pending')))
    .returning()
    .all()
  return updated ?? null
}

export type AssistantToolSet = Record<AssistantToolName, Tool<Record<string, unknown>, AssistantToolOutput>>

/**
 * The registry above as an AI SDK tool set, built per turn: the flat schemas
 * unchanged (`jsonSchema` with `validateToolInput`), `execute` running the
 * tool's own validation and logic (a failure is an `AssistantToolError` with
 * the English message the model reads), capping the serialized result at
 * `limits.toolResultChars`, and turning a write tool's proposal into a
 * pending `assistant_action` of `ctx.messageId`. The tool part's output is
 * `{ result, deckName?, card?, actionId? }`: the chip's display names (#53,
 * #132) and the proposal a write call created (#116, so the history can
 * report its current status); the model only ever reads `result`
 * (`toModelOutput`).
 */
export function buildAssistantToolSet(ctx: AssistantToolSetContext): AssistantToolSet {
  // The turn's deck proposals so far, in call order (#148).
  const turnDeckProposals: TurnDeckProposal[] = []
  const onActionUpdated = ctx.onActionUpdated ?? ctx.onAction

  const entries = ASSISTANT_TOOLS.map((definition) => {
    const parameters = toolParameters(definition, ctx.limits.toolResultItems)
    const name = definition.name as AssistantToolName
    const assistantTool = tool({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(parameters as JSONSchema7, {
        validate: value => validateToolInput(parameters, value),
      }),
      execute: async (input, { toolCallId }): Promise<AssistantToolOutput> => {
        try {
          const outcome = await definition.run(ctx, input)
          let action = 'action' in outcome ? outcome.action : undefined
          let resultValue = outcome.result
          // Several proposals for one deck in one turn (e.g. set_deck_format
          // + update_deck_cards) form one package: each previews the deck
          // with all of them applied (#148, ADR 0026).
          const deckProposal = action ? turnDeckProposalOf(action) : null
          const earlier = deckProposal ? stillPending(ctx.db, turnDeckProposals.filter(proposal => proposal.deckId === deckProposal.deckId)) : []
          const combined = deckProposal && earlier.length > 0
            ? combinedDeckPreview(ctx.db, ctx.userId, deckProposal.deckId, [...earlier, deckProposal])
            : null
          if (action && combined) {
            action = { ...action, payload: { ...action.payload, preview: combined } }
            resultValue = { ...(resultValue as Record<string, unknown>), preview: previewForModel(combined, ctx.cardLocale) }
          }
          const result: unknown = JSON.parse(serializeToolResult(resultValue, ctx.limits.toolResultChars))
          let actionId: string | undefined
          if (action) {
            const row = insertPendingAction(ctx.db, {
              conversationId: ctx.conversationId,
              messageId: ctx.messageId,
              userId: ctx.userId,
              action,
            })
            actionId = row.id
            ctx.onAction(toolCallId, ctx.actionView(row))
            if (deckProposal) {
              turnDeckProposals.push({ ...deckProposal, actionId: row.id })
            }
            for (const proposal of combined ? earlier : []) {
              const updated = updatePendingActionPreview(ctx.db, proposal.actionId, combined!)
              if (updated) {
                onActionUpdated(toolCallId, ctx.actionView(updated))
              }
            }
          }
          const deckId = toolCallDeckId({ name, arguments: input })
          const deckName = deckId ? ctx.deckName(deckId) : undefined
          const cardId = toolCallCardId(name, input, outcome.result)
          const card = cardId !== null ? resolveCardNames(ctx.db, [cardId]).get(cardId) : undefined
          return {
            result,
            ...(deckName !== undefined ? { deckName } : {}),
            ...(card ? { card } : {}),
            ...(actionId ? { actionId } : {}),
          }
        }
        catch (error) {
          throw error instanceof AssistantToolError ? error : new AssistantToolError(toolErrorMessage(error))
        }
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: (output.result ?? null) as JSONValue }),
    })
    return [name, assistantTool] as const
  })
  return Object.fromEntries(entries) as AssistantToolSet
}

// --- Actions: apply/reject a pending write --------------------------------------

function actionAlreadyResolved(): never {
  throw createError({ statusCode: 409, statusMessage: 'This action was already resolved', data: { code: 'action_already_resolved' } })
}

function requireOwnAction(db: Db, userId: string, actionId: string): AssistantActionRow {
  const row = db
    .select()
    .from(assistantAction)
    .where(and(eq(assistantAction.id, actionId), eq(assistantAction.userId, userId)))
    .get()

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: 'Action not found', data: { code: 'action_not_found' } })
  }
  return row
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'statusMessage' in error && typeof (error as { statusMessage?: unknown }).statusMessage === 'string') {
    return (error as { statusMessage: string }).statusMessage
  }
  return 'Unknown error while applying the action'
}

/**
 * Re-validates a pending action's stored payload against the *current* state
 * of the world (deck ownership, catalog card existence, section legality,
 * quantity bounds) before executing it — the payload was validated once when
 * the tool call first proposed it, but time has passed since (cards can be
 * deleted from the catalog, formats removed, decks deleted) and nothing
 * stops a payload row from being anything the `assistant_action` schema
 * allows. Reuses the same validators as the tool layer and the deck/
 * inventory APIs themselves, so this is defense-in-depth, not the only line
 * of defense.
 *
 * Only the keys a write needs are read (`name`/`description`/`formatId`/
 * `cards` for create_deck, `deckId`/`changes` for update_deck_cards,
 * `deckId`/`formatId` for set_deck_format, and per row only
 * `catalogCardId`/`section`/`quantity`); the display-only extras the tools
 * store next to them (`preview`, `formatName`, `deckName`,
 * `previousFormatId`/`previousFormatName`, each row's `name`) are ignored
 * here, so they can never alter a write.
 *
 * Must run synchronously inside the caller's transaction (`applyAction`) —
 * every write util invoked here (`addOwnedCardsBulkSync`, `createDeck`,
 * `updateDeck`, `upsertDeckCard`) is synchronous itself.
 */
function executeActionPayload(db: Db, userId: string, action: AssistantActionRow): unknown {
  switch (action.kind) {
    case 'add_to_inventory': {
      const payload = action.payload as unknown as { items: unknown }
      // Actions stored before ADR 0017 may still carry `language`/`condition`/
      // `edition` (ignored) and a `printingId` in the old set-code form; a
      // printing that is not (or no longer) one of the card's is dropped, so
      // the copies are added as "printing unknown" instead of failing (ADR 0034).
      const inputs = validateInventoryBulkInput(db, userId, { items: payload.items }, { unknownPrinting: 'drop' })
      return addOwnedCardsBulkSync(db, userId, inputs)
    }
    case 'create_deck': {
      const payload = action.payload as unknown as {
        name: string
        description: string | null
        formatId: string | null
        cards: unknown
      }
      const cards = validateDeckCreateCardsInput({ cards: payload.cards ?? [] }) ?? []
      const missingIds = missingCatalogCardIds(db, cards.map(card => card.catalogCardId))
      if (missingIds.length > 0) {
        badRequest(TOOL_TEXT.unknownCardIds(missingIds))
      }
      assertCardsFitSections(db, cards)

      // One write with the format: `createDeck` re-validates it
      // (`requireAssignableFormat`) before it writes anything, so a format
      // removed since the action was proposed leaves no orphan deck.
      return createDeck(db, userId, {
        name: payload.name,
        description: payload.description,
        formatId: payload.formatId || null,
      }, cards)
    }
    case 'update_deck_cards': {
      const payload = action.payload as unknown as { deckId: string, changes: unknown }
      const rawChanges = Array.isArray(payload.changes) ? payload.changes : []
      const changes: DeckCardInput[] = rawChanges.map(raw => validateDeckCardInput(raw))
      const missingIds = missingCatalogCardIds(db, changes.map(change => change.catalogCardId))
      if (missingIds.length > 0) {
        badRequest(TOOL_TEXT.unknownCardIds(missingIds))
      }
      assertCardsFitSections(db, changes)

      let detail: DeckDetail | undefined
      for (const change of changes) {
        detail = upsertDeckCard(db, userId, payload.deckId, change)
      }
      return detail
    }
    case 'set_deck_format': {
      const payload = action.payload as { deckId?: unknown, formatId?: unknown }
      if (typeof payload.deckId !== 'string' || payload.deckId === '') {
        badRequest('deckId is required')
      }
      if (payload.formatId !== null && typeof payload.formatId !== 'string') {
        badRequest('formatId must be a string or null')
      }
      // `updateDeck` re-checks deck ownership and (for a string) that the
      // format is still assignable, inside the caller's transaction.
      return updateDeck(db, userId, payload.deckId, { formatId: payload.formatId })
    }
    default:
      throw createError({ statusCode: 500, statusMessage: `Unknown action kind: ${action.kind}` })
  }
}

/**
 * Applies a pending action's payload with the existing, already-tested write
 * utils. Concurrency-safe: the pending → applied transition is claimed with
 * one conditional `UPDATE ... WHERE status = 'pending'` before anything is
 * executed, so two concurrent applies of the same action can never both run
 * it — the loser's `WHERE` matches no row and gets 409. The payload's writes
 * all run inside one transaction, so a failure partway through (a card
 * deleted from the catalog mid-flight, a format removed) leaves no partial
 * deck/inventory changes — only the action's own status moves to `failed`.
 */
export async function applyAction(db: Db, userId: string, actionId: string): Promise<AssistantActionRow> {
  // 404 for a foreign/missing action, independent of its status.
  requireOwnAction(db, userId, actionId)

  const claimed = db
    .update(assistantAction)
    .set({ status: 'applied', resolvedAt: new Date() })
    .where(and(
      eq(assistantAction.id, actionId),
      eq(assistantAction.userId, userId),
      eq(assistantAction.status, 'pending'),
    ))
    .returning()
    .all()

  if (claimed.length === 0) {
    actionAlreadyResolved()
  }
  const action = claimed[0]!

  try {
    const result = db.transaction(tx => executeActionPayload(tx as unknown as Db, userId, action))
    const [updated] = db
      .update(assistantAction)
      .set({ result: result ?? null })
      .where(eq(assistantAction.id, actionId))
      .returning()
      .all()
    return updated!
  }
  catch (error) {
    const [updated] = db
      .update(assistantAction)
      .set({ status: 'failed', result: { error: errorMessage(error) } })
      .where(eq(assistantAction.id, actionId))
      .returning()
      .all()
    return updated!
  }
}

export function rejectAction(db: Db, userId: string, actionId: string): AssistantActionRow {
  const action = requireOwnAction(db, userId, actionId)
  if (action.status !== 'pending') {
    actionAlreadyResolved()
  }

  const [updated] = db
    .update(assistantAction)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(assistantAction.id, actionId))
    .returning()
    .all()
  return updated!
}
