// The preview step of the deck import (POST /api/decks/import/preview): reads
// a pasted deck list (or the text of a .ydk file) in any format
// `parseDecklist` knows and looks every distinct entry up in the catalog with
// the same matching as quick capture. Nothing is written; the client reviews
// the rows and then creates the deck with POST /api/decks.

import { createError } from 'h3'
import { DECK_SECTIONS } from '../../shared/deck-sections'
import type { DeckSection } from '../../shared/deck-sections'
import type { DecklistFormat } from '../../shared/decklist'
import type { useDb } from '../db'
import { MAX_ENTRY_TEXT_LENGTH, suggestForRequest } from './card-entry'
import type { EntrySuggestResult } from './card-entry'
import { entryToParsedLine, parseDecklist } from './decklist-parse'
import { MAX_DECK_CREATE_CARDS } from './decks'

type Db = ReturnType<typeof useDb>

export interface DeckImportPreview {
  format: DecklistFormat
  /**
   * The lines as the list had them, one result per distinct entry. Omega
   * codes and lists without an Extra header have Main and Extra together in
   * `main`; the client puts each resolved card into the section its type
   * allows.
   */
  sections: Record<DeckSection, EntrySuggestResult[]>
  /**
   * The cover card's passcode from an Omega code, else `null`. The client
   * makes the row with that passcode the new deck's cover while it ends up in
   * Main or Extra (ADR 0012).
   */
  cover: number | null
}

const SUGGESTIONS_PER_ENTRY = 5

function badRequest(message: string, code: string, params?: Record<string, unknown>): never {
  throw createError({ statusCode: 400, statusMessage: message, data: { code, params } })
}

/** The pasted text of a request body, checked for size. */
export function parseImportRequest(body: unknown): string {
  const text = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).text : undefined
  if (typeof text !== 'string') {
    badRequest('text must be a string', 'invalid_body')
  }
  if (text.length > MAX_ENTRY_TEXT_LENGTH) {
    badRequest(`text must be at most ${MAX_ENTRY_TEXT_LENGTH} characters`, 'request_too_large')
  }
  return text
}

export function previewDeckImport(db: Db, text: string): DeckImportPreview {
  const parsed = parseDecklist(text)

  const entryCount = DECK_SECTIONS.reduce((sum, section) => sum + parsed.sections[section].length, 0)
  if (entryCount === 0) {
    badRequest('No cards found in the deck list', 'empty_decklist')
  }
  if (entryCount > MAX_DECK_CREATE_CARDS) {
    badRequest(`A deck list may have at most ${MAX_DECK_CREATE_CARDS} different cards`, 'too_many_import_entries', { max: MAX_DECK_CREATE_CARDS })
  }

  const lookup = (section: DeckSection): EntrySuggestResult[] => {
    const lines = parsed.sections[section].map(entryToParsedLine)
    return lines.length === 0 ? [] : suggestForRequest(db, { lines, limit: SUGGESTIONS_PER_ENTRY })
  }

  return {
    format: parsed.format,
    sections: { main: lookup('main'), extra: lookup('extra'), side: lookup('side') },
    cover: parsed.cover,
  }
}
