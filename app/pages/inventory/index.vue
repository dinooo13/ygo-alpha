<script setup lang="ts">
import type { LocationQueryRaw } from 'vue-router'
import { isCardKind } from '~~/shared/card-kind'
import { UNASSIGNED_COLLECTION_ID } from '~~/shared/inventory'
import type { InventorySearchFilters } from '~/components/inventory/InventorySearchPanel.vue'
import type { MoveEntry } from '~/components/inventory/MoveCopiesModal.vue'
import type { CardDetailPreview } from '~/utils/card-detail'
import type { InventorySearchResultItem } from '~/utils/inventory-search-result'
import { isPreviousHistoryEntry } from '~/utils/history-entry'
import { csvQueryValue, queryList } from '~/utils/query-list'

interface InventoryItem {
  id: string
  catalogCardId: number
  collectionId: string | null
  quantity: number
  note: string | null
  cardName: string
  cardNameDe?: string | null
  cardType: string
  cardAttribute: string | null
  cardTextExcerpt: string | null
  cardTextExcerptDe?: string | null
  cardRetired?: boolean
  imageUrlSmall: string | null
}

interface CatalogCard {
  id: number
  name: string
  nameDe?: string | null
  type: string
  imageUrlSmall?: string | null
}

interface SearchFilters extends InventorySearchFilters {
  q: string
  inText: boolean
  page: number
}

type SearchResultItem = InventorySearchResultItem

interface SearchResponse {
  items: SearchResultItem[]
  total: number
  page: number
  pageSize: number
}

interface SearchFacets {
  types: string[]
  attributes: string[]
  races: string[]
  levels: number[]
}

function emptyFacets(): SearchFacets {
  return {
    types: [],
    attributes: [],
    races: [],
    levels: [],
  }
}

usePageTitle('inventory.title')

const { t } = useI18n()
const { cardName } = useCardText()
const count = useCount()

const route = useRoute()
const router = useRouter()
const page = ref(1)
const pageSize = 20
const isPickerOpen = ref(false)
const isEntryOpen = ref(false)
const selectedCard = ref<CatalogCard | null>(null)

// The URL is the single source of truth for the page's scope and view, so
// deep links, reloads and Back/Forward all restore them:
// - `?collectionId=` — a collection id or `__none__` (cards without one);
//   absent = all cards. Drives both views, the header and the presets.
// - `?view=gallery` — "Galerie"; absent = "Liste" (`list`). The former
//   `view=overview` ("Übersicht", before #135) is still accepted and
//   rewritten on load.
// - `?card=<catalogCardId>` — the card's detail panel is open (#145), as
//   in the catalog. Opening it from a tile or row pushes a history entry, so
//   Back closes it and Forward opens it again; closing it goes back when the
//   previous entry is this view without the card, else (deep link, reload,
//   filters changed meanwhile) drops the param. An invalid value is dropped
//   on load.
// - The search (#148): `?q=` (the debounced text), `?inText=1` ("Auch im
//   Kartentext suchen", kept even without a text, as in the catalog),
//   `?kind=` / `type` / `attribute` / `race` / `level` (comma lists) and `?sort=`
//   (Galerie; `name` is not written).
// - `?page=` — the shown view's page (#148); each view keeps its own counter,
//   the other one starts at 1 on a reload. Any filter or scope change goes
//   back to page 1.
// Search, facets and pages are written with `replace`, so they add no
// history entries. Defaults are never written, so the plain page stays at
// `/inventory`.
// Patches build on the one still being navigated to, so two in a row (e.g.
// on load: a stale collection and the old view value) don't undo each other.
let pendingQuery: LocationQueryRaw | null = null
function setQuery(patch: LocationQueryRaw) {
  const query = { ...(pendingQuery ?? route.query), ...patch }
  pendingQuery = query
  return router.replace({ query }).finally(() => {
    if (pendingQuery === query) {
      pendingQuery = null
    }
  })
}

const collectionId = computed({
  get: () => {
    const value = route.query.collectionId
    return typeof value === 'string' ? value : ''
  },
  set: (value: string) => {
    setQuery({ collectionId: value || undefined })
  },
})

const mode = computed<'list' | 'gallery'>({
  get: () => route.query.view === 'gallery' || route.query.view === 'overview' ? 'gallery' : 'list',
  set: (value) => {
    setQuery({ view: value === 'gallery' ? 'gallery' : undefined })
  },
})

// A positive integer `?card=`, else `null`.
function parseCardParam(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null
  }
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// Old links: `view=overview` → `view=gallery`; an invalid `card` is dropped.
onMounted(() => {
  const invalidCard = route.query.card !== undefined && parseCardParam(route.query.card) === null
  if (route.query.view === 'overview' || invalidCard) {
    setQuery({
      view: route.query.view === 'overview' ? 'gallery' : route.query.view ?? undefined,
      ...(invalidCard ? { card: undefined } : {}),
    })
  }
})

const SEARCH_SORTS: ReadonlyArray<SearchFilters['sort']> = ['name', '-name', 'quantity', 'newest']

function querySort(value: unknown): SearchFilters['sort'] {
  return SEARCH_SORTS.find(sort => sort === value) ?? 'name'
}

// A positive integer `?page=`, else 1.
function queryPage(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : 1
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

// `?page=` belongs to the view it was written in (see the URL comment above).
const initialPage = queryPage(route.query.page)
page.value = mode.value === 'list' ? initialPage : 1

const filters = ref<SearchFilters>({
  q: typeof route.query.q === 'string' ? route.query.q : '',
  inText: route.query.inText === '1',
  kind: queryList(route.query.kind).filter(isCardKind),
  type: queryList(route.query.type),
  attribute: queryList(route.query.attribute),
  race: queryList(route.query.race),
  level: queryList(route.query.level).map(Number).filter(Number.isInteger),
  sort: querySort(route.query.sort),
  page: mode.value === 'gallery' ? initialPage : 1,
})

// The search text is debounced (~300ms) before it drives either fetch, while
// the input itself stays bound directly to `filters.q` for instant feedback.
// A deep link starts with its text, so SSR already fetches the filtered data.
const debouncedQ = ref(filters.value.q)
let qTimeout: ReturnType<typeof setTimeout> | undefined
watch(() => filters.value.q, (value) => {
  if (qTimeout) {
    clearTimeout(qTimeout)
  }
  qTimeout = setTimeout(() => {
    debouncedQ.value = value
  }, 300)
})

// "Liste" takes the same text and facet filters as "Galerie" (#145), but
// keeps its own order (recently changed first).
const listQuery = computed(() => ({
  q: debouncedQ.value || undefined,
  inText: filters.value.inText ? 1 : undefined,
  kind: filters.value.kind.length ? filters.value.kind.join(',') : undefined,
  type: filters.value.type.length ? filters.value.type.join(',') : undefined,
  attribute: filters.value.attribute.length ? filters.value.attribute.join(',') : undefined,
  race: filters.value.race.length ? filters.value.race.join(',') : undefined,
  level: filters.value.level.length ? filters.value.level.join(',') : undefined,
  page: page.value,
  pageSize,
  collectionId: collectionId.value || undefined,
}))

const { data, pending, refresh } = await useFetch<{ items: InventoryItem[], total: number }>('/api/inventory', {
  query: listQuery,
  default: () => ({ items: [], total: 0 }),
  watch: [listQuery],
})

const items = computed(() => data.value.items)
const total = computed(() => data.value.total)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

// Shared (same `useCollections` key) with the collection menu, the add modal
// and the dashboard, so one refresh after creating a collection or assigning
// a card updates all of them (UX review #4).
const {
  data: collectionsResponse,
  refresh: refreshCollections,
  status: collectionsStatus,
} = await useCollections()
const collectionOptions = computed(() => collectionsResponse.value.items)
const allCardsCount = computed(() => collectionsResponse.value.allCount ?? 0)
// Both counts sum quantities, so the difference is the copies without one.
const unassignedCount = computed(() => Math.max(
  0,
  allCardsCount.value - collectionOptions.value.reduce((sum, c) => sum + c.cardCount, 0),
))

const isUnassigned = computed(() => collectionId.value === UNASSIGNED_COLLECTION_ID)
const activeCollection = computed(() => collectionOptions.value.find(c => c.id === collectionId.value) ?? null)
const headerTitle = computed(() => activeCollection.value?.name ?? (isUnassigned.value ? t('inventory.scope.unassigned') : t('inventory.scope.all')))
const headerCount = computed(() => {
  if (activeCollection.value) {
    return activeCollection.value.cardCount
  }
  return isUnassigned.value ? unassignedCount.value : allCardsCount.value
})

// A stale `?collectionId=` (deleted elsewhere, or a foreign id) falls back to
// all cards once the collection list is known.
function dropStaleCollection() {
  const id = collectionId.value
  if (
    id
    && id !== UNASSIGNED_COLLECTION_ID
    && collectionsStatus?.value === 'success'
    && !collectionOptions.value.some(c => c.id === id)
  ) {
    setQuery({ collectionId: undefined })
  }
}
onMounted(dropStaleCollection)
watch([collectionId, collectionOptions, () => collectionsStatus?.value], dropStaleCollection)

function onCollectionsChanged() {
  refreshCollections()
}

async function onCollectionDeleted() {
  await Promise.all([refresh(), refreshCollections(), refreshSearch()])
}

// A "Liste" row's collection as text; hidden when the page is scoped to one
// collection (or to none) anyway.
function rowCollectionLabel(item: InventoryItem): string {
  if (!item.collectionId) {
    return t('inventory.breakdown.noCollection')
  }
  return collectionOptions.value.find(c => c.id === item.collectionId)?.name ?? t('inventory.breakdown.unnamedCollection')
}

// Any filter or scope change resets both views back to page 1.
watch([debouncedQ, collectionId], () => {
  page.value = 1
  filters.value.page = 1
})
watch(
  () => [
    filters.value.inText,
    filters.value.kind,
    filters.value.type,
    filters.value.attribute,
    filters.value.race,
    filters.value.level,
    filters.value.sort,
  ],
  () => {
    page.value = 1
    filters.value.page = 1
  },
  { deep: true },
)

// The search state and the shown view's page go into the URL (#148, see the
// URL comment above). `setQuery` builds on a patch still being navigated to,
// so this can't undo the load-time view/card rewrite.
watch(
  () => [
    debouncedQ.value,
    filters.value.inText,
    filters.value.kind,
    filters.value.type,
    filters.value.attribute,
    filters.value.race,
    filters.value.level,
    filters.value.sort,
    mode.value,
    page.value,
    filters.value.page,
  ],
  () => {
    const shownPage = mode.value === 'gallery' ? filters.value.page : page.value
    setQuery({
      q: debouncedQ.value.trim() || undefined,
      inText: filters.value.inText ? '1' : undefined,
      kind: csvQueryValue(filters.value.kind),
      type: csvQueryValue(filters.value.type),
      attribute: csvQueryValue(filters.value.attribute),
      race: csvQueryValue(filters.value.race),
      level: csvQueryValue(filters.value.level),
      sort: filters.value.sort === 'name' ? undefined : filters.value.sort,
      page: shownPage > 1 ? String(shownPage) : undefined,
    })
  },
  { deep: true, flush: 'post' },
)

// Whether any of the panel's facets is set.
const hasActiveFacets = computed(() => Boolean(
  filters.value.kind.length
  || filters.value.type.length
  || filters.value.attribute.length
  || filters.value.race.length
  || filters.value.level.length,
))

// Search text or facets (not the collection, which is the page's scope).
const hasActiveSearchFilters = computed(() => Boolean(filters.value.q) || hasActiveFacets.value)

// Same, but including the collection scope — used for the Galerie empty
// state ("leer" vs. "keine Treffer"). Both views filter, so a filter never
// switches the view (#145).
const hasAnyFilter = computed(() => hasActiveSearchFilters.value || Boolean(collectionId.value))

const searchPageSize = 24
// Note: in "Galerie" a collection keeps every card with at least one copy
// in it, and the totals/breakdown still span all collections — "Liste"
// filters row by row (see server/utils/inventory-search.ts vs. inventory.ts).
const searchQuery = computed(() => ({
  q: debouncedQ.value || undefined,
  inText: filters.value.inText ? 1 : undefined,
  kind: filters.value.kind.length ? filters.value.kind.join(',') : undefined,
  type: filters.value.type.length ? filters.value.type.join(',') : undefined,
  attribute: filters.value.attribute.length ? filters.value.attribute.join(',') : undefined,
  race: filters.value.race.length ? filters.value.race.join(',') : undefined,
  level: filters.value.level.length ? filters.value.level.join(',') : undefined,
  collectionId: collectionId.value || undefined,
  sort: filters.value.sort,
  page: filters.value.page,
  pageSize: searchPageSize,
}))

const {
  data: searchData,
  pending: searchPending,
  error: searchError,
  refresh: refreshSearch,
} = await useFetch<SearchResponse>('/api/inventory/search', {
  query: searchQuery,
  default: () => ({ items: [], total: 0, page: 1, pageSize: searchPageSize }),
  watch: [searchQuery],
})

const searchItems = computed<SearchResultItem[]>(() => searchData.value?.items ?? [])
const searchTotal = computed(() => searchData.value?.total ?? 0)
const searchPageCount = computed(() => Math.max(1, Math.ceil(searchTotal.value / searchPageSize)))

// A `?page=` past the end (cards removed since, an old link) shows the last
// page instead of an empty one without pagination. After mount, so SSR and
// hydration render the same page.
function clampPages() {
  if (!pending?.value && page.value > pageCount.value) {
    page.value = pageCount.value
  }
  if (!searchPending?.value && !searchError?.value && filters.value.page > searchPageCount.value) {
    filters.value.page = searchPageCount.value
  }
}
onMounted(clampPages)
watch(() => [pageCount.value, pending?.value, searchPageCount.value, searchPending?.value], clampPages)

const { data: facetsData, refresh: refreshFacets } = await useFetch<SearchFacets>('/api/inventory/search/facets', {
  default: emptyFacets,
})

const facets = computed<SearchFacets>(() => ({
  types: facetsData.value?.types ?? [],
  attributes: facetsData.value?.attributes ?? [],
  races: facetsData.value?.races ?? [],
  levels: facetsData.value?.levels ?? [],
}))

function openAdd(card: CatalogCard) {
  selectedCard.value = card
  isPickerOpen.value = false
  isEntryOpen.value = true
}

async function refreshAll() {
  await Promise.all([refresh(), refreshCollections(), refreshSearch(), refreshFacets()])
}

// After each write in the detail panel: one refresh of everything behind it
// once a burst of edits ("+ + +") has settled.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    refreshAll()
  }, 150)
}
onBeforeUnmount(() => {
  clearTimeout(refreshTimer)
  clearTimeout(qTimeout)
})

// The card detail panel (#88, #135): the same overlay with the same editor
// from a "Galerie" tile and from a "Liste" row. It always shows all the
// card's rows; from a row, that row is highlighted. `?card=` drives it
// (#145): see the URL comment above.
interface DetailContext {
  cardId: number
  preview: CardDetailPreview | null
  focusRowId: string | null
}

const detailCardId = computed(() => parseCardParam(route.query.card))
// What the page knew when it opened the panel itself (a tile or a row).
const detailContext = ref<DetailContext | null>(null)
// What the panel shows. Not cleared on close: the overlay keeps its content
// during the close animation.
const shownDetail = ref<DetailContext | null>(null)

function previewFromListItem(item: InventoryItem): CardDetailPreview {
  return {
    name: item.cardName,
    nameDe: item.cardNameDe,
    type: item.cardType,
    attribute: item.cardAttribute,
    level: null,
    atk: null,
    def: null,
    imageSmall: item.imageUrlSmall,
  }
}

// A deep link or Back/Forward: a preview from what the page already shows,
// if the card is on it (the overlay loads the rest itself).
function loadedPreview(cardId: number): CardDetailPreview | null {
  const tile = searchItems.value.find(item => item.catalogCardId === cardId)
  if (tile) {
    return tile
  }
  const row = items.value.find(item => item.catalogCardId === cardId)
  return row ? previewFromListItem(row) : null
}

watch(detailCardId, (id) => {
  if (id === null) {
    return
  }
  const context = detailContext.value?.cardId === id ? detailContext.value : null
  shownDetail.value = {
    cardId: id,
    preview: context?.preview ?? loadedPreview(id),
    focusRowId: context?.focusRowId ?? null,
  }
}, { immediate: true })

function openDetail(context: DetailContext) {
  detailContext.value = context
  // Push, not replace: Back closes the panel.
  router.push({ query: { ...(pendingQuery ?? route.query), card: String(context.cardId) } })
}

// Goes back only when the previous history entry is this view without the
// card (the entry `openDetail` pushed, also after Back → Forward, #148); a
// deep link, a reload or filters changed meanwhile replace the URL instead,
// so closing never leaves the page or leaves a duplicate entry behind.
function closeDetail() {
  const query = { ...(pendingQuery ?? route.query) }
  delete query.card
  if (isPreviousHistoryEntry(router, { path: route.path, query })) {
    router.back()
  }
  else {
    setQuery({ card: undefined })
  }
}

const isDetailOpen = computed({
  get: () => detailCardId.value !== null,
  set: (value: boolean) => {
    if (!value) {
      closeDetail()
    }
  },
})

// The removal question names the card; without a preview (a card not on
// this page) it falls back to the overlay's generic title.
const detailCardLabel = computed(() => shownDetail.value?.preview
  ? cardName(shownDetail.value.preview)
  : t('card.detail.fallbackTitle'))

function openFromGallery(item: SearchResultItem) {
  openDetail({ cardId: item.catalogCardId, preview: item, focusRowId: null })
}

function openFromList(item: InventoryItem) {
  openDetail({ cardId: item.catalogCardId, preview: previewFromListItem(item), focusRowId: item.id })
}

// --- Verschieben -------------------------------------------------------------
// A "Liste" row moves some or all of its copies; "Auswählen" turns the list
// into a selection whose whole stacks move together (`MoveCopiesModal`). The
// selection holds the rows themselves, so it survives paging and a refresh.

const isSelecting = ref(false)
const selection = ref<Record<string, InventoryItem>>({})
const selectedCount = computed(() => Object.keys(selection.value).length)
const isMoveOpen = ref(false)
const moveEntries = ref<MoveEntry[]>([])

function moveEntryFor(item: InventoryItem): MoveEntry {
  return {
    ownedCardId: item.id,
    name: cardName({ name: item.cardName, nameDe: item.cardNameDe }),
    quantity: item.quantity,
    collectionId: item.collectionId,
  }
}

function openMove(entries: MoveEntry[]) {
  moveEntries.value = entries
  isMoveOpen.value = true
}

function toggleSelected(item: InventoryItem) {
  const { [item.id]: removed, ...rest } = selection.value
  selection.value = removed ? rest : { ...rest, [item.id]: item }
}

function selectPage() {
  selection.value = { ...selection.value, ...Object.fromEntries(items.value.map(item => [item.id, item])) }
}

function stopSelecting() {
  isSelecting.value = false
  selection.value = {}
}

// The selection belongs to the scope it was made in.
watch(collectionId, () => {
  selection.value = {}
})

async function onMoved() {
  stopSelecting()
  await refreshAll()
}
</script>

<template>
  <div class="space-y-6">
    <LayoutPageHeader
      :title="headerTitle"
      truncate
    >
      <template #description>
        <span class="inline-flex flex-wrap items-center gap-2">
          {{ count('inventory.cardCount', headerCount) }}
          <SharingVisibilityBadge
            v-if="activeCollection"
            :visibility="activeCollection.visibility"
            hide-private
          />
        </span>
      </template>

      <template #actions>
        <UButton
          :to="{ path: '/inventory/quick-entry', query: activeCollection ? { collectionId: activeCollection.id } : undefined }"
          icon="i-lucide-zap"
          color="neutral"
          variant="outline"
          :label="t('inventory.actions.quickEntry')"
        />
        <UButton
          icon="i-lucide-plus"
          :label="t('inventory.actions.addCard')"
          @click="() => { isPickerOpen = true }"
        />
      </template>
    </LayoutPageHeader>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <CollectionsCollectionActions
          v-model="collectionId"
          :collections="collectionOptions"
          :all-count="allCardsCount"
          :unassigned-count="unassignedCount"
          @changed="onCollectionsChanged"
          @deleted="onCollectionDeleted"
        />

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="mode === 'list'"
            icon="i-lucide-list-checks"
            color="neutral"
            :variant="isSelecting ? 'subtle' : 'outline'"
            :label="t('inventory.select.toggle')"
            :aria-pressed="isSelecting"
            @click="() => { isSelecting ? stopSelecting() : (isSelecting = true) }"
          />

          <UFieldGroup>
            <UButton
              :label="t('inventory.view.list')"
              :color="mode === 'list' ? 'primary' : 'neutral'"
              :variant="mode === 'list' ? 'subtle' : 'outline'"
              :aria-pressed="mode === 'list'"
              @click="() => { mode = 'list' }"
            />
            <UButton
              :label="t('inventory.view.gallery')"
              :color="mode === 'gallery' ? 'primary' : 'neutral'"
              :variant="mode === 'gallery' ? 'subtle' : 'outline'"
              :aria-pressed="mode === 'gallery'"
              @click="() => { mode = 'gallery' }"
            />
          </UFieldGroup>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <UInput
          v-model="filters.q"
          icon="i-lucide-search"
          :placeholder="t('inventory.search.placeholder')"
          :aria-label="t('inventory.search.label')"
          class="w-full max-w-xl"
        />
        <UCheckbox
          v-model="filters.inText"
          :label="t('inventory.search.inText')"
        />
      </div>
    </div>

    <!-- Filterleiste ist modusunabhängig sichtbar (UX review #16) — vorher
         verschwand sie kommentarlos beim Wechsel auf "Liste". -->
    <InventorySearchPanel
      v-model:filters="filters"
      :facets="facets"
      :show-sort="mode === 'gallery'"
    />

    <!-- Galerie: aggregated, faceted inventory-wide search -->
    <div
      v-if="mode === 'gallery'"
      class="space-y-4"
    >
      <!-- Skeletons only before there is anything to show: a refresh after
           an edit in the detail panel keeps the tiles (and so the tile the
           panel returns focus to). -->
      <div
        v-if="searchPending && searchItems.length === 0"
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4"
      >
        <USkeleton
          v-for="n in 12"
          :key="n"
          class="aspect-[59/86] rounded-lg"
        />
      </div>

      <div
        v-else-if="searchError || searchItems.length === 0"
        class="panel overflow-hidden"
      >
        <UAlert
          v-if="searchError"
          color="error"
          variant="subtle"
          :title="t('inventory.gallery.loadFailed')"
          :description="t('inventory.gallery.tryAgain')"
          class="m-4"
        >
          <template #actions>
            <UButton
              icon="i-lucide-refresh-cw"
              :label="t('common.retry')"
              color="error"
              variant="outline"
              @click="() => refreshSearch()"
            />
          </template>
        </UAlert>

        <LayoutEmptyState
          v-else-if="!hasAnyFilter"
          icon="i-lucide-archive"
          :title="t('inventory.gallery.empty')"
          :description="t('inventory.emptyDescription')"
          :bordered="false"
        >
          <template #actions>
            <UButton
              icon="i-lucide-plus"
              :label="t('inventory.actions.addCard')"
              @click="() => { isPickerOpen = true }"
            />
          </template>
        </LayoutEmptyState>

        <LayoutEmptyState
          v-else
          icon="i-lucide-search-x"
          :title="t('inventory.gallery.noMatches')"
          :description="t('inventory.gallery.noMatchesDescription')"
          :bordered="false"
        />
      </div>

      <div
        v-else
        class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4"
        :aria-busy="searchPending || undefined"
      >
        <InventoryCardTile
          v-for="result in searchItems"
          :key="result.catalogCardId"
          :item="result"
          @open="openFromGallery(result)"
        />
      </div>

      <div
        v-if="searchTotal > searchPageSize"
        class="flex justify-end"
      >
        <UPagination
          v-model:page="filters.page"
          :total="searchTotal"
          :items-per-page="searchPageSize"
          :page-count="searchPageCount"
        />
      </div>
    </div>

    <!-- Liste: one row per card and collection, for reading; a row opens
         the card's detail panel. -->
    <div
      v-else
      class="space-y-4"
    >
      <div
        v-if="isSelecting"
        class="flex flex-wrap items-center justify-between gap-3 panel p-3"
        role="region"
        :aria-label="t('inventory.select.bar')"
      >
        <p
          class="text-sm font-medium text-highlighted"
          aria-live="polite"
        >
          {{ count('inventory.select.count', selectedCount) }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('inventory.select.page')"
            :disabled="items.length === 0"
            @click="selectPage"
          />
          <UButton
            icon="i-lucide-folder-input"
            :label="t('inventory.move.toCollection')"
            :disabled="selectedCount === 0"
            @click="() => openMove(Object.values(selection).map(moveEntryFor))"
          />
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="stopSelecting"
          />
        </div>
      </div>

      <div class="panel overflow-hidden">
        <ul
          v-if="pending && items.length === 0"
          class="divide-y divide-default"
          aria-busy="true"
          :aria-label="t('inventory.list.loading')"
        >
          <li
            v-for="n in 5"
            :key="n"
            class="flex items-center gap-3 px-4 py-3"
          >
            <USkeleton class="aspect-[59/86] w-16 shrink-0 rounded sm:w-12" />
            <div class="flex-1 space-y-2">
              <USkeleton class="h-4 w-1/2" />
              <USkeleton class="h-3 w-1/3" />
            </div>
          </li>
        </ul>

        <LayoutEmptyState
          v-else-if="items.length === 0 && (debouncedQ || hasActiveFacets)"
          icon="i-lucide-search-x"
          :title="t('inventory.list.noMatches')"
          :description="t('inventory.list.noMatchesDescription')"
          :bordered="false"
        />

        <LayoutEmptyState
          v-else-if="items.length === 0 && isUnassigned"
          icon="i-lucide-archive"
          :title="t('inventory.list.noUnassigned')"
          :description="t('inventory.list.noUnassignedDescription')"
          :bordered="false"
        />

        <LayoutEmptyState
          v-else-if="items.length === 0"
          icon="i-lucide-archive"
          :title="collectionId ? t('inventory.list.emptyCollection') : t('inventory.list.empty')"
          :description="t('inventory.emptyDescription')"
          :bordered="false"
        >
          <template #actions>
            <UButton
              icon="i-lucide-plus"
              :label="t('inventory.actions.addCard')"
              @click="() => { isPickerOpen = true }"
            />
          </template>
        </LayoutEmptyState>

        <ul
          v-else
          class="divide-y divide-default"
          :aria-busy="pending || undefined"
        >
          <InventoryListRow
            v-for="item in items"
            :key="item.id"
            :item="item"
            :collection-label="rowCollectionLabel(item)"
            :show-collection="!collectionId"
            :selectable="isSelecting"
            :selected="Boolean(selection[item.id])"
            @open="openFromList(item)"
            @move="openMove([moveEntryFor(item)])"
            @toggle="toggleSelected(item)"
          />
        </ul>
      </div>

      <div
        v-if="total > pageSize"
        class="flex justify-end"
      >
        <UPagination
          v-model:page="page"
          :total="total"
          :items-per-page="pageSize"
          :page-count="pageCount"
        />
      </div>
    </div>

    <UModal
      v-model:open="isPickerOpen"
      :title="t('inventory.picker.title')"
    >
      <template #body>
        <InventoryCatalogCardPicker @select="openAdd" />
      </template>
    </UModal>

    <InventoryMoveCopiesModal
      v-model:open="isMoveOpen"
      :entries="moveEntries"
      :collections="collectionOptions"
      @moved="onMoved"
    />

    <InventoryAddToInventoryModal
      v-model:open="isEntryOpen"
      :card="selectedCard"
      :collections="collectionOptions"
      :preset-collection-id="activeCollection?.id ?? null"
      @saved="refreshAll"
    />

    <CardDetailModal
      v-model:open="isDetailOpen"
      :card-id="shownDetail?.cardId ?? null"
      :preview="shownDetail?.preview ?? null"
      variant="inventory"
    >
      <template #context>
        <InventoryOwnedCardEditor
          v-if="shownDetail"
          :key="shownDetail.cardId"
          :catalog-card-id="shownDetail.cardId"
          :card-label="detailCardLabel"
          :collections="collectionOptions"
          :focus-row-id="shownDetail.focusRowId"
          :after-write="scheduleRefresh"
        />
      </template>
      <template #actions>
        <UButton
          v-if="shownDetail"
          :to="`/catalog?card=${shownDetail.cardId}`"
          icon="i-lucide-book-open"
          :label="t('inventory.preview.openInCatalog')"
          color="neutral"
          variant="outline"
          class="tap-target"
        />
      </template>
    </CardDetailModal>
  </div>
</template>
