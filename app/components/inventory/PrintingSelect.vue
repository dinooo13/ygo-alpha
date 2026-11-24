<script setup lang="ts">
/**
 * The printing of owned copies (ADR 0034): "Printing unbekannt" or one of
 * the card's printings (set code and rarity, the set name below), searchable
 * by both. Used by "Karte hinzufügen" and the copies in the card's detail
 * panel. `v-model` is the printing id, `null` for "printing unknown".
 */
import { printingRarityLabel } from '~~/shared/printing'
import type { CardPrinting } from '~/composables/useCardPrintings'

const props = withDefaults(defineProps<{
  printings: CardPrinting[]
  /** The select's accessible name. */
  label: string
  loading?: boolean
  size?: 'xs' | 'sm' | 'md'
}>(), {
  loading: false,
  size: 'md',
})

const model = defineModel<string | null>({ required: true })

const { t } = useI18n()

// reka-ui reserves `''` for "no selection", so "unknown" gets a value of its own.
const UNKNOWN_VALUE = '__unknown__'

const items = computed(() => [
  { label: t('inventory.printing.unknown'), value: UNKNOWN_VALUE },
  ...props.printings.map(printing => ({
    label: [printing.setCode, printingRarityLabel(printing)].filter(Boolean).join(' · '),
    description: printing.setName,
    value: printing.id,
  })),
])

const selection = computed({
  get: () => model.value ?? UNKNOWN_VALUE,
  set: (value: string | undefined) => {
    model.value = !value || value === UNKNOWN_VALUE ? null : value
  },
})
</script>

<template>
  <USelectMenu
    v-model="selection"
    :items="items"
    value-key="value"
    :filter-fields="['label', 'description']"
    :loading="loading"
    :size="size"
    :aria-label="label"
    :search-input="{ placeholder: t('inventory.printing.search') }"
    class="w-full min-w-0"
  />
</template>
