// Pure rule-format model and deck validation engine, shared by the server
// (server/utils/rule-formats.ts, server/utils/deck-validation.ts) and the UI
// (app/pages/formats/**, app/pages/decks/[id].vue) so both agree on what a
// rule means. Intentionally dependency-free: no Drizzle, no h3, no Vue — the
// only import is the equally pure deck-section vocabulary.
//
// See docs/adr/0005-rule-format-model.md for why rules are a JSON list of
// typed predicates evaluated in code instead of relational rule tables.

import { DECK_SECTIONS } from './deck-sections'
import type { DeckSection } from './deck-sections'

export const RULE_FORMAT_NAME_MAX_LENGTH = 80
export const RULE_FORMAT_DESCRIPTION_MAX_LENGTH = 500

/** Hard cap on the rules of one format — a rule set is hand-written, not generated. */
export const MAX_RULES_PER_FORMAT = 50
/** Hard cap on any id/string list inside a card filter. */
export const MAX_FILTER_ENTRIES = 200
/** Copies of one catalog card across main + extra + side when no `copies` rule is set. */
export const DEFAULT_MAX_COPIES = 3
/** Highest per-card limit a `copies` rule may set (server check and editor input). */
export const MAX_COPIES_RULE = 10

// --- Model -----------------------------------------------------------------

/**
 * A predicate over catalog card data. All provided fields are ANDed; the
 * values inside an array field are ORed. An empty filter matches every card.
 */
export interface CardFilter {
  types?: string[]
  frameTypes?: string[]
  attributes?: string[]
  races?: string[]
  archetypes?: string[]
  /** Card has a printing in any of these sets (`catalog_set.id`). */
  setIds?: string[]
  cardIds?: number[]
  levelMin?: number
  levelMax?: number
  atkMin?: number
  atkMax?: number
  defMin?: number
  defMax?: number
  /** See `cardHasEffect`. */
  hasEffect?: boolean
  /** ISO `YYYY-MM-DD`; *strictly* before / *strictly* after. */
  releasedBefore?: string
  releasedAfter?: string
  /** Which release date the date predicates read. Defaults to 'tcg'. */
  region?: 'tcg' | 'ocg'
  nameContains?: string
}

export type CardStatusName = 'forbidden' | 'limited' | 'semi_limited'
export type BanlistSource = 'tcg' | 'ocg' | 'goat' | 'edison' | 'classic-plus'
export type FilterMatch = 'matching' | 'not_matching'
export type FilterMaxCopies = 0 | 1 | 2 | 3

export type Rule =
  | { kind: 'deck_size', section: DeckSection, min?: number, max?: number }
  /** Default per-card cap across main + extra + side (normally 3). */
  | { kind: 'copies', maxCopies: number }
  | { kind: 'card_status', status: CardStatusName, cardIds: number[] }
  /**
   * Reads the card's banlist status (Forbidden / Limited / Semi-Limited): the
   * official lists from `catalog_card.banlist_info`, Edison and Classic Plus
   * from their own lists (`loadCardDataForValidation`, ADR 0030, ADR 0022).
   */
  | { kind: 'banlist', source: BanlistSource }
  | { kind: 'filter', match: FilterMatch, filter: CardFilter, maxCopies: FilterMaxCopies, label?: string }

export interface RuleSet {
  rules: Rule[]
}

export const RULE_KINDS = ['deck_size', 'copies', 'card_status', 'banlist', 'filter'] as const
export type RuleKind = typeof RULE_KINDS[number]

export const CARD_STATUSES = ['forbidden', 'limited', 'semi_limited'] as const
export const BANLIST_SOURCES = ['tcg', 'ocg', 'goat', 'edison', 'classic-plus'] as const
export const FILTER_MATCHES = ['matching', 'not_matching'] as const

/**
 * Ids of the built-in formats (`server/utils/rule-formats.ts` seeds them).
 * Their names and descriptions are stored in English; the UI shows them in
 * the interface language by id (`useFormatLabel`, ADR 0014).
 */
export const BUILTIN_FORMAT_IDS = ['tcg-advanced', 'ocg', 'goat', 'edison', 'classic-plus', 'unlimited'] as const
export type BuiltinFormatId = typeof BUILTIN_FORMAT_IDS[number]

export function isBuiltinFormatId(id: string | null | undefined): id is BuiltinFormatId {
  return typeof id === 'string' && (BUILTIN_FORMAT_IDS as readonly string[]).includes(id)
}

// --- Card data + deck input ------------------------------------------------

export interface BanlistInfo {
  ban_tcg?: string
  ban_ocg?: string
  ban_goat?: string
  /** Not from YGOPRODeck: added from the Format Library's March 2010 list (ADR 0030). */
  ban_edison?: string
  /** Not from YGOPRODeck: added from the generated Classic Plus list (ADR 0022). */
  ban_classic_plus?: string
}

/** Where a banlist source's status sits in `BanlistInfo`. */
export function banlistInfoKey(source: BanlistSource): keyof BanlistInfo {
  return source === 'classic-plus' ? 'ban_classic_plus' : `ban_${source}`
}

/** Konami's lists (Edison's is the TCG list of March 2010); Classic Plus is a house list (ADR 0022). */
export function isOfficialBanlist(source: BanlistSource): boolean {
  return source !== 'classic-plus'
}

/** How the UI names a banlist source, e.g. "GOAT" or "Classic Plus". */
export function banlistSourceLabel(source: BanlistSource): string {
  if (source === 'classic-plus') {
    return 'Classic Plus'
  }
  return source === 'edison' ? 'Edison' : source.toUpperCase()
}

/** The catalog fields the engine needs; see `loadCardDataForValidation`. */
export interface ValidationCardData {
  id: number
  name: string
  /** Official German name (ADR 0015), display only: it goes into issue params as `cardNameDe`. */
  nameDe?: string | null
  type: string
  frameType?: string | null
  attribute?: string | null
  race?: string | null
  archetype?: string | null
  level?: number | null
  atk?: number | null
  def?: number | null
  banlistInfo?: BanlistInfo | null
  tcgDate?: string | null
  ocgDate?: string | null
  setIds?: string[]
}

export interface DeckCardEntry {
  catalogCardId: number
  section: DeckSection
  quantity: number
}

export type CardStatus = CardStatusName | 'unrestricted'

export type ValidationIssueCode =
  | 'deck_size_min'
  | 'deck_size_max'
  | 'card_forbidden'
  | 'card_limit_exceeded'
  | 'unknown_card_data'

/**
 * The values a validation issue or deck warning is phrased with. The UI
 * renders `validation.<code>` with them (`useValidationText`, ADR 0014).
 */
export interface ValidationIssueParams {
  section?: DeckSection
  /** Cards in `section`. */
  count?: number
  min?: number
  max?: number
  cardId?: number
  /** The card's English name (canonical; the assistant reads it). */
  cardName?: string
  /** The card's official German name (ADR 0015), when it has one — the UI shows it in German card language. */
  cardNameDe?: string
  /** Copies of the card across the deck. */
  copies?: number
  maxCopies?: number
}

export interface ValidationIssue {
  severity: 'error'
  code: ValidationIssueCode
  /**
   * Canonical English text. The assistant model reads it (`validate_deck`);
   * the UI renders `code` + `params` instead.
   */
  message: string
  params: ValidationIssueParams
  cardId?: number
  section?: DeckSection
}

export type DeckWarningCode =
  | 'main_below_min'
  | 'main_above_max'
  | 'extra_above_max'
  | 'side_above_max'
  | 'copies_above_max'
  | 'card_retired'

/**
 * A structural hint independent of any rule format (standard deck sizes and
 * copy limit, `server/utils/decks.ts`). Same shape as a `ValidationIssue`:
 * canonical English `message`, rendered by the UI from `code` + `params`.
 */
export interface DeckWarning {
  code: DeckWarningCode
  message: string
  params: ValidationIssueParams
  cardId?: number
}

/**
 * Why a card's copy limit is lower than the format's base limit. Rendered by
 * the client (`app/utils/rule-description.ts`), most specific first.
 */
export type CapReason =
  | { kind: 'format_rule', status: CardStatusName }
  | { kind: 'banlist', source: BanlistSource, raw: string }
  | { kind: 'filter', label?: string, rule: Extract<Rule, { kind: 'filter' }> }

export interface DeckValidationCard {
  maxCopies: number
  status: CardStatus
  /** The restrictions behind the limit, most specific first. */
  reasons: CapReason[]
}

export interface DeckValidation {
  legal: boolean
  issues: ValidationIssue[]
  /** Keyed by catalog card id, for every card in the deck with known data. */
  cards: Record<number, DeckValidationCard>
}

// --- Card predicates -------------------------------------------------------

/**
 * Whether a card "has an effect" for filter purposes.
 *
 * Spell, Trap, and Skill cards always count as having an effect — they are
 * nothing but effect text. For monsters the answer follows the card type:
 * every type containing "Normal" ("Normal Monster", "Normal Tuner Monster",
 * "Pendulum Normal Monster", ...) is vanilla, everything else has an effect.
 */
export function cardHasEffect(card: Pick<ValidationCardData, 'type'>): boolean {
  const type = card.type ?? ''
  if (/spell|trap|skill/i.test(type)) {
    return true
  }
  return !/normal/i.test(type)
}

/** The release date a filter compares against, or null when unknown. */
export function releaseDateFor(card: ValidationCardData, region: 'tcg' | 'ocg' = 'tcg'): string | null {
  const value = region === 'ocg' ? card.ocgDate : card.tcgDate
  return value && value.trim() !== '' ? value : null
}

function includesIgnoreCase(values: string[] | undefined, value: string | null | undefined): boolean {
  if (!values || values.length === 0) {
    return true
  }
  if (value === null || value === undefined) {
    return false
  }
  const needle = value.toLowerCase()
  return values.some(entry => entry.toLowerCase() === needle)
}

function withinRange(value: number | null | undefined, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) {
    return true
  }
  if (value === null || value === undefined) {
    return false
  }
  if (min !== undefined && value < min) {
    return false
  }
  if (max !== undefined && value > max) {
    return false
  }
  return true
}

/**
 * An ATK/DEF as a number, or null when the card has none or a "?" stat
 * (YGOPRODeck stores "?" as -1). A "?" is unknown, so it is inside no
 * range (#140) — the same conservative choice as an unknown release date.
 */
function knownStat(value: number | null | undefined): number | null {
  return value === null || value === undefined || value < 0 ? null : value
}

/**
 * Matches a card against a filter (AND across fields, OR inside array fields).
 *
 * A card *without* a release date for the selected region never matches
 * `releasedBefore`/`releasedAfter`. That is the conservative choice: a GOAT
 * style "only cards up to June 2005" rule (`not_matching releasedBefore → 0`)
 * therefore disallows cards whose release date is unknown instead of quietly
 * letting them through.
 *
 * A `?` ATK/DEF (stored as -1) is like a missing value: it never matches an
 * ATK/DEF range. So a `not_matching` rule on an ATK/DEF range applies to it
 * (e.g. "cards not matching ATK ≤ 1500 → forbidden" forbids Ten Thousand Dragon).
 */
export function matchesCardFilter(filter: CardFilter, card: ValidationCardData): boolean {
  if (!includesIgnoreCase(filter.types, card.type)) {
    return false
  }
  if (!includesIgnoreCase(filter.frameTypes, card.frameType)) {
    return false
  }
  if (!includesIgnoreCase(filter.attributes, card.attribute)) {
    return false
  }
  if (!includesIgnoreCase(filter.races, card.race)) {
    return false
  }
  if (!includesIgnoreCase(filter.archetypes, card.archetype)) {
    return false
  }

  if (filter.setIds && filter.setIds.length > 0) {
    const setIds = card.setIds ?? []
    if (!filter.setIds.some(setId => setIds.includes(setId))) {
      return false
    }
  }

  if (filter.cardIds && filter.cardIds.length > 0 && !filter.cardIds.includes(card.id)) {
    return false
  }

  if (!withinRange(card.level, filter.levelMin, filter.levelMax)) {
    return false
  }
  if (!withinRange(knownStat(card.atk), filter.atkMin, filter.atkMax)) {
    return false
  }
  if (!withinRange(knownStat(card.def), filter.defMin, filter.defMax)) {
    return false
  }

  if (filter.hasEffect !== undefined && cardHasEffect(card) !== filter.hasEffect) {
    return false
  }

  if (filter.releasedBefore !== undefined || filter.releasedAfter !== undefined) {
    const released = releaseDateFor(card, filter.region ?? 'tcg')
    if (released === null) {
      return false
    }
    if (filter.releasedBefore !== undefined && !(released < filter.releasedBefore)) {
      return false
    }
    if (filter.releasedAfter !== undefined && !(released > filter.releasedAfter)) {
      return false
    }
  }

  if (filter.nameContains !== undefined && filter.nameContains !== '') {
    if (!card.name.toLowerCase().includes(filter.nameContains.toLowerCase())) {
      return false
    }
  }

  return true
}

/** Maps a YGOPRODeck banlist value ("Forbidden"/"Limited"/"Semi-Limited") to a copy cap. */
export function banlistCopies(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const normalized = value.trim().toLowerCase().replaceAll(' ', '').replaceAll('_', '').replaceAll('-', '')
  if (normalized === 'forbidden' || normalized === 'banned') {
    return 0
  }
  if (normalized === 'limited') {
    return 1
  }
  if (normalized === 'semilimited') {
    return 2
  }
  return null
}

export function statusForMaxCopies(maxCopies: number): CardStatus {
  if (maxCopies <= 0) {
    return 'forbidden'
  }
  if (maxCopies === 1) {
    return 'limited'
  }
  if (maxCopies === 2) {
    return 'semi_limited'
  }
  return 'unrestricted'
}

const STATUS_COPIES: Record<CardStatusName, number> = {
  forbidden: 0,
  limited: 1,
  semi_limited: 2,
}

export interface DescribeOptions {
  /** Catalog card names by id, for `card_status` rules and `cardIds` filters. */
  cardNames?: Record<number | string, string>
  /** Set names by set id, for `setIds` filters. */
  setNames?: Record<string, string>
}

// --- Evaluation ------------------------------------------------------------

/** `{ cardNameDe }` for an issue's params when the card has a German name, else nothing. */
export function germanName(nameDe: string | null | undefined): { cardNameDe?: string } {
  return nameDe ? { cardNameDe: nameDe } : {}
}

function toCardMap(
  cardData: Iterable<ValidationCardData> | Map<number, ValidationCardData>,
): Map<number, ValidationCardData> {
  if (cardData instanceof Map) {
    return cardData
  }
  const map = new Map<number, ValidationCardData>()
  for (const card of cardData) {
    map.set(card.id, card)
  }
  return map
}

interface CapCandidate {
  maxCopies: number
  reason: CapReason
}

function capsForCard(rules: Rule[], card: ValidationCardData): CapCandidate[] {
  const caps: CapCandidate[] = []

  for (const rule of rules) {
    if (rule.kind === 'card_status') {
      if (rule.cardIds.includes(card.id)) {
        caps.push({
          maxCopies: STATUS_COPIES[rule.status],
          reason: { kind: 'format_rule', status: rule.status },
        })
      }
      continue
    }

    if (rule.kind === 'banlist') {
      const raw = card.banlistInfo?.[banlistInfoKey(rule.source)]
      const maxCopies = banlistCopies(raw)
      if (raw && maxCopies !== null) {
        caps.push({
          maxCopies,
          reason: { kind: 'banlist', source: rule.source, raw },
        })
      }
      continue
    }

    if (rule.kind === 'filter') {
      const matches = matchesCardFilter(rule.filter, card)
      const applies = rule.match === 'matching' ? matches : !matches
      if (applies) {
        caps.push({
          maxCopies: rule.maxCopies,
          reason: rule.label ? { kind: 'filter', label: rule.label, rule } : { kind: 'filter', rule },
        })
      }
    }
  }

  return caps
}

// English section names for the canonical (model-facing) issue messages only;
// the UI renders `decks.section.<section>`.
const SECTION_NAMES: Record<DeckSection, string> = {
  main: 'Main Deck',
  extra: 'Extra Deck',
  side: 'Side Deck',
}

function cardCount(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`
}

function deckSizeIssues(rules: Rule[], counts: Record<DeckSection, number>): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const rule of rules) {
    if (rule.kind !== 'deck_size') {
      continue
    }
    const count = counts[rule.section]
    const label = SECTION_NAMES[rule.section]

    if (rule.min !== undefined && count < rule.min) {
      issues.push({
        severity: 'error',
        code: 'deck_size_min',
        section: rule.section,
        params: { section: rule.section, count, min: rule.min },
        message: `The ${label} has ${cardCount(count)}; at least ${rule.min} are required.`,
      })
    }
    if (rule.max !== undefined && count > rule.max) {
      issues.push({
        severity: 'error',
        code: 'deck_size_max',
        section: rule.section,
        params: { section: rule.section, count, max: rule.max },
        message: `The ${label} has ${cardCount(count)}; at most ${rule.max} are allowed.`,
      })
    }
  }

  return issues
}

/**
 * Validates a deck against a rule set. Pure: everything it needs is passed in.
 *
 * Copies are counted across main + extra + side (one physical playset), and
 * the effective cap per card is the *minimum* of the base `copies` rule
 * (default 3), any explicit `card_status`, the selected banlist, and every
 * applicable `filter` rule. A card the caller passed no data for produces an
 * `unknown_card_data` issue and is left out of `cards`.
 */
export function evaluateDeck(
  ruleSet: RuleSet | Rule[],
  deckCards: DeckCardEntry[],
  cardData: Iterable<ValidationCardData> | Map<number, ValidationCardData>,
): DeckValidation {
  const rules = Array.isArray(ruleSet) ? ruleSet : (ruleSet?.rules ?? [])
  const byId = toCardMap(cardData)

  const counts: Record<DeckSection, number> = { main: 0, extra: 0, side: 0 }
  const copiesByCard = new Map<number, number>()

  for (const entry of deckCards) {
    if ((DECK_SECTIONS as readonly string[]).includes(entry.section)) {
      counts[entry.section] += entry.quantity
    }
    copiesByCard.set(entry.catalogCardId, (copiesByCard.get(entry.catalogCardId) ?? 0) + entry.quantity)
  }

  const copiesRules = rules.filter((rule): rule is Extract<Rule, { kind: 'copies' }> => rule.kind === 'copies')
  const baseCopies = copiesRules.length > 0
    ? Math.min(...copiesRules.map(rule => rule.maxCopies))
    : DEFAULT_MAX_COPIES

  const issues = deckSizeIssues(rules, counts)
  const cardIssues: ValidationIssue[] = []
  const cards: Record<number, DeckValidationCard> = {}

  for (const [cardId, copies] of copiesByCard) {
    const card = byId.get(cardId)
    if (!card) {
      cardIssues.push({
        severity: 'error',
        code: 'unknown_card_data',
        cardId,
        params: { cardId },
        message: `Card data is missing for a card in the deck (ID ${cardId}).`,
      })
      continue
    }

    const caps = capsForCard(rules, card)
    const maxCopies = caps.reduce((lowest, cap) => Math.min(lowest, cap.maxCopies), baseCopies)
    const reasons = caps.filter(cap => cap.maxCopies < baseCopies).map(cap => cap.reason)

    cards[cardId] = { maxCopies, status: statusForMaxCopies(maxCopies), reasons }

    if (maxCopies <= 0) {
      cardIssues.push({
        severity: 'error',
        code: 'card_forbidden',
        cardId,
        params: { cardId, cardName: card.name, ...germanName(card.nameDe) },
        message: `${card.name} is forbidden in this format.`,
      })
    }
    else if (copies > maxCopies) {
      cardIssues.push({
        severity: 'error',
        code: 'card_limit_exceeded',
        cardId,
        params: { cardId, cardName: card.name, ...germanName(card.nameDe), copies, maxCopies },
        message: `${card.name}: ${copies} copies in the deck; ${maxCopies === 1 ? '1 copy is' : `${maxCopies} copies are`} allowed.`,
      })
    }
  }

  // By card name (issues about unknown card data last), independent of the
  // language the issues are rendered in.
  cardIssues.sort((a, b) => {
    const nameA = a.params.cardName
    const nameB = b.params.cardName
    if (nameA === undefined || nameB === undefined) {
      return nameA === nameB ? (a.cardId ?? 0) - (b.cardId ?? 0) : nameA === undefined ? 1 : -1
    }
    return nameA.localeCompare(nameB, 'de')
  })

  return {
    legal: issues.length === 0 && cardIssues.length === 0,
    issues: [...issues, ...cardIssues],
    cards,
  }
}

// --- Rule set validation ---------------------------------------------------

/**
 * Thrown by `validateRuleSet` for a malformed rule set. Deliberately a plain
 * Error subclass (no h3 dependency) — the server maps it to a 400.
 */
export class RuleSetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleSetValidationError'
  }
}

function fail(message: string): never {
  throw new RuleSetValidationError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) {
    fail(`${field} must be an integer between ${min} and ${max}`)
  }
  return numberValue
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    fail(`${field} must be an array of strings`)
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      fail(`${field} must be an array of strings`)
    }
    const trimmed = entry.trim()
    if (trimmed === '') {
      continue
    }
    if (trimmed.length > 100) {
      fail(`${field} entries must be at most 100 characters`)
    }
    if (!entries.includes(trimmed)) {
      entries.push(trimmed)
    }
  }
  if (entries.length > MAX_FILTER_ENTRIES) {
    fail(`${field} must have at most ${MAX_FILTER_ENTRIES} entries`)
  }
  return entries.length > 0 ? entries : undefined
}

function optionalCardIdList(value: unknown, field: string): number[] | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    fail(`${field} must be an array of card ids`)
  }
  const entries: number[] = []
  for (const entry of value) {
    const numberValue = typeof entry === 'number' ? entry : Number(entry)
    if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
      fail(`${field} must contain positive integer card ids`)
    }
    if (!entries.includes(numberValue)) {
      entries.push(numberValue)
    }
  }
  if (entries.length > MAX_FILTER_ENTRIES) {
    fail(`${field} must have at most ${MAX_FILTER_ENTRIES} entries`)
  }
  return entries.length > 0 ? entries : undefined
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function optionalIsoDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    fail(`${field} must be an ISO date (YYYY-MM-DD)`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${field} must be a valid calendar date`)
  }
  return value
}

function validateCardFilter(input: unknown): CardFilter {
  if (!isRecord(input)) {
    fail('filter must be an object')
  }

  const filter: CardFilter = {}

  const types = optionalStringList(input.types, 'filter.types')
  if (types) {
    filter.types = types
  }
  const frameTypes = optionalStringList(input.frameTypes ?? input.frame_types, 'filter.frameTypes')
  if (frameTypes) {
    filter.frameTypes = frameTypes
  }
  const attributes = optionalStringList(input.attributes, 'filter.attributes')
  if (attributes) {
    filter.attributes = attributes
  }
  const races = optionalStringList(input.races, 'filter.races')
  if (races) {
    filter.races = races
  }
  const archetypes = optionalStringList(input.archetypes, 'filter.archetypes')
  if (archetypes) {
    filter.archetypes = archetypes
  }
  const setIds = optionalStringList(input.setIds ?? input.set_ids, 'filter.setIds')
  if (setIds) {
    filter.setIds = setIds
  }
  const cardIds = optionalCardIdList(input.cardIds ?? input.card_ids, 'filter.cardIds')
  if (cardIds) {
    filter.cardIds = cardIds
  }

  const ranges = [
    ['levelMin', 'levelMax', 0, 13] as const,
    ['atkMin', 'atkMax', 0, 100_000] as const,
    ['defMin', 'defMax', 0, 100_000] as const,
  ]
  for (const [minKey, maxKey, lower, upper] of ranges) {
    const min = optionalInteger(input[minKey], `filter.${minKey}`, lower, upper)
    const max = optionalInteger(input[maxKey], `filter.${maxKey}`, lower, upper)
    if (min !== undefined && max !== undefined && min > max) {
      fail(`filter.${minKey} must not be greater than filter.${maxKey}`)
    }
    if (min !== undefined) {
      filter[minKey] = min
    }
    if (max !== undefined) {
      filter[maxKey] = max
    }
  }

  if (input.hasEffect !== undefined && input.hasEffect !== null) {
    if (typeof input.hasEffect !== 'boolean') {
      fail('filter.hasEffect must be a boolean')
    }
    filter.hasEffect = input.hasEffect
  }

  const releasedBefore = optionalIsoDate(input.releasedBefore ?? input.released_before, 'filter.releasedBefore')
  if (releasedBefore) {
    filter.releasedBefore = releasedBefore
  }
  const releasedAfter = optionalIsoDate(input.releasedAfter ?? input.released_after, 'filter.releasedAfter')
  if (releasedAfter) {
    filter.releasedAfter = releasedAfter
  }

  if (input.region !== undefined && input.region !== null && input.region !== '') {
    if (input.region !== 'tcg' && input.region !== 'ocg') {
      fail('filter.region must be "tcg" or "ocg"')
    }
    filter.region = input.region
  }

  if (input.nameContains !== undefined && input.nameContains !== null && input.nameContains !== '') {
    if (typeof input.nameContains !== 'string') {
      fail('filter.nameContains must be a string')
    }
    const trimmed = input.nameContains.trim()
    if (trimmed.length > 100) {
      fail('filter.nameContains must be at most 100 characters')
    }
    if (trimmed !== '') {
      filter.nameContains = trimmed
    }
  }

  return filter
}

function validateRule(input: unknown, index: number): Rule {
  if (!isRecord(input)) {
    fail(`rules[${index}] must be an object`)
  }

  const kind = input.kind
  if (typeof kind !== 'string' || !(RULE_KINDS as readonly string[]).includes(kind)) {
    fail(`rules[${index}].kind must be one of ${RULE_KINDS.join(', ')}`)
  }

  switch (kind as RuleKind) {
    case 'deck_size': {
      const section = input.section
      if (typeof section !== 'string' || !(DECK_SECTIONS as readonly string[]).includes(section)) {
        fail(`rules[${index}].section must be one of ${DECK_SECTIONS.join(', ')}`)
      }
      const min = optionalInteger(input.min, `rules[${index}].min`, 0, 999)
      const max = optionalInteger(input.max, `rules[${index}].max`, 0, 999)
      if (min === undefined && max === undefined) {
        fail(`rules[${index}] needs at least a min or a max`)
      }
      if (min !== undefined && max !== undefined && min > max) {
        fail(`rules[${index}].min must not be greater than rules[${index}].max`)
      }
      const rule: Rule = { kind: 'deck_size', section: section as DeckSection }
      if (min !== undefined) {
        rule.min = min
      }
      if (max !== undefined) {
        rule.max = max
      }
      return rule
    }
    case 'copies': {
      const maxCopies = optionalInteger(input.maxCopies ?? input.max_copies, `rules[${index}].maxCopies`, 1, MAX_COPIES_RULE)
      if (maxCopies === undefined) {
        fail(`rules[${index}].maxCopies is required`)
      }
      return { kind: 'copies', maxCopies }
    }
    case 'card_status': {
      const status = input.status
      if (typeof status !== 'string' || !(CARD_STATUSES as readonly string[]).includes(status)) {
        fail(`rules[${index}].status must be one of ${CARD_STATUSES.join(', ')}`)
      }
      const cardIds = optionalCardIdList(input.cardIds ?? input.card_ids, `rules[${index}].cardIds`)
      if (!cardIds) {
        fail(`rules[${index}].cardIds must contain at least one card`)
      }
      return { kind: 'card_status', status: status as CardStatusName, cardIds }
    }
    case 'banlist': {
      const source = input.source
      if (typeof source !== 'string' || !(BANLIST_SOURCES as readonly string[]).includes(source)) {
        fail(`rules[${index}].source must be one of ${BANLIST_SOURCES.join(', ')}`)
      }
      return { kind: 'banlist', source: source as BanlistSource }
    }
    case 'filter': {
      const match = input.match
      if (typeof match !== 'string' || !(FILTER_MATCHES as readonly string[]).includes(match)) {
        fail(`rules[${index}].match must be one of ${FILTER_MATCHES.join(', ')}`)
      }
      const maxCopies = optionalInteger(input.maxCopies ?? input.max_copies, `rules[${index}].maxCopies`, 0, 3)
      if (maxCopies === undefined) {
        fail(`rules[${index}].maxCopies is required`)
      }
      const rule: Rule = {
        kind: 'filter',
        match: match as FilterMatch,
        filter: validateCardFilter(input.filter ?? {}),
        maxCopies: maxCopies as FilterMaxCopies,
      }
      if (input.label !== undefined && input.label !== null && input.label !== '') {
        if (typeof input.label !== 'string') {
          fail(`rules[${index}].label must be a string`)
        }
        const label = input.label.trim()
        if (label.length > RULE_FORMAT_NAME_MAX_LENGTH) {
          fail(`rules[${index}].label must be at most ${RULE_FORMAT_NAME_MAX_LENGTH} characters`)
        }
        if (label !== '') {
          rule.label = label
        }
      }
      return rule
    }
  }
}

/**
 * Strictly validates and normalizes a rule set coming from a request body.
 * Unknown keys are dropped, lists deduped, and everything is bounded, so a
 * stored `rule_format.rules` blob is always a valid `RuleSet`.
 */
export function validateRuleSet(input: unknown): RuleSet {
  const raw = Array.isArray(input) ? { rules: input } : input
  if (!isRecord(raw)) {
    fail('rules must be an object with a rules array')
  }

  const rules = raw.rules
  if (!Array.isArray(rules)) {
    fail('rules must be an array')
  }
  if (rules.length > MAX_RULES_PER_FORMAT) {
    fail(`a format may have at most ${MAX_RULES_PER_FORMAT} rules`)
  }

  return { rules: rules.map((rule, index) => validateRule(rule, index)) }
}

/** Every card id explicitly referenced by `card_status` rules. */
export function referencedCardIds(ruleSet: RuleSet): number[] {
  const ids = new Set<number>()
  for (const rule of ruleSet.rules) {
    if (rule.kind === 'card_status') {
      for (const id of rule.cardIds) {
        ids.add(id)
      }
    }
    if (rule.kind === 'filter' && rule.filter.cardIds) {
      for (const id of rule.filter.cardIds) {
        ids.add(id)
      }
    }
  }
  return [...ids]
}
