<script setup lang="ts">
import type { CardKind } from '~~/shared/card-kind'
import type { CardFacetOptions } from '~/components/card/CardFacetFilters.vue'
import { UNKNOWN_PRINTING_FILTER } from '~~/shared/printing'

export interface InventorySearchFilters {
  kind: CardKind[]
  type: string[]
  attribute: string[]
  race: string[]
  level: number[]
  /** Set ids and/or `UNKNOWN_PRINTING_FILTER` ("Printing unbekannt", ADR 0034). */
  set: string[]
  sort: 'name' | '-name' | 'quantity' | 'newest'
}

/** The card facets plus the sets of the owned printings (`GET /api/inventory/search/facets`). */
export interface InventorySearchFacetOptions extends CardFacetOptions {
  sets?: Array<{ id: string, name: string }>
  hasUnknownPrinting?: boolean
}

const props = withDefaults(defineProps<{
  facets: InventorySearchFacetOptions
  /** The sort select; only "Galerie" sorts ("Liste" stays "recently changed first"). */
  showSort?: boolean
}>(), {
  showSort: true,
})

const { t } = useI18n()

const filters = defineModel<InventorySearchFilters>('filters', { required: true })

// "Set / Printing": the sets the user owns printings of, and the copies
// without a printing. Set names come from YGOPRODeck, English only. Hidden
// until some copy has a printing: "unknown" alone filters nothing useful.
const setItems = computed(() => [
  ...(props.facets.hasUnknownPrinting ? [{ label: t('inventory.printing.unknown'), value: UNKNOWN_PRINTING_FILTER }] : []),
  ...(props.facets.sets ?? []).map(set => ({ label: set.name, value: set.id })),
])

const sortItems = computed(() => [
  { label: t('inventory.search.sort.nameAsc'), value: 'name' },
  { label: t('inventory.search.sort.nameDesc'), value: '-name' },
  { label: t('inventory.search.sort.quantity'), value: 'quantity' },
  { label: t('inventory.search.sort.newest'), value: 'newest' },
])

function resetFilters() {
  // Mutate the shared filters object in place (rather than reassigning
  // `filters.value`) so fields owned by the parent (q, inText, page) that
  // this panel doesn't render controls for are left untouched. The
  // collection is the page's scope (URL), not a filter — Reset keeps it.
  filters.value.kind = []
  filters.value.type = []
  filters.value.attribute = []
  filters.value.race = []
  filters.value.level = []
  filters.value.set = []
  filters.value.sort = 'name'
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <CardFacetFilters
        v-model:kind="filters.kind"
        v-model:type="filters.type"
        v-model:attribute="filters.attribute"
        v-model:race="filters.race"
        v-model:level="filters.level"
        :facets="facets"
        menu-class="w-36"
      />
      <USelectMenu
        v-if="(facets.sets?.length ?? 0) > 0 || filters.set.length > 0"
        v-model="filters.set"
        multiple
        value-key="value"
        :items="setItems"
        :placeholder="t('inventory.search.set')"
        :aria-label="t('inventory.search.set')"
        class="w-48"
      />
      <UButton
        icon="i-lucide-rotate-ccw"
        color="neutral"
        variant="ghost"
        :label="t('inventory.search.reset')"
        @click="resetFilters"
      />
    </div>

    <div
      v-if="showSort"
      class="flex justify-end"
    >
      <UFormField
        :label="t('inventory.search.sortLabel')"
        class="flex items-center gap-2"
      >
        <USelect
          v-model="filters.sort"
          :items="sortItems"
          :aria-label="t('inventory.search.sortLabel')"
          class="w-40"
        />
      </UFormField>
    </div>
  </div>
</template>
