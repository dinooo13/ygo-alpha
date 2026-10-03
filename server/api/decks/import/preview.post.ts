import { readBody } from 'h3'
import { useDb } from '../../../db'
import { parseImportRequest, previewDeckImport } from '../../../utils/deck-import'
import { requireUser } from '../../../utils/session'

/**
 * Reads a pasted deck list (ydke://, Omega deck code, YDK, text recipe) and
 * matches every entry against the catalog, grouped by Main / Extra / Side.
 * Read-only: the deck is created by `POST /api/decks` once the user has
 * reviewed the rows.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)

  return previewDeckImport(useDb(), parseImportRequest(await readBody(event)))
})
