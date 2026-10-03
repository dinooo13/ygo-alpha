// Bridges the pure tournament model (shared/tournaments.ts,
// shared/tournament-pairing.ts, shared/tournament-standings.ts) and the
// database. See docs/adr/0008-tournament-model.md.
//
// A tournament belongs to exactly one organizer (D2). Two operations are
// participant-scoped (D3): reading the detail, and registering their own
// deck. Everything else is organizer-only. A tournament the caller neither
// organizes nor plays in is reported as 404, the same ownership boundary as
// decks/collections/formats.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { useDb } from '../db'
import {
  ruleFormat,
  tournament,
  tournamentMatch,
  tournamentParticipant,
  tournamentRound,
  user,
} from '../db/schema'
import { evaluateDeck } from '../../shared/rule-formats'
import type { RuleSet } from '../../shared/rule-formats'
import { getDeckDetail } from './decks'
import { loadCardDataForValidation } from './deck-validation'
import { requireAssignableFormat } from './rule-formats'
import { pairRound } from '../../shared/tournament-pairing'
import type { Pairing, PairingParticipant } from '../../shared/tournament-pairing'
import { computeStandings } from '../../shared/tournament-standings'
import type { StandingsMatch, StandingsOptions, StandingsParticipant } from '../../shared/tournament-standings'
import {
  BYE_GAMES,
  BYE_SCORINGS,
  DEFAULT_BYE_SCORING,
  DEFAULT_SCORING,
  DEFAULT_WIN_GAMES,
  MAX_GAMES_PER_MATCH,
  MAX_PARTICIPANTS,
  MAX_PLANNED_ROUNDS,
  MAX_SNAPSHOT_ISSUES,
  MIN_PARTICIPANTS_TO_START,
  PAIRING_SYSTEMS,
  PARTICIPANT_NAME_MAX_LENGTH,
  roundRobinRoundCount,
  SCORING_SYSTEMS,
  swissRoundCount,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  TOURNAMENT_NAME_MAX_LENGTH,
  TOURNAMENT_STATUSES,
} from '../../shared/tournaments'
import type {
  ByeScoring,
  PairingSystem,
  ScoringSystem,
  TournamentDeckSnapshot,
  TournamentDeckSnapshotCard,
  TournamentDetail,
  TournamentErrorCode,
  TournamentFormatRef,
  TournamentListItem,
  TournamentListResponse,
  TournamentMatchDto,
  TournamentParticipantDto,
  TournamentRole,
  TournamentRoundDto,
  TournamentStandingRow,
  TournamentStatus,
} from '../../shared/tournaments'

type Db = ReturnType<typeof useDb>

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 60

// --- Error helpers (D11: every 400/403/409 carries `data.code`) ------------

// `params` are the named values the client's `errors.api.<code>` message
// needs (e.g. `{ max }`); the English `statusMessage` is never shown (ADR 0014).
type ErrorParams = Record<string, string | number>

function fail(statusCode: number, code: TournamentErrorCode, message: string, params?: ErrorParams): never {
  throw createError({ statusCode, statusMessage: message, data: params ? { code, params } : { code } })
}
function badRequest(code: TournamentErrorCode, message: string, params?: ErrorParams): never {
  fail(400, code, message, params)
}
function forbidden(code: TournamentErrorCode, message: string, params?: ErrorParams): never {
  fail(403, code, message, params)
}
function conflict(code: TournamentErrorCode, message: string, params?: ErrorParams): never {
  fail(409, code, message, params)
}
function notFound(): never {
  throw createError({ statusCode: 404, statusMessage: 'Tournament not found' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// --- Access helpers ----------------------------------------------------

interface TournamentAccess {
  row: typeof tournament.$inferSelect
  role: TournamentRole
  selfParticipantId: string | null
}

function requireTournamentRow(db: Db, userId: string, id: string): TournamentAccess {
  const row = db.select().from(tournament).where(eq(tournament.id, id)).get()
  if (!row) {
    notFound()
  }

  const participant = db
    .select()
    .from(tournamentParticipant)
    .where(and(eq(tournamentParticipant.tournamentId, id), eq(tournamentParticipant.userId, userId)))
    .get()

  if (row.organizerUserId === userId) {
    return { row, role: 'organizer', selfParticipantId: participant?.id ?? null }
  }

  if (!participant) {
    notFound()
  }

  return { row, role: 'participant', selfParticipantId: participant.id }
}

function requireOrganizerTournament(db: Db, userId: string, id: string): { row: typeof tournament.$inferSelect } {
  const { row, role } = requireTournamentRow(db, userId, id)
  if (role !== 'organizer') {
    forbidden('organizer_only', 'Only the organizer can do this')
  }
  return { row }
}

function assertStatus(
  row: { status: TournamentStatus },
  allowed: TournamentStatus[],
  code: TournamentErrorCode = 'invalid_status',
): void {
  if (!allowed.includes(row.status)) {
    // A finished tournament always gets its own status-specific code, even
    // when the caller passed a fallback (e.g. 'registration_closed') meant
    // for the more common "still in the wrong phase" case.
    conflict(row.status === 'finished' ? 'tournament_finished' : code, `Tournament must be ${allowed.join(' or ')}`)
  }
}

/**
 * Reads a tournament's rule format, unscoped by user: a tournament
 * legitimizes its participants' need to know the rules they're checked
 * against. Only `{ id, name, isBuiltin }` ever reaches a response — the rule
 * JSON never leaves the server for tournaments.
 */
function loadTournamentFormat(
  db: Db,
  row: { formatId: string | null },
): { id: string, name: string, isBuiltin: boolean, rules: RuleSet } | null {
  if (!row.formatId) {
    return null
  }
  const format = db
    .select({ id: ruleFormat.id, name: ruleFormat.name, isBuiltin: ruleFormat.isBuiltin, rules: ruleFormat.rules })
    .from(ruleFormat)
    .where(eq(ruleFormat.id, row.formatId))
    .get()
  return format ?? null
}

function loadTournamentFormatRef(db: Db, formatId: string): TournamentFormatRef | null {
  const format = db
    .select({ id: ruleFormat.id, name: ruleFormat.name, isBuiltin: ruleFormat.isBuiltin })
    .from(ruleFormat)
    .where(eq(ruleFormat.id, formatId))
    .get()
  return format ?? null
}

// --- Input validation --------------------------------------------------

export interface TournamentInput {
  name: string
  description: string | null
  formatId: string | null
  pairingSystem: PairingSystem
  scoring: ScoringSystem
  byeScoring: ByeScoring
  plannedRounds: number | null
  includeSelf: boolean
}

function normalizeDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null
  }
  if (typeof raw !== 'string') {
    badRequest('invalid_description', 'description must be a string', { max: TOURNAMENT_DESCRIPTION_MAX_LENGTH })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return null
  }
  if (trimmed.length > TOURNAMENT_DESCRIPTION_MAX_LENGTH) {
    badRequest('invalid_description', `description must be at most ${TOURNAMENT_DESCRIPTION_MAX_LENGTH} characters`, { max: TOURNAMENT_DESCRIPTION_MAX_LENGTH })
  }
  return trimmed
}

function normalizeFormatId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  if (typeof raw !== 'string') {
    badRequest('unknown_format', 'formatId must be a string')
  }
  return raw.trim()
}

function normalizePairingSystem(raw: unknown): PairingSystem {
  if (raw === undefined) {
    return 'swiss'
  }
  if (typeof raw !== 'string' || !(PAIRING_SYSTEMS as readonly string[]).includes(raw)) {
    badRequest('invalid_pairing_system', 'Unknown pairing system')
  }
  return raw as PairingSystem
}

function normalizeScoring(raw: unknown): ScoringSystem {
  if (raw === undefined) {
    return DEFAULT_SCORING
  }
  if (typeof raw !== 'string' || !(SCORING_SYSTEMS as readonly string[]).includes(raw)) {
    badRequest('invalid_scoring', 'Unknown scoring system')
  }
  return raw as ScoringSystem
}

function normalizeByeScoring(raw: unknown): ByeScoring {
  if (raw === undefined) {
    return DEFAULT_BYE_SCORING
  }
  if (typeof raw !== 'string' || !(BYE_SCORINGS as readonly string[]).includes(raw)) {
    badRequest('invalid_bye_scoring', 'Unknown bye scoring')
  }
  return raw as ByeScoring
}

function normalizePlannedRounds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PLANNED_ROUNDS) {
    badRequest('invalid_planned_rounds', `plannedRounds must be an integer 1-${MAX_PLANNED_ROUNDS}`, { max: MAX_PLANNED_ROUNDS })
  }
  return value
}

export function validateTournamentInput(body: unknown): TournamentInput {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const rawName = body.name
  if (typeof rawName !== 'string') {
    badRequest('invalid_name', 'name is required', { max: TOURNAMENT_NAME_MAX_LENGTH })
  }
  const name = rawName.trim()
  if (name.length === 0 || name.length > TOURNAMENT_NAME_MAX_LENGTH) {
    badRequest('invalid_name', `name must be 1-${TOURNAMENT_NAME_MAX_LENGTH} characters`, { max: TOURNAMENT_NAME_MAX_LENGTH })
  }

  return {
    name,
    description: normalizeDescription(body.description),
    formatId: normalizeFormatId(body.formatId),
    pairingSystem: normalizePairingSystem(body.pairingSystem),
    scoring: normalizeScoring(body.scoring),
    byeScoring: normalizeByeScoring(body.byeScoring),
    plannedRounds: normalizePlannedRounds(body.plannedRounds),
    includeSelf: body.includeSelf !== false,
  }
}

export interface TournamentUpdateInput {
  name?: string
  description?: string | null
  formatId?: string | null
  pairingSystem?: PairingSystem
  scoring?: ScoringSystem
  byeScoring?: ByeScoring
  plannedRounds?: number | null
}

export function validateTournamentUpdateInput(body: unknown): TournamentUpdateInput {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const patch: TournamentUpdateInput = {}

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      badRequest('invalid_name', 'name must be a string', { max: TOURNAMENT_NAME_MAX_LENGTH })
    }
    const name = body.name.trim()
    if (name.length === 0 || name.length > TOURNAMENT_NAME_MAX_LENGTH) {
      badRequest('invalid_name', `name must be 1-${TOURNAMENT_NAME_MAX_LENGTH} characters`, { max: TOURNAMENT_NAME_MAX_LENGTH })
    }
    patch.name = name
  }
  if (body.description !== undefined) {
    patch.description = normalizeDescription(body.description)
  }
  if (body.formatId !== undefined) {
    patch.formatId = normalizeFormatId(body.formatId)
  }
  if (body.pairingSystem !== undefined) {
    patch.pairingSystem = normalizePairingSystem(body.pairingSystem)
  }
  if (body.scoring !== undefined) {
    patch.scoring = normalizeScoring(body.scoring)
  }
  if (body.byeScoring !== undefined) {
    patch.byeScoring = normalizeByeScoring(body.byeScoring)
  }
  if (body.plannedRounds !== undefined) {
    patch.plannedRounds = normalizePlannedRounds(body.plannedRounds)
  }

  return patch
}

export interface ParticipantInput { email: string | null, name: string | null }

export function validateParticipantInput(body: unknown): ParticipantInput {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const hasEmail = typeof body.email === 'string' && body.email.trim().length > 0
  const hasName = typeof body.name === 'string' && body.name.trim().length > 0

  if (hasEmail === hasName) {
    badRequest('invalid_participant', 'Provide either an email address or a name')
  }

  if (hasEmail) {
    return { email: (body.email as string).trim().toLowerCase(), name: null }
  }

  const name = (body.name as string).trim()
  if (name.length > PARTICIPANT_NAME_MAX_LENGTH) {
    badRequest('invalid_participant', `name must be at most ${PARTICIPANT_NAME_MAX_LENGTH} characters`)
  }
  return { email: null, name }
}

export interface ParticipantUpdateInput { name?: string, dropped?: boolean, withdrawn?: boolean }

export function validateParticipantUpdateInput(body: unknown): ParticipantUpdateInput {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const patch: ParticipantUpdateInput = {}

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      badRequest('invalid_body', 'name must be a string')
    }
    const name = body.name.trim()
    if (name.length === 0 || name.length > PARTICIPANT_NAME_MAX_LENGTH) {
      badRequest('invalid_body', `name must be 1-${PARTICIPANT_NAME_MAX_LENGTH} characters`)
    }
    patch.name = name
  }
  if (body.dropped !== undefined) {
    if (typeof body.dropped !== 'boolean') {
      badRequest('invalid_body', 'dropped must be a boolean')
    }
    patch.dropped = body.dropped
  }
  if (body.withdrawn !== undefined) {
    if (typeof body.withdrawn !== 'boolean') {
      badRequest('invalid_body', 'withdrawn must be a boolean')
    }
    patch.withdrawn = body.withdrawn
  }

  return patch
}

export function validateDeckRegistrationInput(body: unknown): { deckId: string | null } {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const raw = body.deckId
  if (raw === null || raw === undefined) {
    return { deckId: null }
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    badRequest('invalid_body', 'deckId must be a string or null')
  }
  return { deckId: raw }
}

/**
 * Normalizes both entry styles into games (see D8). A match always has a
 * winner (ADR 0028): `{ draw: true }` and equal game counts are rejected.
 */
export function validateMatchResultInput(body: unknown): { gamesA: number, gamesB: number } {
  if (!isRecord(body)) {
    badRequest('invalid_result', 'Result must be an object')
  }

  if (body.gamesA !== undefined || body.gamesB !== undefined) {
    const { gamesA, gamesB } = body
    const isValidCount = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_GAMES_PER_MATCH

    if (!isValidCount(gamesA) || !isValidCount(gamesB)) {
      badRequest('invalid_result', `gamesA/gamesB must be integers 0-${MAX_GAMES_PER_MATCH}`)
    }
    if (gamesA === gamesB) {
      badRequest('draws_not_allowed', 'A match cannot end in a draw')
    }
    return { gamesA, gamesB }
  }

  if (body.draw === true) {
    badRequest('draws_not_allowed', 'A match cannot end in a draw')
  }

  if (body.winnerParticipantId === 'a') {
    return { gamesA: DEFAULT_WIN_GAMES, gamesB: 0 }
  }
  if (body.winnerParticipantId === 'b') {
    return { gamesA: 0, gamesB: DEFAULT_WIN_GAMES }
  }

  badRequest('invalid_result', 'Invalid result shape')
}

/**
 * The endpoint (here: `reportMatchResult`) resolves a caller-supplied
 * `winnerParticipantId` (the real participant id) to a side (`'a'` / `'b'`)
 * before `validateMatchResultInput` ever sees the body — the validator only
 * knows about match sides, never about real ids.
 */
function normalizeMatchResultBody(body: unknown, participantAId: string, participantBId: string): unknown {
  if (!isRecord(body) || typeof body.winnerParticipantId !== 'string') {
    return body
  }
  if (body.winnerParticipantId === participantAId) {
    return { winnerParticipantId: 'a' }
  }
  if (body.winnerParticipantId === participantBId) {
    return { winnerParticipantId: 'b' }
  }
  badRequest('invalid_result', 'winnerParticipantId does not belong to this match')
}

export interface PairingSwapInput { matchAId: string, slotA: 'a' | 'b', matchBId: string, slotB: 'a' | 'b' }

export function validatePairingSwapInput(body: unknown): PairingSwapInput {
  if (!isRecord(body)) {
    badRequest('invalid_body', 'Request body must be an object')
  }

  const { matchAId, slotA, matchBId, slotB } = body
  if (typeof matchAId !== 'string' || matchAId.length === 0) {
    badRequest('invalid_swap', 'matchAId is required')
  }
  if (typeof matchBId !== 'string' || matchBId.length === 0) {
    badRequest('invalid_swap', 'matchBId is required')
  }
  if (slotA !== 'a' && slotA !== 'b') {
    badRequest('invalid_swap', 'slotA must be "a" or "b"')
  }
  if (slotB !== 'a' && slotB !== 'b') {
    badRequest('invalid_swap', 'slotB must be "a" or "b"')
  }

  return { matchAId, slotA, matchBId, slotB }
}

export interface TournamentListOptions {
  role?: TournamentRole
  /** 'active' = registration + running. */
  status?: TournamentStatus | 'active'
  page?: number
  pageSize?: number
}

export function parseTournamentListQuery(rawQuery: Record<string, unknown>): TournamentListOptions {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value)

  const rawRole = first(rawQuery.role)
  const role = rawRole === 'organizer' || rawRole === 'participant' ? rawRole : undefined

  const rawStatus = first(rawQuery.status)
  const status = typeof rawStatus === 'string'
    && (rawStatus === 'active' || (TOURNAMENT_STATUSES as readonly string[]).includes(rawStatus))
    ? (rawStatus as TournamentStatus | 'active')
    : undefined

  const rawPage = Number(first(rawQuery.page))
  const rawPageSize = Number(first(rawQuery.pageSize))

  return {
    role,
    status,
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : undefined,
    pageSize: Number.isInteger(rawPageSize) && rawPageSize > 0 ? rawPageSize : undefined,
  }
}

// --- Deck snapshot -------------------------------------------------------

/**
 * Copies `deckId` (owned by `deckOwnerUserId`) into a frozen snapshot and
 * evaluates it against the tournament's format. Reuses the deck reader so a
 * snapshot always matches what the deck page shows at that moment.
 */
function buildDeckSnapshot(
  db: Db,
  deckOwnerUserId: string,
  deckId: string,
  format: { id: string, name: string, rules: RuleSet } | null,
): { snapshot: TournamentDeckSnapshot, legal: boolean | null, issueCount: number | null } {
  let detail: ReturnType<typeof getDeckDetail>
  try {
    detail = getDeckDetail(db, deckOwnerUserId, deckId)
  }
  catch {
    badRequest('unknown_deck', 'Deck not found')
  }

  if (detail.counts.total === 0) {
    badRequest('empty_deck', 'An empty deck cannot be registered')
  }

  const toSnapshotCards = (rows: typeof detail.sections.main): TournamentDeckSnapshotCard[] =>
    rows.map(row => ({ catalogCardId: row.catalogCardId, name: row.name, nameDe: row.nameDe, quantity: row.quantity }))

  const allRows = [...detail.sections.main, ...detail.sections.extra, ...detail.sections.side]

  let validation: TournamentDeckSnapshot['validation'] = null
  let legal: boolean | null = null
  let issueCount: number | null = null

  if (format) {
    const entries = allRows.map(row => ({
      catalogCardId: row.catalogCardId,
      section: row.section,
      quantity: row.quantity,
    }))
    const cardData = loadCardDataForValidation(db, entries.map(entry => entry.catalogCardId))

    const result = evaluateDeck(format.rules, entries, cardData)
    legal = result.legal
    issueCount = result.issues.length
    validation = {
      legal: result.legal,
      issueCount: result.issues.length,
      issues: result.issues.slice(0, MAX_SNAPSHOT_ISSUES).map(issue => issue.message),
      issueDetails: result.issues.slice(0, MAX_SNAPSHOT_ISSUES),
    }
  }

  const snapshot: TournamentDeckSnapshot = {
    deckId,
    name: detail.name,
    formatName: format?.name,
    formatId: format?.id,
    sections: {
      main: toSnapshotCards(detail.sections.main),
      extra: toSnapshotCards(detail.sections.extra),
      side: toSnapshotCards(detail.sections.side),
    },
    counts: detail.counts,
    validation,
    capturedAt: new Date().toISOString(),
  }

  return { snapshot, legal, issueCount }
}

// --- Standings and byes ----------------------------------------------------

type ParticipantRow = typeof tournamentParticipant.$inferSelect
type MatchRow = typeof tournamentMatch.$inferSelect

function standingsOptionsOf(row: typeof tournament.$inferSelect): StandingsOptions {
  return { scoring: row.scoring, byeScoring: row.byeScoring, pairingSystem: row.pairingSystem }
}

/** Standings are always computed on read, from the match history, never stored. */
function computeTournamentStandings(
  row: typeof tournament.$inferSelect,
  participants: ParticipantRow[],
  matches: MatchRow[],
) {
  const standingsParticipants: StandingsParticipant[] = participants.map(p => ({
    id: p.id,
    seed: p.seed,
    dropped: p.dropped,
    withdrawn: p.withdrawn,
  }))
  const standingsMatches: StandingsMatch[] = matches.map(match => ({
    participantAId: match.participantAId,
    participantBId: match.participantBId,
    winnerParticipantId: match.winnerParticipantId,
    gamesA: match.gamesA,
    gamesB: match.gamesB,
    isDraw: match.isDraw,
    reported: match.reportedAt !== null,
  }))
  return computeStandings(standingsParticipants, standingsMatches, standingsOptionsOf(row))
}

/**
 * A match with a withdrawn player is void (ADR 0028): it is not scored and
 * needs no result. A bye has no second player, so it is void only when its
 * one player is withdrawn.
 */
function isVoidedMatch(match: MatchRow, withdrawnIds: Set<string>): boolean {
  return withdrawnIds.has(match.participantAId)
    || (match.participantBId !== null && withdrawnIds.has(match.participantBId))
}

/** The stored shape of a bye: reported at once, a 2–0 win or an empty 0–0 (ADR 0028). */
function byeMatchValues(byeScoring: ByeScoring, participantAId: string, now: Date) {
  const scoredAsWin = byeScoring === 'win'
  return {
    winnerParticipantId: scoredAsWin ? participantAId : null,
    gamesA: scoredAsWin ? BYE_GAMES : 0,
    gamesB: 0,
    isDraw: false,
    reportedAt: now,
  }
}

// --- Detail building -----------------------------------------------------

function toParticipantDto(
  participant: typeof tournamentParticipant.$inferSelect,
  callerUserId: string,
  role: TournamentRole,
  tournamentStatus: TournamentStatus,
): TournamentParticipantDto {
  const isSelf = participant.userId !== null && participant.userId === callerUserId
  const canSeeSnapshot = role === 'organizer' || isSelf || tournamentStatus === 'finished'

  return {
    id: participant.id,
    name: participant.name,
    linked: participant.userId !== null,
    isSelf,
    dropped: participant.dropped,
    withdrawn: participant.withdrawn,
    seed: participant.seed,
    // Don't hand out a deck id for a snapshot the caller cannot open (#3):
    // deckName/deckLegal/deckIssueCount stay populated (snapshot-derived),
    // only the identifier of a resource the caller can't read is withheld.
    deckId: canSeeSnapshot ? participant.deckId : null,
    deckName: participant.deckSnapshot?.name ?? null,
    deckLegal: participant.deckLegal,
    deckIssueCount: participant.deckIssueCount,
    deckSnapshot: canSeeSnapshot ? participant.deckSnapshot ?? null : null,
    createdAt: participant.createdAt.toISOString(),
  }
}

function buildTournamentDetail(
  db: Db,
  userId: string,
  row: typeof tournament.$inferSelect,
  role: TournamentRole,
  selfParticipantId: string | null,
): TournamentDetail {
  const participants = db
    .select()
    .from(tournamentParticipant)
    .where(eq(tournamentParticipant.tournamentId, row.id))
    .orderBy(asc(tournamentParticipant.seed))
    .all()

  const rounds = db
    .select()
    .from(tournamentRound)
    .where(eq(tournamentRound.tournamentId, row.id))
    .orderBy(asc(tournamentRound.number))
    .all()

  const matches = db
    .select()
    .from(tournamentMatch)
    .where(eq(tournamentMatch.tournamentId, row.id))
    .orderBy(asc(tournamentMatch.tableNumber))
    .all()

  const participantById = new Map(participants.map(p => [p.id, p]))
  const withdrawnIds = new Set(participants.filter(p => p.withdrawn).map(p => p.id))

  const matchesByRound = new Map<string, typeof matches>()
  for (const match of matches) {
    const list = matchesByRound.get(match.roundId) ?? []
    list.push(match)
    matchesByRound.set(match.roundId, list)
  }

  const toMatchDto = (match: typeof matches[number], roundNumber: number): TournamentMatchDto => ({
    id: match.id,
    roundId: match.roundId,
    roundNumber,
    tableNumber: match.tableNumber,
    participantAId: match.participantAId,
    participantAName: participantById.get(match.participantAId)?.name ?? '',
    participantBId: match.participantBId,
    participantBName: match.participantBId ? participantById.get(match.participantBId)?.name ?? null : null,
    winnerParticipantId: match.winnerParticipantId,
    gamesA: match.gamesA,
    gamesB: match.gamesB,
    isDraw: match.isDraw,
    isBye: match.participantBId === null,
    voided: isVoidedMatch(match, withdrawnIds),
    reported: match.reportedAt !== null,
    reportedAt: match.reportedAt ? match.reportedAt.toISOString() : null,
  })

  const roundDtos: TournamentRoundDto[] = rounds.map(round => ({
    id: round.id,
    number: round.number,
    status: round.status,
    matches: (matchesByRound.get(round.id) ?? []).map(match => toMatchDto(match, round.number)),
    createdAt: round.createdAt.toISOString(),
    completedAt: round.completedAt ? round.completedAt.toISOString() : null,
  }))

  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1]! : undefined
  const currentRoundDto = lastRound && lastRound.status === 'pending' ? roundDtos[roundDtos.length - 1]! : null

  const format = row.formatId ? loadTournamentFormatRef(db, row.formatId) : null
  const organizer = db.select({ name: user.name }).from(user).where(eq(user.id, row.organizerUserId)).get()

  const standings: TournamentStandingRow[] = computeTournamentStandings(row, participants, matches)
    .map(standingsRow => ({ ...standingsRow, name: participantById.get(standingsRow.participantId)?.name ?? '' }))

  const activeParticipantCount = participants.filter(p => !p.dropped && !p.withdrawn).length

  const canStart = role === 'organizer'
    && row.status === 'registration'
    && participants.length >= MIN_PARTICIPANTS_TO_START

  const canCreateRound = role === 'organizer'
    && row.status === 'running'
    && rounds.length > 0
    && lastRound!.status === 'completed'
    && rounds.length < (row.plannedRounds ?? 0)
    && activeParticipantCount >= 2
    && (row.pairingSystem !== 'round_robin' || rounds.length < roundRobinRoundCount(participants.length))

  const canCompleteRound = role === 'organizer'
    && currentRoundDto !== null
    && currentRoundDto.matches.every(match => match.reported || match.voided)

  const canFinish = role === 'organizer'
    && row.status === 'running'
    && rounds.length > 0
    && lastRound!.status === 'completed'

  // A round-robin schedule is fixed by the circle method (ADR 0028): moving a
  // player to another table would break "everyone plays everyone once".
  const canEditPairings = role === 'organizer'
    && row.pairingSystem === 'swiss'
    && currentRoundDto !== null
    && currentRoundDto.matches.every(match => match.isBye || !match.reported)

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    pairingSystem: row.pairingSystem,
    scoring: row.scoring,
    byeScoring: row.byeScoring,
    plannedRounds: row.plannedRounds,
    format,
    organizerName: organizer?.name ?? '',
    role,
    selfParticipantId,
    participants: participants.map(p => toParticipantDto(p, userId, role, row.status)),
    rounds: roundDtos,
    currentRound: currentRoundDto,
    standings,
    canStart,
    canCreateRound,
    canCompleteRound,
    canFinish,
    canEditPairings,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Creates round `roundNumber` (pairings + matches) inside an open transaction. */
function createRoundInTransaction(
  txDb: Db,
  tournamentId: string,
  system: PairingSystem,
  byeScoring: ByeScoring,
  roundNumber: number,
  participants: PairingParticipant[],
  now: Date,
): void {
  const pairings: Pairing[] = pairRound({ system, roundNumber, participants })
  if (pairings.length === 0) {
    conflict('planned_rounds_reached', 'All planned rounds have been played')
  }

  const roundId = randomUUID()
  txDb.insert(tournamentRound).values({
    id: roundId,
    tournamentId,
    number: roundNumber,
    status: 'pending',
    createdAt: now,
    completedAt: null,
  }).run()

  txDb.insert(tournamentMatch).values(pairings.map((pairing) => {
    const isBye = pairing.participantBId === null
    return {
      id: randomUUID(),
      roundId,
      tournamentId,
      tableNumber: pairing.tableNumber,
      participantAId: pairing.participantAId,
      participantBId: pairing.participantBId,
      ...(isBye
        ? byeMatchValues(byeScoring, pairing.participantAId, now)
        : { winnerParticipantId: null, gamesA: 0, gamesB: 0, isDraw: false, reportedAt: null }),
    }
  })).run()

  txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, tournamentId)).run()
}

// --- Exported operations --------------------------------------------------

export function listTournaments(db: Db, userId: string, options: TournamentListOptions = {}): TournamentListResponse {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE))

  const participatesClause = sql`exists (
    select 1 from ${tournamentParticipant}
    where ${tournamentParticipant.tournamentId} = ${tournament.id}
      and ${tournamentParticipant.userId} = ${userId}
  )`

  // "participant" intentionally does NOT exclude the organizer: an organizer
  // who also plays in their own tournament (`includeSelf`) has a genuine
  // participant row and should see it under "Teilnahmen" too (#32 in the UX
  // review — this used to require `organizerUserId <> userId`, which hid an
  // organizer's own tournament from their "Teilnahmen" tab whenever they
  // played themselves).
  const roleClause = options.role === 'organizer'
    ? eq(tournament.organizerUserId, userId)
    : options.role === 'participant'
      ? participatesClause
      : or(eq(tournament.organizerUserId, userId), participatesClause)!

  const statusClause = options.status === 'active'
    ? inArray(tournament.status, ['registration', 'running'])
    : options.status
      ? eq(tournament.status, options.status)
      : undefined

  const where = statusClause ? and(roleClause, statusClause)! : roleClause

  const total = db.select({ count: sql<number>`count(*)` }).from(tournament).where(where).get()?.count ?? 0

  const rows = db
    .select()
    .from(tournament)
    .where(where)
    .orderBy(
      sql`(${tournament.status} = 'finished')`,
      sql`coalesce(${tournament.startedAt}, ${tournament.createdAt}) desc`,
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  const tournamentIds = rows.map(row => row.id)

  const participantCounts = tournamentIds.length > 0
    ? db
        .select({ tournamentId: tournamentParticipant.tournamentId, count: sql<number>`count(*)` })
        .from(tournamentParticipant)
        .where(inArray(tournamentParticipant.tournamentId, tournamentIds))
        .groupBy(tournamentParticipant.tournamentId)
        .all()
    : []
  const roundCounts = tournamentIds.length > 0
    ? db
        .select({ tournamentId: tournamentRound.tournamentId, count: sql<number>`count(*)` })
        .from(tournamentRound)
        .where(inArray(tournamentRound.tournamentId, tournamentIds))
        .groupBy(tournamentRound.tournamentId)
        .all()
    : []

  const participantCountById = new Map(participantCounts.map(row => [row.tournamentId, row.count]))
  const roundCountById = new Map(roundCounts.map(row => [row.tournamentId, row.count]))

  const formatIds = [...new Set(rows.flatMap(row => (row.formatId ? [row.formatId] : [])))]
  const formats = formatIds.length > 0
    ? db
        .select({ id: ruleFormat.id, name: ruleFormat.name, isBuiltin: ruleFormat.isBuiltin })
        .from(ruleFormat)
        .where(inArray(ruleFormat.id, formatIds))
        .all()
    : []
  const formatById = new Map(formats.map(format => [format.id, format]))

  const organizerIds = [...new Set(rows.map(row => row.organizerUserId))]
  const organizers = organizerIds.length > 0
    ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, organizerIds)).all()
    : []
  const organizerNameById = new Map(organizers.map(organizer => [organizer.id, organizer.name]))

  const items: TournamentListItem[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    pairingSystem: row.pairingSystem,
    format: row.formatId ? formatById.get(row.formatId) ?? null : null,
    organizerName: organizerNameById.get(row.organizerUserId) ?? '',
    role: row.organizerUserId === userId ? 'organizer' : 'participant',
    participantCount: participantCountById.get(row.id) ?? 0,
    roundCount: roundCountById.get(row.id) ?? 0,
    plannedRounds: row.plannedRounds,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  }))

  return { items, total, page, pageSize }
}

export function getTournamentDetail(db: Db, userId: string, tournamentId: string): TournamentDetail {
  const { row, role, selfParticipantId } = requireTournamentRow(db, userId, tournamentId)
  return buildTournamentDetail(db, userId, row, role, selfParticipantId)
}

export function createTournament(db: Db, userId: string, input: TournamentInput): TournamentDetail {
  if (input.formatId !== null) {
    try {
      requireAssignableFormat(db, userId, input.formatId)
    }
    catch {
      badRequest('unknown_format', 'format_id does not exist')
    }
  }

  const now = new Date()
  const id = randomUUID()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    txDb.insert(tournament).values({
      id,
      organizerUserId: userId,
      name: input.name,
      description: input.description,
      formatId: input.formatId,
      pairingSystem: input.pairingSystem,
      scoring: input.scoring,
      byeScoring: input.byeScoring,
      status: 'registration',
      plannedRounds: input.plannedRounds,
      createdAt: now,
      updatedAt: now,
    }).run()

    if (input.includeSelf) {
      const organizer = txDb.select({ name: user.name }).from(user).where(eq(user.id, userId)).get()
      txDb.insert(tournamentParticipant).values({
        id: randomUUID(),
        tournamentId: id,
        userId,
        name: organizer?.name ?? '',
        seed: 1,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })

  return getTournamentDetail(db, userId, id)
}

export function updateTournament(db: Db, userId: string, id: string, patch: TournamentUpdateInput): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)

  const touchesAnything = patch.name !== undefined
    || patch.description !== undefined
    || patch.formatId !== undefined
    || patch.pairingSystem !== undefined
    || patch.scoring !== undefined
    || patch.byeScoring !== undefined
    || patch.plannedRounds !== undefined

  if (!touchesAnything) {
    return getTournamentDetail(db, userId, id)
  }

  if (row.status === 'finished') {
    conflict('tournament_finished', 'Tournament is finished')
  }

  // Changing how points are awarded mid-tournament would silently re-rank
  // every result already entered, so scoring is fixed once it starts.
  if ((patch.formatId !== undefined || patch.pairingSystem !== undefined
    || patch.scoring !== undefined || patch.byeScoring !== undefined) && row.status !== 'registration') {
    conflict('tournament_started', 'Tournament has already started')
  }

  if (patch.formatId) {
    try {
      requireAssignableFormat(db, userId, patch.formatId)
    }
    catch {
      badRequest('unknown_format', 'format_id does not exist')
    }
  }

  if (patch.plannedRounds !== undefined && patch.plannedRounds !== null && row.status === 'running') {
    const roundCount = db
      .select({ count: sql<number>`count(*)` })
      .from(tournamentRound)
      .where(eq(tournamentRound.tournamentId, id))
      .get()?.count ?? 0
    if (patch.plannedRounds < roundCount) {
      conflict('invalid_status', 'plannedRounds must be at least the number of rounds already played')
    }
  }

  db.update(tournament).set({
    name: patch.name ?? row.name,
    description: patch.description !== undefined ? patch.description : row.description,
    formatId: patch.formatId !== undefined ? patch.formatId : row.formatId,
    pairingSystem: patch.pairingSystem ?? row.pairingSystem,
    scoring: patch.scoring ?? row.scoring,
    byeScoring: patch.byeScoring ?? row.byeScoring,
    plannedRounds: patch.plannedRounds !== undefined ? patch.plannedRounds : row.plannedRounds,
    updatedAt: new Date(),
  }).where(eq(tournament.id, id)).run()

  return getTournamentDetail(db, userId, id)
}

export function deleteTournament(db: Db, userId: string, id: string): void {
  requireOrganizerTournament(db, userId, id)
  db.delete(tournament).where(and(eq(tournament.id, id), eq(tournament.organizerUserId, userId))).run()
}

export function addParticipant(db: Db, userId: string, id: string, input: ParticipantInput): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)
  assertStatus(row, ['registration'], 'registration_closed')

  const now = new Date()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    const participantCount = txDb
      .select({ count: sql<number>`count(*)` })
      .from(tournamentParticipant)
      .where(eq(tournamentParticipant.tournamentId, id))
      .get()?.count ?? 0
    if (participantCount >= MAX_PARTICIPANTS) {
      conflict('too_many_participants', 'Tournament is full', { max: MAX_PARTICIPANTS })
    }

    let name: string
    let linkedUserId: string | null = null

    if (input.email !== null) {
      const found = txDb
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(sql`lower(${user.email}) = ${input.email}`)
        .get()
      if (!found) {
        badRequest('user_not_found', 'No account with this email address')
      }

      const existing = txDb
        .select({ id: tournamentParticipant.id })
        .from(tournamentParticipant)
        .where(and(eq(tournamentParticipant.tournamentId, id), eq(tournamentParticipant.userId, found.id)))
        .get()
      if (existing) {
        conflict('participant_exists', 'This participant is already registered')
      }

      name = found.name
      linkedUserId = found.id
    }
    else {
      const guestName = input.name!
      const existingNames = txDb
        .select({ name: tournamentParticipant.name })
        .from(tournamentParticipant)
        .where(eq(tournamentParticipant.tournamentId, id))
        .all()
      if (existingNames.some(row2 => row2.name.toLowerCase() === guestName.toLowerCase())) {
        conflict('participant_exists', 'This participant is already registered')
      }
      name = guestName
    }

    const maxSeed = txDb
      .select({ maxSeed: sql<number | null>`max(${tournamentParticipant.seed})` })
      .from(tournamentParticipant)
      .where(eq(tournamentParticipant.tournamentId, id))
      .get()?.maxSeed ?? 0

    txDb.insert(tournamentParticipant).values({
      id: randomUUID(),
      tournamentId: id,
      userId: linkedUserId,
      name,
      seed: maxSeed + 1,
      createdAt: now,
      updatedAt: now,
    }).run()

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function updateParticipant(
  db: Db,
  userId: string,
  id: string,
  participantId: string,
  patch: ParticipantUpdateInput,
): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)

  if (row.status === 'finished') {
    conflict('tournament_finished', 'Tournament is finished')
  }

  const now = new Date()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    const participant = txDb
      .select()
      .from(tournamentParticipant)
      .where(and(eq(tournamentParticipant.id, participantId), eq(tournamentParticipant.tournamentId, id)))
      .get()
    if (!participant) {
      notFound()
    }

    if ((patch.dropped !== undefined || patch.withdrawn !== undefined) && row.status !== 'running') {
      conflict('invalid_status', 'A participant can only drop or be withdrawn while the tournament is running')
    }

    txDb.update(tournamentParticipant).set({
      name: patch.name ?? participant.name,
      dropped: patch.dropped ?? participant.dropped,
      withdrawn: patch.withdrawn ?? participant.withdrawn,
      updatedAt: now,
    }).where(eq(tournamentParticipant.id, participantId)).run()

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function removeParticipant(db: Db, userId: string, id: string, participantId: string): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)
  assertStatus(row, ['registration'], 'registration_closed')

  const now = new Date()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    const deleted = txDb
      .delete(tournamentParticipant)
      .where(and(eq(tournamentParticipant.id, participantId), eq(tournamentParticipant.tournamentId, id)))
      .returning({ id: tournamentParticipant.id })
      .all()
    if (deleted.length === 0) {
      notFound()
    }

    // Renumber seeds contiguously (1..n) so registration never shows gaps;
    // startTournament re-freezes seeds anyway, so this is purely cosmetic
    // during the registration phase.
    const remaining = txDb
      .select()
      .from(tournamentParticipant)
      .where(eq(tournamentParticipant.tournamentId, id))
      .orderBy(asc(tournamentParticipant.seed))
      .all()
    remaining.forEach((participant, index) => {
      if (participant.seed !== index + 1) {
        txDb.update(tournamentParticipant)
          .set({ seed: index + 1, updatedAt: now })
          .where(eq(tournamentParticipant.id, participant.id))
          .run()
      }
    })

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function registerParticipantDeck(
  db: Db,
  userId: string,
  id: string,
  participantId: string,
  deckId: string | null,
): TournamentDetail {
  const { row, role } = requireTournamentRow(db, userId, id)
  assertStatus(row, ['registration'], 'registration_closed')

  const participant = db
    .select()
    .from(tournamentParticipant)
    .where(and(eq(tournamentParticipant.id, participantId), eq(tournamentParticipant.tournamentId, id)))
    .get()
  if (!participant) {
    notFound()
  }

  let deckOwnerUserId: string
  if (participant.userId === userId) {
    deckOwnerUserId = userId
  }
  else if (role === 'organizer' && participant.userId === null) {
    deckOwnerUserId = userId
  }
  else if (role === 'organizer') {
    forbidden('foreign_deck_owner', 'This participant registers their own deck')
  }
  else {
    forbidden('organizer_only', 'Only the organizer can do this')
  }

  const now = new Date()

  // buildDeckSnapshot reads through getDeckDetail/loadCardDataForValidation
  // against `db` (not a transaction handle) and may throw a validation error
  // (unknown_deck/empty_deck); resolve it before opening the transaction that
  // guards the actual writes.
  const write = deckId === null
    ? { deckId: null, deckSnapshot: null, deckLegal: null, deckIssueCount: null }
    : (() => {
        const format = loadTournamentFormat(db, row)
        const { snapshot, legal, issueCount } = buildDeckSnapshot(db, deckOwnerUserId, deckId, format)
        return { deckId, deckSnapshot: snapshot, deckLegal: legal, deckIssueCount: issueCount }
      })()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    txDb.update(tournamentParticipant).set({ ...write, updatedAt: now })
      .where(eq(tournamentParticipant.id, participantId)).run()

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function startTournament(db: Db, userId: string, id: string): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)
  assertStatus(row, ['registration'], 'invalid_status')

  const participants = db
    .select()
    .from(tournamentParticipant)
    .where(eq(tournamentParticipant.tournamentId, id))
    .orderBy(asc(tournamentParticipant.seed))
    .all()
  if (participants.length < MIN_PARTICIPANTS_TO_START) {
    conflict('not_enough_participants', 'Not enough participants to start', { min: MIN_PARTICIPANTS_TO_START })
  }

  const now = new Date()
  const plannedRounds = row.pairingSystem === 'round_robin'
    ? roundRobinRoundCount(participants.length)
    : (row.plannedRounds ?? swissRoundCount(participants.length))

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    participants.forEach((participant, index) => {
      txDb.update(tournamentParticipant)
        .set({ seed: index + 1, updatedAt: now })
        .where(eq(tournamentParticipant.id, participant.id))
        .run()
    })

    txDb.update(tournament).set({
      status: 'running',
      plannedRounds,
      startedAt: now,
      updatedAt: now,
    }).where(eq(tournament.id, id)).run()

    const pairingParticipants: PairingParticipant[] = participants.map((participant, index) => ({
      id: participant.id,
      seed: index + 1,
      points: 0,
      tiebreak: 0,
      dropped: participant.dropped,
      withdrawn: participant.withdrawn,
      opponentIds: [],
      hadBye: false,
    }))

    createRoundInTransaction(txDb, id, row.pairingSystem, row.byeScoring, 1, pairingParticipants, now)
  })

  return getTournamentDetail(db, userId, id)
}

export function createNextRound(db: Db, userId: string, id: string): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)
  assertStatus(row, ['running'], 'invalid_status')

  const rounds = db
    .select()
    .from(tournamentRound)
    .where(eq(tournamentRound.tournamentId, id))
    .orderBy(asc(tournamentRound.number))
    .all()
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1]! : undefined
  if (lastRound && lastRound.status === 'pending') {
    conflict('round_not_complete', 'The current round is not complete yet')
  }
  if (rounds.length >= (row.plannedRounds ?? 0)) {
    conflict('planned_rounds_reached', 'All planned rounds have been played')
  }

  const participants = db
    .select()
    .from(tournamentParticipant)
    .where(eq(tournamentParticipant.tournamentId, id))
    .orderBy(asc(tournamentParticipant.seed))
    .all()
  const activeCount = participants.filter(p => !p.dropped && !p.withdrawn).length
  if (activeCount < 2) {
    conflict('not_enough_participants', 'Not enough active participants', { min: MIN_PARTICIPANTS_TO_START })
  }

  const matches = db
    .select()
    .from(tournamentMatch)
    .where(eq(tournamentMatch.tournamentId, id))
    .all()

  const standingsRows = computeTournamentStandings(row, participants, matches)
  const pointsById = new Map(standingsRows.map(row2 => [row2.participantId, row2.points]))
  const tiebreakById = new Map(standingsRows.map(row2 => [row2.participantId, row2.opponentMatchWinRate]))

  const opponentIdsById = new Map<string, string[]>(participants.map(p => [p.id, []]))
  const hadByeById = new Map<string, boolean>(participants.map(p => [p.id, false]))
  for (const match of matches) {
    if (match.reportedAt === null) {
      continue
    }
    if (match.participantBId === null) {
      hadByeById.set(match.participantAId, true)
      continue
    }
    opponentIdsById.get(match.participantAId)?.push(match.participantBId)
    opponentIdsById.get(match.participantBId)?.push(match.participantAId)
  }

  const pairingParticipants: PairingParticipant[] = participants.map(p => ({
    id: p.id,
    seed: p.seed,
    points: pointsById.get(p.id) ?? 0,
    tiebreak: tiebreakById.get(p.id) ?? 0,
    dropped: p.dropped,
    withdrawn: p.withdrawn,
    opponentIds: opponentIdsById.get(p.id) ?? [],
    hadBye: hadByeById.get(p.id) ?? false,
  }))

  const now = new Date()
  db.transaction((tx) => {
    const txDb = tx as unknown as Db
    createRoundInTransaction(txDb, id, row.pairingSystem, row.byeScoring, rounds.length + 1, pairingParticipants, now)
  })

  return getTournamentDetail(db, userId, id)
}

function loadWithdrawnIds(db: Db, tournamentId: string): Set<string> {
  const rows = db
    .select({ id: tournamentParticipant.id })
    .from(tournamentParticipant)
    .where(and(eq(tournamentParticipant.tournamentId, tournamentId), eq(tournamentParticipant.withdrawn, true)))
    .all()
  return new Set(rows.map(row => row.id))
}

export function reportMatchResult(
  db: Db,
  userId: string,
  id: string,
  matchId: string,
  body: unknown,
): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)

  const match = db
    .select()
    .from(tournamentMatch)
    .where(and(eq(tournamentMatch.id, matchId), eq(tournamentMatch.tournamentId, id)))
    .get()
  if (!match) {
    notFound()
  }

  assertStatus(row, ['running'], 'invalid_status')

  const round = db.select().from(tournamentRound).where(eq(tournamentRound.id, match.roundId)).get()
  if (!round || round.status !== 'pending') {
    conflict('round_completed', 'This round is already completed')
  }

  if (match.participantBId === null) {
    conflict('bye_not_editable', 'A bye has no result to edit')
  }

  const withdrawnIds = loadWithdrawnIds(db, id)
  if (isVoidedMatch(match, withdrawnIds)) {
    conflict('match_voided', 'A match with a withdrawn participant is not scored')
  }

  const normalizedBody = normalizeMatchResultBody(body, match.participantAId, match.participantBId)
  const { gamesA, gamesB } = validateMatchResultInput(normalizedBody)

  // validateMatchResultInput guarantees gamesA !== gamesB: no draws (ADR 0028).
  const winnerParticipantId = gamesA > gamesB ? match.participantAId : match.participantBId

  const now = new Date()
  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    txDb.update(tournamentMatch).set({
      gamesA,
      gamesB,
      winnerParticipantId,
      isDraw: false,
      reportedAt: now,
    }).where(eq(tournamentMatch.id, matchId)).run()

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function swapPairing(db: Db, userId: string, id: string, input: PairingSwapInput): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)

  if (row.pairingSystem === 'round_robin') {
    conflict('pairings_fixed', 'Round-robin pairings follow a fixed schedule')
  }

  const rounds = db
    .select()
    .from(tournamentRound)
    .where(eq(tournamentRound.tournamentId, id))
    .orderBy(asc(tournamentRound.number))
    .all()
  const currentRound = rounds.length > 0 ? rounds[rounds.length - 1]! : undefined
  if (!currentRound || currentRound.status !== 'pending') {
    conflict('round_completed', 'This round is already completed')
  }

  // Load every match of the round once: matchA/matchB are derived from it, and
  // the "no result reported yet" gate below must look at *all* of them, not
  // just the two being swapped, or a third already-reported table would let
  // pairings drift after results exist (see swapPairing review finding #1).
  const roundMatches = db
    .select()
    .from(tournamentMatch)
    .where(eq(tournamentMatch.roundId, currentRound.id))
    .all()

  const matchA = roundMatches.find(match => match.id === input.matchAId)
  const matchB = roundMatches.find(match => match.id === input.matchBId)
  if (!matchA || !matchB) {
    badRequest('invalid_swap', 'Both matches must belong to the current round')
  }

  if (matchA.id === matchB.id && input.slotA === input.slotB) {
    badRequest('invalid_swap', 'Cannot swap a slot with itself')
  }

  const isReportedNonBye = (match: typeof matchA) => match.participantBId !== null && match.reportedAt !== null
  if (roundMatches.some(isReportedNonBye)) {
    conflict('results_reported', 'Results have already been reported for this round')
  }

  const getSlot = (match: typeof matchA, slot: 'a' | 'b') => (slot === 'a' ? match.participantAId : match.participantBId)
  const idA = getSlot(matchA, input.slotA)
  const idB = getSlot(matchB, input.slotB)
  if (idA === null || idB === null) {
    badRequest('invalid_swap', 'Cannot swap an empty bye slot')
  }
  if (idA === idB) {
    badRequest('invalid_swap', 'Cannot pair a participant with themself')
  }

  const otherOfA = input.slotA === 'a' ? matchA.participantBId : matchA.participantAId
  const otherOfB = input.slotB === 'a' ? matchB.participantBId : matchB.participantAId
  if (matchA.id !== matchB.id && (idB === otherOfA || idA === otherOfB)) {
    badRequest('invalid_swap', 'This swap would pair a participant with themself')
  }

  const now = new Date()

  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    if (input.slotA === 'a') {
      txDb.update(tournamentMatch).set({ participantAId: idB }).where(eq(tournamentMatch.id, matchA.id)).run()
    }
    else {
      txDb.update(tournamentMatch).set({ participantBId: idB }).where(eq(tournamentMatch.id, matchA.id)).run()
    }
    if (input.slotB === 'a') {
      txDb.update(tournamentMatch).set({ participantAId: idA }).where(eq(tournamentMatch.id, matchB.id)).run()
    }
    else {
      txDb.update(tournamentMatch).set({ participantBId: idA }).where(eq(tournamentMatch.id, matchB.id)).run()
    }

    for (const matchId of new Set([matchA.id, matchB.id])) {
      const current = txDb.select().from(tournamentMatch).where(eq(tournamentMatch.id, matchId)).get()!
      if (current.participantBId === null) {
        txDb.update(tournamentMatch)
          .set(byeMatchValues(row.byeScoring, current.participantAId, now))
          .where(eq(tournamentMatch.id, matchId))
          .run()
      }
      else {
        txDb.update(tournamentMatch).set({
          winnerParticipantId: null,
          gamesA: 0,
          gamesB: 0,
          isDraw: false,
          reportedAt: null,
        }).where(eq(tournamentMatch.id, matchId)).run()
      }
    }

    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function completeRound(db: Db, userId: string, id: string, roundId: string): TournamentDetail {
  requireOrganizerTournament(db, userId, id)

  const round = db
    .select()
    .from(tournamentRound)
    .where(and(eq(tournamentRound.id, roundId), eq(tournamentRound.tournamentId, id)))
    .get()
  if (!round) {
    notFound()
  }
  if (round.status !== 'pending') {
    conflict('round_completed', 'This round is already completed')
  }

  const matches = db.select().from(tournamentMatch).where(eq(tournamentMatch.roundId, roundId)).all()
  const withdrawnIds = loadWithdrawnIds(db, id)
  if (matches.some(match => match.reportedAt === null && !isVoidedMatch(match, withdrawnIds))) {
    conflict('results_missing', 'Results are missing for this round')
  }

  const now = new Date()
  db.transaction((tx) => {
    const txDb = tx as unknown as Db

    txDb.update(tournamentRound).set({ status: 'completed', completedAt: now }).where(eq(tournamentRound.id, roundId)).run()
    txDb.update(tournament).set({ updatedAt: now }).where(eq(tournament.id, id)).run()
  })

  return getTournamentDetail(db, userId, id)
}

export function finishTournament(db: Db, userId: string, id: string): TournamentDetail {
  const { row } = requireOrganizerTournament(db, userId, id)
  assertStatus(row, ['running'], 'invalid_status')

  const rounds = db
    .select()
    .from(tournamentRound)
    .where(eq(tournamentRound.tournamentId, id))
    .orderBy(asc(tournamentRound.number))
    .all()
  if (rounds.length === 0) {
    conflict('no_rounds', 'No round has been played yet')
  }
  const lastRound = rounds[rounds.length - 1]!
  if (lastRound.status !== 'completed') {
    conflict('round_not_complete', 'The current round is not complete yet')
  }

  const now = new Date()
  db.update(tournament).set({
    status: 'finished',
    finishedAt: now,
    updatedAt: now,
  }).where(eq(tournament.id, id)).run()

  return getTournamentDetail(db, userId, id)
}
