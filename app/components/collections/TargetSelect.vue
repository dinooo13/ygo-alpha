<script setup lang="ts">
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { CollectionItem } from '~/composables/useCollections'

/**
 * A collection to move cards into: "ohne Sammlung", one of the collections
 * and "Neue Sammlung…", which opens the create form and selects what it
 * creates. Used by the move dialog, the "gerade gespeichert" panel of the
 * quick entry and the deck-to-collection dialog.
 *
 * `v-model` is the picked collection id, `UNASSIGNED_COLLECTION_ID` for
 * "ohne Sammlung" and `''` while nothing is picked (the placeholder shows).
 * `excludeIds` leaves collections out (the one the cards already are in).
 */
const props = withDefaults(defineProps<{
  collections: CollectionItem[]
  excludeIds?: string[]
  allowNone?: boolean
  allowNew?: boolean
  /** The select's accessible name. */
  label: string
}>(), {
  excludeIds: () => [],
  allowNone: true,
  allowNew: true,
})

const model = defineModel<string>({ required: true })

const { t } = useI18n()

// reka-ui reserves `''` for "no selection": "Neue Sammlung…" is an action, not a value.
const NEW_VALUE = '__new__'

const items = computed(() => [
  ...(props.allowNone ? [{ label: t('inventory.scope.unassigned'), value: UNASSIGNED_COLLECTION_ID }] : []),
  ...props.collections
    .filter(collection => !props.excludeIds.includes(collection.id))
    .map(collection => ({ label: collection.name, value: collection.id })),
  ...(props.allowNew ? [{ label: t('collections.createEllipsis'), value: NEW_VALUE, icon: 'i-lucide-folder-plus' }] : []),
])

const isFormOpen = ref(false)

const selection = computed({
  get: () => model.value || undefined,
  set: (value: string | undefined) => {
    if (value === NEW_VALUE) {
      isFormOpen.value = true
      return
    }
    model.value = value ?? ''
  },
})

async function onCreated(created: { id: string }) {
  // The new collection is in the shared list before it is selected.
  await refreshNuxtData('collections')
  model.value = created.id
}
</script>

<template>
  <div>
    <USelect
      v-model="selection"
      :items="items"
      :placeholder="t('collections.target.placeholder')"
      :aria-label="label"
      class="w-full"
    />

    <CollectionsCollectionFormModal
      v-model:open="isFormOpen"
      @saved="onCreated"
    />
  </div>
</template>
