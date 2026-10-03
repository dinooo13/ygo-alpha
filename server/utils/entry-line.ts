// The syntax of one quick-capture / deck-list line, without the catalog:
// quantity, set code and passcode. Split from card-entry.ts so the deck-list
// parser (decklist-parse.ts) and the catalog lookup can both use it.

/** Upper bound for a single parsed quantity ("99x Kuriboh" is already absurd). */
export const MAX_ENTRY_QUANTITY = 99

// Set codes look like "SDY-006", "LOB-005", "LDS2-EN018", "YS17-EN041".
const SET_CODE_SOURCE = '[A-Z0-9]{2,5}-[A-Z]{0,3}\\d{3}'
export const SET_CODE_EXACT = new RegExp(`^${SET_CODE_SOURCE}$`, 'i')
const SET_CODE_PARENTHESIZED = new RegExp(`\\((${SET_CODE_SOURCE})\\)`, 'i')
// YGOPRODeck passcodes are 8 digits (the catalog card id).
const PASSCODE_EXACT = /^\d{8}$/
// A line that is only a quantity ("3", "3x") names no card at all.
const QUANTITY_ONLY = /^\d{1,3}\s*[x×*]?$/i

export interface ParsedEntryLine {
  /** The line exactly as the user/OCR/speech produced it. */
  raw: string
  quantity: number
  /** The searchable remainder (card name, set code, or passcode). */
  query: string
  setCode?: string
  passcode?: number
}

export function clampQuantity(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1
  }
  return Math.min(MAX_ENTRY_QUANTITY, Math.floor(value))
}

/**
 * Parses one hand-typed / dictated / OCR'd line into a quantity plus a
 * searchable remainder. Recognized shapes:
 * `3x Dark Magician`, `Dark Magician x3`, `3 Dark Magician`,
 * `Dark Magician (SDY-006)`, `SDY-006`, `46986414`.
 *
 * Purely syntactic: a leading bare number is ambiguous ("7 Colored Fish" is
 * a card, "7 Kuriboh" is a count), so `resolveEntryLine` re-checks the
 * untouched line against the catalog before the line is looked up.
 */
export function parseEntryLine(line: string): ParsedEntryLine {
  const raw = line
  const collapsed = line.replace(/\s+/g, ' ').trim()

  if (QUANTITY_ONLY.test(collapsed)) {
    // "3" / "3x" alone names no card — parseEntryText drops it.
    return { raw, quantity: 1, query: '' }
  }

  // Tabs and commas act as field separators (pasted spreadsheet columns),
  // never as part of a card name.
  let rest = line.replace(/[\t,;]+/g, ' ').replace(/\s+/g, ' ').trim()
  let quantity = 1

  const leadingMultiplier = rest.match(/^(\d{1,3})\s*[x×*]\s*(.+)$/i)
  const trailingMultiplier = rest.match(/^(.+?)\s*[x×*]\s*(\d{1,3})$/i)
  const leadingCount = rest.match(/^(\d{1,3})\s+(.+)$/)

  if (leadingMultiplier) {
    quantity = clampQuantity(Number(leadingMultiplier[1]))
    rest = leadingMultiplier[2]!.trim()
  }
  else if (trailingMultiplier) {
    quantity = clampQuantity(Number(trailingMultiplier[2]))
    rest = trailingMultiplier[1]!.trim()
  }
  else if (leadingCount) {
    quantity = clampQuantity(Number(leadingCount[1]))
    rest = leadingCount[2]!.trim()
  }

  const parsed: ParsedEntryLine = { raw, quantity, query: rest }

  const parenthesized = rest.match(SET_CODE_PARENTHESIZED)
  if (parenthesized) {
    parsed.setCode = parenthesized[1]!.toUpperCase()
    const withoutSetCode = rest.replace(SET_CODE_PARENTHESIZED, ' ').replace(/\s+/g, ' ').trim()
    parsed.query = withoutSetCode === '' ? parsed.setCode : withoutSetCode
    return parsed
  }

  if (SET_CODE_EXACT.test(rest)) {
    parsed.setCode = rest.toUpperCase()
    parsed.query = parsed.setCode
    return parsed
  }

  if (PASSCODE_EXACT.test(rest)) {
    parsed.passcode = Number(rest)
  }

  return parsed
}
