<script setup lang="ts">
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { CollectionItem } from '~/composables/useCollections'

/**
 * The inventory's collection scope: a "Sammlung" select (all cards, cards
 * without a collection, or one collection), "Neue Sammlung", and for a real
 * collection a "…" menu with Umbenennen / Teilen / Aus Deck befüllen / Löschen.
 *
 * `v-model` is the selected collection id — `''` for all cards,
 * `UNASSIGNED_COLLECTION_ID` for cards without a collection. The parent keeps
 * it in the URL (`?collectionId=`).
 */
const props = defineProps<{
  collections: CollectionItem[]
  allCount: number
  unassignedCount: number
}>()

const emit = defineEmits<{
  // A collection was created, renamed or its visibility changed.
  changed: []
  // The selected collection was deleted (the model is already reset to '').
  deleted: []
  // Copies were moved into the collection from a deck: the lists behind changed.
  filled: []
}>()

const model = defineModel<string>({ required: true })

const { t, n } = useI18n()
const apiError = useApiError()

// reka-ui's <SelectItem> reserves `''` for "no selection", so "Alle
// Sammlungen" needs a non-empty sentinel that maps back to `''`.
const allValue = '__all__'

const selectItems = computed(() => [
  { label: t('collections.select.all', { count: n(props.allCount, 'integer') }), value: allValue },
  { label: t('collections.select.unassigned', { count: n(props.unassignedCount, 'integer') }), value: UNASSIGNED_COLLECTION_ID },
  ...props.collections.map(c => ({ label: t('collections.select.collection', { name: c.name, count: n(c.cardCount, 'integer') }), value: c.id })),
])

const selection = computed({
  get: () => model.value || allValue,
  set: (value: string) => {
    model.value = value === allValue ? '' : value
  },
})

const activeCollection = computed(() => props.collections.find(c => c.id === model.value) ?? null)

const isFormOpen = ref(false)
const editingCollection = ref<CollectionItem | null>(null)

function openCreate() {
  editingCollection.value = null
  isFormOpen.value = true
}

function openRename(collection: CollectionItem) {
  editingCollection.value = collection
  isFormOpen.value = true
}

function onSaved(saved: { id: string, name: string }) {
  // Refresh first: the parent drops an unknown `collectionId` once the list
  // has loaded, so the new one must not look stale in between.
  emit('changed')
  if (!editingCollection.value) {
    model.value = saved.id
  }
}

const { confirm } = useConfirm()
const toast = useToast()

async function onDelete(collection: CollectionItem) {
  const confirmed = await confirm({
    title: t('collections.confirm.delete.title'),
    description: t('collections.confirm.delete.description', { name: collection.name }),
  })
  if (!confirmed) {
    return
  }

  try {
    await $fetch(`/api/collections/${collection.id}`, { method: 'DELETE' })
  }
  catch (error) {
    toast.add({ title: apiError(error, 'collections.errors.deleteFailed'), color: 'error' })
    return
  }

  model.value = ''
  emit('deleted')
}

// Cheap, lazily creates the profile on first read — only needed to build the
// "Teilen" share link (`/players/:handle/collections/:id`).
const { data: ownProfile } = await useOwnProfile()

const isShareOpen = ref(false)
const sharingCollection = ref<CollectionItem | null>(null)
const sharePath = computed(() => `/players/${ownProfile.value?.handle ?? ''}/collections/${sharingCollection.value?.id ?? ''}`)

function openShare(collection: CollectionItem) {
  sharingCollection.value = collection
  isShareOpen.value = true
}

function onShareUpdated() {
  emit('changed')
}

// "Aus Deck befüllen": moves the copies a deck needs into the collection.
const isFillOpen = ref(false)

const menuItems = computed(() => {
  const collection = activeCollection.value
  if (!collection) {
    return []
  }
  return [[
    {
      label: t('collections.menu.rename'),
      icon: 'i-lucide-pencil',
      onSelect: () => openRename(collection),
    },
    {
      label: t('collections.menu.share'),
      icon: 'i-lucide-share-2',
      // Without a loaded handle, sharePath would resolve to a broken
      // `/players//collections/:id` link — keep the entry disabled until then.
      disabled: !ownProfile.value?.handle,
      onSelect: () => openShare(collection),
    },
    {
      label: t('collections.menu.fillFromDeck'),
      icon: 'i-lucide-folder-input',
      onSelect: () => { isFillOpen.value = true },
    },
    {
      label: t('common.delete'),
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => onDelete(collection),
    },
  ]]
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <USelect
      v-model="selection"
      :items="selectItems"
      :aria-label="t('card.field.collection')"
      class="w-56 max-w-full"
    />

    <UDropdownMenu
      v-if="activeCollection"
      :items="menuItems"
    >
      <UButton
        icon="i-lucide-more-horizontal"
        color="neutral"
        variant="outline"
        class="tap-target"
        :aria-label="t('collections.menu.optionsFor', { name: activeCollection.name })"
      />
    </UDropdownMenu>

    <UButton
      icon="i-lucide-folder-plus"
      :label="t('collections.create')"
      color="neutral"
      variant="ghost"
      @click="openCreate"
    />

    <CollectionsCollectionFormModal
      v-model:open="isFormOpen"
      :initial-values="editingCollection"
      @saved="onSaved"
    />

    <CollectionsFillFromDeckModal
      v-model:open="isFillOpen"
      :collection-id="activeCollection?.id ?? null"
      :collections="collections"
      @done="emit('filled')"
    />

    <SharingShareModal
      v-if="sharingCollection"
      v-model:open="isShareOpen"
      resource-type="collection"
      :resource-id="sharingCollection.id"
      :resource-name="sharingCollection.name"
      :share-path="sharePath"
      @updated="onShareUpdated"
    />
  </div>
</template>
