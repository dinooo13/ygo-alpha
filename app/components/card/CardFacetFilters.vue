<script setup lang="ts">
import { CARD_KINDS } from '~~/shared/card-kind'
import type { CardKind } from '~~/shared/card-kind'

/**
 * The card facet menus (kind, type, attribute, race, level), shared by the
 * catalog and the inventory so both filter the same way (#63), and by the
 * format editor's card filter (#120).
 *
 * - Multi-select; an empty array means "no filter".
 * - "Kartenart" (`kind`) is the grouped filter by frame, "Typ" the exact type
 *   line below it (shared/card-kind.ts); leave out `v-model:kind` to hide it.
 * - Multi-root (no wrapper): the parent's grid or flex places the menus, and
 *   `menuClass` sets their width (a multi-root component doesn't inherit `class`).
 * - Leave out `v-model:level` to hide the level menu (the format editor
 *   filters levels by range).
 * - `disabled` disables every menu (a read-only built-in format).
 */
export interface CardFacetOptions {
  types: string[]
  attributes: string[]
  races: string[]
  levels: number[]
}

const props = withDefaults(defineProps<{
  facets: CardFacetOptions
  /** Width classes for each menu; the parent's grid/flex places them. */
  menuClass?: string
  disabled?: boolean
}>(), { menuClass: 'w-full min-w-0', disabled: false })

const kind = defineModel<CardKind[]>('kind')
const type = defineModel<string[]>('type', { required: true })
const attribute = defineModel<string[]>('attribute', { required: true })
const race = defineModel<string[]>('race', { required: true })
const level = defineModel<number[]>('level')

const { t } = useI18n()
const { cardValueOptions } = useCardText()

// Filter values stay English (the APIs filter on them); labels follow the card language (ADR 0015).
const kindItems = computed(() => CARD_KINDS.map(value => ({ label: t(`card.kind.${value}`), value })))
const typeItems = computed(() => cardValueOptions('type', props.facets.types))
const attributeItems = computed(() => cardValueOptions('attribute', props.facets.attributes))
const raceItems = computed(() => cardValueOptions('race', props.facets.races))
const levelItems = computed(() => props.facets.levels.map(value => ({ label: t('card.levelFilterOption', { value }), value })))
</script>

<template>
  <USelectMenu
    v-if="kind !== undefined"
    v-model="kind"
    multiple
    value-key="value"
    :items="kindItems"
    :disabled="disabled"
    :placeholder="t('card.field.kind')"
    :aria-label="t('card.field.kind')"
    :class="menuClass"
  />
  <USelectMenu
    v-model="type"
    multiple
    value-key="value"
    :items="typeItems"
    :disabled="disabled"
    :placeholder="t('card.field.type')"
    :aria-label="t('card.field.type')"
    :class="menuClass"
  />
  <USelectMenu
    v-model="attribute"
    multiple
    value-key="value"
    :items="attributeItems"
    :disabled="disabled"
    :placeholder="t('card.field.attribute')"
    :aria-label="t('card.field.attribute')"
    :class="menuClass"
  />
  <USelectMenu
    v-model="race"
    multiple
    value-key="value"
    :items="raceItems"
    :disabled="disabled"
    :placeholder="t('card.field.race')"
    :aria-label="t('card.field.race')"
    :class="menuClass"
  />
  <USelectMenu
    v-if="level !== undefined"
    v-model="level"
    multiple
    value-key="value"
    :items="levelItems"
    :disabled="disabled"
    :placeholder="t('card.field.level')"
    :aria-label="t('card.field.level')"
    :class="menuClass"
  />
</template>
