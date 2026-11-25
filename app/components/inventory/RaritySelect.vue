<script setup lang="ts">
/**
 * The rarity of owned copies (ADR 0034): "Seltenheit unbekannt", the
 * rarities YGOPRODeck lists for the chosen set code (`suggested`) and
 * "Andere Seltenheit…", which opens the full list. Without suggestions (no
 * set code, or no usable data for it) the full list shows right away. Any
 * rarity may be picked: YGOPRODeck's data is not complete enough to forbid
 * one. `v-model` is the rarity key, `null` for "unknown".
 */
import { RARITIES, RARITY_GROUPS, rarityByKey, rarityLabel } from '~~/shared/rarity'
import type { Rarity } from '~~/shared/rarity'

const props = withDefaults(defineProps<{
  /** Rarity keys YGOPRODeck lists for the set code, in `RARITIES` order. */
  suggested?: string[]
  /** The select's accessible name. */
  label: string
  /** Shown instead of "unknown" while `asking` and nothing is picked. */
  placeholder?: string
  /** The rarity is wanted (quick entry, several listed): no selection shows the placeholder. */
  asking?: boolean
  color?: 'warning'
  highlight?: boolean
  size?: 'xs' | 'sm' | 'md'
}>(), {
  suggested: () => [],
  placeholder: undefined,
  asking: false,
  color: undefined,
  highlight: false,
  size: 'md',
})

const model = defineModel<string | null>({ required: true })

const { t } = useI18n()

// reka-ui reserves `''` for "no selection", so "unknown" and "other" get
// values of their own.
const UNKNOWN_VALUE = '__unknown__'
const OTHER_VALUE = '__other__'

const open = ref(false)
const showAll = ref(false)

// A new set code starts with its own suggestions again.
watch(() => props.suggested.join(','), () => {
  showAll.value = false
})

// Group headings (`type: 'label'`) have no value.
interface Item {
  label: string
  value?: string
  type?: 'label'
}

function rarityItem(rarity: Rarity): Item {
  return { label: rarityLabel(rarity.key)!, value: rarity.key }
}

const unknownItem = computed<Item>(() => ({ label: t('inventory.rarity.unknown'), value: UNKNOWN_VALUE }))

const fullList = computed<Item[][]>(() =>
  RARITY_GROUPS.map(group => [
    { type: 'label', label: t(`inventory.rarity.group.${group}`) },
    ...RARITIES.filter(rarity => rarity.group === group).map(rarityItem),
  ]),
)

const items = computed<Item[][]>(() => {
  const suggested = props.suggested.map(key => rarityByKey(key)).filter((rarity): rarity is Rarity => rarity !== undefined)
  // A picked rarity outside the suggestions shows the full list, so the
  // selection stays visible.
  const outside = model.value !== null && !props.suggested.includes(model.value)
  if (showAll.value || suggested.length === 0 || outside) {
    return [[unknownItem.value], ...fullList.value]
  }
  return [
    [unknownItem.value, ...suggested.map(rarityItem)],
    [{ label: t('inventory.rarity.other'), value: OTHER_VALUE }],
  ]
})

const selection = computed({
  get: () => model.value ?? (props.asking ? undefined : UNKNOWN_VALUE),
  set: (value: string | undefined) => {
    if (value === OTHER_VALUE) {
      showAll.value = true
      // Picking "other" closes the menu; it reopens with the full list.
      nextTick(() => {
        open.value = true
      })
      return
    }
    model.value = !value || value === UNKNOWN_VALUE ? null : value
  },
})
</script>

<template>
  <USelectMenu
    v-model="selection"
    v-model:open="open"
    :items="items"
    value-key="value"
    :placeholder="placeholder"
    :color="color"
    :highlight="highlight"
    :size="size"
    :aria-label="label"
    :search-input="{ placeholder: t('inventory.rarity.search') }"
    class="w-full min-w-0"
  />
</template>
