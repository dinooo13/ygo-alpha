<script setup lang="ts">
import type { DeckBreakdownGroup } from '~~/shared/deck-breakdown'
import type { DeckCover } from '~~/shared/deck-cover'
import { DECK_NAME_MAX_LENGTH, DECK_SECTIONS } from '~~/shared/deck-sections'
import type { DeckSection } from '~~/shared/deck-sections'
import type { Visibility } from '~~/shared/sharing'
import { copyName } from '~/utils/copy-name'
import { deckCountState, deckMeterFill } from '~/utils/deck-meter'

interface DeckListItem {
  id: string
  name: string
  description: string | null
  mainCount: number
  extraCount: number
  sideCount: number
  cardCount: number
  complete: boolean
  missingCount: number
  formatId: string | null
  formatName: string | null
  legal: boolean | null
  visibility: Visibility
  cover: DeckCover | null
  /** Copies per card kind in Main and Extra (#148); older fixtures lack it. */
  breakdown?: DeckBreakdownGroup[]
  createdAt: string
  updatedAt: string
}

interface DeckListResponse {
  items: DeckListItem[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 20

usePageTitle('decks.list.title')

const { t } = useI18n()
const { cardName } = useCardText()
const count = useCount()
const apiError = useApiError()
const { formatName, sortFormats } = useFormatLabel()

const route = useRoute()
const toast = useToast()

const searchInput = ref('')
const debouncedSearch = ref('')
const sort = ref<'updated' | 'name' | '-name' | 'newest'>('updated')
// reka-ui reserves the empty string for "clear selection", so "no filter" uses
// a sentinel that is dropped from the query.
const ALL_FORMATS = '__all_formats__'
const formatFilter = ref(ALL_FORMATS)
const page = ref(1)
const errorMessage = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | undefined
watch(searchInput, (value) => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debouncedSearch.value = value.trim()
    page.value = 1
  }, 300)
})

watch([sort, formatFilter], () => {
  page.value = 1
})

const deckQuery = computed(() => ({
  q: debouncedSearch.value || undefined,
  sort: sort.value,
  formatId: formatFilter.value === ALL_FORMATS ? undefined : formatFilter.value,
  page: page.value,
  pageSize: PAGE_SIZE,
}))

const { data, pending, refresh } = await useFetch<DeckListResponse>('/api/decks', {
  query: deckQuery,
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  default: () => ({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE }),
  watch: [deckQuery],
})

const decks = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)

const { data: formatsData } = await useFetch<{ items: Array<{ id: string, name: string, isBuiltin: boolean }> }>('/api/formats', {
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  default: () => ({ items: [] }),
})

const formatFilterItems = computed(() => [
  { label: t('decks.list.allFormats'), value: ALL_FORMATS },
  { label: t('decks.list.noFormat'), value: 'none' },
  ...sortFormats(formatsData.value?.items ?? []).map(format => ({ label: formatName(format), value: format.id })),
])

const sortItems = computed(() => [
  { label: t('decks.list.sort.updated'), value: 'updated' },
  { label: t('decks.list.sort.newest'), value: 'newest' },
  { label: t('decks.list.sort.nameAsc'), value: 'name' },
  { label: t('decks.list.sort.nameDesc'), value: '-name' },
])

const { data: ownProfile } = await useOwnProfile()

const isFormOpen = ref(false)
const editingDeck = ref<DeckListItem | null>(null)

const isShareOpen = ref(false)
const sharingDeck = ref<DeckListItem | null>(null)
const sharePath = computed(() => `/players/${ownProfile.value?.handle ?? ''}/decks/${sharingDeck.value?.id ?? ''}`)

function openShare(deck: DeckListItem) {
  sharingDeck.value = deck
  isShareOpen.value = true
}

function onShareUpdated(visibility: Visibility) {
  if (!sharingDeck.value || !data.value) {
    return
  }
  const sharedId = sharingDeck.value.id
  data.value = {
    ...data.value,
    items: data.value.items.map(item => (item.id === sharedId ? { ...item, visibility } : item)),
  }
}

function openCreate() {
  editingDeck.value = null
  isFormOpen.value = true
}

// `/decks?new=1` (dashboard "Deck anlegen") opens the create modal right
// away; the query is dropped so a reload or back-navigation doesn't reopen it.
onMounted(() => {
  if (route.query.new === '1') {
    openCreate()
    navigateTo({ query: {} }, { replace: true })
  }
})

const isImportOpen = ref(false)

async function onImported(deck: { id: string }) {
  toast.add({ title: t('decks.import.toast.created'), color: 'success' })
  await navigateTo(`/decks/${deck.id}`)
}

function openRename(deck: DeckListItem) {
  editingDeck.value = deck
  isFormOpen.value = true
}

async function onSaved(deck: { id: string }, created: boolean) {
  if (created) {
    // Straight into the editor — a fresh deck is always empty.
    await navigateTo(`/decks/${deck.id}`)
    return
  }
  await refresh()
}

async function duplicateDeck(deck: DeckListItem) {
  errorMessage.value = ''
  try {
    // The copy is named in the interface language ("… (Kopie)" / "… (copy)").
    const name = copyName(source => t('decks.copyName', { name: source }), deck.name, DECK_NAME_MAX_LENGTH)
    await $fetch(`/api/decks/${deck.id}/duplicate`, { method: 'POST', body: { name } })
    toast.add({ title: t('decks.toast.duplicated'), color: 'success' })
    await refresh()
  }
  catch (error) {
    errorMessage.value = apiError(error, 'decks.errors.duplicateFailed')
    toast.add({ title: t('decks.errors.duplicateFailed'), color: 'error' })
  }
}

const { confirm } = useConfirm()

async function deleteDeck(deck: DeckListItem) {
  errorMessage.value = ''
  const confirmed = await confirm({
    title: t('decks.confirm.delete.title'),
    description: t('decks.confirm.delete.description', { name: deck.name }),
  })
  if (!confirmed) {
    return
  }

  try {
    await $fetch(`/api/decks/${deck.id}`, { method: 'DELETE' })
    toast.add({ title: t('decks.toast.deleted'), color: 'success' })
    await refresh()
  }
  catch (error) {
    errorMessage.value = apiError(error, 'decks.errors.deleteFailed')
    toast.add({ title: t('decks.errors.deleteFailed'), color: 'error' })
  }
}

// "Sammlung befüllen": moves the copies a deck needs into a collection.
const { data: collectionsData } = await useCollections()
const fillDeck = ref<DeckListItem | null>(null)
const isFillOpen = ref(false)

function openFill(deck: DeckListItem) {
  fillDeck.value = deck
  isFillOpen.value = true
}

function menuItemsFor(deck: DeckListItem) {
  return [[
    {
      label: t('decks.menu.edit'),
      icon: 'i-lucide-pencil-ruler',
      onSelect: () => navigateTo(`/decks/${deck.id}`),
    },
    {
      label: t('decks.menu.rename'),
      icon: 'i-lucide-pencil',
      onSelect: () => openRename(deck),
    },
    {
      label: t('decks.menu.duplicate'),
      icon: 'i-lucide-copy',
      onSelect: () => duplicateDeck(deck),
    },
    {
      label: t('decks.menu.fillCollection'),
      icon: 'i-lucide-folder-input',
      onSelect: () => openFill(deck),
    },
    {
      label: t('decks.menu.share'),
      icon: 'i-lucide-share-2',
      // Without a loaded handle, sharePath would resolve to a broken
      // `/players//decks/:id` link — keep the entry disabled until then.
      disabled: !ownProfile.value?.handle,
      onSelect: () => openShare(deck),
    },
    {
      label: t('common.delete'),
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => deleteDeck(deck),
    },
  ]]
}

// An empty deck is neither complete nor missing anything — it is just empty.
// "Vollständig"/"N fehlen" read as "the deck is tournament-ready", but this
// badge is purely about ownership — `complete` really means "every deck
// card is in the inventory" (server/utils/decks.ts) — so the wording spells
// that out explicitly (UX review #12).
function statusLabel(deck: DeckListItem) {
  if (deck.cardCount === 0) {
    return t('decks.list.status.empty')
  }
  if (deck.complete) {
    return t('decks.list.status.complete')
  }
  return count('decks.list.status.missing', deck.missingCount)
}

function sectionShortName(section: DeckSection): string {
  return t(`decks.sectionShort.${section}`)
}

function sectionCount(deck: DeckListItem, section: DeckSection): number {
  return section === 'main' ? deck.mainCount : section === 'extra' ? deck.extraCount : deck.sideCount
}

function sectionMeter(deck: DeckListItem, section: DeckSection) {
  const count = sectionCount(deck, section)
  return { state: deckCountState(section, count), fill: `${deckMeterFill(section, count)}%` }
}

function deckFormatName(deck: DeckListItem): string | null {
  return deck.formatName ? formatName({ id: deck.formatId, name: deck.formatName }) : null
}

function statusColor(deck: DeckListItem) {
  if (deck.cardCount === 0) {
    return 'neutral' as const
  }
  return deck.complete ? ('success' as const) : ('warning' as const)
}
</script>

<template>
  <div class="space-y-6">
    <LayoutPageHeader
      :title="t('decks.list.title')"
      :description="count('decks.list.count', total)"
    >
      <template #actions>
        <UButton
          icon="i-lucide-file-up"
          color="neutral"
          variant="outline"
          :label="t('decks.list.importDeck')"
          @click="() => { isImportOpen = true }"
        />
        <UButton
          icon="i-lucide-plus"
          class="btn-summon"
          :label="t('decks.list.newDeck')"
          @click="openCreate"
        />
      </template>
    </LayoutPageHeader>

    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <UInput
        v-model="searchInput"
        icon="i-lucide-search"
        :placeholder="t('decks.list.searchPlaceholder')"
        :aria-label="t('decks.list.searchLabel')"
        class="w-full max-w-xl"
      />
      <USelect
        v-model="sort"
        :items="sortItems"
        :aria-label="t('decks.list.sortLabel')"
        class="w-full sm:w-52"
      />
      <USelect
        v-model="formatFilter"
        :items="formatFilterItems"
        :aria-label="t('decks.list.formatLabel')"
        class="w-full sm:w-52"
      />
    </div>

    <p
      v-if="errorMessage"
      class="text-sm text-error"
    >
      {{ errorMessage }}
    </p>

    <div
      v-if="pending"
      class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      <USkeleton
        v-for="n in 3"
        :key="n"
        class="h-40 w-full rounded-xl"
      />
    </div>

    <LayoutEmptyState
      v-else-if="decks.length === 0 && !debouncedSearch"
      icon="i-lucide-layers"
      :title="t('decks.list.empty.title')"
      :description="t('decks.list.empty.description')"
    >
      <template #actions>
        <UButton
          icon="i-lucide-plus"
          :label="t('decks.list.newDeck')"
          @click="openCreate"
        />
      </template>
    </LayoutEmptyState>

    <LayoutEmptyState
      v-else-if="decks.length === 0"
      icon="i-lucide-search-x"
      :title="t('decks.list.noResults.title')"
    >
      <template #description>
        {{ t('decks.list.noResults.description', { query: debouncedSearch }) }}
      </template>
    </LayoutEmptyState>

    <ul
      v-else
      class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      <li
        v-for="deck in decks"
        :key="deck.id"
        class="group panel relative flex gap-4 p-4 transition-[translate,box-shadow,border-color] duration-200 ease-out-expo hover:border-primary/40 hover:shadow-lift motion-safe:hover:-translate-y-0.5"
      >
        <!-- Cover card (#29): decorative; the stretched deck link covers the
             tile (#134), so it stays out of the accessibility tree. Two card
             backs fan out behind it (ADR 0016). -->
        <div
          aria-hidden="true"
          class="deck-fan shrink-0 self-start"
        >
          <span class="fan-card card-back" />
          <span class="fan-card card-back" />
          <CardThumb
            size="lg"
            class="fan-cover"
            :src="deck.cover?.imageSmall"
            :src-large="deck.cover?.imageLarge"
            :alt="deck.cover ? cardName(deck.cover) : deck.name"
            :no-image-label="deck.cover ? undefined : t('decks.list.emptyCover')"
          />
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-start justify-between gap-2">
            <NuxtLink
              :to="`/decks/${deck.id}`"
              class="stretched-link min-w-0 flex-1 rounded-sm"
            >
              <h2 class="line-clamp-2 break-words text-base font-semibold text-highlighted transition-colors group-hover:text-primary">
                {{ deck.name }}
              </h2>
              <p
                v-if="deck.description"
                class="mt-0.5 line-clamp-2 text-sm text-muted"
              >
                {{ deck.description }}
              </p>
            </NuxtLink>

            <UDropdownMenu :items="menuItemsFor(deck)">
              <UButton
                icon="i-lucide-more-horizontal"
                color="neutral"
                variant="ghost"
                size="xs"
                :aria-label="t('decks.list.options', { name: deck.name })"
                class="tap-target relative z-10"
              />
            </UDropdownMenu>
          </div>

          <!-- Each count with a meter against the deck limits (decorative;
               the number is the information). -->
          <dl class="mt-3 grid max-w-72 grid-cols-3 gap-3 text-xs text-muted">
            <div
              v-for="section in DECK_SECTIONS"
              :key="section"
              class="deck-meter flex items-baseline gap-1.5"
              :data-state="sectionMeter(deck, section).state"
              :style="{ '--fill': sectionMeter(deck, section).fill }"
            >
              <dt>{{ sectionShortName(section) }}</dt>
              <dd class="font-numeric text-base font-bold tracking-[0.04em] text-highlighted tabular-nums">
                {{ sectionCount(deck, section) }}
              </dd>
            </div>
          </dl>

          <!-- Card kinds in Main and Extra (#148). -->
          <DecksDeckKindBreakdown
            v-if="deck.breakdown?.length"
            :groups="deck.breakdown"
            compact
            class="mt-2"
          />

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <!-- Besitz-Status (links) -->
            <UBadge
              :color="statusColor(deck)"
              variant="subtle"
              :label="statusLabel(deck)"
            />
            <SharingVisibilityBadge
              :visibility="deck.visibility"
              hide-private
            />

            <!-- Format + Legalität (rechts) -->
            <div class="ml-auto flex flex-wrap items-center justify-end gap-2">
              <UBadge
                v-if="deck.formatName"
                color="neutral"
                variant="subtle"
                icon="i-lucide-scroll-text"
                :label="deckFormatName(deck) ?? undefined"
              />
              <UBadge
                v-if="deck.legal !== null"
                :color="deck.legal ? 'success' : 'error'"
                variant="subtle"
                :label="deck.legal ? t('validation.badge.legal') : t('validation.badge.notLegal')"
              />
              <span class="text-xs text-muted tabular-nums">{{ count('decks.list.cardCount', deck.cardCount) }}</span>
            </div>
          </div>
        </div>
      </li>
    </ul>

    <div
      v-if="total > PAGE_SIZE"
      class="flex justify-end"
    >
      <UPagination
        v-model:page="page"
        :total="total"
        :items-per-page="PAGE_SIZE"
      />
    </div>

    <DecksDeckFormModal
      v-model:open="isFormOpen"
      :initial-values="editingDeck"
      @saved="onSaved"
    />

    <DecksDeckImportModal
      v-model:open="isImportOpen"
      @created="onImported"
    />

    <CollectionsFillFromDeckModal
      v-model:open="isFillOpen"
      :deck-id="fillDeck?.id ?? null"
      :collections="collectionsData?.items ?? []"
    />

    <SharingShareModal
      v-if="sharingDeck"
      v-model:open="isShareOpen"
      resource-type="deck"
      :resource-id="sharingDeck.id"
      :resource-name="sharingDeck.name"
      :share-path="sharePath"
      @updated="onShareUpdated"
    />
  </div>
</template>
