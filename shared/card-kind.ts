// The grouped "Kartenart" filter (catalog, inventory, the deck builder's card
// source): a card's kind is its frame (`shared/card-frame.ts`), not its exact
// `type` line. "Effekt" therefore covers every monster with an effect frame
// (Flip, Tuner, Spirit, Toon, Union, Gemini, ...), which the exact type filter
// ("Effect Monster" only) cannot. Pendulum is the second half of a frame, so a
// Pendulum Effect Monster is both "Effekt" and "Pendel". The filter values are
// these keys; a card matches when it has any selected kind. Skill Cards have
// no kind.
import { cardFrame } from './card-frame'

export const CARD_KINDS = [
  'normal',
  'effect',
  'ritual',
  'fusion',
  'synchro',
  'xyz',
  'link',
  'pendulum',
  'token',
  'spell',
  'trap',
] as const

export type CardKind = typeof CARD_KINDS[number]

export function isCardKind(value: string): value is CardKind {
  return (CARD_KINDS as readonly string[]).includes(value)
}

/**
 * The kinds of one card, computed in code with the same rules as the SQL
 * filter (`server/utils/card-kind-sql.ts`); `[]` for a Skill Card or a card
 * without a type.
 */
export function cardKinds(card: { type?: string | null, frameType?: string | null }): CardKind[] {
  const frame = cardFrame(card)
  if (!frame) {
    return []
  }
  const kinds: CardKind[] = isCardKind(frame.frame) ? [frame.frame] : []
  if (frame.pendulum) {
    kinds.push('pendulum')
  }
  return kinds
}
