import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { catalogCard } from '../db/schema'
import { CARD_FRAMES, CARD_FRAME_TYPE_KEYWORDS } from '../../shared/card-frame'
import { isCardKind } from '../../shared/card-kind'
import type { CardKind } from '../../shared/card-kind'

// The SQL twin of `cardFrame()` (shared/card-frame.ts), so the "Kartenart"
// filter groups cards exactly like the frame stripe does: YGOPRODeck's
// `frame_type` when it is a known frame ("effect_pendulum" = effect +
// pendulum), else the keywords of the English type line. `tests/nuxt/
// card-kind-filter.test.ts` checks both against each other.

const PENDULUM_SUFFIX = '_pendulum'

const frameType = sql`lower(trim(coalesce(${catalogCard.frameType}, '')))`
const typeLine = sql`lower(trim(coalesce(${catalogCard.type}, '')))`
const hasPendulumSuffix = sql`substr(${frameType}, -${sql.raw(String(PENDULUM_SUFFIX.length))}) = ${PENDULUM_SUFFIX}`
const baseFrameType = sql`(case when ${hasPendulumSuffix} then substr(${frameType}, 1, length(${frameType}) - ${sql.raw(String(PENDULUM_SUFFIX.length))}) else ${frameType} end)`
const hasKnownFrame = sql`${baseFrameType} in (${sql.join(CARD_FRAMES.map(frame => sql`${frame}`), sql`, `)})`

// The first keyword in `CARD_FRAME_TYPE_KEYWORDS` order that the type line
// contains; any other monster is an Effect monster; no type line, no frame.
const frameFromTypeLine = sql`(case when ${typeLine} = '' then null ${sql.join(
  CARD_FRAME_TYPE_KEYWORDS.map(([keyword, frame]) => sql`when ${typeLine} like ${`%${keyword}%`} then ${frame}`),
  sql` `,
)} else 'effect' end)`

const frame = sql`(case when ${hasKnownFrame} then ${baseFrameType} else ${frameFromTypeLine} end)`
const isPendulum = sql`(case when ${hasKnownFrame} then ${hasPendulumSuffix} else ${typeLine} like '%pendulum%' end)`

/**
 * The WHERE clause of a "Kartenart" filter: the card has any of `kinds`.
 * Unknown keys are ignored; no usable kind means no clause. The outer query
 * must join `catalog_card` unaliased.
 */
export function cardKindClause(kinds: readonly string[]): SQL | undefined {
  const valid = [...new Set(kinds.filter(isCardKind))] as CardKind[]
  const frames = valid.filter(kind => kind !== 'pendulum')
  const clauses: SQL[] = []
  if (frames.length > 0) {
    clauses.push(sql`${frame} in (${sql.join(frames.map(kind => sql`${kind}`), sql`, `)})`)
  }
  if (valid.includes('pendulum')) {
    clauses.push(sql`${isPendulum}`)
  }
  if (clauses.length === 0) {
    return undefined
  }
  return clauses.length === 1 ? clauses[0] : sql`(${sql.join(clauses, sql` or `)})`
}

/** The valid kinds of a raw query value list (CSV already split), in first-seen order. */
export function parseCardKinds(values: readonly string[]): CardKind[] {
  return [...new Set(values.filter(isCardKind))] as CardKind[]
}
