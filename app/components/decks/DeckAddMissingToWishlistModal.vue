<script setup lang="ts">
import type { MissingCard } from '~/utils/deck-shortfall'
import { wishlistQuantity } from '~/utils/deck-shortfall'

/**
 * "Fehlende Karten auf die Wunschliste" (#178): lists every card the deck is
 * short of (Main + Extra + Side) with the missing count, and puts the ones
 * not yet on the wishlist there with that count. Cards already on the
 * wishlist are skipped, so their quantity and note stay as the user set them
 * (the POST is an upsert). The requests run one after another, as in
 * "Sammlung aus Deck befüllen" (`CollectionsFillFromDeckModal`).
 */
const props = defineProps<{
  open: boolean
  /** From `missingCards` (`~/utils/deck-shortfall`), with the wishlist state. */
  cards: MissingCard[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** After every confirm, also after a failure or with no card added: reload the wishlist state. */
  added: [catalogCardIds: number[]]
}>()

const { t, n } = useI18n()
const { cardName } = useCardText()
const apiError = useApiError()
const toast = useToast()
const count = useCount()

const openProxy = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const isSaving = ref(false)
const errorMessage = ref('')

watch(() => props.open, (open) => {
  if (open) {
    errorMessage.value = ''
  }
})

const toAdd = computed(() => props.cards.filter(card => !card.wishlisted))
const hasWishlisted = computed(() => props.cards.some(card => card.wishlisted))

async function confirm() {
  if (toAdd.value.length === 0 || isSaving.value) {
    return
  }

  isSaving.value = true
  errorMessage.value = ''
  const added: number[] = []
  try {
    // The page's wishlist state can be stale (a card wished in another tab,
    // or a failed reload that left it empty). The POST is an upsert that
    // would overwrite such a card's quantity and note, so ask the server
    // right before posting; if that fails, nothing is posted.
    const { ids } = await $fetch<{ ids: number[] }>('/api/wishlist/ids')
    const wished = new Set(ids)
    const cards = toAdd.value.filter(card => !wished.has(card.catalogCardId))
    for (const card of cards) {
      await $fetch('/api/wishlist', {
        method: 'POST',
        body: { catalogCardId: card.catalogCardId, quantity: wishlistQuantity(card.missing) },
      })
      added.push(card.catalogCardId)
    }
    toast.add({ title: count('decks.editor.missingToWishlist.success', added.length), icon: 'i-lucide-check', color: 'success' })
    openProxy.value = false
  }
  catch (error) {
    errorMessage.value = apiError(error, 'decks.editor.missingToWishlist.failed')
  }
  finally {
    isSaving.value = false
    // Also when nothing was added: the page's state may have been stale.
    emit('added', added)
  }
}
</script>

<template>
  <UModal
    v-model:open="openProxy"
    :title="t('decks.editor.missingToWishlist.title')"
    :description="t('decks.editor.missingToWishlist.description')"
  >
    <template #body>
      <div class="space-y-4">
        <p
          v-if="cards.length === 0"
          class="text-sm text-muted"
        >
          {{ t('decks.editor.missingToWishlist.nothingMissing') }}
        </p>

        <ul
          v-else
          class="max-h-72 divide-y divide-default overflow-y-auto rounded-md border border-default text-sm"
          :aria-label="t('decks.editor.missingToWishlist.listLabel')"
          data-testid="missing-cards"
        >
          <li
            v-for="card in cards"
            :key="card.catalogCardId"
            class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-1.5"
            :data-wishlisted="card.wishlisted ? '' : undefined"
          >
            <!-- min-w-40: on a phone the badge wraps below the name instead of cutting it off. -->
            <span class="min-w-40 flex-1 truncate text-highlighted">{{ cardName(card) }}</span>
            <span class="flex shrink-0 items-center gap-2 text-xs">
              <UBadge
                v-if="card.wishlisted"
                size="sm"
                variant="subtle"
                color="neutral"
                icon="i-lucide-heart"
                :label="t('decks.editor.missingToWishlist.alreadyWished')"
              />
              <span
                class="font-semibold tabular-nums"
                :class="card.wishlisted ? 'text-muted' : 'text-warning'"
              >
                {{ t('decks.editor.missingToWishlist.missingCount', { count: n(card.missing, 'integer') }, card.missing) }}
              </span>
            </span>
          </li>
        </ul>

        <p
          v-if="cards.length > 0 && toAdd.length === 0"
          class="text-sm text-muted"
          role="status"
        >
          {{ t('decks.editor.missingToWishlist.allWished') }}
        </p>
        <p
          v-else-if="hasWishlisted"
          class="text-xs text-muted"
        >
          {{ t('decks.editor.missingToWishlist.skipHint') }}
        </p>

        <p
          v-if="errorMessage"
          role="alert"
          class="text-sm text-error"
        >
          {{ errorMessage }}
        </p>

        <div class="flex flex-wrap justify-end gap-2">
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            :label="toAdd.length > 0 ? t('common.cancel') : t('common.close')"
            @click="() => { openProxy = false }"
          />
          <UButton
            v-if="toAdd.length > 0"
            icon="i-lucide-heart"
            :loading="isSaving"
            :label="count('decks.editor.missingToWishlist.confirm', toAdd.length)"
            @click="confirm"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
