<script setup lang="ts">
import type { CardKind } from '~~/shared/card-kind'
import type { CardFacetOptions } from '~/components/card/CardFacetFilters.vue'

export interface InventorySearchFilters {
  kind: CardKind[]
  type: string[]
  attribute: string[]
  race: string[]
  level: number[]
  sort: 'name' | '-name' | 'quantity' | 'newest'
}

withDefaults(defineProps<{
  facets: CardFacetOptions
  /** The sort select; only "Galerie" sorts ("Liste" stays "recently changed first"). */
  showSort?: boolean
}>(), {
  showSort: true,
})

const { t } = useI18n()

const filters = defineModel<InventorySearchFilters>('filters', { required: true })

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
