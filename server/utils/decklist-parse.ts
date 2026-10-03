// Reads a pasted deck list in any of the formats the games and deck sites
// copy: `ydke://` links, YGO Omega deck codes, YDK files and text recipes
// (Omega's "Recipe", EDOPro's text export, plain card lists). Quick capture
// (card-entry.ts) and the deck import (POST /api/decks/import/preview) both
// read their input through `parseDecklist`.
//
// Syntax only: a passcode that no card has, or a name the catalog doesn't
// know, is still an entry; resolving them is the caller's business.

import { createError } from 'h3'
import { inflateRawSync } from 'node:zlib'
import {
  base64ToBytes,
  decodeYdke,
  isCommentLine,
  isPasscode,
  isYdke,
  looksLikeYdk,
  MAX_DECKLIST_QUANTITY,
  mergeDecklistEntries,
  parseSectionHeader,
  readOmegaPayload,
} from '../../shared/decklist'
import type { DecklistEntry, DecklistSections, ParsedDecklist, PasscodeSections } from '../../shared/decklist'
import type { DeckSection } from '../../shared/deck-sections'
import { parseEntryLine } from './entry-line'
import type { ParsedEntryLine } from './entry-line'

function invalidDecklist(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message, data: { code: 'invalid_decklist' } })
}

function emptySections(): DecklistSections {
  return { main: [], extra: [], side: [] }
}

/** One entry per distinct passcode, with its copies counted. */
function passcodeEntries(passcodes: number[]): DecklistEntry[] {
  return mergeDecklistEntries(passcodes.map(passcode => ({ passcode, quantity: 1, raw: String(passcode) })))
}

function fromPasscodes(format: ParsedDecklist['format'], sections: PasscodeSections, cover: number | null = null): ParsedDecklist {
  return {
    format,
    sections: {
      main: passcodeEntries(sections.main),
      extra: passcodeEntries(sections.extra),
      side: passcodeEntries(sections.side),
    },
    cover,
  }
}

// A code holds at most 255 + 255 passcodes plus a short trailer (the cover
// card); nothing bigger is one.
const OMEGA_MAX_PAYLOAD = 2 + 4 * (255 + 255) + 64

// An Omega code is one token of base64 characters; a card name or a list of
// names has spaces or is too short, and what doesn't inflate isn't a code.
const OMEGA_TOKEN = /^[A-Za-z0-9+/_-]{12,}={0,2}$/

function parseOmega(text: string): ParsedDecklist | null {
  const token = text.replace(/\s+/g, '')
  if (!OMEGA_TOKEN.test(token) || /^\S+\s+\S/.test(text.trim().split(/\r?\n/)[0] ?? '')) {
    return null
  }

  const bytes = base64ToBytes(token)
  if (!bytes) {
    return null
  }
  let payload: ReturnType<typeof readOmegaPayload>
  try {
    payload = readOmegaPayload(inflateRawSync(bytes, { maxOutputLength: OMEGA_MAX_PAYLOAD }))
  }
  catch {
    return null
  }
  if (!payload) {
    return null
  }

  // Main and Extra come mixed; the caller splits them by card type.
  return fromPasscodes('omega', { main: payload.mainAndExtra, extra: [], side: payload.side }, payload.cover)
}

function parseLines(text: string, format: 'ydk' | 'text'): ParsedDecklist {
  const sections = emptySections()
  let section: DeckSection = 'main'

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || isCommentLine(trimmed)) {
      continue
    }
    const header = parseSectionHeader(trimmed)
    if (header) {
      section = header
      continue
    }

    // In a YDK file every number is a passcode, whatever its length: Konami's
    // ids below 10,000,000 lose their leading zero ("5318639" is 05318639).
    if (format === 'ydk' && /^\d{1,10}$/.test(trimmed)) {
      const passcode = Number(trimmed)
      if (isPasscode(passcode)) {
        sections[section].push({ passcode, quantity: 1, raw: trimmed })
      }
      continue
    }

    const parsed = parseEntryLine(line)
    if (parsed.query === '') {
      continue
    }
    sections[section].push({
      ...(parsed.passcode === undefined ? { name: parsed.query } : { passcode: parsed.passcode }),
      ...(parsed.setCode ? { setCode: parsed.setCode } : {}),
      quantity: parsed.quantity,
      raw: parsed.raw.trim(),
    })
  }

  return {
    format,
    sections: {
      main: mergeDecklistEntries(sections.main),
      extra: mergeDecklistEntries(sections.extra),
      side: mergeDecklistEntries(sections.side),
    },
    cover: null,
  }
}

/**
 * Detects the format and reads the list. Throws a 400 (`invalid_decklist`)
 * for a `ydke://` link that can't be read; anything else that is no code
 * falls through to the text reader, so no input is an error just for being
 * unusual. A text list's Main/Extra split follows its headers; without an
 * Extra header (and for Omega codes) everything but the Side Deck is `main`.
 */
export function parseDecklist(text: string): ParsedDecklist {
  const trimmed = text.trim()

  if (isYdke(trimmed)) {
    const sections = decodeYdke(trimmed)
    if (!sections) {
      invalidDecklist('The ydke:// link could not be read')
    }
    return fromPasscodes('ydke', sections)
  }

  const omega = parseOmega(trimmed)
  if (omega) {
    return omega
  }

  return parseLines(text, looksLikeYdk(text) ? 'ydk' : 'text')
}

/** The entry as the catalog lookup takes it (`suggestCatalogMatches`, `resolveEntryLine`). */
export function entryToParsedLine(entry: DecklistEntry): ParsedEntryLine {
  const quantity = Math.min(MAX_DECKLIST_QUANTITY, Math.max(1, entry.quantity))
  if (entry.passcode !== undefined) {
    return { raw: entry.raw, quantity, query: String(entry.passcode).padStart(8, '0'), passcode: entry.passcode }
  }
  return {
    raw: entry.raw,
    quantity,
    query: entry.name ?? entry.raw,
    ...(entry.setCode ? { setCode: entry.setCode } : {}),
  }
}
