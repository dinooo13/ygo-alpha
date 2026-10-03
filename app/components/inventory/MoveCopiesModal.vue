<script setup lang="ts">
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { CollectionItem } from '~/composables/useCollections'
import type { MoveCopiesResult } from '~/composables/useMoveCopies'

/**
 * "Verschieben": moves owned copies into another collection. The inventory is
 * the master list and collections partition it, so a move takes the copies out
 * of their collection and puts them into the target; nothing is counted twice.
 *
 * - One entry (a "Liste" row): a quantity stepper, default all copies. Fewer
 *   than all splits the stack.
 * - Several entries (the selection): whole stacks. Entries that already are in
 *   the target stay where they are.
 * - The target is "ohne Sammlung", a collection or a new one (`CollectionsTargetSelect`).
 */
export interface MoveEntry {
  ownedCardId: string
  /** The card's name as shown. */
  name: string
  /** Copies in the stack. */
  quantity: number
  /** The stack's collection, `null` = none. */
  collectionId: string | null
}

const props = defineProps<{
  open: boolean
  entries: MoveEntry[]
  collections: CollectionItem[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  moved: [result: MoveCopiesResult, targetName: string]
}>()

const { t, n } = useI18n()
const toast = useToast()
const { moveCopies, moveErrorMessage } = useMoveCopies()

const openProxy = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const target = ref('')
const quantity = ref(1)
const isSubmitting = ref(false)
const errorMessage = ref('')

const isSingle = computed(() => props.entries.length === 1)
const totalCopies = computed(() => props.entries.reduce((sum, entry) => sum + entry.quantity, 0))

watch(
  () => [props.open, props.entries] as const,
  () => {
    if (!props.open) {
      return
    }
    target.value = ''
    quantity.value = props.entries.length === 1 ? props.entries[0]!.quantity : 1
    errorMessage.value = ''
  },
  { immediate: true },
)

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

// Where the entries come from, when it is one place: that one is no target.
const sharedSource = computed(() => {
  const [first] = props.entries
  return first && props.entries.every(entry => entry.collectionId === first.collectionId)
    ? { id: first.collectionId }
    : null
})

const targetId = computed<string | null>(() => target.value === UNASSIGNED_COLLECTION_ID ? null : target.value)
// What actually moves: entries already in the target stay.
const movable = computed(() => target.value === '' ? [] : props.entries.filter(entry => entry.collectionId !== targetId.value))
const staying = computed(() => target.value === '' ? 0 : props.entries.length - movable.value.length)

const summary = computed(() => isSingle.value
  ? t('inventory.move.single', { count: n(props.entries[0]!.quantity, 'integer'), collection: collectionName(props.entries[0]!.collectionId) }, props.entries[0]!.quantity)
  : t('inventory.move.multiple', { stacks: n(props.entries.length, 'integer'), count: n(totalCopies.value, 'integer') }, totalCopies.value))

async function submit() {
  if (target.value === '' || movable.value.length === 0) {
    return
  }

  isSubmitting.value = true
  errorMessage.value = ''
  try {
    const result = await moveCopies(movable.value.map(entry => ({
      ownedCardId: entry.ownedCardId,
      // A single entry may move fewer than all copies; a selection moves whole stacks.
      quantity: isSingle.value ? quantity.value : undefined,
      toCollectionId: targetId.value,
    })))
    const name = targetName(targetId.value)
    toast.add({
      title: t('inventory.move.success', { count: n(result.moved, 'integer'), collection: name }, result.moved),
      icon: 'i-lucide-check',
      color: 'success',
    })
    emit('moved', result, name)
    openProxy.value = false
  }
  catch (error) {
    errorMessage.value = moveErrorMessage(error)
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openProxy"
    :title="t('inventory.move.title')"
    :description="summary"
  >
    <template #body>
      <form
        class="space-y-4"
        @submit.prevent="submit"
      >
        <div v-if="isSingle">
          <p class="text-sm font-medium text-highlighted">
            {{ entries[0]!.name }}
          </p>
        </div>
        <ul
          v-else
          class="max-h-40 space-y-0.5 overflow-y-auto text-sm text-default"
          :aria-label="t('inventory.move.selected')"
        >
          <li
            v-for="entry in entries"
            :key="entry.ownedCardId"
            class="flex justify-between gap-3"
          >
            <span class="truncate">{{ entry.name }}</span>
            <span class="shrink-0 tabular-nums text-muted">×{{ n(entry.quantity, 'integer') }}</span>
          </li>
        </ul>

        <UFormField
          v-if="isSingle"
          :label="t('inventory.move.quantity')"
        >
          <CardQuantityStepper
            v-model="quantity"
            :min="1"
            :max="entries[0]!.quantity"
            size="md"
            name="quantity"
            :input-label="t('inventory.move.quantity')"
            :decrease-label="t('inventory.move.decrease')"
            :increase-label="t('inventory.move.increase')"
          />
        </UFormField>

        <UFormField :label="t('inventory.move.target')">
          <CollectionsTargetSelect
            v-model="target"
            :collections="collections"
            :exclude-ids="sharedSource?.id ? [sharedSource.id] : []"
            :allow-none="!sharedSource || sharedSource.id !== null"
            :label="t('inventory.move.target')"
          />
        </UFormField>

        <p
          v-if="staying > 0 && movable.length > 0"
          class="text-xs text-muted"
        >
          {{ t('inventory.move.staying', { count: n(staying, 'integer') }, staying) }}
        </p>
        <p
          v-else-if="staying > 0"
          class="text-xs text-warning"
        >
          {{ t('inventory.move.alreadyThere') }}
        </p>

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
            :label="t('common.cancel')"
            @click="() => { openProxy = false }"
          />
          <UButton
            type="submit"
            icon="i-lucide-folder-input"
            :loading="isSubmitting"
            :disabled="target === '' || movable.length === 0"
            :label="t('inventory.move.submit')"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
