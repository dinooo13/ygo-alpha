// Card-frame and attribute keys for the decorative accents of the Duel Arena
// design (docs/adr/0016-visual-design-system.md): a frame color as a stripe
// or dot next to a card, an attribute "orb" next to the attribute text. The
// colors live in main.css (`[data-frame="…"]`, `[data-attribute="…"]`); they
// are never the only signal — the type and attribute are always written out.

export const CARD_FRAMES = [
  'normal',
  'effect',
  'ritual',
  'fusion',
  'synchro',
  'xyz',
  'link',
  'spell',
  'trap',
  'token',
  'skill',
] as const

export type CardFrame = typeof CARD_FRAMES[number]

export interface CardFrameInfo {
  frame: CardFrame
  /** Pendulum monsters get a second, spell-colored half. */
  pendulum: boolean
}

export const CARD_ATTRIBUTES = ['dark', 'light', 'earth', 'water', 'fire', 'wind', 'divine'] as const

export type CardAttributeKey = typeof CARD_ATTRIBUTES[number]

// Keyword → frame, checked in this order against the English type line: the
// Extra Deck frames first ("Synchro Tuner Monster" is synchro, "Ritual
// Effect Monster" is ritual), then the non-monster cards, then Normal
// monsters; any other monster has an Effect frame.
export const CARD_FRAME_TYPE_KEYWORDS: ReadonlyArray<readonly [string, CardFrame]> = [
  ['link', 'link'],
  ['xyz', 'xyz'],
  ['synchro', 'synchro'],
  ['fusion', 'fusion'],
  ['ritual', 'ritual'],
  ['spell', 'spell'],
  ['trap', 'trap'],
  ['token', 'token'],
  ['skill', 'skill'],
  ['normal', 'normal'],
]

function isCardFrame(value: string): value is CardFrame {
  return (CARD_FRAMES as readonly string[]).includes(value)
}

/**
 * The frame of a card: YGOPRODeck's `frameType` when present
 * ("effect_pendulum" → effect + pendulum), else parsed from the English
 * `type` line. Null when neither is known.
 */
export function cardFrame(card: { type?: string | null, frameType?: string | null }): CardFrameInfo | null {
  const frameType = card.frameType?.trim().toLowerCase()
  if (frameType) {
    const pendulum = frameType.endsWith('_pendulum')
    const base = pendulum ? frameType.slice(0, -'_pendulum'.length) : frameType
    if (isCardFrame(base)) {
      return { frame: base, pendulum }
    }
  }

  const type = card.type?.trim().toLowerCase()
  if (!type) {
    return null
  }
  const pendulum = type.includes('pendulum')
  const match = CARD_FRAME_TYPE_KEYWORDS.find(([keyword]) => type.includes(keyword))
  return { frame: match?.[1] ?? 'effect', pendulum }
}

/** The attribute's orb key ("DARK" → `dark`), or null for none/unknown. */
export function attributeKey(attribute?: string | null): CardAttributeKey | null {
  const key = attribute?.trim().toLowerCase()
  return key && (CARD_ATTRIBUTES as readonly string[]).includes(key) ? key as CardAttributeKey : null
}
