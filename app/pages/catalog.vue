<script setup lang="ts">
import { cardFrame } from '~~/shared/card-frame'
import { isCardKind } from '~~/shared/card-kind'
import type { CardKind } from '~~/shared/card-kind'
import { isPreviousHistoryEntry } from '~/utils/history-entry'
import { csvQueryValue as csv, queryList } from '~/utils/query-list'
import { CARD_LEVEL_ICON, cardLevel } from '~/utils/card-level'
import type { CardDetailSummary } from '~/utils/card-detail'

interface CatalogFacets {
  types: string[]
  attributes: string[]
  races: string[]
  levels: number[]
  sets: Array<{ id: string, name: string }>
}

interface CatalogCardSummary {
  id: number
  name: string
  nameDe: string | null
  type: string
  frameType: string | null
  attribute: string | null
  race: string | null
  level: number | null
  linkval: number | null
  atk: number | null
  def: number | null
  imageSmall: string | null
}

interface CatalogSearchResponse {
  items: CatalogCardSummary[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 24

usePageTitle('catalog.title')

const { t } = useI18n()
const { cardName, cardLevelLabel } = useCardText()
const count = useCount()

const route = useRoute()
const router = useRouter()

const searchInput = ref(typeof route.query.q === 'string' ? route.query.q : '')
const debouncedSearch = ref(searchInput.value)
const kind = ref<CardKind[]>(queryList(route.query.kind).filter(isCardKind))
const type = ref<string[]>(queryList(route.query.type))
const attribute = ref<string[]>(queryList(route.query.attribute))
const race = ref<string[]>(queryList(route.query.race))
const level = ref<number[]>(queryList(route.query.level).map(value => Number.parseInt(value, 10)).filter(Number.isFinite))
const setId = ref(typeof route.query.setId === 'string' ? route.query.setId : '')
const sort = ref(typeof route.query.sort === 'string' ? route.query.sort : 'name')
// "Auch im Kartentext suchen" (owner feedback in #148); kept in the URL even without a search text.
const inText = ref(route.query.inText === '1')
const page = ref(Number.parseInt(typeof route.query.page === 'string' ? route.query.page : '1', 10) || 1)
const selectedCardId = computed(() => Number.parseInt(typeof route.query.card === 'string' ? route.query.card : '', 10))
const isDetailOpen = computed(() => Number.isFinite(selectedCardId.value))

let debounceTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (value) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debouncedSearch.value = value
  }, 300)
})

const filtersActive = computed(() =>
  Boolean(debouncedSearch.value.trim() || kind.value.length || type.value.length || attribute.value.length || race.value.length || level.value.length || setId.value),
)

const cardQuery = computed(() => ({
  q: debouncedSearch.value.trim() || undefined,
  // Only with a search text: ticking the box on an empty search changes nothing, so it doesn't refetch.
  inText: inText.value && debouncedSearch.value.trim() ? 1 : undefined,
  kind: csv(kind.value),
  type: csv(type.value),
  attribute: csv(attribute.value),
  race: csv(race.value),
  level: csv(level.value),
  setId: setId.value || undefined,
  sort: sort.value,
  page: page.value,
  pageSize: PAGE_SIZE,
}))

const { data: facets } = await useFetch<CatalogFacets>('/api/catalog/facets', {
  default: () => ({ types: [], attributes: [], races: [], levels: [], sets: [] }),
})

const sortItems = computed(() => [
  { label: t('catalog.sort.nameAsc'), value: 'name' },
  { label: t('catalog.sort.nameDesc'), value: '-name' },
  { label: t('catalog.sort.newest'), value: 'newest' },
])

// A plain `<select>` with 1000+ sets meant scrolling through an unsearchable
// list to find one (UX review #5) — `USelectMenu` is searchable by default.
// The set filter stays single-select, and reka-ui reserves the empty string
// for "clear selection", so "no set" uses a non-empty sentinel mapped back
// to `''`.
const noSetValue = '__all_sets__'
const setItems = computed(() => [
  { label: t('catalog.filters.allSets'), value: noSetValue },
  ...facets.value.sets.map(set => ({ label: set.name, value: set.id })),
])
const setSelection = computed({
  get: () => setId.value || noSetValue,
  set: (value: string) => {
    setId.value = value === noSetValue ? '' : value
  },
})

// Seeds the "Zur Wunschliste" toggle state per card (Phase 6). The state
// lives here, not in the buttons (#98): a toggle that finishes while the grid
// reloads isn't lost, and the tile and the card detail agree.
const { data: wishlistIds } = await useFetch<{ ids: number[] }>('/api/wishlist/ids', {
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  default: () => ({ ids: [] }),
})
const wishlist = useWishlistToggle(computed(() => wishlistIds.value?.ids ?? []))

const {
  data: cards,
  pending,
  error,
  refresh,
} = await useFetch<CatalogSearchResponse>('/api/catalog/cards', {
  query: cardQuery,
  default: () => ({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE }),
})

// Skeletons only before the first result; later searches keep the previous
// grid, dimmed, until the new one arrives (#148). `useFetch` keeps the old
// data while a new query loads.
const hasLoadedOnce = ref(!pending.value)
watch(pending, (value) => {
  if (!value) {
    hasLoadedOnce.value = true
  }
})

watch([kind, type, attribute, race, level, setId, sort, debouncedSearch, inText], () => {
  page.value = 1
}, { deep: true })

watch([debouncedSearch, inText, kind, type, attribute, race, level, setId, sort, page], async () => {
  await router.replace({
    query: {
      ...route.query,
      q: debouncedSearch.value.trim() || undefined,
      inText: inText.value ? '1' : undefined,
      kind: csv(kind.value),
      type: csv(type.value),
      attribute: csv(attribute.value),
      race: csv(race.value),
      level: csv(level.value),
      setId: setId.value || undefined,
      sort: sort.value === 'name' ? undefined : sort.value,
      page: page.value > 1 ? String(page.value) : undefined,
    },
  })
}, { flush: 'post' })

// What the grid already knows about the open card, shown while its detail loads.
const selectedSummary = computed(() => cards.value.items.find(card => card.id === selectedCardId.value) ?? null)

const totalPages = computed(() => Math.max(1, Math.ceil((cards.value?.total ?? 0) / PAGE_SIZE)))
// Locale-formatted and pluralized, so a one-hit search reads "1 Karte" and
// the full catalog "13.000 Karten" (UX review #10).
const cardsTotalLabel = computed(() => count('catalog.resultCount', cards.value.total))

// `?card=` (#148, the inventory's pattern from #145): a tile pushes a
// history entry, so Back closes the overlay and Forward opens it again.
function openCard(cardId: number) {
  router.push({ query: { ...route.query, card: String(cardId) } })
}

// An alias passcode shows its canonical card (ADR 0024, #154): same entry.
function showCanonicalCard(cardId: number) {
  router.replace({ query: { ...route.query, card: String(cardId) } })
}

// Closing goes back only to the entry this page pushed: the previous history
// entry must be this catalog view without `card`. A deep link, a reload of a
// fresh tab, or the retired card's "Aktuelle Karte anzeigen" link (a push to
// another card) drop the param with a replace instead, so closing never leaves
// the catalog and never reopens a different card.
function closeCard() {
  const query = { ...route.query }
  delete query.card
  if (isPreviousHistoryEntry(router, { path: route.path, query })) {
    router.back()
  }
  else {
    router.replace({ query })
  }
}

function resetFilters() {
  searchInput.value = ''
  debouncedSearch.value = ''
  inText.value = false
  kind.value = []
  type.value = []
  attribute.value = []
  race.value = []
  level.value = []
  setId.value = ''
  sort.value = 'name'
  page.value = 1
}

function previousPage() {
  page.value = Math.max(1, page.value - 1)
}

function nextPage() {
  page.value = Math.min(totalPages.value, page.value + 1)
}

async function reloadCards() {
  await refresh()
}

// "Zum Inventar" (UX review #6) reuses the same add-to-inventory modal as
// `/inventory`, pre-filled with the card the user clicked — no more detour of
// remembering the name and searching for it again on another page.
const { data: collectionsData, refresh: refreshCollectionsAfterAdd } = await useCollections()
const isAddToInventoryOpen = ref(false)
const addingCard = ref<CardDetailSummary | null>(null)

// From a grid tile or from the card detail; in the detail, the add dialog
// opens on top of it and closing it returns there.
function openAddToInventory(card: CardDetailSummary) {
  addingCard.value = card
  isAddToInventoryOpen.value = true
}

async function onAddedToInventory() {
  await refreshCollectionsAfterAdd()
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-4">
      <LayoutPageHeader
        :title="t('catalog.title')"
        :description="t('catalog.description')"
      />

      <section class="panel space-y-3 p-3 sm:p-4">
        <UInput
          v-model="searchInput"
          icon="i-lucide-search"
          :placeholder="t('catalog.search.placeholder')"
          :aria-label="t('catalog.search.label')"
          class="w-full"
        />
        <UCheckbox
          v-model="inText"
          :label="t('catalog.search.inText')"
        />

        <div class="grid grid-cols-2 gap-3 lg:grid-cols-[repeat(6,minmax(0,1fr))_auto]">
          <CardFacetFilters
            v-model:kind="kind"
            v-model:type="type"
            v-model:attribute="attribute"
            v-model:race="race"
            v-model:level="level"
            :facets="facets"
          />

          <USelectMenu
            v-model="setSelection"
            :items="setItems"
            value-key="value"
            :aria-label="t('catalog.filters.set')"
            :placeholder="t('catalog.filters.set')"
            class="min-w-0 w-full"
          />

          <UButton
            icon="i-lucide-rotate-ccw"
            :label="t('catalog.filters.reset')"
            color="neutral"
            variant="outline"
            class="min-w-0 justify-center"
            @click="resetFilters"
          />
        </div>
      </section>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm font-medium text-default">
        {{ cardsTotalLabel }}
      </p>

      <UFormField
        :label="t('catalog.sort.label')"
        class="flex items-center gap-2"
      >
        <USelect
          v-model="sort"
          :items="sortItems"
          :aria-label="t('catalog.sort.label')"
          class="w-40"
        />
      </UFormField>
    </div>

    <UAlert
      v-if="error"
      color="error"
      icon="i-lucide-circle-alert"
      :title="t('catalog.loadFailed')"
      :description="t('catalog.tryAgain')"
    >
      <template #actions>
        <UButton
          icon="i-lucide-refresh-cw"
          :label="t('catalog.reload')"
          color="error"
          variant="outline"
          @click="reloadCards"
        />
      </template>
    </UAlert>

    <div
      v-else-if="pending && !hasLoadedOnce"
      class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
    >
      <USkeleton
        v-for="index in 12"
        :key="index"
        class="aspect-[3/4.9] rounded-xl"
      />
    </div>

    <!-- A later search keeps the previous results, dimmed, until the new ones
         arrive (#148). The delay is on the dimmed state only, so a fast answer
         doesn't flicker and un-dimming is immediate. -->
    <div
      v-else
      :aria-busy="pending || undefined"
      class="motion-safe:transition-opacity motion-safe:duration-200"
      :class="pending ? 'opacity-50 motion-safe:delay-150' : undefined"
      data-testid="catalog-results"
    >
      <LayoutEmptyState
        v-if="cards.total === 0"
        :icon="filtersActive ? 'i-lucide-search-x' : 'i-lucide-book-open'"
        :title="filtersActive ? t('catalog.empty.noMatches') : t('catalog.empty.noCatalog')"
        :description="filtersActive ? t('catalog.empty.noMatchesDescription') : t('catalog.empty.noCatalogDescription')"
      />

      <section
        v-else
        class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
      >
        <!-- The card name is the tile's button; `stretched-link` makes the
             whole tile clickable, while the action buttons sit above it. Not a
             `role="button"` wrapper: that would nest the action buttons inside
             another control. -->
        <article
          v-for="card in cards.items"
          :key="card.id"
          :aria-label="cardName(card)"
          class="group panel relative flex min-w-0 flex-col text-left transition-[translate,box-shadow,border-color] duration-200 ease-out-expo hover:border-primary/40 hover:shadow-lift motion-safe:hover:-translate-y-0.5"
        >
          <!-- Plain thumbnail: the tile already opens the card. -->
          <CardThumb
            :src="card.imageSmall"
            :alt="cardName(card)"
            :frame="cardFrame(card)?.frame"
            :pendulum="cardFrame(card)?.pendulum"
            size="full"
            foil
            class="p-2 pb-0"
          />
          <div class="flex flex-1 flex-col gap-2 p-3">
            <h2 class="min-h-10 text-sm font-semibold leading-5 text-highlighted transition-colors group-hover:text-primary">
              <button
                type="button"
                class="stretched-link block w-full text-left"
                @click="openCard(card.id)"
              >
                <span class="line-clamp-2">{{ cardName(card) }}</span>
              </button>
            </h2>
            <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <CardTypeChip
                :type="card.type"
                :frame-type="card.frameType"
                size="xs"
              />
              <CardAttributeOrb
                v-if="card.attribute"
                :attribute="card.attribute"
                size="xs"
              />
              <span
                v-if="cardLevel(card)"
                class="inline-flex items-center gap-1 font-numeric text-[0.6875rem] font-semibold tracking-[0.04em] text-toned tabular-nums"
              >
                <UIcon
                  :name="CARD_LEVEL_ICON[cardLevel(card)!.kind]"
                  class="size-3 text-secondary"
                  aria-hidden="true"
                />
                {{ cardLevelLabel(card) }}
              </span>
            </div>
            <div class="relative z-10 mt-auto flex flex-wrap gap-1 pt-1">
              <UButton
                icon="i-lucide-archive-restore"
                color="primary"
                size="xs"
                :label="t('catalog.addToInventory')"
                class="tap-target"
                @click="openAddToInventory(card)"
              />
              <WishlistAddToWishlistButton
                :in-wishlist="wishlist.isWishlisted(card.id)"
                :loading="wishlist.isSaving(card.id)"
                :error="wishlist.errorFor(card.id)"
                @toggle="wishlist.toggle(card.id)"
              />
            </div>
          </div>
        </article>
      </section>
    </div>

    <div
      v-if="cards.total > PAGE_SIZE"
      class="flex items-center justify-center gap-2"
    >
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        :disabled="page <= 1"
        :aria-label="t('common.pagination.previous')"
        class="tap-target"
        @click="previousPage"
      />
      <span class="min-w-28 text-center text-sm text-toned">
        {{ t('common.pagination.pageOf', { page, total: totalPages }) }}
      </span>
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        :disabled="page >= totalPages"
        :aria-label="t('common.pagination.next')"
        class="tap-target"
        @click="nextPage"
      />
    </div>

    <CardDetailModal
      :open="isDetailOpen"
      :card-id="isDetailOpen ? selectedCardId : null"
      :preview="selectedSummary"
      variant="catalog"
      @update:open="value => { if (!value) closeCard() }"
      @resolved="showCanonicalCard"
    >
      <template #actions="{ card }">
        <UButton
          icon="i-lucide-archive-restore"
          color="primary"
          :label="t('catalog.addToInventory')"
          :disabled="!card"
          class="tap-target"
          @click="card ? openAddToInventory(card) : undefined"
        />
        <CardAddToDeckMenu :card="card" />
        <WishlistAddToWishlistButton
          v-if="isDetailOpen"
          :in-wishlist="wishlist.isWishlisted(selectedCardId)"
          :loading="wishlist.isSaving(selectedCardId)"
          :error="wishlist.errorFor(selectedCardId)"
          size="md"
          @toggle="wishlist.toggle(selectedCardId)"
        />
      </template>
    </CardDetailModal>

    <InventoryAddToInventoryModal
      v-model:open="isAddToInventoryOpen"
      :card="addingCard"
      :collections="collectionsData?.items ?? []"
      @saved="onAddedToInventory"
    />
  </div>
</template>
