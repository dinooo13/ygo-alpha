import type { Ref } from 'vue'

/**
 * The catalog's "Zur Wunschliste" toggles, held by the page rather than by
 * each button (#98): a grid tile that is unmounted while a search reloads
 * no longer drops a toggle that finishes afterwards, and the tile and the
 * card detail overlay show the same state.
 *
 * `initialIds` seeds the wishlisted cards (`GET /api/wishlist/ids`); a toggle
 * adds or removes a card and is ignored while that card is still saving.
 * An add sends `quantity` only when given (the deck editor wishes for the
 * deck's shortfall, #178); without it the server's default of 1 applies.
 */
export function useWishlistToggle(initialIds: Ref<readonly number[]>) {
  const apiError = useApiError()

  // Replaced, not mutated, so every reader re-renders.
  const ids = ref<Set<number>>(new Set())
  const saving = ref<Set<number>>(new Set())
  const errors = ref<Map<number, string>>(new Map())

  watch(initialIds, (value) => {
    ids.value = new Set(value)
  }, { immediate: true })

  function isWishlisted(cardId: number): boolean {
    return ids.value.has(cardId)
  }

  function isSaving(cardId: number): boolean {
    return saving.value.has(cardId)
  }

  function errorFor(cardId: number): string | undefined {
    return errors.value.get(cardId)
  }

  function withCard<T>(set: Set<T>, value: T, present: boolean): Set<T> {
    const next = new Set(set)
    if (present) {
      next.add(value)
    }
    else {
      next.delete(value)
    }
    return next
  }

  async function toggle(cardId: number, quantity?: number): Promise<void> {
    if (isSaving(cardId)) {
      return
    }

    const add = !isWishlisted(cardId)
    saving.value = withCard(saving.value, cardId, true)
    if (errors.value.has(cardId)) {
      const next = new Map(errors.value)
      next.delete(cardId)
      errors.value = next
    }

    try {
      if (add) {
        await $fetch('/api/wishlist', {
          method: 'POST',
          body: quantity === undefined ? { catalogCardId: cardId } : { catalogCardId: cardId, quantity },
        })
      }
      else {
        await $fetch(`/api/wishlist/card/${cardId}`, { method: 'DELETE' })
      }
      ids.value = withCard(ids.value, cardId, add)
    }
    catch (error) {
      errors.value = new Map(errors.value).set(cardId, apiError(error, 'wishlist.errors.updateFailed'))
    }
    finally {
      saving.value = withCard(saving.value, cardId, false)
    }
  }

  return { isWishlisted, isSaving, errorFor, toggle }
}
