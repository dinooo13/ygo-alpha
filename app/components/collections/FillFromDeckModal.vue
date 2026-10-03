<script setup lang="ts">
import { MAX_WISHLIST_QUANTITY } from '~~/shared/sharing'
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { CollectionItem } from '~/composables/useCollections'

/**
 * "Sammlung aus Deck befüllen": moves the owned copies a deck needs (main +
 * extra + side per card) into a collection. The inventory is the master list
 * and collections partition it, so the copies leave the collection they were
 * in; the deck itself is not touched (ADR 0004, 0032).
 *
 * 1. Pick the deck (unless one is given), the target collection (existing or
 *    new) and the sources, "ohne Sammlung" first, then the other collections;
 *    sources can be left out.
 * 2. A preview (`POST /api/decks/:id/fill-collection` with `dryRun`) shows what
 *    would move, what is already in the target and what is missing.
 * 3. "Sammlung befüllen" does it and shows the result, with the shortfall and
 *    a way to put the cards that aren't owned at all on the wishlist.
 */
interface DeckOption {
  id: string
  name: string
}

interface FillCard {
  catalogCardId: number
  name: string
  nameDe: string | null
  needed: number
  alreadyInTarget: number
  toMove: number
  missing: number
  ownedElsewhere: number
  notOwned: number
  moves: Array<{ ownedCardId: string, fromCollectionId: string | null, quantity: number }>
}

interface FillAnswer {
  deck: { id: string, name: string }
  collection: { id: string, name: string }
  cards: FillCard[]
  totals: { cards: number, needed: number, alreadyInTarget: number, toMove: number, missing: number, notOwned: number }
  executed: boolean
  moved: number
}

const props = defineProps<{
  open: boolean
  /** The deck to fill from; without it the dialog asks. */
  deckId?: string | null
  /** The target collection to start with. */
  collectionId?: string | null
  collections: CollectionItem[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** The collection was filled: the inventory behind the dialog changed. */
  done: []
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

const decks = ref<DeckOption[]>([])
const deckChoice = ref('')
const target = ref('')
// The sources the user unticked; the others are used, in the order listed.
const leftOut = ref<Set<string>>(new Set())

const plan = ref<FillAnswer | null>(null)
const result = ref<FillAnswer | null>(null)
const isPlanning = ref(false)
const isRunning = ref(false)
const errorMessage = ref('')
const wishlist = ref<'idle' | 'saving' | 'done'>('idle')

const deckId = computed(() => props.deckId ?? deckChoice.value)

const deckItems = computed(() => decks.value.map(deck => ({ label: deck.name, value: deck.id })))

// "Ohne Sammlung" first, then the others as the collection menu lists them.
const sourceOptions = computed(() => [
  { id: UNASSIGNED_COLLECTION_ID, label: t('inventory.scope.unassigned') },
  ...props.collections.filter(collection => collection.id !== target.value).map(collection => ({ id: collection.id, label: collection.name })),
])
const sources = computed(() => sourceOptions.value.filter(option => !leftOut.value.has(option.id)).map(option => option.id))

function collectionName(collectionId: string | null): string {
  if (collectionId === null) {
    return t('inventory.scope.unassigned')
  }
  return props.collections.find(collection => collection.id === collectionId)?.name ?? t('inventory.breakdown.unnamedCollection')
}

function setSource(id: string, value: boolean) {
  const next = new Set(leftOut.value)
  if (value) {
    next.delete(id)
  }
  else {
    next.add(id)
  }
  leftOut.value = next
}

async function loadDecks() {
  try {
    const response = await $fetch<{ items: DeckOption[] }>('/api/decks', { query: { pageSize: 100, sort: 'name' } })
    decks.value = response.items
  }
  catch {
    decks.value = []
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      return
    }
    deckChoice.value = ''
    target.value = props.collectionId ?? ''
    leftOut.value = new Set()
    plan.value = null
    result.value = null
    errorMessage.value = ''
    wishlist.value = 'idle'
    if (!props.deckId) {
      loadDecks()
    }
  },
  { immediate: true },
)

// The preview follows the choices; an answer for choices that have changed since is dropped.
let planRequest = 0
watch([() => props.open, deckId, target, sources], async () => {
  const request = ++planRequest
  plan.value = null
  errorMessage.value = ''
  if (!props.open || !deckId.value || !target.value || result.value) {
    isPlanning.value = false
    return
  }

  isPlanning.value = true
  try {
    const answer = await $fetch<FillAnswer>(`/api/decks/${deckId.value}/fill-collection`, {
      method: 'POST',
      body: { collectionId: target.value, sourceCollectionIds: sources.value, dryRun: true },
    })
    if (request === planRequest) {
      plan.value = answer
    }
  }
  catch (error) {
    if (request === planRequest) {
      errorMessage.value = apiError(error, 'collections.fill.errors.planFailed')
    }
  }
  finally {
    if (request === planRequest) {
      isPlanning.value = false
    }
  }
}, { immediate: true })

async function run() {
  if (!plan.value || plan.value.totals.toMove === 0) {
    return
  }

  isRunning.value = true
  errorMessage.value = ''
  try {
    result.value = await $fetch<FillAnswer>(`/api/decks/${deckId.value}/fill-collection`, {
      method: 'POST',
      body: { collectionId: target.value, sourceCollectionIds: sources.value },
    })
    await refreshNuxtData('collections')
    emit('done')
  }
  catch (error) {
    errorMessage.value = apiError(error, 'collections.fill.errors.runFailed')
  }
  finally {
    isRunning.value = false
  }
}

const shown = computed(() => result.value ?? plan.value)
const moving = computed(() => (shown.value?.cards ?? []).filter(card => card.toMove > 0))
const missing = computed(() => (shown.value?.cards ?? []).filter(card => card.missing > 0))
// What no collection of the user has: the wishlist asks for exactly this.
const notOwned = computed(() => missing.value.filter(card => card.notOwned > 0))

// "aus Box A", or "2 aus Box A, 1 aus Box B" when the copies come from several collections.
function fromLabel(card: FillCard): string {
  const from = (move: FillCard['moves'][number]) => t('collections.fill.from', { collection: collectionName(move.fromCollectionId) })
  return card.moves.length === 1
    ? from(card.moves[0]!)
    : card.moves.map(move => `${n(move.quantity, 'integer')} ${from(move)}`).join(', ')
}

async function addToWishlist() {
  wishlist.value = 'saving'
  errorMessage.value = ''
  try {
    for (const card of notOwned.value) {
      await $fetch('/api/wishlist', {
        method: 'POST',
        body: { catalogCardId: card.catalogCardId, quantity: Math.min(card.notOwned, MAX_WISHLIST_QUANTITY) },
      })
    }
    wishlist.value = 'done'
    toast.add({ title: count('collections.fill.wishlist.success', notOwned.value.length), icon: 'i-lucide-check', color: 'success' })
  }
  catch (error) {
    wishlist.value = 'idle'
    errorMessage.value = apiError(error, 'collections.fill.wishlist.failed')
  }
}
</script>

<template>
  <UModal
    v-model:open="openProxy"
    :title="t('collections.fill.title')"
    :description="t('collections.fill.description')"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <!-- Choices stay visible and editable until the copies are moved. -->
        <div
          v-if="!result"
          class="grid gap-4 sm:grid-cols-2"
        >
          <UFormField
            v-if="!props.deckId"
            :label="t('collections.fill.deck')"
          >
            <USelect
              v-model="deckChoice"
              :items="deckItems"
              :placeholder="t('collections.fill.deckPlaceholder')"
              :aria-label="t('collections.fill.deck')"
              class="w-full"
            />
          </UFormField>

          <UFormField :label="t('collections.fill.target')">
            <CollectionsTargetSelect
              v-model="target"
              :collections="collections"
              :allow-none="false"
              :label="t('collections.fill.target')"
            />
          </UFormField>

          <fieldset
            v-if="target"
            class="space-y-1.5 sm:col-span-2"
          >
            <legend class="text-sm font-medium text-highlighted">
              {{ t('collections.fill.sources') }}
            </legend>
            <p class="text-xs text-muted">
              {{ t('collections.fill.sourcesHint') }}
            </p>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5">
              <UCheckbox
                v-for="option in sourceOptions"
                :key="option.id"
                :model-value="!leftOut.has(option.id)"
                :label="option.label"
                @update:model-value="value => setSource(option.id, value === true)"
              />
            </div>
          </fieldset>
        </div>

        <p
          v-if="isPlanning"
          class="text-sm text-muted"
          role="status"
        >
          {{ t('collections.fill.planning') }}
        </p>

        <div
          v-if="shown"
          class="space-y-4"
          data-testid="fill-preview"
        >
          <p
            v-if="result"
            class="text-sm font-medium text-highlighted"
            role="status"
          >
            {{ t('collections.fill.result.moved', { count: n(result.moved, 'integer'), collection: result.collection.name }, result.moved) }}
          </p>

          <div class="flex flex-wrap items-center gap-2 text-sm">
            <UBadge
              color="primary"
              variant="subtle"
              :label="t(result ? 'collections.fill.summary.moved' : 'collections.fill.summary.toMove', { count: n(shown.totals.toMove, 'integer') })"
            />
            <UBadge
              color="neutral"
              variant="subtle"
              :label="t('collections.fill.summary.alreadyThere', { count: n(shown.totals.alreadyInTarget, 'integer') })"
            />
            <UBadge
              :color="shown.totals.missing > 0 ? 'warning' : 'success'"
              variant="subtle"
              :label="t('collections.fill.summary.missing', { count: n(shown.totals.missing, 'integer') })"
            />
          </div>

          <p
            v-if="!result && shown.totals.toMove === 0"
            class="text-sm text-muted"
          >
            {{ t('collections.fill.nothingToMove') }}
          </p>

          <section
            v-if="moving.length > 0"
            :aria-label="t('collections.fill.list.move')"
          >
            <h3 class="text-sm font-semibold text-highlighted">
              {{ result ? t('collections.fill.list.moved') : t('collections.fill.list.move') }}
            </h3>
            <ul class="mt-1 max-h-48 divide-y divide-default overflow-y-auto rounded-md border border-default text-sm">
              <li
                v-for="card in moving"
                :key="card.catalogCardId"
                class="flex items-baseline justify-between gap-3 px-3 py-1.5"
              >
                <span class="min-w-0 truncate text-highlighted">{{ cardName(card) }}</span>
                <span class="shrink-0 text-xs text-muted">
                  <span class="font-semibold tabular-nums text-default">×{{ n(card.toMove, 'integer') }}</span>
                  {{ fromLabel(card) }}
                </span>
              </li>
            </ul>
          </section>

          <section
            v-if="missing.length > 0"
            :aria-label="t('collections.fill.list.missing')"
            data-testid="fill-shortfall"
          >
            <h3 class="text-sm font-semibold text-highlighted">
              {{ t('collections.fill.list.missing') }}
            </h3>
            <ul class="mt-1 max-h-48 divide-y divide-default overflow-y-auto rounded-md border border-default text-sm">
              <li
                v-for="card in missing"
                :key="card.catalogCardId"
                class="flex items-baseline justify-between gap-3 px-3 py-1.5"
              >
                <span class="min-w-0 truncate text-highlighted">{{ cardName(card) }}</span>
                <span class="shrink-0 text-xs text-muted">
                  <span class="font-semibold tabular-nums text-warning">{{ t('collections.fill.missingCount', { count: n(card.missing, 'integer') }) }}</span>
                  <template v-if="card.ownedElsewhere > 0">
                    · {{ t('collections.fill.elsewhere', { count: n(card.ownedElsewhere, 'integer') }) }}
                  </template>
                </span>
              </li>
            </ul>
            <UButton
              v-if="notOwned.length > 0"
              class="mt-2"
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-heart"
              :label="wishlist === 'done' ? t('collections.fill.wishlist.done') : t('collections.fill.wishlist.add', { count: n(notOwned.length, 'integer') }, notOwned.length)"
              :loading="wishlist === 'saving'"
              :disabled="wishlist === 'done'"
              @click="addToWishlist"
            />
          </section>

          <p
            v-if="shown.cards.length > 0 && missing.length === 0 && moving.length + shown.totals.alreadyInTarget > 0"
            class="text-sm text-success"
          >
            {{ t('collections.fill.complete') }}
          </p>
        </div>

        <p
          v-if="errorMessage"
          role="alert"
          class="text-sm text-error"
        >
          {{ errorMessage }}
        </p>

        <div class="flex justify-end gap-2">
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            :label="result ? t('common.close') : t('common.cancel')"
            @click="() => { openProxy = false }"
          />
          <UButton
            v-if="!result"
            icon="i-lucide-folder-input"
            :loading="isRunning"
            :disabled="!plan || plan.totals.toMove === 0"
            :label="t('collections.fill.run')"
            @click="run"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
