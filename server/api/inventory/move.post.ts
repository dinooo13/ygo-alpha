import { readBody } from 'h3'
import { useDb } from '../../db'
import { moveOwnedCards, validateInventoryMoveInput } from '../../utils/inventory'
import { requireUser } from '../../utils/session'

/**
 * Moves copies between collections: `{ items: [{ ownedCardId, quantity?,
 * toCollectionId }] }`, up to 200 items in one transaction. A partial move
 * splits the stack, `quantity` left out moves the whole stack. Answers with
 * where every item ended up, so a caller can keep following the copies.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  return moveOwnedCards(useDb(), user.id, validateInventoryMoveInput(await readBody(event)))
})
