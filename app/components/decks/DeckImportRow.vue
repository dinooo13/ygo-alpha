<script setup lang="ts">
/**
 * One line of the deck import review: the card the line resolved to (or the
 * candidates to pick from), its copies, and a catalog search for a line
 * without a match. The compact sibling of `EntryReviewRow`, without the
 * collection column.
 */
import { MAX_ENTRY_QUANTITY, entryRowStatus, selectedCandidate } from '~/utils/card-entry'
import type { EntryCandidate } from '~/utils/card-entry'
import type { DeckImportRow } from '~/utils/deck-import'

interface PickedCatalogCard {
  id: number
  name: string
  nameDe: string | null
  type: string
  imageUrlSmall: string | null
}

const props = defineProps<{
  row: DeckImportRow
}>()

const emit = defineEmits<{
  update: [patch: Partial<DeckImportRow>]
  remove: []
}>()

const { t } = useI18n()
const { cardName, cardValue } = useCardText()

const isPickerOpen = ref(false)

const status = computed(() => entryRowStatus(props.row))
const selected = computed(() => selectedCandidate(props.row))

const statusMeta = computed(() => {
  switch (status.value) {
    case 'sicher':
      return { label: t('quickEntry.status.sicher'), color: 'success' as const }
    case 'unsicher':
      return { label: t('quickEntry.status.unsicher'), color: 'warning' as const }
    default:
      return { label: t('quickEntry.status.ohne_treffer'), color: 'error' as const }
  }
})

const candidateItems = computed(() => props.row.candidates.map(candidate => ({
  label: t('quickEntry.row.candidate', {
    name: cardName(candidate),
    matchedBy: t(`quickEntry.matchedBy.${candidate.matchedBy}`),
    score: Math.round(candidate.score * 100),
  }),
  value: String(candidate.cardId),
})))

const candidateValue = computed({
  get: () => props.row.selectedCardId === null ? undefined : String(props.row.selectedCardId),
  set: (value: string | undefined) => {
    emit('update', { selectedCardId: value === undefined ? null : Number(value), conflict: false })
  },
})

const quantityValue = computed({
  get: () => props.row.quantity,
  set: (value: number) => emit('update', {
    quantity: Math.min(MAX_ENTRY_QUANTITY, Math.max(1, Math.floor(Number(value) || 1))),
  }),
})

function onPicked(card: PickedCatalogCard) {
  const candidate: EntryCandidate = {
    cardId: card.id,
    name: card.name,
    nameDe: card.nameDe,
    type: card.type,
    frameType: null,
    imageSmall: card.imageUrlSmall ?? null,
    score: 1,
    matchedBy: 'exact',
  }

  emit('update', {
    candidates: [candidate, ...props.row.candidates.filter(entry => entry.cardId !== candidate.cardId)],
    selectedCardId: candidate.cardId,
    setCode: null,
    conflict: false,
  })
  isPickerOpen.value = false
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
    :data-status="status"
  >
    <CardThumb
      :src="selected?.imageSmall"
      :alt="selected ? cardName(selected) : row.query"
      size="sm"
    />

    <div class="min-w-0 flex-1 basis-40">
      <p class="truncate text-sm font-medium text-highlighted">
        {{ selected ? cardName(selected) : t('quickEntry.status.ohne_treffer') }}
      </p>
      <p class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <UBadge
          :color="statusMeta.color"
          variant="subtle"
          size="sm"
          :label="statusMeta.label"
        />
        <span class="truncate font-mono">{{ row.raw }}</span>
      </p>
      <p
        v-if="selected"
        class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted"
      >
        <CardFrameDot :type="selected.type" />
        <span class="truncate">{{ cardValue('type', selected.type) }}</span>
      </p>
    </div>

    <CardQuantityStepper
      v-model="quantityValue"
      :min="1"
      :max="MAX_ENTRY_QUANTITY"
      size="xs"
      :input-label="t('quickEntry.row.quantityFor', { line: row.raw })"
      :decrease-label="t('quickEntry.row.decreaseFor', { line: row.raw })"
      :increase-label="t('quickEntry.row.increaseFor', { line: row.raw })"
    />

    <USelect
      v-if="row.candidates.length > 0"
      v-model="candidateValue"
      :items="candidateItems"
      :placeholder="t('quickEntry.row.pickCandidate')"
      :aria-label="t('quickEntry.row.candidateFor', { line: row.raw })"
      class="w-full sm:w-64"
    />
    <p
      v-else
      class="text-xs text-muted"
    >
      {{ t('quickEntry.row.noSuggestions') }}
    </p>

    <UButton
      icon="i-lucide-search"
      color="neutral"
      variant="outline"
      size="sm"
      :label="t('quickEntry.row.catalog')"
      @click="() => { isPickerOpen = true }"
    />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="t('quickEntry.row.remove', { line: row.raw })"
      class="tap-target shrink-0"
      @click="emit('remove')"
    />

    <UModal
      v-model:open="isPickerOpen"
      :title="t('inventory.picker.title')"
      :ui="{ overlay: 'z-[60]', content: 'z-[60]' }"
    >
      <template #body>
        <InventoryCatalogCardPicker @select="onPicked" />
      </template>
    </UModal>
  </div>
</template>
