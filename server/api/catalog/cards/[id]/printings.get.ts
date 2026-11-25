import { useDb } from '../../../../db'
import { listCardSetCodes } from '../../../../utils/catalog-search'
import { requireUser } from '../../../../utils/session'

/**
 * The set codes of a card with the set name and the rarities YGOPRODeck
 * lists for each (ADR 0034), for the inventory's printing pickers. An
 * unknown card has none.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)

  const id = Number.parseInt(getRouterParam(event, 'id') ?? '', 10)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }

  return { items: listCardSetCodes(useDb(), id) }
})
