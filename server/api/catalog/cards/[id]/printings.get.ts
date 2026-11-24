import { useDb } from '../../../../db'
import { listCardPrintings } from '../../../../utils/catalog-search'
import { requireUser } from '../../../../utils/session'

/**
 * The printings of a card (ADR 0034: set code + rarity, with the set name),
 * for the inventory's printing picker. An unknown card has none.
 */
export default defineEventHandler(async (event) => {
  await requireUser(event)

  const id = Number.parseInt(getRouterParam(event, 'id') ?? '', 10)
  if (!Number.isSafeInteger(id) || id < 1) {
    throw createError({ statusCode: 404, statusMessage: 'Card not found' })
  }

  return { items: listCardPrintings(useDb(), id) }
})
