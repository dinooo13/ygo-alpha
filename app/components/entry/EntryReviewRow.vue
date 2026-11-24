<script setup lang="ts">
import {
  DEFAULT_VALUE,
  MAX_ENTRY_QUANTITY,
  NO_COLLECTION_VALUE,
  defaultPrintingId,
  entryRowStatus,
  needsRarity,
  rowPrintings,
  selectedCandidate,
} from '~/utils/card-entry'
import { printingRarityLabel } from '~~/shared/printing'
import type { EntryCandidate, EntryRow } from '~/utils/card-entry'
import type { CardDetailPreview } from '~/utils/card-detail'

interface PickedCatalogCard {
  id: number
  name: string
  nameDe: string | null
  type: string
  imageUrlSmall: string | null
}

const props = defineProps<{
  row: EntryRow
  collections: Array<{ id: string, name: string }>
}>()

const emit = defineEmits<{
  update: [patch: Partial<EntryRow>]
  remove: []
}>()

const { t } = useI18n()
const { cardName, cardValue } = useCardText()

const isPickerOpen = ref(false)

const status = computed(() => entryRowStatus(props.row))
const selected = computed(() => selectedCandidate(props.row))

// The selected card's overlay (#114); it loads the card only once opened.
const isCardOpen = ref(false)
const selectedPreview = computed<CardDetailPreview | null>(() => selected.value
  ? {
      name: selected.value.name,
      nameDe: selected.value.nameDe,
      type: selected.value.type,
      frameType: selected.value.frameType,
      imageSmall: selected.value.imageSmall,
      attribute: null,
      level: null,
      atk: null,
      def: null,
    }
  : null)

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
    const selectedCardId = value === undefined ? null : Number(value)
    emit('update', {
      selectedCardId,
      // The printing belongs to the card: start over with the new card's.
      printingId: defaultPrintingId(props.row.candidates.find(candidate => candidate.cardId === selectedCardId)),
      // The user just decided which card this line is.
      conflict: false,
    })
  },
})

// The printing under the parsed set code (ADR 0034): one is preselected;
// several rarities ask for a pick. "Printing unbekannt" stays possible.
const UNKNOWN_PRINTING_VALUE = '__unknown__'
const printings = computed(() => rowPrintings(props.row))
const askRarity = computed(() => needsRarity(props.row))
const printingItems = computed(() => [
  { label: t('inventory.printing.unknown'), value: UNKNOWN_PRINTING_VALUE },
  ...printings.value.map(printing => ({
    label: [printingRarityLabel(printing), printing.setName].filter(Boolean).join(' · '),
    value: printing.id,
  })),
])
const printingValue = computed({
  // Asking: the placeholder shows instead of "unknown".
  get: () => props.row.printingId ?? (askRarity.value ? undefined : UNKNOWN_PRINTING_VALUE),
  set: (value: string | undefined) => emit('update', {
    printingId: !value || value === UNKNOWN_PRINTING_VALUE ? null : value,
  }),
})

const quantityValue = computed({
  get: () => props.row.quantity,
  set: (value: number) => emit('update', {
    quantity: Math.min(MAX_ENTRY_QUANTITY, Math.max(1, Math.floor(Number(value) || 1))),
  }),
})

// The row's own collection; "Standard" inherits the default collection above
// the list (`row.collectionId === null`).
const collectionItems = computed(() => [
  { label: t('quickEntry.row.useDefault'), value: DEFAULT_VALUE },
  { label: t('inventory.noCollectionOption'), value: NO_COLLECTION_VALUE },
  ...props.collections.map(collection => ({ label: collection.name, value: collection.id })),
])

const collectionOverride = computed({
  get: () => props.row.collectionId ?? DEFAULT_VALUE,
  set: (value: string) => emit('update', { collectionId: value === DEFAULT_VALUE ? null : value }),
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
    // The parsed set code (and its printing) belonged to the old guess, not
    // to the card the user just pointed this row at.
    setCode: null,
    printingId: null,
    conflict: false,
  })
  isPickerOpen.value = false
}
</script>

<template>
  <div
    class="space-y-3 p-4"
    :data-status="status"
  >
    <div class="flex items-start gap-3">
      <CardThumb
        :src="selected?.imageSmall"
        :alt="selected ? cardName(selected) : row.query"
        size="sm"
      />

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            :color="statusMeta.color"
            variant="subtle"
            :label="statusMeta.label"
          />
          <span class="truncate font-mono text-xs text-muted">{{ row.raw }}</span>
          <UBadge
            v-if="row.setCode"
            color="neutral"
            variant="subtle"
            :label="row.setCode"
          />
        </div>
        <p class="mt-1 truncate text-sm font-medium text-highlighted">
          <button
            v-if="selected"
            type="button"
            aria-haspopup="dialog"
            class="block max-w-full truncate text-left transition-colors hover:text-primary"
            @click="() => { isCardOpen = true }"
          >
            {{ cardName(selected) }}
          </button>
          <template v-else>
            {{ t('quickEntry.status.ohne_treffer') }}
          </template>
        </p>
        <p
          v-if="selected"
          class="flex min-w-0 items-center gap-1.5 text-xs text-muted"
        >
          <CardFrameDot :type="selected.type" />
          <span class="truncate">{{ cardValue('type', selected.type) }}</span>
        </p>
        <p
          v-if="row.conflict"
          class="mt-1 text-xs text-warning"
        >
          {{ t('quickEntry.row.conflict') }}
        </p>
      </div>

      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        :aria-label="t('quickEntry.row.remove', { line: row.raw })"
        class="tap-target shrink-0"
        @click="emit('remove')"
      />
    </div>

    <!-- The stepper leads the second row: in the top row its tap targets
         would squeeze the card name on a phone. Its labels name the line. -->
    <div class="grid gap-3 sm:grid-cols-[auto_2fr_2fr_auto] sm:items-center">
      <CardQuantityStepper
        v-model="quantityValue"
        :min="1"
        :max="MAX_ENTRY_QUANTITY"
        size="xs"
        class="justify-self-start"
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
      />
      <p
        v-else
        class="self-center text-xs text-muted"
      >
        {{ t('quickEntry.row.noSuggestions') }}
      </p>

      <USelect
        v-model="collectionOverride"
        :items="collectionItems"
        :aria-label="t('quickEntry.row.collectionFor', { line: row.raw })"
      />

      <UButton
        icon="i-lucide-search"
        color="neutral"
        variant="outline"
        :label="t('quickEntry.row.catalog')"
        @click="() => { isPickerOpen = true }"
      />
    </div>

    <div
      v-if="printings.length > 0"
      class="flex flex-wrap items-center gap-2"
      data-testid="entry-printing"
    >
      <span class="text-xs text-muted">{{ t('quickEntry.row.printing', { setCode: printings[0]!.setCode }) }}</span>
      <USelect
        v-model="printingValue"
        :items="printingItems"
        :placeholder="t('quickEntry.row.pickRarity')"
        :aria-label="t('quickEntry.row.printingFor', { line: row.raw })"
        :color="askRarity ? 'warning' : undefined"
        :highlight="askRarity"
        class="min-w-0 flex-1 sm:max-w-md"
      />
      <p
        v-if="askRarity"
        class="w-full text-xs text-warning"
      >
        {{ t('quickEntry.row.severalRarities', { setCode: printings[0]!.setCode, count: printings.length }) }}
      </p>
    </div>

    <UModal
      v-model:open="isPickerOpen"
      :title="t('inventory.picker.title')"
    >
      <template #body>
        <InventoryCatalogCardPicker @select="onPicked" />
      </template>
    </UModal>

    <CardDetailModal
      v-model:open="isCardOpen"
      :card-id="selected?.cardId ?? null"
      :preview="selectedPreview"
      variant="catalog"
    />
  </div>
</template>
