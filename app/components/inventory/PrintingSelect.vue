<script setup lang="ts">
/**
 * The printing of owned copies (ADR 0034): the set code ("Set-Code
 * unbekannt" or one of the card's, searchable by code and set name) and the
 * rarity (`InventoryRaritySelect`, suggesting what YGOPRODeck lists for the
 * set code). Choosing a set code with a single listed rarity picks that
 * rarity. Used by "Karte hinzufügen" and the copies in the card's detail
 * panel. `v-model` is the whole printing, so one change is one update.
 */
import type { CardSetCode, StackPrinting } from '~~/shared/printing'

const props = withDefaults(defineProps<{
  setCodes: CardSetCode[]
  /** Prefix of the selects' accessible names, e.g. the stack's label. */
  label: string
  loading?: boolean
  size?: 'xs' | 'sm' | 'md'
}>(), {
  loading: false,
  size: 'md',
})

const model = defineModel<StackPrinting>({ required: true })

const { t } = useI18n()

const UNKNOWN_VALUE = '__unknown__'

const setCodeItems = computed(() => [
  { label: t('inventory.printing.unknownSetCode'), value: UNKNOWN_VALUE },
  ...props.setCodes.map(entry => ({ label: entry.setCode, description: entry.setName, value: entry.setCode })),
])

const current = computed(() => props.setCodes.find(entry => entry.setCode === model.value.setCode))

const setCodeSelection = computed({
  get: () => model.value.setCode ?? UNKNOWN_VALUE,
  set: (value: string | undefined) => {
    const setCode = !value || value === UNKNOWN_VALUE ? null : value
    const listed = props.setCodes.find(entry => entry.setCode === setCode)?.rarities ?? []
    model.value = { setCode, rarity: listed.length === 1 ? listed[0]! : model.value.rarity }
  },
})

const raritySelection = computed({
  get: () => model.value.rarity,
  set: (rarity: string | null) => {
    model.value = { setCode: model.value.setCode, rarity }
  },
})
</script>

<template>
  <div class="grid min-w-0 gap-2 sm:grid-cols-2">
    <USelectMenu
      v-model="setCodeSelection"
      :items="setCodeItems"
      value-key="value"
      :filter-fields="['label', 'description']"
      :loading="loading"
      :size="size"
      :aria-label="t('inventory.printing.setCodeFor', { label })"
      :search-input="{ placeholder: t('inventory.printing.search') }"
      class="w-full min-w-0"
      data-testid="printing-set-code"
    />
    <InventoryRaritySelect
      v-model="raritySelection"
      :suggested="current?.rarities ?? []"
      :size="size"
      :label="t('inventory.printing.rarityFor', { label })"
      data-testid="printing-rarity"
    />
  </div>
</template>
