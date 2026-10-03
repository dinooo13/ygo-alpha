import { createError, getRouterParam, readBody } from 'h3'
import { useDb } from '../../../db'
import { fillCollectionFromDeck, validateDeckCollectionFillInput } from '../../../utils/deck-collection'
import { requireUser } from '../../../utils/session'

/**
 * "Sammlung aus Deck befüllen": moves the owned copies one of the caller's
 * decks needs into a collection. `dryRun: true` only answers with the plan
 * (the preview); the answer carries the per-card plan, the copies moved and
 * what is still missing. See `server/utils/deck-collection.ts`.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 404, statusMessage: 'Deck not found' })
  }

  const user = await requireUser(event)

  return fillCollectionFromDeck(useDb(), user.id, id, validateDeckCollectionFillInput(await readBody(event)))
})
