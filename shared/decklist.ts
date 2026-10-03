// Deck-list formats shared by the server's parser (server/utils/decklist-parse.ts)
// and the deck export in the browser (app/components/decks/DeckExportMenu.vue):
// ydke:// links, YGO Omega deck codes, YDK files and Omega's text recipe.
// Pure and dependency-free: no Drizzle, no h3, no Vue, no Node `Buffer`.
import { cardCategoryRank, compareDeckRows } from './deck-order'
import { DECK_SECTIONS } from './deck-sections'
import type { DeckSection } from './deck-sections'

export const DECKLIST_FORMATS = ['ydke', 'omega', 'ydk', 'text'] as const
export type DecklistFormat = typeof DECKLIST_FORMATS[number]

/** One line of a pasted deck list: a passcode or a name, with its copies. */
export interface DecklistEntry {
  passcode?: number
  /** The searchable remainder of a text line (card name, or a set code's query). */
  name?: string
  setCode?: string
  quantity: number
  /** The line as it was written (a passcode as its digits), for review and for `resolveEntryLine`. */
  raw: string
}

export type DecklistSections = Record<DeckSection, DecklistEntry[]>

export interface ParsedDecklist {
  format: DecklistFormat
  /**
   * Omega codes and a text list without an Extra header don't separate Main
   * from Extra: everything but the Side Deck is in `main`, and the caller
   * splits by card type once it knows the cards (`isExtraDeckCard`).
   */
  sections: DecklistSections
}

/** Passcodes per section, as the passcode formats carry them (one per copy). */
export type PasscodeSections = Record<DeckSection, number[]>

/** The most copies of one entry; mirrors MAX_ENTRY_QUANTITY (server/utils/entry-line.ts). */
export const MAX_DECKLIST_QUANTITY = 99

const UINT32_MAX = 0xFFFFFFFF

export function isPasscode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= UINT32_MAX
}

// --- Section headers -------------------------------------------------------

const HEADER_ALIASES: Record<string, DeckSection> = {
  // Omega's recipe groups the Main Deck by card kind; all of it is Main.
  'monster': 'main',
  'monsters': 'main',
  'monster cards': 'main',
  'monsterkarten': 'main',
  'spell': 'main',
  'spells': 'main',
  'spell cards': 'main',
  'zauber': 'main',
  'zauberkarten': 'main',
  'trap': 'main',
  'traps': 'main',
  'trap cards': 'main',
  'fallen': 'main',
  'fallenkarten': 'main',
  'main': 'main',
  'main deck': 'main',
  'maindeck': 'main',
  'hauptdeck': 'main',
  'extra': 'extra',
  'extra deck': 'extra',
  'extradeck': 'extra',
  'side': 'side',
  'side deck': 'side',
  'sidedeck': 'side',
}

// "Monster", "Spell Cards:", "Main Deck (40)", "Extra Deck: 15", "#main", "!side".
const HEADER_LINE = /^[#!]?\s*(\p{L}[\p{L} ]*?)\s*(?:[:([]\s*\d+\s*[)\]]?)?\s*:?$/u

/** The deck section a header line opens (`Monster`, `#extra`, `Side Deck:` …), else `null`. */
export function parseSectionHeader(line: string): DeckSection | null {
  const match = HEADER_LINE.exec(line.trim())
  if (!match) {
    return null
  }
  return HEADER_ALIASES[match[1]!.toLowerCase().replace(/\s+/g, ' ')] ?? null
}

/** `#created by …` and every other `#` line that is not a section marker. */
export function isCommentLine(line: string): boolean {
  return line.trim().startsWith('#') && parseSectionHeader(line) === null
}

/** A YDK file (`#main`, `#extra`, `!side`, `#created by …`), as opposed to a text recipe. */
export function looksLikeYdk(text: string): boolean {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return lines.some(line => /^#\s*(?:main|extra|created by)\b/i.test(line) || /^!\s*side\b/i.test(line))
    || (lines.length > 0 && lines.every(line => isCommentLine(line) || /^\d{5,10}$/.test(line)) && lines.some(line => /^\d{5,10}$/.test(line)))
}

// --- Merging ---------------------------------------------------------------

// "7 Colored Fish": a bare leading count may be part of the name, so such a
// line is only known to be a count after the catalog lookup
// (`resolveEntryLine`). Merging it by name here would drop copies.
const BARE_LEADING_COUNT = /^\d{1,3}\s+\S/

function mergeKey(entry: DecklistEntry, index: number): string {
  if (entry.passcode !== undefined) {
    return `p:${entry.passcode}`
  }
  if (BARE_LEADING_COUNT.test(entry.raw.replace(/\s+/g, ' ').trim())) {
    return `line:${index}`
  }
  return `n:${(entry.name ?? entry.raw).toLowerCase()}|${entry.setCode ?? ''}`
}

/** Sums the copies of entries naming the same card (same passcode, or same name and set code). */
export function mergeDecklistEntries(entries: DecklistEntry[]): DecklistEntry[] {
  const merged = new Map<string, DecklistEntry>()
  entries.forEach((entry, index) => {
    const key = mergeKey(entry, index)
    const existing = merged.get(key)
    if (existing) {
      existing.quantity = Math.min(MAX_DECKLIST_QUANTITY, existing.quantity + entry.quantity)
    }
    else {
      merged.set(key, { ...entry })
    }
  })
  return [...merged.values()]
}

/**
 * How many entries a pasted list will have after parsing, for a warning while
 * typing: the lines that are neither blank, comments nor headers, with equal
 * lines counted once. Mirrors the server's merge for the usual shapes (YDK
 * has one identical line per copy), and counts a ydke link or an Omega code as one.
 */
export function countEntryLines(text: string): number {
  const lines = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !isCommentLine(trimmed) && parseSectionHeader(trimmed) === null) {
      lines.add(trimmed.toLowerCase())
    }
  }
  return lines.size
}

// --- Bytes and base64 ------------------------------------------------------

/** Standard or URL-safe base64, with or without padding; `null` for anything else. */
export function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(normalized) || normalized.length % 4 === 1) {
    return null
  }
  try {
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  catch {
    return null
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** Little-endian uint32 values, 4 bytes each; `null` when the length isn't a multiple of 4. */
export function bytesToUint32s(bytes: Uint8Array, offset = 0, count = (bytes.length - offset) / 4): number[] | null {
  if (!Number.isInteger(count) || count < 0 || offset + count * 4 > bytes.length) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: count }, (_, index) => view.getUint32(offset + index * 4, true))
}

export function uint32sToBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return bytes
}

// --- ydke:// ---------------------------------------------------------------

const YDKE_PREFIX = 'ydke://'

export function isYdke(text: string): boolean {
  return text.trim().toLowerCase().startsWith(YDKE_PREFIX)
}

/** `ydke://<main>!<extra>!<side>!`, each part base64 of uint32 LE passcodes; `null` when it is malformed. */
export function decodeYdke(text: string): PasscodeSections | null {
  const parts = text.trim().slice(YDKE_PREFIX.length).split('!')
  if (parts.length < 3) {
    return null
  }
  const decoded: number[][] = []
  for (const part of parts.slice(0, 3)) {
    const bytes = base64ToBytes(part)
    const passcodes = bytes && bytesToUint32s(bytes)
    if (!passcodes) {
      return null
    }
    decoded.push(passcodes)
  }
  return { main: decoded[0]!, extra: decoded[1]!, side: decoded[2]! }
}

export function encodeYdke(sections: PasscodeSections): string {
  return `${YDKE_PREFIX}${DECK_SECTIONS.map(section => bytesToBase64(uint32sToBytes(sections[section]))).join('!')}!`
}

// --- YGO Omega deck code ---------------------------------------------------

/**
 * The bytes inside an Omega deck code: the count of Main + Extra cards and the
 * count of Side cards (one byte each), then every passcode as uint32 LE: Main
 * and Extra mixed, then Side.
 */
export function omegaPayload(mainAndExtra: number[], side: number[]): Uint8Array {
  if (mainAndExtra.length > 255 || side.length > 255) {
    throw new RangeError('An Omega deck code holds at most 255 cards per part')
  }
  const ids = uint32sToBytes([...mainAndExtra, ...side])
  const bytes = new Uint8Array(2 + ids.length)
  bytes[0] = mainAndExtra.length
  bytes[1] = side.length
  bytes.set(ids, 2)
  return bytes
}

/**
 * The inverse of `omegaPayload`; `null` when the counted passcodes don't fit.
 * Current Omega exports append a passcode after the Side Deck (the deck's
 * cover card, outside both counts); bytes after the counted passcodes are
 * ignored.
 */
export function readOmegaPayload(bytes: Uint8Array): { mainAndExtra: number[], side: number[] } | null {
  if (bytes.length < 2) {
    return null
  }
  const mainCount = bytes[0]!
  const sideCount = bytes[1]!
  if (bytes.length < 2 + 4 * (mainCount + sideCount)) {
    return null
  }
  const ids = bytesToUint32s(bytes, 2, mainCount + sideCount)!
  return { mainAndExtra: ids.slice(0, mainCount), side: ids.slice(mainCount) }
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Response(bytes as BodyInit).body!.pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(compressed).arrayBuffer())
}

/**
 * The code Omega's "Import" takes: the payload, raw-deflated (no zlib header)
 * and base64'd. Async because it uses the platform's `CompressionStream`
 * (browsers since 2023, Node 18+).
 */
export async function encodeOmegaCode(sections: PasscodeSections): Promise<string> {
  const payload = omegaPayload([...sections.main, ...sections.extra], sections.side)
  return bytesToBase64(await deflateRaw(payload))
}

// --- YDK -------------------------------------------------------------------

export function encodeYdk(sections: PasscodeSections): string {
  return [
    '#created by ygo-alpha',
    '#main',
    ...sections.main.map(String),
    '#extra',
    ...sections.extra.map(String),
    '!side',
    ...sections.side.map(String),
    '',
  ].join('\n')
}

// --- Text recipe (Omega style) ---------------------------------------------

export interface RecipeRow {
  /** The English card name. */
  name: string
  type: string
  section: DeckSection
  quantity: number
}

/**
 * Omega's recipe: `Monster` / `Spell` / `Trap` for the Main Deck, then `Extra`
 * and `Side`, one `3 Name` line per card, in the deck's order
 * (`compareDeckRows`, English names). Empty groups are left out.
 */
export function encodeRecipe(rows: RecipeRow[]): string {
  const lines: string[] = []

  function group(header: string, groupRows: RecipeRow[]) {
    if (groupRows.length > 0) {
      lines.push(header, ...groupRows.map(row => `${row.quantity} ${row.name}`))
    }
  }

  const ordered = (section: DeckSection) => rows
    .filter(row => row.section === section)
    .sort((a, b) => compareDeckRows(section, a, b, 'en'))

  const main = ordered('main')
  group('Monster', main.filter(row => cardCategoryRank(row.type) === 0))
  group('Spell', main.filter(row => cardCategoryRank(row.type) === 1))
  group('Trap', main.filter(row => cardCategoryRank(row.type) === 2))
  group('Extra', ordered('extra'))
  group('Side', ordered('side'))

  return lines.join('\n')
}

export interface ExportCardRow {
  catalogCardId: number
  name: string
  type: string
  quantity: number
}

/**
 * The passcodes of a deck, one per copy, in the deck's order, and how many
 * copies have no usable passcode (they are left out of every passcode format).
 */
export function deckPasscodes(sections: Record<DeckSection, ExportCardRow[]>): { passcodes: PasscodeSections, skipped: number } {
  const passcodes: PasscodeSections = { main: [], extra: [], side: [] }
  let skipped = 0
  for (const section of DECK_SECTIONS) {
    for (const row of sections[section]) {
      if (isPasscode(row.catalogCardId)) {
        for (let copy = 0; copy < row.quantity; copy += 1) {
          passcodes[section].push(row.catalogCardId)
        }
      }
      else {
        skipped += row.quantity
      }
    }
  }
  return { passcodes, skipped }
}

export function deckRecipeRows(sections: Record<DeckSection, ExportCardRow[]>): RecipeRow[] {
  return DECK_SECTIONS.flatMap(section => sections[section].map(row => ({
    name: row.name,
    type: row.type,
    section,
    quantity: row.quantity,
  })))
}

/** The name of a downloaded YDK file: the deck's name as a file name, `deck.ydk` for a name without letters or digits. */
export function ydkFileName(deckName: string): string {
  const stem = deckName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '')
  return `${stem || 'deck'}.ydk`
}
