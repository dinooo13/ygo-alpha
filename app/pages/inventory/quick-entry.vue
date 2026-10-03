<script setup lang="ts">
import {
  MAX_ENTRY_LINES,
  MAX_ENTRY_ROWS,
  createEntryRows,
} from '~/utils/card-entry'
import type { EntryRow, EntrySuggestResult } from '~/utils/card-entry'
import { countEntryLines } from '~~/shared/decklist'

interface CollectionOption {
  id: string
  name: string
}

usePageTitle('quickEntry.title')

const { t, n } = useI18n()
const apiError = useApiError()

const toast = useToast()
const route = useRoute()

const rows = ref<EntryRow[]>([])
const isSuggesting = ref(false)
const errorMessage = ref('')
const warningMessage = ref('')

// Deep-link from /inventory?collectionId=… so the Standardwerte panel starts
// on the collection the user was just looking at.
const presetCollectionId = computed(() => {
  const value = route.query.collectionId
  return typeof value === 'string' && value !== '' ? value : null
})

const { data: collectionsData } = await useFetch<{ items: CollectionOption[], allCount: number }>('/api/collections', {
  default: () => ({ items: [], allCount: 0 }),
})
const collections = computed(() => collectionsData.value?.items ?? [])

async function requestSuggestions(body: { text?: string, items?: string[] }) {
  isSuggesting.value = true
  errorMessage.value = ''
  warningMessage.value = ''

  try {
    const response = await $fetch<{ results: EntrySuggestResult[] }>('/api/inventory/entry/suggest', {
      method: 'POST',
      body,
    })

    const free = Math.max(0, MAX_ENTRY_ROWS - rows.value.length)
    const accepted = response.results.slice(0, free)
    const dropped = response.results.length - accepted.length
    if (dropped > 0) {
      warningMessage.value = t('quickEntry.queueFull.description', {
        max: n(MAX_ENTRY_ROWS, 'integer'),
        dropped: n(dropped, 'integer'),
      }, dropped)
    }

    rows.value = [...rows.value, ...createEntryRows(accepted)]
    return accepted.length
  }
  catch (error) {
    errorMessage.value = apiError(error, 'quickEntry.errors.suggestFailed')
    return 0
  }
  finally {
    isSuggesting.value = false
  }
}

// --- Liste -----------------------------------------------------------------

// Input syntax samples: card names and codes, the same in every language.
const LIST_PLACEHOLDER = ['3x Dark Magician', 'Pot of Greed', 'Dark Magician (SDY-006)', '46986414'].join('\n')
const LIST_EXAMPLES = ['3x Dark Magician', 'Dark Magician x3', 'Dark Magician (SDY-006)', 'SDY-006', '46986414']
  .map((text, index, all) => ({ text, separator: index < all.length - 1 ? ', ' : '' }))

const listText = ref('')

// Distinct card lines: a pasted YDK has one line per copy, and headers and comments are no cards.
const listLineCount = computed(() => countEntryLines(listText.value))
const tooManyLines = computed(() => listLineCount.value > MAX_ENTRY_LINES)

async function submitList() {
  if (listText.value.trim() === '') {
    errorMessage.value = t('quickEntry.errors.empty')
    return
  }
  if (tooManyLines.value) {
    errorMessage.value = t('quickEntry.errors.tooManyLines', { max: n(MAX_ENTRY_LINES, 'integer') })
    return
  }

  const count = await requestSuggestions({ text: listText.value })
  if (count > 0) {
    listText.value = ''
  }
}

// --- Speichern -------------------------------------------------------------

function onSaved(result: { created: number, merged: number }) {
  toast.add({
    title: t('quickEntry.toast.saved.title'),
    description: t('quickEntry.toast.saved.description', { created: n(result.created, 'integer'), merged: n(result.merged, 'integer') }),
    icon: 'i-lucide-check',
    color: 'success',
  })
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-2">
      <LayoutBackLink
        :to="{ path: '/inventory', query: presetCollectionId ? { collectionId: presetCollectionId } : {} }"
        :label="t('quickEntry.backToInventory')"
      />
      <LayoutPageHeader
        :title="t('quickEntry.title')"
        :description="t('quickEntry.description')"
      />
    </div>

    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-sparkles"
      :title="t('quickEntry.assistantHint.title')"
      :description="t('quickEntry.assistantHint.description')"
    >
      <template #actions>
        <UButton
          to="/assistant"
          size="xs"
          color="neutral"
          variant="outline"
          :label="t('quickEntry.assistantHint.cta')"
          class="tap-target"
        />
      </template>
    </UAlert>

    <div class="panel p-4">
      <div class="space-y-3">
        <UFormField
          :label="t('quickEntry.list.label')"
          :description="t('quickEntry.list.description')"
        >
          <UTextarea
            v-model="listText"
            :rows="8"
            class="w-full"
            :aria-label="t('quickEntry.list.label')"
            :placeholder="LIST_PLACEHOLDER"
          />
        </UFormField>

        <p class="text-xs text-muted">
          {{ t('quickEntry.list.examples') }}
          <template
            v-for="example in LIST_EXAMPLES"
            :key="example.text"
          >
            <span class="font-mono">{{ example.text }}</span>{{ example.separator }}
          </template>
        </p>

        <p
          v-if="tooManyLines"
          class="text-xs text-warning"
        >
          {{ t('quickEntry.list.tooManyLines', { count: n(listLineCount, 'integer'), max: n(MAX_ENTRY_LINES, 'integer') }) }}
        </p>

        <UButton
          icon="i-lucide-scan-text"
          :label="t('quickEntry.list.submit')"
          :loading="isSuggesting"
          :disabled="tooManyLines"
          @click="submitList"
        />
      </div>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="subtle"
      :title="t('quickEntry.errors.title')"
      :description="errorMessage"
    />

    <UAlert
      v-if="warningMessage"
      color="warning"
      variant="subtle"
      :title="t('quickEntry.queueFull.title')"
      :description="warningMessage"
    />

    <div
      v-if="rows.length > 0"
      class="space-y-4"
    >
      <h2 class="text-lg font-semibold text-highlighted">
        {{ t('quickEntry.review.title') }}
      </h2>
      <EntryReviewTable
        v-model:rows="rows"
        :collections="collections"
        :preset-collection-id="presetCollectionId"
        @saved="onSaved"
      />
    </div>
    <p
      v-else-if="!isSuggesting"
      class="text-sm text-muted"
    >
      {{ t('quickEntry.review.nothingYet') }}
    </p>
  </div>
</template>
