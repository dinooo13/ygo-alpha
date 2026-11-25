import type { CardSetCode } from '~~/shared/printing'

/**
 * The set codes of a card with their listed rarities (ADR 0034,
 * `GET /api/catalog/cards/:id/printings`) for the printing pickers, loaded on
 * the client whenever `cardId` changes. A failed load leaves the list empty:
 * the printing is optional, so the picker then offers "set code unknown" and
 * every rarity.
 */
export function useCardPrintings(cardId: MaybeRefOrGetter<number | null | undefined>) {
  const setCodes = ref<CardSetCode[]>([])
  const loading = ref(false)
  let latest = 0

  watch(() => toValue(cardId), async (id) => {
    const request = ++latest
    setCodes.value = []
    if (import.meta.server || !id) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      const response = await $fetch<{ items?: CardSetCode[] }>(`/api/catalog/cards/${id}/printings`)
      if (request === latest) {
        // Anything but a list (an old cached answer) counts as no set codes.
        setCodes.value = Array.isArray(response?.items) ? response.items : []
      }
    }
    catch {
      // Stays empty, see above.
    }
    finally {
      if (request === latest) {
        loading.value = false
      }
    }
  }, { immediate: true })

  return { setCodes, loading }
}
