<script setup lang="ts">
/**
 * "Deck importieren": paste a deck list (YDK, ydke:// link, YGO Omega deck
 * code or a text recipe) or pick a .ydk file, review the cards grouped by
 * Main / Extra / Side, and create the deck. Matching is the server's
 * (`POST /api/decks/import/preview`, the same as quick capture); the deck is
 * created by the existing `POST /api/decks`.
 */
import { DECK_NAME_MAX_LENGTH, DECK_SECTIONS } from '~~/shared/deck-sections'
import type { DeckSection } from '~~/shared/deck-sections'
import { summarizeEntryRows } from '~/utils/card-entry'
import {
  buildImportCards,
  createImportRows,
  IMPORT_FILE_MAX_BYTES,
  IMPORT_TEXT_MAX_LENGTH,
  importCounts,
  importSizeWarnings,
  MAX_IMPORT_CARDS,
  rowsInSection,
} from '~/utils/deck-import'
import type { DeckImportPreview, DeckImportRow } from '~/utils/deck-import'

interface FormatItem {
  id: string
  name: string
  isBuiltin: boolean
}

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'created': [deck: { id: string }]
}>()

const { t, n } = useI18n()
const count = useCount()
const apiError = useApiError()
const validationText = useValidationText()
const { formatName, sortFormats } = useFormatLabel()

const openProxy = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

// reka-ui reserves the empty string for "clear selection", so "no format" is a sentinel (as in the deck editor).
const NO_FORMAT = '__no_format__'

const step = ref<'input' | 'review'>('input')
const text = ref('')
const rows = ref<DeckImportRow[]>([])
const detectedFormat = ref<DeckImportPreview['format']>('text')
const deckName = ref('')
const formatId = ref(NO_FORMAT)
const errorMessage = ref('')
const isPreviewing = ref(false)
const isCreating = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
let fileStem = ''

const { data: formatsData } = useFetch<{ items: FormatItem[] }>('/api/formats', {
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  default: () => ({ items: [] }),
})

const formatItems = computed(() => [
  { label: t('decks.editor.noFormat'), value: NO_FORMAT },
  ...sortFormats(formatsData.value?.items ?? []).map(format => ({
    label: format.isBuiltin ? formatName(format) : t('decks.editor.ownFormat', { name: format.name }),
    value: format.id,
  })),
])

watch(() => props.open, (open) => {
  if (open) {
    step.value = 'input'
    text.value = ''
    rows.value = []
    deckName.value = ''
    formatId.value = NO_FORMAT
    errorMessage.value = ''
    fileStem = ''
  }
})

const summary = computed(() => summarizeEntryRows(rows.value))
const unresolvedCount = computed(() => summary.value.unsicher + summary.value.ohneTreffer)
const counts = computed(() => importCounts(rows.value))
const warnings = computed(() => importSizeWarnings(counts.value))
const cards = computed(() => buildImportCards(rows.value))
const canCreate = computed(() => cards.value.length > 0 && unresolvedCount.value === 0 && deckName.value.trim() !== '')

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }
  errorMessage.value = ''
  if (file.size > IMPORT_FILE_MAX_BYTES) {
    errorMessage.value = t('decks.import.errors.fileTooLarge')
    return
  }
  try {
    text.value = await file.text()
    fileStem = file.name.replace(/\.[^.]*$/, '')
  }
  catch {
    errorMessage.value = t('decks.import.errors.fileUnreadable')
  }
  finally {
    // The same file can be chosen again after the text was edited.
    if (fileInput.value) {
      fileInput.value.value = ''
    }
  }
}

async function analyze() {
  if (text.value.trim() === '') {
    errorMessage.value = t('decks.import.errors.empty')
    return
  }
  if (text.value.length > IMPORT_TEXT_MAX_LENGTH) {
    errorMessage.value = t('decks.import.errors.tooLong', { max: n(IMPORT_TEXT_MAX_LENGTH, 'integer') })
    return
  }

  isPreviewing.value = true
  errorMessage.value = ''
  try {
    const preview = await $fetch<DeckImportPreview>('/api/decks/import/preview', { method: 'POST', body: { text: text.value } })
    rows.value = createImportRows(preview)
    detectedFormat.value = preview.format
    if (deckName.value.trim() === '') {
      deckName.value = (fileStem || t('decks.import.defaultName')).slice(0, DECK_NAME_MAX_LENGTH)
    }
    step.value = 'review'
  }
  catch (error) {
    errorMessage.value = apiError(error, 'decks.import.errors.previewFailed')
  }
  finally {
    isPreviewing.value = false
  }
}

function updateRow(id: string, patch: Partial<DeckImportRow>) {
  rows.value = rows.value.map(row => row.id === id ? { ...row, ...patch } : row)
}

function removeRow(id: string) {
  rows.value = rows.value.filter(row => row.id !== id)
}

function sectionLabel(section: DeckSection): string {
  return t(`decks.section.${section}`)
}

async function create() {
  if (!canCreate.value) {
    return
  }
  if (cards.value.length > MAX_IMPORT_CARDS) {
    errorMessage.value = t('decks.import.errors.tooManyCards', { max: n(MAX_IMPORT_CARDS, 'integer') })
    return
  }

  isCreating.value = true
  errorMessage.value = ''
  try {
    const deck = await $fetch<{ id: string }>('/api/decks', {
      method: 'POST',
      body: {
        name: deckName.value.trim(),
        format_id: formatId.value === NO_FORMAT ? null : formatId.value,
        cards: cards.value,
      },
    })
    emit('created', deck)
    openProxy.value = false
  }
  catch (error) {
    errorMessage.value = apiError(error, 'decks.import.errors.createFailed')
  }
  finally {
    isCreating.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openProxy"
    :title="t('decks.import.title')"
    :description="step === 'input' ? t('decks.import.description') : t('decks.import.reviewDescription')"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <form
        v-if="step === 'input'"
        class="space-y-4"
        @submit.prevent="analyze"
      >
        <UFormField
          :label="t('decks.import.list.label')"
          :description="t('decks.import.list.description')"
        >
          <UTextarea
            v-model="text"
            :rows="10"
            class="w-full font-mono"
            name="decklist"
            :aria-label="t('decks.import.list.label')"
            :placeholder="t('decks.import.list.placeholder')"
          />
        </UFormField>

        <div class="flex flex-wrap items-center gap-3">
          <input
            ref="fileInput"
            type="file"
            accept=".ydk,.txt,text/plain"
            class="sr-only"
            tabindex="-1"
            data-testid="deck-import-file"
            :aria-label="t('decks.import.file.label')"
            @change="onFile"
          >
          <UButton
            type="button"
            icon="i-lucide-file-up"
            color="neutral"
            variant="outline"
            :label="t('decks.import.file.pick')"
            @click="() => fileInput?.click()"
          />
          <span class="text-xs text-muted">{{ t('decks.import.file.hint') }}</span>
        </div>

        <p
          v-if="errorMessage"
          role="alert"
          class="text-sm text-error"
        >
          {{ errorMessage }}
        </p>

        <div class="flex justify-end gap-2">
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="() => { openProxy = false }"
          />
          <UButton
            type="submit"
            icon="i-lucide-scan-text"
            :loading="isPreviewing"
            :label="t('decks.import.analyze')"
          />
        </div>
      </form>

      <form
        v-else
        class="space-y-4"
        @submit.prevent="create"
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField :label="t('decks.form.name')">
            <UInput
              v-model="deckName"
              name="name"
              class="w-full"
              :maxlength="DECK_NAME_MAX_LENGTH"
              :aria-label="t('decks.form.nameLabel')"
            />
          </UFormField>
          <UFormField :label="t('decks.import.format')">
            <USelect
              v-model="formatId"
              :items="formatItems"
              class="w-full"
              :aria-label="t('decks.editor.formatLabel')"
            />
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-sm">
          <UBadge
            color="neutral"
            variant="subtle"
            icon="i-lucide-file-search"
            :label="t('decks.import.detected', { format: t(`decks.import.formats.${detectedFormat}`) })"
          />
          <span class="text-muted">{{ t('quickEntry.summary.total', { count: n(summary.total, 'integer') }) }}</span>
          <span class="text-success">{{ t('quickEntry.summary.sicher', { count: n(summary.sicher, 'integer') }) }}</span>
          <span class="text-warning">{{ t('quickEntry.summary.unsicher', { count: n(summary.unsicher, 'integer') }) }}</span>
          <span class="text-error">{{ t('quickEntry.summary.ohne_treffer', { count: n(summary.ohneTreffer, 'integer') }) }}</span>
        </div>

        <UAlert
          v-if="warnings.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('decks.import.sizeWarningTitle')"
        >
          <template #description>
            <ul class="list-inside list-disc space-y-0.5">
              <li
                v-for="warning in warnings"
                :key="warning.code"
              >
                {{ validationText(warning) }}
              </li>
            </ul>
          </template>
        </UAlert>

        <div
          v-for="section in DECK_SECTIONS"
          :key="section"
          :data-section="section"
          class="space-y-1"
        >
          <h3 class="flex items-baseline gap-2 text-sm font-semibold text-highlighted">
            {{ sectionLabel(section) }}
            <span class="text-xs font-normal text-muted">{{ count('decks.import.cardCount', counts[section]) }}</span>
          </h3>
          <ul
            v-if="rowsInSection(rows, section).length > 0"
            class="divide-y divide-default rounded-lg border border-default"
          >
            <li
              v-for="row in rowsInSection(rows, section)"
              :key="row.id"
            >
              <DecksDeckImportRow
                :row="row"
                @update="patch => updateRow(row.id, patch)"
                @remove="removeRow(row.id)"
              />
            </li>
          </ul>
          <p
            v-else
            class="text-xs text-muted"
          >
            {{ t('decks.import.sectionEmpty') }}
          </p>
        </div>

        <p
          v-if="unresolvedCount > 0"
          class="text-xs text-warning"
        >
          {{ t('decks.import.unresolvedHint') }}
        </p>

        <p
          v-if="errorMessage"
          role="alert"
          class="text-sm text-error"
        >
          {{ errorMessage }}
        </p>

        <div class="flex justify-between gap-2">
          <UButton
            type="button"
            icon="i-lucide-arrow-left"
            color="neutral"
            variant="ghost"
            :label="t('decks.import.back')"
            @click="() => { step = 'input'; errorMessage = '' }"
          />
          <UButton
            type="submit"
            icon="i-lucide-file-down"
            :loading="isCreating"
            :disabled="!canCreate"
            :label="t('decks.import.create')"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
