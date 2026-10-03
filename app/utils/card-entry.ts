// Shared client-side types and pure helpers for the "Schnellerfassung"
// review flow (Roadmap Phase 2). Kept out of the components so the
// preselection, status, and payload rules can be unit tested on their own.

export type EntryMatchedBy = 'passcode' | 'near_passcode' | 'set_code' | 'exact' | 'prefix' | 'contains' | 'fuzzy'

export interface EntryCandidate {
  cardId: number
  name: string
  /** Official German name (ADR 0015); null when there is none. */
  nameDe: string | null
  type: string
  frameType: string | null
  imageSmall: string | null
  score: number
  matchedBy: EntryMatchedBy
}

export interface ParsedEntryLine {
  raw: string
  quantity: number
  query: string
  setCode?: string
  passcode?: number
}

export interface EntrySuggestResult {
  input: ParsedEntryLine
  candidates: EntryCandidate[]
}

export interface EntryRow {
  id: string
  raw: string
  query: string
  quantity: number
  /** A parsed set code only identifies the card; no printing is stored (ADR 0017). */
  setCode: string | null
  candidates: EntryCandidate[]
  selectedCardId: number | null
  /** Set code and name pointed at different cards — never auto-selected. */
  conflict: boolean
  /** Per-row collection override; `null` means "use the default collection". */
  collectionId: string | null
}

export interface EntryDefaults {
  /** A collection id, or `NO_COLLECTION_VALUE` for "no collection". */
  collectionId: string
}

export interface EntryBulkEntry {
  rowId: string
  item: EntryBulkItem
}

export interface EntryBulkItem {
  catalogCardId: number
  collectionId: string | null
  quantity: number
}

export type EntryRowStatus = 'sicher' | 'unsicher' | 'ohne_treffer'

/** Sentinel for "no collection" in a `USelect` (empty values are unselectable). */
export const NO_COLLECTION_VALUE = '__no_collection__'
/** Sentinel for "inherit the default collection" in a per-row `USelect`. */
export const DEFAULT_VALUE = '__default__'

/** Above this score a name match is trusted enough to preselect. */
export const AUTO_SELECT_SCORE = 0.85
/** Mirrors MAX_ENTRY_QUANTITY in server/utils/card-entry.ts. */
export const MAX_ENTRY_QUANTITY = 99
/** Mirrors MAX_ENTRY_LINES in server/utils/card-entry.ts. */
export const MAX_ENTRY_LINES = 50
/** Mirrors INVENTORY_BULK_MAX_ITEMS in server/utils/inventory.ts. */
export const BULK_CHUNK_SIZE = 50
/** Upper bound for the review queue, so the page stays responsive. */
export const MAX_ENTRY_ROWS = 200
/** Match kinds that identify a card exactly, whatever the score says. */
export const CERTAIN_MATCHES: readonly EntryMatchedBy[] = ['passcode', 'set_code', 'exact']

export function isCertainMatch(candidate: EntryCandidate): boolean {
  return CERTAIN_MATCHES.includes(candidate.matchedBy) || candidate.score >= AUTO_SELECT_SCORE
}

function createRowId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * A parsed set code and the parsed name resolving to *different* cards
 * ("Pot of Greed (SDY-006)") means one of the two is wrong — the row must be
 * confirmed by hand instead of silently trusting the set code.
 */
export function hasMatchConflict(candidates: EntryCandidate[]): boolean {
  const bySetCode = candidates.find(entry => entry.matchedBy === 'set_code')
  const byName = candidates.find(entry => entry.matchedBy === 'exact')

  return Boolean(bySetCode && byName && bySetCode.cardId !== byName.cardId)
}

/**
 * Turns one suggest result into a review row. The best candidate is
 * preselected when it is certain (passcode/set code/exact name) or scores
 * above AUTO_SELECT_SCORE; everything else — including contradictory
 * matches — stays unresolved on purpose so the user has to confirm it
 * before anything is written.
 */
export function createEntryRow(result: EntrySuggestResult): EntryRow {
  const best = result.candidates[0]
  const setCode = result.input.setCode ?? null
  const conflict = hasMatchConflict(result.candidates)
  const preselected = best && !conflict && isCertainMatch(best) ? best : undefined

  return {
    id: createRowId(),
    conflict,
    raw: result.input.raw.trim() === '' ? result.input.query : result.input.raw.trim(),
    query: result.input.query,
    quantity: result.input.quantity,
    setCode,
    candidates: result.candidates,
    selectedCardId: preselected?.cardId ?? null,
    collectionId: null,
  }
}

export function createEntryRows(results: EntrySuggestResult[]): EntryRow[] {
  return results.map(result => createEntryRow(result))
}

export function selectedCandidate(row: EntryRow): EntryCandidate | undefined {
  return row.candidates.find(candidate => candidate.cardId === row.selectedCardId)
}

export function entryRowStatus(row: EntryRow): EntryRowStatus {
  if (row.selectedCardId !== null) {
    return 'sicher'
  }
  return row.candidates.length === 0 ? 'ohne_treffer' : 'unsicher'
}

export function isEntryRowResolved(row: EntryRow): boolean {
  return row.selectedCardId !== null
}

export interface EntrySummary {
  total: number
  sicher: number
  unsicher: number
  ohneTreffer: number
}

export function summarizeEntryRows(rows: EntryRow[]): EntrySummary {
  const summary: EntrySummary = { total: rows.length, sicher: 0, unsicher: 0, ohneTreffer: 0 }

  for (const row of rows) {
    const status = entryRowStatus(row)
    if (status === 'sicher') {
      summary.sicher += 1
    }
    else if (status === 'unsicher') {
      summary.unsicher += 1
    }
    else {
      summary.ohneTreffer += 1
    }
  }

  return summary
}

/**
 * The collection a row is saved into: its own override, else the default
 * collection. `null` means "no collection".
 */
export function effectiveCollectionId(row: EntryRow, defaults: EntryDefaults): string | null {
  const collectionId = row.collectionId ?? defaults.collectionId
  return collectionId === NO_COLLECTION_VALUE ? null : collectionId
}

/**
 * Builds the `/api/inventory/bulk` payload from all resolved rows, keeping
 * each item tied to its row id so a per-item error can be pointed back at
 * the row the user actually sees.
 */
export function buildBulkEntries(rows: EntryRow[], defaults: EntryDefaults): EntryBulkEntry[] {
  return rows.filter(isEntryRowResolved).map(row => ({
    rowId: row.id,
    item: {
      catalogCardId: row.selectedCardId!,
      collectionId: effectiveCollectionId(row, defaults),
      quantity: row.quantity,
    },
  }))
}

/** Splits the payload into server-sized batches (`INVENTORY_BULK_MAX_ITEMS`). */
export function chunkBulkEntries(entries: EntryBulkEntry[], size = BULK_CHUNK_SIZE): EntryBulkEntry[][] {
  const chunks: EntryBulkEntry[][] = []
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size))
  }
  return chunks
}

export interface ApiItemError {
  index: number
  /** Technical English; the UI shows the translated `code` instead (ADR 0014). */
  message: string
  code?: string
  params?: Record<string, unknown>
}

interface ApiErrorBody {
  statusCode?: number
  statusMessage?: string
  data?: { errors?: ApiItemError[], code?: string, params?: Record<string, unknown> }
}

function apiErrorBody(error: unknown): ApiErrorBody | undefined {
  const body = (error as { data?: unknown } | null | undefined)?.data
  return body && typeof body === 'object' ? body as ApiErrorBody : undefined
}

/** Per-item validation failures carried by `/api/inventory/bulk`. */
export function apiItemErrors(error: unknown): ApiItemError[] {
  return apiErrorBody(error)?.data?.errors ?? []
}

/** Machine-readable error code (`data.code`), see `useApiError`. */
export function apiErrorCode(error: unknown): string | undefined {
  const code = apiErrorBody(error)?.data?.code
  return typeof code === 'string' ? code : undefined
}

/** Named parameters for the code's message (`data.params`, e.g. `{ max }`). */
export function apiErrorParams(error: unknown): Record<string, unknown> {
  const params = apiErrorBody(error)?.data?.params
  return params && typeof params === 'object' ? params : {}
}
