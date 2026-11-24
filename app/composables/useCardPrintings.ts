/** One printing of a card (ADR 0034), as `GET /api/catalog/cards/:id/printings` returns it. */
export interface CardPrinting {
  id: string
  setCode: string
  setName: string
  rarity: string | null
  rarityCode: string | null
}

/**
 * The printings of a card for the printing pickers, loaded on the client
 * whenever `cardId` changes. A failed load leaves the list empty: the
 * printing is optional, so the picker then only offers "printing unknown".
 */
export function useCardPrintings(cardId: MaybeRefOrGetter<number | null | undefined>) {
  const printings = ref<CardPrinting[]>([])
  const loading = ref(false)
  let latest = 0

  watch(() => toValue(cardId), async (id) => {
    const request = ++latest
    printings.value = []
    if (import.meta.server || !id) {
      loading.value = false
      return
    }
    loading.value = true
    try {
      const response = await $fetch<{ items?: CardPrinting[] }>(`/api/catalog/cards/${id}/printings`)
      if (request === latest) {
        // Anything but a list (an old cached answer) counts as no printings.
        printings.value = Array.isArray(response?.items) ? response.items : []
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

  return { printings, loading }
}
