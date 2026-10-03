<script setup lang="ts">
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { CollectionItem } from '~/composables/useCollections'
import { applyMovedCopies } from '~/utils/saved-copies'
import type { SavedCopy } from '~/utils/saved-copies'

/**
 * "Gerade gespeichert": what the quick entry just wrote (card, copies,
 * collection), kept after the review table has emptied so the copies can go
 * to another collection without typing the list in again. A move takes exactly
 * these copies out of the collection they were saved into
 * (`POST /api/inventory/move`) and into the target; nothing is written twice
 * and the review table is not touched. The panel follows the copies, so they
 * can be moved again; "Schließen" dismisses it.
 */
const props = defineProps<{
  collections: CollectionItem[]
}>()

const copies = defineModel<SavedCopy[]>('copies', { required: true })

const { t, n } = useI18n()
const { cardName } = useCardText()
const toast = useToast()
const { moveCopies, moveErrorMessage } = useMoveCopies()
const count = useCount()

// Every copy is picked until the user unticks it; a copy added later is picked too.
const unpicked = ref<Set<string>>(new Set())
const target = ref('')
const isMoving = ref(false)
const errorMessage = ref('')

const heading = useTemplateRef<HTMLElement>('heading')
// The panel appears where the save button was: bring it into view.
defineExpose({
  focus: () => {
    heading.value?.focus()
    heading.value?.scrollIntoView?.({ block: 'nearest' })
  },
})

// A stack's collection as the inventory rows word it.
function collectionName(collectionId: string | null): string {
  if (collectionId === null) {
    return t('inventory.breakdown.noCollection')
  }
  return props.collections.find(collection => collection.id === collectionId)?.name ?? t('inventory.breakdown.unnamedCollection')
}

// The target as the select words it ("Ohne Sammlung").
function targetName(collectionId: string | null): string {
  return collectionId === null ? t('inventory.scope.unassigned') : collectionName(collectionId)
}

const targetId = computed<string | null>(() => target.value === UNASSIGNED_COLLECTION_ID ? null : target.value)
const picked = computed(() => copies.value.filter(copy => !unpicked.value.has(copy.ownedCardId)))
// Copies already in the target stay.
const movable = computed(() => target.value === '' ? [] : picked.value.filter(copy => copy.collectionId !== targetId.value))
const totalCopies = computed(() => copies.value.reduce((sum, copy) => sum + copy.quantity, 0))

function setPicked(copy: SavedCopy, value: boolean) {
  const next = new Set(unpicked.value)
  if (value) {
    next.delete(copy.ownedCardId)
  }
  else {
    next.add(copy.ownedCardId)
  }
  unpicked.value = next
}

async function move() {
  if (movable.value.length === 0) {
    return
  }

  isMoving.value = true
  errorMessage.value = ''
  const toCollectionId = targetId.value
  try {
    const result = await moveCopies(movable.value.map(copy => ({
      ownedCardId: copy.ownedCardId,
      quantity: copy.quantity,
      toCollectionId,
    })))
    copies.value = applyMovedCopies(copies.value, result.items, toCollectionId)
    unpicked.value = new Set()
    toast.add({
      title: t('inventory.move.success', { count: n(result.moved, 'integer'), collection: targetName(toCollectionId) }, result.moved),
      icon: 'i-lucide-check',
      color: 'success',
    })
  }
  catch (error) {
    errorMessage.value = moveErrorMessage(error)
  }
  finally {
    isMoving.value = false
  }
}
</script>

<template>
  <section
    class="panel space-y-4 p-4"
    aria-labelledby="just-saved-title"
    data-testid="just-saved"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2
          id="just-saved-title"
          ref="heading"
          tabindex="-1"
          class="text-lg font-semibold text-highlighted outline-none"
        >
          {{ t('quickEntry.justSaved.title') }}
        </h2>
        <p class="mt-1 text-sm text-muted">
          {{ t('quickEntry.justSaved.description', { count: n(totalCopies, 'integer') }, totalCopies) }}
        </p>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        class="tap-target shrink-0"
        :label="t('quickEntry.justSaved.dismiss')"
        @click="() => { copies = [] }"
      />
    </div>

    <ul
      class="max-h-72 divide-y divide-default overflow-y-auto rounded-md border border-default"
      :aria-label="t('quickEntry.justSaved.list')"
    >
      <li
        v-for="copy in copies"
        :key="copy.ownedCardId"
        class="flex items-center gap-3 px-3 py-2 text-sm"
      >
        <UCheckbox
          :model-value="!unpicked.has(copy.ownedCardId)"
          :aria-label="t('quickEntry.justSaved.pick', { name: cardName(copy) })"
          @update:model-value="value => setPicked(copy, value === true)"
        />
        <span class="min-w-0 flex-1 truncate font-medium text-highlighted">{{ cardName(copy) }}</span>
        <span class="shrink-0 tabular-nums text-muted">×{{ n(copy.quantity, 'integer') }}</span>
        <span class="inline-flex w-32 shrink-0 items-center gap-1 text-xs text-muted sm:w-44">
          <UIcon
            name="i-lucide-folder"
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t('card.field.collection') }}: </span>
          <span class="truncate">{{ collectionName(copy.collectionId) }}</span>
        </span>
      </li>
    </ul>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <CollectionsTargetSelect
        v-model="target"
        :collections="collections"
        :label="t('quickEntry.justSaved.target')"
        class="w-full sm:max-w-xs"
      />
      <UButton
        icon="i-lucide-folder-input"
        :label="t('quickEntry.justSaved.move')"
        :loading="isMoving"
        :disabled="movable.length === 0"
        @click="move"
      />
      <p
        v-if="target !== '' && picked.length > 0 && movable.length < picked.length"
        class="text-xs text-muted"
      >
        {{ count('inventory.move.staying', picked.length - movable.length) }}
      </p>
    </div>

    <p
      v-if="errorMessage"
      role="alert"
      class="text-sm text-error"
    >
      {{ errorMessage }}
    </p>
  </section>
</template>
