import { apiItemErrors } from '~/utils/card-entry'

export interface MoveCopiesItem {
  ownedCardId: string
  /** Left out: the whole stack. */
  quantity?: number
  /** `null` = "ohne Sammlung". */
  toCollectionId: string | null
}

export interface MoveCopiesItemResult {
  ownedCardId: string
  catalogCardId: number
  fromCollectionId: string | null
  toCollectionId: string | null
  quantity: number
  /** The stack the copies are in now (`POST /api/inventory/move`). */
  resultId: string
  remaining: number
}

export interface MoveCopiesResult {
  moved: number
  items: MoveCopiesItemResult[]
}

/**
 * Moving owned copies between collections (`POST /api/inventory/move`): the
 * inventory's "Verschieben" dialog, the "gerade gespeichert" panel of the
 * quick entry. The collection counts (the collection menu, the dashboard)
 * change with a move, so the shared `collections` fetch is refreshed after it.
 */
export function useMoveCopies() {
  const translate = useApiErrorCode()
  const apiError = useApiError()

  async function moveCopies(items: MoveCopiesItem[]): Promise<MoveCopiesResult> {
    const result = await $fetch<MoveCopiesResult>('/api/inventory/move', {
      method: 'POST',
      body: { items },
    })
    await refreshNuxtData('collections')
    return result
  }

  /** The message for a failed move: the first item's own reason when there is one. */
  function moveErrorMessage(error: unknown): string {
    const [first] = apiItemErrors(error)
    return first?.code
      ? translate(first.code, first.params, 'inventory.move.failed')
      : apiError(error, 'inventory.move.failed')
  }

  return { moveCopies, moveErrorMessage }
}
