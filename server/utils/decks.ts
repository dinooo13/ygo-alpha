import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { createError } from 'h3'
import type { useDb } from '../db'
import { catalogCard, deck, deckCard, ruleFormat } from '../db/schema'
import { ownedQuantitiesByCard } from './inventory'
import { cardNameMatches, escapedLike, escapeLikeTerm } from './card-name-search'
import { primaryImageUrlSql } from './card-image-sql'
import { parseQueryTriState } from './query-flag'
import { cardNameDeSql } from './card-translation-sql'
import { cardCategoryRank, compareDeckRows } from '../../shared/deck-order'
import type { AppLocale } from '../../shared/locale'
import { evaluateDeck, germanName } from '../../shared/rule-formats'
import type { DeckValidation, DeckWarning, RuleSet } from '../../shared/rule-formats'
import { loadCardDataForValidation } from './deck-validation'
import { requireAssignableFormat, ruleFormatsById } from './rule-formats'
import { deleteGrantsForResource } from './sharing'
import {
  allowedSectionsForCard,
  DECK_LIMITS,
  DECK_SECTIONS,
  defaultSectionForCard,
  isExtraDeckCard,
  isSectionAllowedForCard,
  DECK_DESCRIPTION_MAX_LENGTH,
  DECK_NAME_MAX_LENGTH,
  MAX_DECK_CARD_QUANTITY,
} from '../../shared/deck-sections'
import type { DeckSection, DeckSectionCard } from '../../shared/deck-sections'
import type { Visibility } from '../../shared/sharing'
import type { DeckCover } from '../../shared/deck-cover'
import { deckBreakdownGroups } from '../../shared/deck-breakdown'
import type { DeckBreakdownGroup } from '../../shared/deck-breakdown'

type Db = ReturnType<typeof useDb>

export {
  allowedSectionsForCard,
  cardCategoryRank,
  DECK_LIMITS,
  DECK_SECTIONS,
  defaultSectionForCard,
  isExtraDeckCard,
  isSectionAllowedForCard,
}
export type { DeckCover, DeckSection, DeckSectionCard }

export { DECK_DESCRIPTION_MAX_LENGTH, DECK_NAME_MAX_LENGTH, MAX_DECK_CARD_QUANTITY }

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 60

export type DeckListSort = 'name' | '-name' | 'newest' | 'updated'

const DECK_LIST_SORTS: readonly DeckListSort[] = ['name', '-name', 'newest', 'updated']

export interface DeckInput {
  name: string
  description: string | null
}

export interface DeckFormatRef {
  id: string
  name: string
  isBuiltin: boolean
}

export interface DeckCardInput {
  catalogCardId: number
  section: DeckSection
  // 0 removes the row (see upsertDeckCard).
  quantity: number
}

export interface DeckCardMoveInput {
  catalogCardId: number
  from: DeckSection
  to: DeckSection
  quantity?: number
}

export interface DeckListOptions {
  q?: string
  sort?: DeckListSort
  page?: number
  pageSize?: number
  contains?: number
  /** A format id, or 'none' for decks without a format. */
  formatId?: string
  /** Only decks that are legal (true) / not legal (false) in their format. */
  legal?: boolean
}

export interface DeckCardRow {
  catalogCardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  /** A Link monster's rating; null for other cards. */
  linkval: number | null
  atk: number | null
  def: number | null
  /** The primary artwork (ADR 0025). */
  imageSmall: string | null
  section: DeckSection
  quantity: number
  /** Copies the user owns in total, across all collections. */
  owned: number
  /** Copies used across all sections of *this* deck. */
  usedInDeck: number
  shortfall: number
  /** YGOPRODeck no longer lists the card (ADR 0019); the row still resolves. */
  retired: boolean
}

export type { DeckWarning }

export interface DeckDetail {
  id: string
  name: string
  description: string | null
  createdAt: Date
  updatedAt: Date
  sections: Record<DeckSection, DeckCardRow[]>
  counts: { main: number, extra: number, side: number, total: number }
  limits: typeof DECK_LIMITS
  /** Informational structural hints, independent of any rule format. */
  warnings: DeckWarning[]
  /** The assigned rule format, or null when the deck has none. */
  format: DeckFormatRef | null
  /** Recomputed on every read/write; null while no format is assigned. */
  validation: DeckValidation | null
  /** Sharing state (Phase 6). */
  visibility: Visibility
  /** Effective cover (#49): the chosen card while it is in Main/Extra, else the rule's pick. */
  cover: DeckCover | null
  /** True when `cover` is the user's explicit choice, false when picked by rule. */
  coverIsChosen: boolean
  /**
   * The user's chosen cover card (`deck.cover_card_id`) while it doesn't
   * count because it has no Main/Extra Deck row (removed or moved to the
   * Side Deck). `cover` is then the rule's pick; re-adding the card makes
   * it the cover again (ADR 0012). Null otherwise.
   */
  inactiveCoverChoice: DeckCover | null
}

function badRequest(message: string, code?: string): never {
  throw createError({ statusCode: 400, statusMessage: message, data: code ? { code } : undefined })
}

function notFound(message = 'Deck not found', code = 'deck_not_found'): never {
  throw createError({ statusCode: 404, statusMessage: message, data: { code } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateDeckInput(body: unknown): DeckInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const rawName = body.name
  if (typeof rawName !== 'string') {
    badRequest('name is required')
  }

  const name = rawName.trim()
  if (name === '') {
    badRequest('name is required')
  }
  if (name.length > DECK_NAME_MAX_LENGTH) {
    badRequest(`name must be at most ${DECK_NAME_MAX_LENGTH} characters`)
  }

  let description: string | null = null
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      badRequest('description must be a string')
    }
    const trimmed = body.description.trim()
    if (trimmed.length > DECK_DESCRIPTION_MAX_LENGTH) {
      badRequest(`description must be at most ${DECK_DESCRIPTION_MAX_LENGTH} characters`)
    }
    description = trimmed === '' ? null : trimmed
  }

  return { name, description }
}

/**
 * `format_id` (or `formatId`) of a create or update body: `undefined` when
 * absent, `null` for `null`/`''` (no format). Whether the format exists is
 * checked by the write (`requireAssignableFormat`).
 */
function parseFormatIdField(body: Record<string, unknown>): string | null | undefined {
  const rawFormatId = body.format_id !== undefined ? body.format_id : body.formatId
  if (rawFormatId === undefined) {
    return undefined
  }
  if (rawFormatId === null || rawFormatId === '') {
    return null
  }
  if (typeof rawFormatId !== 'string') {
    badRequest('format_id must be a string or null')
  }
  return rawFormatId
}

export interface DeckCreateInput extends DeckInput {
  /** The rule format to assign right away; `null` for none. */
  formatId: string | null
  /**
   * The cover card to choose right away (an imported Omega code's, ADR 0012);
   * `null` leaves it to the rule. Must be a Main or Extra Deck card of `cards`.
   */
  coverCardId: number | null
}

/** A `POST /api/decks` body: name, description, the optional `format_id` (#148) and `cover_card_id`. */
export function validateDeckCreateInput(body: unknown): DeckCreateInput {
  const input = validateDeckInput(body)
  const record = body as Record<string, unknown>
  return { ...input, formatId: parseFormatIdField(record) ?? null, coverCardId: parseCoverCardIdField(record) ?? null }
}

/** `cover_card_id` (or `coverCardId`): `undefined` when absent, `null` to clear, else a card id. */
function parseCoverCardIdField(body: Record<string, unknown>): number | null | undefined {
  const rawCoverCardId = body.cover_card_id !== undefined ? body.cover_card_id : body.coverCardId
  if (rawCoverCardId === undefined) {
    return undefined
  }
  if (rawCoverCardId === null || rawCoverCardId === '') {
    return null
  }
  const coverCardId = typeof rawCoverCardId === 'number'
    ? rawCoverCardId
    : typeof rawCoverCardId === 'string' ? Number(rawCoverCardId) : Number.NaN
  if (!Number.isSafeInteger(coverCardId) || coverCardId < 1) {
    badRequest('cover_card_id must be a positive integer or null')
  }
  return coverCardId
}

export interface DeckUpdateInput extends Partial<DeckInput> {
  /** `null` removes the format assignment (validation off). */
  formatId?: string | null
  /**
   * The chosen cover card (#49, ADR 0012); `null` goes back to the rule's
   * pick. Must be a Main or Extra Deck card of the deck (checked by updateDeck).
   */
  coverCardId?: number | null
}

export function validateDeckUpdateInput(body: unknown): DeckUpdateInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const input: DeckUpdateInput = {}
  if (body.name !== undefined) {
    input.name = validateDeckInput({ name: body.name }).name
  }
  if (body.description !== undefined) {
    input.description = validateDeckInput({ name: 'placeholder', description: body.description }).description
  }

  const formatId = parseFormatIdField(body)
  if (formatId !== undefined) {
    input.formatId = formatId
  }

  const coverCardId = parseCoverCardIdField(body)
  if (coverCardId !== undefined) {
    input.coverCardId = coverCardId
  }

  return input
}

function normalizeCatalogCardId(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    badRequest('catalog_card_id must be a positive integer')
  }
  return numberValue
}

function normalizeSection(value: unknown, field = 'section'): DeckSection {
  if (typeof value !== 'string' || !(DECK_SECTIONS as readonly string[]).includes(value)) {
    badRequest(`${field} must be one of ${DECK_SECTIONS.join(', ')}`)
  }
  return value as DeckSection
}

function normalizeQuantity(value: unknown, { allowZero }: { allowZero: boolean }): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < (allowZero ? 0 : 1)) {
    badRequest(allowZero
      ? 'quantity must be a non-negative integer'
      : 'quantity must be a positive integer')
  }
  if (numberValue > MAX_DECK_CARD_QUANTITY) {
    badRequest(`quantity must be at most ${MAX_DECK_CARD_QUANTITY}`)
  }
  return numberValue
}

export function validateDeckCardInput(body: unknown): DeckCardInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const rawQuantity = body.quantity
  return {
    catalogCardId: normalizeCatalogCardId(body.catalog_card_id ?? body.catalogCardId),
    section: normalizeSection(body.section),
    // `quantity` is optional and defaults to 1; 0 removes the row.
    quantity: rawQuantity === undefined || rawQuantity === null || rawQuantity === ''
      ? 1
      : normalizeQuantity(rawQuantity, { allowZero: true }),
  }
}

// Upper bound on how many card rows a single `POST /api/decks` request may
// seed the new deck with (e.g. a chat assistant `create_deck` proposal).
export const MAX_DECK_CREATE_CARDS = 100

/**
 * Validates the optional `cards` array on deck creation — one entry per
 * (catalog_card_id, section), using the same per-item rules as the card
 * upsert endpoint (unknown card, section rule, 1..99 quantity), except a
 * create-time entry may not use quantity 0 (there is nothing to remove yet).
 * Returns `undefined` when the request carries no `cards` field at all, so
 * `PATCH` (which never reads this key) is unaffected.
 */
export function validateDeckCreateCardsInput(body: unknown): DeckCardInput[] | undefined {
  if (!isRecord(body) || body.cards === undefined) {
    return undefined
  }

  const rawCards = body.cards
  if (!Array.isArray(rawCards)) {
    badRequest('cards must be an array')
  }
  if (rawCards.length > MAX_DECK_CREATE_CARDS) {
    badRequest(`cards must contain at most ${MAX_DECK_CREATE_CARDS} entries`)
  }

  return rawCards.map((rawCard) => {
    if (!isRecord(rawCard)) {
      badRequest('Each entry in cards must be an object')
    }
    return {
      catalogCardId: normalizeCatalogCardId(rawCard.catalog_card_id ?? rawCard.catalogCardId),
      section: normalizeSection(rawCard.section),
      quantity: normalizeQuantity(rawCard.quantity, { allowZero: false }),
    }
  })
}

export function validateDeckCardMoveInput(body: unknown): DeckCardMoveInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const from = normalizeSection(body.from, 'from')
  const to = normalizeSection(body.to, 'to')
  if (from === to) {
    badRequest('from and to must be different sections')
  }

  const rawQuantity = body.quantity
  return {
    catalogCardId: normalizeCatalogCardId(body.catalog_card_id ?? body.catalogCardId),
    from,
    to,
    quantity: rawQuantity === undefined || rawQuantity === null || rawQuantity === ''
      ? undefined
      : normalizeQuantity(rawQuantity, { allowZero: false }),
  }
}

export function parseDeckListQuery(rawQuery: Record<string, unknown>): DeckListOptions {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)

  const rawSort = first(rawQuery.sort)
  const sort = typeof rawSort === 'string' && (DECK_LIST_SORTS as readonly string[]).includes(rawSort)
    ? rawSort as DeckListSort
    : undefined

  const rawQ = first(rawQuery.q)
  const rawContains = Number(first(rawQuery.contains ?? rawQuery.containsCardId))
  const page = Number(first(rawQuery.page))
  const pageSize = Number(first(rawQuery.pageSize))

  const rawFormatId = first(rawQuery.formatId ?? rawQuery.format_id)
  const rawLegal = first(rawQuery.legal)

  return {
    q: typeof rawQ === 'string' && rawQ.trim() !== '' ? rawQ.trim() : undefined,
    sort,
    contains: Number.isInteger(rawContains) && rawContains > 0 ? rawContains : undefined,
    page: Number.isInteger(page) && page > 0 ? page : undefined,
    pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : undefined,
    formatId: typeof rawFormatId === 'string' && rawFormatId.trim() !== '' ? rawFormatId.trim() : undefined,
    legal: parseQueryTriState(rawLegal),
  }
}

function requireDeckRow(db: Db, userId: string, deckId: string) {
  const row = db
    .select()
    .from(deck)
    .where(and(eq(deck.id, deckId), eq(deck.userId, userId)))
    .get()

  // A deck the caller doesn't own is indistinguishable from a missing one
  // (ownership boundary, see docs/adr/0002 and 0004).
  if (!row) {
    notFound()
  }

  return row
}

/** The caller's own deck row, or 404 — also used to link a chat conversation to a deck (server/utils/assistant-chat.ts). */
export { requireDeckRow as requireOwnDeck }

function requireCatalogCard(db: Db, catalogCardId: number) {
  const card = db
    .select({ id: catalogCard.id, name: catalogCard.name, type: catalogCard.type, frameType: catalogCard.frameType })
    .from(catalogCard)
    .where(eq(catalogCard.id, catalogCardId))
    .get()

  if (!card) {
    badRequest('catalog_card_id does not exist')
  }

  return card
}

function assertSectionAllowed(card: DeckSectionCard, section: DeckSection) {
  if (!isSectionAllowedForCard(card, section)) {
    badRequest(isExtraDeckCard(card)
      ? 'Extra deck cards can only be placed in the extra or side section'
      : 'Main deck cards can only be placed in the main or side section', 'section_not_allowed')
  }
}

/**
 * Sorts deck sections in place, the conventional deck-list order
 * (`compareDeckRows`, shared with the deck editor's optimistic rows): the
 * Main Deck by monsters / spells / traps, then by name; Extra and Side by name.
 * Names are compared in the card language (ADR 0015) — `en` (the default,
 * which the assistant and snapshots use) by the English name, `de` by the
 * German name where there is one. Endpoints re-sort their response in the
 * request's card language. Shared with server/utils/shared-views.ts.
 */
export function sortDeckSections<T extends { type: string, name: string, nameDe?: string | null }>(
  sections: Record<DeckSection, T[]>,
  cardLocale: AppLocale = 'en',
): Record<DeckSection, T[]> {
  for (const section of DECK_SECTIONS) {
    sections[section].sort((a, b) => compareDeckRows(section, a, b, cardLocale))
  }
  return sections
}

/** A deck detail with its sections sorted in the request's card language (ADR 0015). */
export function inCardLocale<T extends { sections: Record<DeckSection, Array<{ type: string, name: string, nameDe?: string | null }>> }>(
  detail: T,
  cardLocale: AppLocale,
): T {
  sortDeckSections(detail.sections, cardLocale)
  return detail
}

// Exported for reuse by server/utils/shared-views.ts: warnings are computed
// from counts, quantities and the retired flag (no ownership data), so they
// are safe to reuse verbatim in the shared (read-only) deck view.
export function buildWarnings(
  counts: { main: number, extra: number, side: number },
  rows: Array<{ catalogCardId: number, name: string, nameDe?: string | null, quantity: number, retired?: boolean }>,
): DeckWarning[] {
  const warnings: DeckWarning[] = []

  // Canonical English messages (the assistant model reads them); the UI
  // renders `validation.<code>` from the params (ADR 0014).
  const cards = (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`

  if (counts.main < DECK_LIMITS.mainMin) {
    warnings.push({
      code: 'main_below_min',
      params: { section: 'main', count: counts.main, min: DECK_LIMITS.mainMin },
      message: `The Main Deck has ${cards(counts.main)}; the usual minimum is ${DECK_LIMITS.mainMin}.`,
    })
  }
  if (counts.main > DECK_LIMITS.mainMax) {
    warnings.push({
      code: 'main_above_max',
      params: { section: 'main', count: counts.main, max: DECK_LIMITS.mainMax },
      message: `The Main Deck has ${cards(counts.main)}; the usual maximum is ${DECK_LIMITS.mainMax}.`,
    })
  }
  if (counts.extra > DECK_LIMITS.extraMax) {
    warnings.push({
      code: 'extra_above_max',
      params: { section: 'extra', count: counts.extra, max: DECK_LIMITS.extraMax },
      message: `The Extra Deck has ${cards(counts.extra)}; the usual maximum is ${DECK_LIMITS.extraMax}.`,
    })
  }
  if (counts.side > DECK_LIMITS.sideMax) {
    warnings.push({
      code: 'side_above_max',
      params: { section: 'side', count: counts.side, max: DECK_LIMITS.sideMax },
      message: `The Side Deck has ${cards(counts.side)}; the usual maximum is ${DECK_LIMITS.sideMax}.`,
    })
  }

  // The standard copy limit counts every copy in the deck — main, extra, and
  // side combined.
  const copiesByCard = new Map<number, { name: string, nameDe: string | null, copies: number, retired: boolean }>()
  for (const row of rows) {
    const entry = copiesByCard.get(row.catalogCardId)
      ?? { name: row.name, nameDe: row.nameDe ?? null, copies: 0, retired: row.retired ?? false }
    entry.copies += row.quantity
    copiesByCard.set(row.catalogCardId, entry)
  }

  for (const [cardId, entry] of copiesByCard) {
    if (entry.copies > DECK_LIMITS.maxCopies) {
      warnings.push({
        code: 'copies_above_max',
        cardId,
        params: { cardId, cardName: entry.name, ...germanName(entry.nameDe), copies: entry.copies, maxCopies: DECK_LIMITS.maxCopies },
        message: `${entry.name}: ${entry.copies} copies in the deck; the usual maximum is ${DECK_LIMITS.maxCopies}.`,
      })
    }
  }

  // A retired card (ADR 0019) keeps its frozen banlist status and card data.
  // A warning, not a validation issue: format legality stays unchanged
  // (ADR 0023).
  for (const [cardId, entry] of copiesByCard) {
    if (entry.retired) {
      warnings.push({
        code: 'card_retired',
        cardId,
        params: { cardId, cardName: entry.name, ...germanName(entry.nameDe) },
        message: `${entry.name} is no longer in the catalog; its banlist status and card data are no longer updated.`,
      })
    }
  }

  return warnings
}

function loadDeckCardRows(db: Db, userId: string, deckId: string): DeckCardRow[] {
  const rows = db
    .select({
      catalogCardId: deckCard.catalogCardId,
      section: deckCard.section,
      quantity: deckCard.quantity,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      frameType: catalogCard.frameType,
      attribute: catalogCard.attribute,
      race: catalogCard.race,
      level: catalogCard.level,
      linkval: catalogCard.linkval,
      atk: catalogCard.atk,
      def: catalogCard.def,
      imageSmall: primaryImageUrlSql('imageUrlSmall'),
      retiredAt: catalogCard.retiredAt,
    })
    .from(deckCard)
    .innerJoin(catalogCard, eq(deckCard.catalogCardId, catalogCard.id))
    .where(eq(deckCard.deckId, deckId))
    .all()

  const owned = ownedQuantitiesByCard(db, userId, rows.map(row => row.catalogCardId))

  const usedByCard = new Map<number, number>()
  for (const row of rows) {
    usedByCard.set(row.catalogCardId, (usedByCard.get(row.catalogCardId) ?? 0) + row.quantity)
  }

  return rows.map(({ retiredAt, ...row }) => {
    const ownedQuantity = owned.get(row.catalogCardId) ?? 0
    const usedInDeck = usedByCard.get(row.catalogCardId) ?? 0
    return {
      ...row,
      retired: retiredAt !== null,
      section: row.section as DeckSection,
      owned: ownedQuantity,
      usedInDeck,
      shortfall: Math.max(0, usedInDeck - ownedQuantity),
    }
  })
}

/**
 * Runs the rule engine for a deck. Returns `null` when the deck has no format
 * assigned — "no format" means "no legality statement", not "legal".
 */
function buildValidation(
  db: Db,
  rules: RuleSet | undefined,
  rows: Array<{ catalogCardId: number, section: DeckSection, quantity: number, name: string }>,
): DeckValidation | null {
  if (!rules) {
    return null
  }

  const cardData = loadCardDataForValidation(db, rows.map(row => row.catalogCardId))

  return evaluateDeck(
    rules,
    rows.map(row => ({ catalogCardId: row.catalogCardId, section: row.section, quantity: row.quantity })),
    cardData,
  )
}

function buildDeckDetail(db: Db, userId: string, deckRow: typeof deck.$inferSelect): DeckDetail {
  const rows = loadDeckCardRows(db, userId, deckRow.id)
  const cover = loadDeckCovers(db, [deckRow.id]).get(deckRow.id) ?? null

  const formatRow = deckRow.formatId
    ? db
        .select({
          id: ruleFormat.id,
          name: ruleFormat.name,
          isBuiltin: ruleFormat.isBuiltin,
          rules: ruleFormat.rules,
        })
        .from(ruleFormat)
        .where(eq(ruleFormat.id, deckRow.formatId))
        .get()
    : undefined

  const sections: Record<DeckSection, DeckCardRow[]> = { main: [], extra: [], side: [] }
  for (const row of rows) {
    sections[row.section].push(row)
  }

  sortDeckSections(sections)

  const sum = (section: DeckSection) =>
    sections[section].reduce((total, row) => total + row.quantity, 0)

  const counts = { main: sum('main'), extra: sum('extra'), side: sum('side'), total: 0 }
  counts.total = counts.main + counts.extra + counts.side

  const coverIsChosen = cover !== null && cover.catalogCardId === deckRow.coverCardId
  const inactiveCoverChoice = deckRow.coverCardId !== null && !coverIsChosen
    ? loadCoverCard(db, deckRow.coverCardId)
    : null

  return {
    id: deckRow.id,
    name: deckRow.name,
    description: deckRow.description,
    createdAt: deckRow.createdAt,
    updatedAt: deckRow.updatedAt,
    sections,
    counts,
    limits: DECK_LIMITS,
    warnings: buildWarnings(counts, rows),
    format: formatRow
      ? { id: formatRow.id, name: formatRow.name, isBuiltin: formatRow.isBuiltin }
      : null,
    validation: buildValidation(db, formatRow?.rules, rows),
    visibility: deckRow.visibility,
    cover,
    coverIsChosen,
    inactiveCoverChoice,
  }
}

export function getDeckDetail(db: Db, userId: string, deckId: string): DeckDetail {
  return buildDeckDetail(db, userId, requireDeckRow(db, userId, deckId))
}

/**
 * Validates one of the caller's decks against an arbitrary rule set, without
 * assigning it — the format editor's "Deck prüfen" preview and
 * `GET /api/decks/:id/validate`.
 */
export function validateDeckWithRules(db: Db, userId: string, deckId: string, rules: RuleSet): DeckValidation {
  const deckRow = requireDeckRow(db, userId, deckId)

  const rows = db
    .select({
      catalogCardId: deckCard.catalogCardId,
      section: deckCard.section,
      quantity: deckCard.quantity,
      name: catalogCard.name,
    })
    .from(deckCard)
    .innerJoin(catalogCard, eq(deckCard.catalogCardId, catalogCard.id))
    .where(eq(deckCard.deckId, deckRow.id))
    .all()

  return buildValidation(db, rules, rows.map(row => ({ ...row, section: row.section as DeckSection })))!
}

/**
 * Creates a deck, optionally seeded with a set of cards (e.g. a chat
 * assistant `create_deck` proposal being applied) — the deck row and every card
 * row are written in one transaction, so a bad card never leaves behind an
 * empty deck. An optional `formatId` is assigned at once; it is checked like
 * PATCH does (a built-in format or one of the caller's own, else 400
 * `format_id does not exist`) before anything is written. So is an optional
 * `coverCardId`, which must be a Main or Extra Deck card of `cards`.
 */
export function createDeck(
  db: Db,
  userId: string,
  input: DeckInput & { formatId?: string | null, coverCardId?: number | null },
  cards?: DeckCardInput[],
): DeckDetail {
  const now = new Date()

  if (input.formatId) {
    requireAssignableFormat(db, userId, input.formatId)
  }

  const created = db.transaction((tx) => {
    const txDb = tx as unknown as Db
    const [createdDeck] = txDb
      .insert(deck)
      .values({
        id: randomUUID(),
        userId,
        name: input.name,
        description: input.description,
        formatId: input.formatId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()

    if (cards && cards.length > 0) {
      // Merge duplicate (catalogCardId, section) entries before validating
      // section/existence, same as the card upsert would end up doing.
      const merged = new Map<string, DeckCardInput>()
      for (const cardInput of cards) {
        const card = requireCatalogCard(txDb, cardInput.catalogCardId)
        assertSectionAllowed(card, cardInput.section)

        const key = `${cardInput.catalogCardId}:${cardInput.section}`
        const existing = merged.get(key)
        if (existing) {
          existing.quantity = Math.min(MAX_DECK_CARD_QUANTITY, existing.quantity + cardInput.quantity)
        }
        else {
          merged.set(key, { ...cardInput })
        }
      }

      txDb.insert(deckCard).values([...merged.values()].map(cardInput => ({
        id: randomUUID(),
        deckId: createdDeck!.id,
        catalogCardId: cardInput.catalogCardId,
        section: cardInput.section,
        quantity: cardInput.quantity,
        createdAt: now,
        updatedAt: now,
      }))).run()
    }

    if (typeof input.coverCardId === 'number') {
      assertCoverCandidate(txDb, createdDeck!.id, input.coverCardId)
      const [withCover] = txDb
        .update(deck)
        .set({ coverCardId: input.coverCardId })
        .where(eq(deck.id, createdDeck!.id))
        .returning()
        .all()
      return withCover!
    }

    return createdDeck!
  })

  return buildDeckDetail(db, userId, created)
}

export function updateDeck(db: Db, userId: string, deckId: string, patch: DeckUpdateInput): DeckDetail {
  const current = requireDeckRow(db, userId, deckId)

  // An empty patch is a no-op, not a touch: `updatedAt` drives the default
  // list sorting, so it must only move when something actually changed.
  if (
    patch.name === undefined
    && patch.description === undefined
    && patch.formatId === undefined
    && patch.coverCardId === undefined
  ) {
    return buildDeckDetail(db, userId, current)
  }

  // Validate everything before writing anything: only a built-in or one of
  // the caller's own formats may be assigned, and only a Main/Extra Deck card
  // of this deck may be chosen as its cover.
  if (typeof patch.formatId === 'string') {
    requireAssignableFormat(db, userId, patch.formatId)
  }
  if (typeof patch.coverCardId === 'number') {
    assertCoverCandidate(db, deckId, patch.coverCardId)
  }

  const [updated] = db
    .update(deck)
    .set({
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      formatId: patch.formatId !== undefined ? patch.formatId : current.formatId,
      coverCardId: patch.coverCardId !== undefined ? patch.coverCardId : current.coverCardId,
      updatedAt: new Date(),
    })
    .where(eq(deck.id, deckId))
    .returning()
    .all()

  return buildDeckDetail(db, userId, updated!)
}

// A chosen cover must be one of the deck's own Main/Extra Deck cards — the
// same candidates the rule picks from (Side Deck cards never are a cover).
function assertCoverCandidate(db: Db, deckId: string, catalogCardId: number) {
  const row = db
    .select({ id: deckCard.id })
    .from(deckCard)
    .where(and(
      eq(deckCard.deckId, deckId),
      eq(deckCard.catalogCardId, catalogCardId),
      inArray(deckCard.section, ['main', 'extra']),
    ))
    .get()

  if (!row) {
    badRequest('cover_card_id must be a Main or Extra Deck card of this deck')
  }
}

export function deleteDeck(db: Db, userId: string, deckId: string) {
  const deleted = db
    .delete(deck)
    .where(and(eq(deck.id, deckId), eq(deck.userId, userId)))
    .returning({ id: deck.id })
    .all()

  if (deleted.length === 0) {
    notFound()
  }

  deleteGrantsForResource(db, 'deck', deckId)
}

/**
 * Optional body of `POST /api/decks/:id/duplicate`: the copy's name, which
 * the UI builds in the interface language (ADR 0014). Without it the server
 * falls back to an English `<name> (copy)` from `duplicateNameFor` (ADR 0014:
 * server text is technical English).
 */
export function validateDuplicateDeckInput(body: unknown): { name?: string } {
  if (body === undefined || body === null || body === '') {
    return {}
  }
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }
  if (body.name === undefined) {
    return {}
  }
  return { name: validateDeckInput({ name: body.name }).name }
}

export function duplicateDeck(db: Db, userId: string, deckId: string, input: { name?: string } = {}): DeckDetail {
  const source = requireDeckRow(db, userId, deckId)
  const now = new Date()

  const [copy] = db
    .insert(deck)
    .values({
      id: randomUUID(),
      userId,
      name: input.name ?? duplicateNameFor(source.name),
      description: source.description,
      formatId: source.formatId,
      // The chosen cover (#49) carries over; its card rows are copied below.
      coverCardId: source.coverCardId,
      // The copy never inherits a share: always private with no token.
      visibility: 'private',
      shareToken: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()

  const sourceCards = db.select().from(deckCard).where(eq(deckCard.deckId, deckId)).all()
  if (sourceCards.length > 0) {
    db.insert(deckCard).values(sourceCards.map(row => ({
      id: randomUUID(),
      deckId: copy!.id,
      catalogCardId: row.catalogCardId,
      section: row.section,
      quantity: row.quantity,
      // Keep each row's original "added at" so the copy gets the same
      // cover card as the source deck even when it's picked by rule (#29) —
      // a chosen cover (#49) is copied with the deck row above.
      createdAt: row.createdAt,
      updatedAt: now,
    }))).run()
  }

  return buildDeckDetail(db, userId, copy!)
}

// Truncates the base name (not the suffix) so a duplicate always stays
// recognizable as a copy within the 80 character name limit.
export function duplicateNameFor(name: string): string {
  const suffix = ' (copy)'
  return `${name.slice(0, DECK_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`
}

function touchDeck(db: Db, deckId: string, now: Date) {
  db.update(deck).set({ updatedAt: now }).where(eq(deck.id, deckId)).run()
}

function findDeckCard(db: Db, deckId: string, catalogCardId: number, section: DeckSection) {
  return db
    .select()
    .from(deckCard)
    .where(and(
      eq(deckCard.deckId, deckId),
      eq(deckCard.catalogCardId, catalogCardId),
      eq(deckCard.section, section),
    ))
    .get()
}

/**
 * Sets the quantity of one catalog card in one section of a deck.
 * `quantity: 0` removes the row. Returns the refreshed deck detail so the
 * client never has to re-read after a write.
 */
export function upsertDeckCard(db: Db, userId: string, deckId: string, input: DeckCardInput): DeckDetail {
  const deckRow = requireDeckRow(db, userId, deckId)
  const card = requireCatalogCard(db, input.catalogCardId)
  assertSectionAllowed(card, input.section)

  const now = new Date()
  const existing = findDeckCard(db, deckId, input.catalogCardId, input.section)

  if (input.quantity === 0) {
    if (existing) {
      db.delete(deckCard).where(eq(deckCard.id, existing.id)).run()
    }
  }
  else if (existing) {
    db.update(deckCard)
      .set({ quantity: input.quantity, updatedAt: now })
      .where(eq(deckCard.id, existing.id))
      .run()
  }
  else {
    db.insert(deckCard).values({
      id: randomUUID(),
      deckId,
      catalogCardId: input.catalogCardId,
      section: input.section,
      quantity: input.quantity,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  touchDeck(db, deckId, now)
  return buildDeckDetail(db, userId, { ...deckRow, updatedAt: now })
}

export interface DeckCardIncrementInput {
  catalogCardId: number
  section: DeckSection
  increment: number
}

/**
 * The increment mode of `PUT /api/decks/:id/cards` (#148): `{ catalogCardId,
 * section, increment }` adds copies to what the section already holds, so a
 * caller outside the deck editor (the catalog's "Zum Deck") doesn't have to
 * read the deck first. `increment` is a positive integer and can't be combined
 * with `quantity` (the absolute mode, `validateDeckCardInput`).
 */
export function validateDeckCardIncrementInput(body: unknown): DeckCardIncrementInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }
  if (body.quantity !== undefined && body.quantity !== null) {
    badRequest('quantity and increment are mutually exclusive')
  }

  const increment = typeof body.increment === 'number' ? body.increment : Number(body.increment)
  if (!Number.isSafeInteger(increment) || increment < 1 || increment > MAX_DECK_CARD_QUANTITY) {
    badRequest(`increment must be an integer from 1 to ${MAX_DECK_CARD_QUANTITY}`)
  }

  return {
    catalogCardId: normalizeCatalogCardId(body.catalog_card_id ?? body.catalogCardId),
    section: normalizeSection(body.section),
    increment,
  }
}

/**
 * Adds `increment` copies of a card to one section, with `upsertDeckCard`'s
 * checks (own deck, known card, allowed section) and its cap: a result above
 * `MAX_DECK_CARD_QUANTITY` is rejected (`quantity_too_large`). Read and write
 * run in one transaction, so two adds at once both count.
 */
export function incrementDeckCard(db: Db, userId: string, deckId: string, input: DeckCardIncrementInput): DeckDetail {
  const now = new Date()

  const deckRow = db.transaction((tx) => {
    const txDb = tx as unknown as Db
    const row = requireDeckRow(txDb, userId, deckId)
    const card = requireCatalogCard(txDb, input.catalogCardId)
    assertSectionAllowed(card, input.section)

    const existing = findDeckCard(txDb, deckId, input.catalogCardId, input.section)
    const quantity = (existing?.quantity ?? 0) + input.increment
    if (quantity > MAX_DECK_CARD_QUANTITY) {
      throw createError({
        statusCode: 400,
        statusMessage: `quantity must be at most ${MAX_DECK_CARD_QUANTITY}`,
        data: { code: 'quantity_too_large', params: { max: MAX_DECK_CARD_QUANTITY } },
      })
    }

    if (existing) {
      txDb.update(deckCard)
        .set({ quantity, updatedAt: now })
        .where(eq(deckCard.id, existing.id))
        .run()
    }
    else {
      txDb.insert(deckCard).values({
        id: randomUUID(),
        deckId,
        catalogCardId: input.catalogCardId,
        section: input.section,
        quantity,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    touchDeck(txDb, deckId, now)
    return row
  })

  return buildDeckDetail(db, userId, { ...deckRow, updatedAt: now })
}

export function moveDeckCard(db: Db, userId: string, deckId: string, input: DeckCardMoveInput): DeckDetail {
  const deckRow = requireDeckRow(db, userId, deckId)
  const card = requireCatalogCard(db, input.catalogCardId)
  assertSectionAllowed(card, input.to)

  const source = findDeckCard(db, deckId, input.catalogCardId, input.from)
  if (!source) {
    notFound('Deck card not found', 'deck_card_not_found')
  }

  const quantity = input.quantity ?? source.quantity
  if (quantity > source.quantity) {
    badRequest('quantity exceeds the copies in the source section')
  }

  const now = new Date()
  if (quantity === source.quantity) {
    db.delete(deckCard).where(eq(deckCard.id, source.id)).run()
  }
  else {
    db.update(deckCard)
      .set({ quantity: source.quantity - quantity, updatedAt: now })
      .where(eq(deckCard.id, source.id))
      .run()
  }

  const target = findDeckCard(db, deckId, input.catalogCardId, input.to)
  if (target) {
    db.update(deckCard)
      .set({ quantity: target.quantity + quantity, updatedAt: now })
      .where(eq(deckCard.id, target.id))
      .run()
  }
  else {
    db.insert(deckCard).values({
      id: randomUUID(),
      deckId,
      catalogCardId: input.catalogCardId,
      section: input.to,
      quantity,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  touchDeck(db, deckId, now)
  return buildDeckDetail(db, userId, { ...deckRow, updatedAt: now })
}

export function removeDeckCard(
  db: Db,
  userId: string,
  deckId: string,
  catalogCardId: number,
  section: DeckSection,
): DeckDetail {
  const deckRow = requireDeckRow(db, userId, deckId)

  const deleted = db
    .delete(deckCard)
    .where(and(
      eq(deckCard.deckId, deckId),
      eq(deckCard.catalogCardId, catalogCardId),
      eq(deckCard.section, section),
    ))
    .returning({ id: deckCard.id })
    .all()

  if (deleted.length === 0) {
    notFound('Deck card not found', 'deck_card_not_found')
  }

  const now = new Date()
  touchDeck(db, deckId, now)
  return buildDeckDetail(db, userId, { ...deckRow, updatedAt: now })
}

export interface DeckListItem {
  id: string
  name: string
  description: string | null
  mainCount: number
  extraCount: number
  sideCount: number
  cardCount: number
  /** True when every card in the deck is fully covered by owned copies. */
  complete: boolean
  missingCount: number
  formatId: string | null
  formatName: string | null
  /** Legality in the assigned format; `null` when no format is assigned. */
  legal: boolean | null
  createdAt: Date
  updatedAt: Date
  /** Sharing state (Phase 6). */
  visibility: Visibility
  /** Cover card for the deck tile (#29); `null` for a deck without Main/Extra cards. */
  cover: DeckCover | null
  /** Copies per card kind in Main and Extra (#148), for the tile chips. */
  breakdown: DeckBreakdownGroup[]
}

/** A `deck_card` row with its card's type, as the deck lists load it for {@link deckBreakdownsFor}. */
export interface DeckBreakdownSourceRow {
  deckId: string
  section: string
  type: string | null
  frameType: string | null
  quantity: number
}

/**
 * The card-kind chips (#148) of the given decks, from rows already loaded
 * for the list (no extra query). The Side Deck is never counted; a deck
 * without Main/Extra cards gets `[]`.
 */
export function deckBreakdownsFor(rows: DeckBreakdownSourceRow[], deckIds: string[]): Map<string, DeckBreakdownGroup[]> {
  const wanted = new Set(deckIds)
  const sectionsByDeck = new Map<string, { main: DeckBreakdownSourceRow[], extra: DeckBreakdownSourceRow[] }>()
  for (const row of rows) {
    if (!wanted.has(row.deckId) || (row.section !== 'main' && row.section !== 'extra')) {
      continue
    }
    const sections = sectionsByDeck.get(row.deckId) ?? { main: [], extra: [] }
    sections[row.section].push(row)
    sectionsByDeck.set(row.deckId, sections)
  }
  return new Map(deckIds.map(deckId => [deckId, deckBreakdownGroups(sectionsByDeck.get(deckId) ?? { main: [], extra: [] })]))
}

/** One Main/Extra Deck row considered for a deck's cover — see {@link pickDeckCover}. */
export interface DeckCoverCandidate extends DeckCover {
  section: DeckSection
  type: string
  createdAt: Date
}

function compareFirstAdded(a: DeckCoverCandidate, b: DeckCoverCandidate): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.catalogCardId - b.catalogCardId
}

/**
 * Picks a deck's cover card as documented on {@link DeckCover}. A
 * `chosenCardId` (the deck's `cover_card_id`, #49) wins while that card has a
 * Main or Extra Deck row among the candidates; otherwise — no choice, or the
 * chosen card was removed or moved to the Side Deck — the rule applies: the
 * first-added Main Deck monster, else the first-added Main Deck card, else
 * the first-added Extra Deck card, else `null`. Side Deck rows are ignored.
 * `deck_card.created_at` has second precision, so cards added together (a
 * deck created in one call, a duplicate) tie and fall back to the lower
 * catalog card id — stable, if arbitrary.
 */
export function pickDeckCover(rows: DeckCoverCandidate[], chosenCardId?: number | null): DeckCover | null {
  const chosen = chosenCardId != null
    ? rows.find(row => row.catalogCardId === chosenCardId && row.section !== 'side')
    : undefined
  if (chosen) {
    return toDeckCover(chosen)
  }

  const firstOf = (candidates: DeckCoverCandidate[]) => [...candidates].sort(compareFirstAdded)[0]

  const main = rows.filter(row => row.section === 'main')
  const picked = firstOf(main.filter(row => cardCategoryRank(row.type) === 0))
    ?? firstOf(main)
    ?? firstOf(rows.filter(row => row.section === 'extra'))

  return picked ? toDeckCover(picked) : null
}

function toDeckCover(candidate: DeckCoverCandidate): DeckCover {
  return {
    catalogCardId: candidate.catalogCardId,
    name: candidate.name,
    nameDe: candidate.nameDe,
    imageSmall: candidate.imageSmall,
    imageLarge: candidate.imageLarge,
  }
}

/** One catalog card as a {@link DeckCover}, e.g. a chosen cover that has no deck row (#57). */
function loadCoverCard(db: Db, catalogCardId: number): DeckCover | null {
  return db
    .select({
      catalogCardId: catalogCard.id,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      imageSmall: primaryImageUrlSql('imageUrlSmall'),
      imageLarge: primaryImageUrlSql('imageUrl'),
    })
    .from(catalogCard)
    .where(eq(catalogCard.id, catalogCardId))
    .get() ?? null
}

/**
 * Cover cards for a set of decks in a single query (#29): the deck's chosen
 * cover card (#49) while it is in the Main/Extra Deck, else the rule's pick
 * (see {@link pickDeckCover}). Decks without a cover are simply absent from
 * the map. Callers must only pass deck ids the
 * viewer may already see — this does no access check of its own.
 */
export function loadDeckCovers(db: Db, deckIds: string[]): Map<string, DeckCover> {
  const covers = new Map<string, DeckCover>()
  if (deckIds.length === 0) {
    return covers
  }

  const rows = db
    .select({
      deckId: deckCard.deckId,
      chosenCardId: deck.coverCardId,
      catalogCardId: deckCard.catalogCardId,
      section: deckCard.section,
      createdAt: deckCard.createdAt,
      name: catalogCard.name,
      nameDe: cardNameDeSql(),
      type: catalogCard.type,
      imageSmall: primaryImageUrlSql('imageUrlSmall'),
      imageLarge: primaryImageUrlSql('imageUrl'),
    })
    .from(deckCard)
    .innerJoin(deck, eq(deck.id, deckCard.deckId))
    .innerJoin(catalogCard, eq(deckCard.catalogCardId, catalogCard.id))
    .where(and(inArray(deckCard.deckId, deckIds), inArray(deckCard.section, ['main', 'extra'])))
    .all()

  const rowsByDeck = new Map<string, DeckCoverCandidate[]>()
  const chosenByDeck = new Map<string, number | null>()
  for (const { deckId, chosenCardId, ...row } of rows) {
    const candidates = rowsByDeck.get(deckId) ?? []
    candidates.push({ ...row, section: row.section as DeckSection })
    rowsByDeck.set(deckId, candidates)
    chosenByDeck.set(deckId, chosenCardId)
  }

  for (const [deckId, candidates] of rowsByDeck) {
    const cover = pickDeckCover(candidates, chosenByDeck.get(deckId))
    if (cover) {
      covers.set(deckId, cover)
    }
  }
  return covers
}

// Upper bound on the decks scanned when filtering by legality: legality is
// computed, not stored, so that filter cannot be pushed into SQL.
const MAX_LEGALITY_SCAN = 500

export function listDecks(db: Db, userId: string, options: DeckListOptions = {}) {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))
  const clauses: SQL[] = [eq(deck.userId, userId)]

  const q = options.q?.trim()
  if (q) {
    // Matches the deck name or the (English or German, ADR 0015) name of any
    // card contained in the deck.
    clauses.push(or(
      escapedLike(deck.name, `%${escapeLikeTerm(q)}%`),
      sql`exists (
        select 1 from ${deckCard}
        inner join ${catalogCard} on ${catalogCard.id} = ${deckCard.catalogCardId}
        where ${deckCard.deckId} = ${deck.id}
          and ${cardNameMatches(q)}
      )`,
    ) as SQL)
  }

  if (options.contains) {
    clauses.push(sql`exists (
      select 1 from ${deckCard}
      where ${deckCard.deckId} = ${deck.id}
        and ${deckCard.catalogCardId} = ${options.contains}
    )`)
  }

  if (options.formatId === 'none') {
    clauses.push(isNull(deck.formatId))
  }
  else if (options.formatId) {
    clauses.push(eq(deck.formatId, options.formatId))
  }

  const where = and(...clauses) as SQL

  const orderBy = options.sort === 'name'
    ? [asc(deck.name)]
    : options.sort === '-name'
      ? [desc(deck.name)]
      : options.sort === 'newest'
        ? [desc(deck.createdAt), asc(deck.name)]
        : [desc(deck.updatedAt), asc(deck.name)]

  // Legality is derived, so `legal=` cannot be a SQL predicate: scan the
  // matching decks (bounded), evaluate them, then paginate in memory.
  const filtersByLegality = options.legal !== undefined

  const candidateRows = filtersByLegality
    ? db.select().from(deck).where(where).orderBy(...orderBy).limit(MAX_LEGALITY_SCAN).all()
    : db.select().from(deck).where(where).orderBy(...orderBy).limit(pageSize).offset((page - 1) * pageSize).all()

  const deckIds = candidateRows.map(row => row.id)
  const cardRows = deckIds.length > 0
    ? db
        .select({
          deckId: deckCard.deckId,
          catalogCardId: deckCard.catalogCardId,
          section: deckCard.section,
          quantity: deckCard.quantity,
          // For the tile chips (#148); a left join, so the counts never lose a row.
          type: catalogCard.type,
          frameType: catalogCard.frameType,
        })
        .from(deckCard)
        .leftJoin(catalogCard, eq(catalogCard.id, deckCard.catalogCardId))
        .where(inArray(deckCard.deckId, deckIds))
        .all()
    : []

  const owned = ownedQuantitiesByCard(db, userId, [...new Set(cardRows.map(row => row.catalogCardId))])

  const formats = ruleFormatsById(db, userId, candidateRows.flatMap(row => (row.formatId ? [row.formatId] : [])))
  const cardData = formats.size > 0
    ? loadCardDataForValidation(db, cardRows.map(row => row.catalogCardId))
    : new Map()

  const entriesByDeck = new Map<string, Array<{ catalogCardId: number, section: DeckSection, quantity: number }>>()
  for (const row of cardRows) {
    const entries = entriesByDeck.get(row.deckId) ?? []
    entries.push({ catalogCardId: row.catalogCardId, section: row.section as DeckSection, quantity: row.quantity })
    entriesByDeck.set(row.deckId, entries)
  }

  const legalityByDeck = new Map<string, boolean>()
  for (const row of candidateRows) {
    const format = row.formatId ? formats.get(row.formatId) : undefined
    if (format) {
      legalityByDeck.set(row.id, evaluateDeck(format.rules, entriesByDeck.get(row.id) ?? [], cardData).legal)
    }
  }

  // A deck without a format is neither legal nor illegal — it drops out of
  // both filters instead of counting as "not legal".
  const matchingRows = filtersByLegality
    ? candidateRows.filter(row => legalityByDeck.get(row.id) === options.legal)
    : candidateRows

  const total = filtersByLegality
    ? matchingRows.length
    : db.select({ count: sql<number>`count(*)` }).from(deck).where(where).get()?.count ?? 0

  const deckRows = filtersByLegality
    ? matchingRows.slice((page - 1) * pageSize, page * pageSize)
    : matchingRows

  const usedByDeck = new Map<string, Map<number, number>>()
  const countsByDeck = new Map<string, { main: number, extra: number, side: number }>()
  for (const row of cardRows) {
    const counts = countsByDeck.get(row.deckId) ?? { main: 0, extra: 0, side: 0 }
    counts[row.section as DeckSection] += row.quantity
    countsByDeck.set(row.deckId, counts)

    const used = usedByDeck.get(row.deckId) ?? new Map<number, number>()
    used.set(row.catalogCardId, (used.get(row.catalogCardId) ?? 0) + row.quantity)
    usedByDeck.set(row.deckId, used)
  }

  // Covers and chips only for the page actually returned, not the whole legality scan.
  const covers = loadDeckCovers(db, deckRows.map(row => row.id))
  const breakdowns = deckBreakdownsFor(cardRows, deckRows.map(row => row.id))

  const items: DeckListItem[] = deckRows.map((row) => {
    const counts = countsByDeck.get(row.id) ?? { main: 0, extra: 0, side: 0 }
    const used = usedByDeck.get(row.id) ?? new Map<number, number>()

    let missingCount = 0
    for (const [catalogCardId, usedInDeck] of used) {
      missingCount += Math.max(0, usedInDeck - (owned.get(catalogCardId) ?? 0))
    }

    const cardCount = counts.main + counts.extra + counts.side
    const format = row.formatId ? formats.get(row.formatId) : undefined

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mainCount: counts.main,
      extraCount: counts.extra,
      sideCount: counts.side,
      cardCount,
      // An empty deck has nothing missing, but it is not "complete" either.
      complete: cardCount > 0 && missingCount === 0,
      missingCount,
      formatId: row.formatId,
      formatName: format?.name ?? null,
      legal: format ? legalityByDeck.get(row.id) ?? null : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      visibility: row.visibility,
      cover: covers.get(row.id) ?? null,
      breakdown: breakdowns.get(row.id) ?? [],
    }
  })

  return { items, total, page, pageSize }
}
