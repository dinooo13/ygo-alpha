// Rule format persistence: built-in (global) formats plus a user's own
// formats, both stored in `rule_format` with the rules as a JSON `RuleSet`.
// See docs/adr/0005-rule-format-model.md.

import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { createError } from 'h3'
import type { useDb } from '../db'
import { ruleFormat } from '../db/schema'
import {
  referencedCardIds,
  RULE_FORMAT_DESCRIPTION_MAX_LENGTH,
  RULE_FORMAT_NAME_MAX_LENGTH,
  RuleSetValidationError,
  validateRuleSet,
} from '../../shared/rule-formats'
import type { BuiltinFormatId, RuleSet } from '../../shared/rule-formats'
import { CLASSIC_PLUS_FORBIDDEN_TYPES } from '../../shared/classic-plus'
import { loadCardNameRecords, missingCatalogCardIds } from './deck-validation'

type Db = ReturnType<typeof useDb>

export { RULE_FORMAT_DESCRIPTION_MAX_LENGTH, RULE_FORMAT_NAME_MAX_LENGTH }

export interface RuleFormatInput {
  name: string
  description: string | null
  rules: RuleSet
}

export interface RuleFormatListItem {
  id: string
  name: string
  description: string | null
  isBuiltin: boolean
  ruleCount: number
  updatedAt: Date
}

export interface RuleFormatDetail {
  id: string
  name: string
  description: string | null
  isBuiltin: boolean
  rules: RuleSet
  /** Names of every catalog card the rules reference, for the editor UI. */
  cardNames: Record<number, string>
  /** Their German names (ADR 0015), for the cards that have one. */
  cardNamesDe: Record<number, string>
  createdAt: Date
  updatedAt: Date
}

// --- Built-in formats ------------------------------------------------------

/** Deck sizes every "normal" format shares (40–60 main, 15 extra, 15 side). */
const STANDARD_DECK_SIZES: RuleSet['rules'] = [
  { kind: 'deck_size', section: 'main', min: 40, max: 60 },
  { kind: 'deck_size', section: 'extra', max: 15 },
  { kind: 'deck_size', section: 'side', max: 15 },
]

export interface BuiltinFormatDefinition {
  id: BuiltinFormatId
  name: string
  description: string
  rules: RuleSet
}

/**
 * Globally available formats (`user_id IS NULL`, `is_builtin = 1`). They are
 * read-only for everyone and re-seeded on every boot, so rule improvements
 * ship with a deploy instead of needing a data migration.
 *
 * Names, descriptions and rule labels are canonical English (the assistant
 * model reads them); the UI shows them in the interface language by id
 * (`formats.builtin.<id>.*`, ADR 0014).
 */
export const BUILTIN_FORMATS: BuiltinFormatDefinition[] = [
  {
    id: 'tcg-advanced',
    name: 'TCG Advanced',
    description: 'Official TCG tournament format: standard deck sizes, at most 3 copies per card and the current TCG Forbidden & Limited List.',
    rules: {
      rules: [
        ...STANDARD_DECK_SIZES,
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'tcg' },
      ],
    },
  },
  {
    id: 'ocg',
    name: 'OCG',
    description: 'Japanese tournament format: standard deck sizes, at most 3 copies per card and the OCG Forbidden & Limited List.',
    rules: {
      rules: [
        ...STANDARD_DECK_SIZES,
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'ocg' },
      ],
    },
  },
  {
    id: 'goat',
    name: 'GOAT Format',
    description: 'Retro format as of April 2005: only cards released in the TCG up to June 2005, plus the GOAT banlist.',
    rules: {
      rules: [
        ...STANDARD_DECK_SIZES,
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'goat' },
        {
          kind: 'filter',
          match: 'not_matching',
          filter: { releasedBefore: '2005-07-01', region: 'tcg' },
          maxCopies: 0,
          label: 'Only cards up to June 2005',
        },
      ],
    },
  },
  {
    id: 'edison',
    name: 'Edison',
    description: 'Retro format as of April 2010 (SJC Edison): only TCG cards released up to Duelist Pack: Kaiba (The Shining Darkness is not legal), plus the TCG Forbidden & Limited List of March 2010. The later Hidden Arsenal reprints of older cards are not modeled.',
    rules: {
      rules: [
        ...STANDARD_DECK_SIZES,
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'edison' },
        {
          kind: 'filter',
          match: 'not_matching',
          // `releasedBefore` is strict: a card first released in the TCG on
          // 2010-04-24 (SJC Edison) or earlier is before the 25th.
          filter: { releasedBefore: '2010-04-25', region: 'tcg' },
          maxCopies: 0,
          // Canonical English; the UI shows formats.builtin.edison.cutoffLabel.
          label: 'Only cards up to Duelist Pack: Kaiba (April 2010)',
        },
      ],
    },
  },
  {
    id: 'classic-plus',
    name: 'Classic Plus',
    description: 'House format on the 2005 field (no Extra Monster Zones or Pendulum Zones, one shared Field Zone; the first player does not draw): Main Deck 40–50, Extra Deck up to 10, no Side Deck. No Synchro, Xyz, Pendulum or Link; floodgates, hand traps, draw, burn, revival, mass removal, protection and negation are forbidden or limited by the Classic Plus rules. Everything else is playable at 3.',
    // Rule 1 is a card-type filter; rules 2–11 are the generated Classic Plus
    // banlist (ADR 0022). The board rules are only in the description.
    rules: {
      rules: [
        { kind: 'deck_size', section: 'main', min: 40, max: 50 },
        { kind: 'deck_size', section: 'extra', max: 10 },
        { kind: 'deck_size', section: 'side', max: 0 },
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'classic-plus' },
        {
          kind: 'filter',
          match: 'matching',
          filter: { types: [...CLASSIC_PLUS_FORBIDDEN_TYPES] },
          maxCopies: 0,
          // Canonical English; the UI shows formats.builtin.classic-plus.cutoffLabel.
          label: 'Rule 1: Synchro, Xyz, Pendulum and Link monsters',
        },
      ],
    },
  },
  {
    id: 'unlimited',
    name: 'No banlist',
    description: 'Standard deck sizes and at most 3 copies per card, but no Forbidden & Limited List at all.',
    rules: {
      rules: [
        ...STANDARD_DECK_SIZES,
        { kind: 'copies', maxCopies: 3 },
      ],
    },
  },
]

/**
 * Upserts the built-in formats. Idempotent and called from the migrate plugin
 * on every boot: `name`, `description`, and `rules` are refreshed, while
 * `created_at` and any deck references stay untouched.
 */
export function seedBuiltinFormats(db: Db) {
  const now = new Date()

  db.transaction((tx) => {
    for (const format of BUILTIN_FORMATS) {
      tx.insert(ruleFormat)
        .values({
          id: format.id,
          userId: null,
          name: format.name,
          description: format.description,
          rules: format.rules,
          isBuiltin: true,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: ruleFormat.id,
          set: {
            userId: null,
            name: format.name,
            description: format.description,
            rules: format.rules,
            isBuiltin: true,
            updatedAt: now,
          },
        })
        .run()
    }
  })
}

// --- Errors ----------------------------------------------------------------

function badRequest(message: string, code?: string): never {
  throw createError({ statusCode: 400, statusMessage: message, data: code ? { code } : undefined })
}

function notFound(message = 'Format not found'): never {
  throw createError({ statusCode: 404, statusMessage: message, data: { code: 'format_not_found' } })
}

function forbidden(message: string, code: string): never {
  throw createError({ statusCode: 403, statusMessage: message, data: { code } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// --- Input validation ------------------------------------------------------

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    badRequest('name is required')
  }
  const name = value.trim()
  if (name === '') {
    badRequest('name is required')
  }
  if (name.length > RULE_FORMAT_NAME_MAX_LENGTH) {
    badRequest(`name must be at most ${RULE_FORMAT_NAME_MAX_LENGTH} characters`)
  }
  return name
}

function normalizeDescription(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    badRequest('description must be a string')
  }
  const trimmed = value.trim()
  if (trimmed.length > RULE_FORMAT_DESCRIPTION_MAX_LENGTH) {
    badRequest(`description must be at most ${RULE_FORMAT_DESCRIPTION_MAX_LENGTH} characters`)
  }
  return trimmed === '' ? null : trimmed
}

/** Runs the pure rule validator and maps its error to a 400. */
export function normalizeRuleSet(value: unknown): RuleSet {
  try {
    return validateRuleSet(value)
  }
  catch (error) {
    if (error instanceof RuleSetValidationError) {
      badRequest(error.message, 'invalid_rules')
    }
    throw error
  }
}

/**
 * Rejects `card_status`/`cardIds` rules that point at cards the catalog does
 * not know — a rule referencing a typo'd passcode would silently never apply.
 */
export function assertRuleCardsExist(db: Db, rules: RuleSet) {
  const missing = missingCatalogCardIds(db, referencedCardIds(rules))
  if (missing.length > 0) {
    badRequest(`unknown catalog card ids in rules: ${missing.join(', ')}`)
  }
}

export function validateRuleFormatInput(body: unknown): RuleFormatInput {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  return {
    name: normalizeName(body.name),
    description: normalizeDescription(body.description),
    rules: normalizeRuleSet(body.rules ?? { rules: [] }),
  }
}

export function validateRuleFormatUpdateInput(body: unknown): Partial<RuleFormatInput> {
  if (!isRecord(body)) {
    badRequest('Request body must be an object')
  }

  const input: Partial<RuleFormatInput> = {}
  if (body.name !== undefined) {
    input.name = normalizeName(body.name)
  }
  if (body.description !== undefined) {
    input.description = normalizeDescription(body.description)
  }
  if (body.rules !== undefined) {
    input.rules = normalizeRuleSet(body.rules)
  }

  return input
}

// --- Reads -----------------------------------------------------------------

/** Built-in formats plus the caller's own — anything else is invisible. */
function accessibleClause(userId: string): SQL {
  return or(eq(ruleFormat.isBuiltin, true), eq(ruleFormat.userId, userId)) as SQL
}

export function listRuleFormats(db: Db, userId: string): { items: RuleFormatListItem[] } {
  const rows = db
    .select()
    .from(ruleFormat)
    .where(accessibleClause(userId))
    // Built-ins first, then the user's own formats alphabetically.
    .orderBy(desc(ruleFormat.isBuiltin), asc(ruleFormat.name))
    .all()

  return {
    items: rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isBuiltin: row.isBuiltin,
      ruleCount: row.rules?.rules?.length ?? 0,
      updatedAt: row.updatedAt,
    })),
  }
}

/**
 * A format the caller may read: a built-in or one of their own. Another
 * user's format is reported as missing (same ownership boundary as decks).
 */
export function requireAccessibleFormat(db: Db, userId: string, formatId: string) {
  const row = db
    .select()
    .from(ruleFormat)
    .where(and(eq(ruleFormat.id, formatId), accessibleClause(userId)))
    .get()

  if (!row) {
    notFound()
  }

  return row
}

function requireOwnFormat(db: Db, userId: string, formatId: string) {
  const row = requireAccessibleFormat(db, userId, formatId)

  if (row.isBuiltin || row.userId === null) {
    forbidden('Built-in formats are read-only. Clone the format to change its rules.', 'format_readonly')
  }
  if (row.userId !== userId) {
    notFound()
  }

  return row
}

function toDetail(db: Db, row: typeof ruleFormat.$inferSelect): RuleFormatDetail {
  const rules: RuleSet = row.rules ?? { rules: [] }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isBuiltin: row.isBuiltin,
    rules,
    ...loadCardNameRecords(db, referencedCardIds(rules)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function getRuleFormat(db: Db, userId: string, formatId: string): RuleFormatDetail {
  return toDetail(db, requireAccessibleFormat(db, userId, formatId))
}

// --- Writes ----------------------------------------------------------------

export function createRuleFormat(db: Db, userId: string, input: RuleFormatInput): RuleFormatDetail {
  assertRuleCardsExist(db, input.rules)

  const now = new Date()
  const [created] = db
    .insert(ruleFormat)
    .values({
      id: randomUUID(),
      userId,
      name: input.name,
      description: input.description,
      rules: input.rules,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()

  return toDetail(db, created!)
}

export function updateRuleFormat(
  db: Db,
  userId: string,
  formatId: string,
  patch: Partial<RuleFormatInput>,
): RuleFormatDetail {
  const current = requireOwnFormat(db, userId, formatId)

  if (patch.name === undefined && patch.description === undefined && patch.rules === undefined) {
    return toDetail(db, current)
  }
  if (patch.rules) {
    assertRuleCardsExist(db, patch.rules)
  }

  const [updated] = db
    .update(ruleFormat)
    .set({
      name: patch.name ?? current.name,
      description: patch.description !== undefined ? patch.description : current.description,
      rules: patch.rules ?? current.rules,
      updatedAt: new Date(),
    })
    .where(eq(ruleFormat.id, formatId))
    .returning()
    .all()

  return toDetail(db, updated!)
}

export function deleteRuleFormat(db: Db, userId: string, formatId: string) {
  requireOwnFormat(db, userId, formatId)

  // Decks referencing the format keep existing; `deck.format_id` is reset to
  // NULL by the FK (ON DELETE SET NULL).
  db.delete(ruleFormat).where(and(eq(ruleFormat.id, formatId), eq(ruleFormat.userId, userId))).run()
}

/**
 * The fallback name of a clone without a name from the UI: an English
 * `<name> (copy)` (ADR 0014: server text is technical English). Truncates the
 * base name (not the suffix) so the copy stays within 80 chars.
 */
export function cloneNameFor(name: string): string {
  const suffix = ' (copy)'
  return `${name.slice(0, RULE_FORMAT_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`
}

/**
 * Clones a format. `overrides` (the optional body of
 * `POST /api/formats/:id/clone`) lets the UI name the copy in the interface
 * language and, for a built-in, carry over its translated description and
 * rule labels (ADR 0014); without them the copy keeps the source's text.
 */
export function cloneRuleFormat(
  db: Db,
  userId: string,
  formatId: string,
  overrides: Partial<RuleFormatInput> = {},
): RuleFormatDetail {
  const source = requireAccessibleFormat(db, userId, formatId)
  if (overrides.rules) {
    assertRuleCardsExist(db, overrides.rules)
  }
  const now = new Date()

  const [copy] = db
    .insert(ruleFormat)
    .values({
      id: randomUUID(),
      userId,
      name: overrides.name ?? cloneNameFor(source.name),
      description: overrides.description !== undefined ? overrides.description : source.description,
      rules: overrides.rules ?? source.rules ?? { rules: [] },
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()

  return toDetail(db, copy!)
}

/**
 * Resolves a `formatId` a deck may be assigned to. Unlike reads this answers
 * with a 400: the id is part of a deck write, not the addressed resource.
 */
export function requireAssignableFormat(db: Db, userId: string, formatId: string) {
  const row = db
    .select({ id: ruleFormat.id, name: ruleFormat.name, isBuiltin: ruleFormat.isBuiltin })
    .from(ruleFormat)
    .where(and(
      eq(ruleFormat.id, formatId),
      or(eq(ruleFormat.isBuiltin, true), eq(ruleFormat.userId, userId)),
    ))
    .get()

  if (!row) {
    badRequest('format_id does not exist')
  }

  return row
}

/** Formats visible to the caller, by id — used when validating a deck list. */
export function ruleFormatsById(db: Db, userId: string, formatIds: string[]) {
  const unique = [...new Set(formatIds)]
  const byId = new Map<string, typeof ruleFormat.$inferSelect>()
  if (unique.length === 0) {
    return byId
  }

  const rows = db
    .select()
    .from(ruleFormat)
    .where(and(inArray(ruleFormat.id, unique), accessibleClause(userId)))
    .all()

  for (const row of rows) {
    byId.set(row.id, row)
  }

  return byId
}
