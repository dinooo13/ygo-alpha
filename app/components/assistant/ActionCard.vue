<script setup lang="ts">
import type { AssistantActionView } from '~~/shared/assistant-chat'
import { DECK_SECTIONS } from '~~/shared/deck-sections'
import type { ValidationTextSource } from '~/composables/useValidationText'

const props = defineProps<{
  action: AssistantActionView
}>()

const emit = defineEmits<{
  updated: [action: AssistantActionView]
}>()

// Everything on this card is rendered in the interface language (ADR 0014)
// from the action's kind and payload; the stored `summary` is only the
// fallback for actions whose payload lacks the fields for that.
const { t, n } = useI18n()
const apiError = useApiError()
const validationText = useValidationText()
const { formatName } = useFormatLabel()
const { cardName } = useCardText()

const isExpanded = ref(false)
const isApplying = ref(false)
const isRejecting = ref(false)
const errorMessage = ref('')

// Waiting for a decision: a gold glow; applied: a success ring; turned down
// or failed: faded.
const cardStateClass = computed(() => {
  switch (props.action.status) {
    case 'pending':
      return 'shadow-glow-gold'
    case 'applied':
      return 'ring-1 ring-success/40'
    default:
      return 'opacity-80'
  }
})

const statusColor = computed(() => {
  switch (props.action.status) {
    case 'applied':
      return 'success' as const
    case 'rejected':
      return 'neutral' as const
    case 'failed':
      return 'error' as const
    default:
      return 'warning' as const
  }
})

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function integer(value: number): string {
  return n(value, 'integer')
}

/** A format for display: a built-in one by id in the interface language, else its stored name; `null` = no format. */
function formatLabel(id: unknown, name: unknown, noFormatKey: string): string {
  if (typeof name === 'string') {
    return formatName({ id: typeof id === 'string' ? id : null, name })
  }
  if (typeof id === 'string') {
    return id
  }
  return t(noFormatKey)
}

function rowsOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of ['items', 'cards', 'changes']) {
    const value = payload[key]
    if (Array.isArray(value)) {
      return value.filter(isPlainObject)
    }
  }
  return []
}

/** A stored card name in the card language (ADR 0015); `nameDe` is missing on actions stored before #34 F3c. */
function displayCardName(row: Record<string, unknown>): unknown {
  if (typeof row.name !== 'string') {
    return row.name
  }
  return cardName({ name: row.name, nameDe: typeof row.nameDe === 'string' ? row.nameDe : null })
}

const rows = computed(() => rowsOf(props.action.payload).map((row): Record<string, unknown> => ({ ...row, name: displayCardName(row) })))

/**
 * The summary line from the action's kind and payload. The fields were
 * always stored for the deck actions (ADR 0011); `add_to_inventory` items
 * carry card names since #34 F2d — older ones show the stored summary.
 */
const summary = computed(() => {
  const { kind, payload } = props.action
  const list = rows.value
  switch (kind) {
    case 'add_to_inventory': {
      if (list.length === 0 || !list.every(row => typeof row.name === 'string')) {
        return props.action.summary
      }
      const cards = list
        .map(row => t('assistant.action.summary.cardQuantity', { name: row.name, quantity: integer(Number(row.quantity) || 0) }))
        .join(', ')
      return t('assistant.action.summary.add_to_inventory', { count: integer(list.length), cards }, list.length)
    }
    case 'create_deck': {
      if (typeof payload.name !== 'string' || !Array.isArray(payload.cards)) {
        return props.action.summary
      }
      const total = list.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0)
      return t('assistant.action.summary.create_deck', { name: payload.name, count: integer(total) }, total)
    }
    case 'update_deck_cards': {
      if (typeof payload.deckName !== 'string' || !Array.isArray(payload.changes)) {
        return props.action.summary
      }
      return t('assistant.action.summary.update_deck_cards', { deck: payload.deckName, count: integer(list.length) }, list.length)
    }
    case 'set_deck_format': {
      if (typeof payload.deckName !== 'string' || !('formatId' in payload)) {
        return props.action.summary
      }
      return t('assistant.action.summary.set_deck_format', {
        deck: payload.deckName,
        from: formatLabel(payload.previousFormatId, payload.previousFormatName, 'assistant.action.summary.noFormat'),
        to: formatLabel(payload.formatId, payload.formatName, 'assistant.action.summary.noFormat'),
      })
    }
    default:
      return props.action.summary
  }
})

// Payload fields the write tools actually produce (server/utils/assistant-tools.ts) —
// only these are ever shown, whichever of them a given action kind carries.
// `add_to_inventory` rows show their printing by the display-only `printing`
// label (ADR 0034), never the bare `printingId`; actions stored before ADR
// 0017 may still carry `printingId`/`language`/`condition`/`edition`, which
// are not shown.
const FIELDS = ['name', 'catalogCardId', 'quantity', 'printing', 'section', 'collectionId'] as const
type Field = typeof FIELDS[number]

const columns = computed<Field[]>(() => {
  const keys = FIELDS.filter(key => rows.value.some(row => row[key] !== null && row[key] !== undefined))
  // Rows carry the card's name (ADR 0011; inventory rows since #34 F2d) —
  // the bare catalog id next to it is noise. Older actions without names
  // still show the id.
  return keys.includes('name') ? keys.filter(key => key !== 'catalogCardId') : keys
})

function columnLabel(column: Field): string {
  // update_deck_cards' quantity is the new absolute amount, not a delta.
  if (column === 'quantity' && props.action.kind === 'update_deck_cards') {
    return t('assistant.action.field.newQuantity')
  }
  return t(`assistant.action.field.${column}`)
}

function displayValue(column: Field, value: unknown): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'string') {
    if (column === 'section' && (DECK_SECTIONS as readonly string[]).includes(value)) {
      return t(`decks.section.${value}`)
    }
    // A collection by its current name (#69), never its id; unknown when it
    // is gone or the server couldn't resolve it.
    if (column === 'collectionId') {
      return props.action.display?.collectionNames?.[value] ?? t('assistant.action.unknownCollection')
    }
  }
  return String(value)
}

// --- Proposal preview (create_deck / update_deck_cards / set_deck_format, ADR 0011) ---

interface DeckPreview {
  counts: { main: number, extra: number, side: number }
  /** `issueDetails` when stored (code + params, #34 F2d), else the stored `issues` text. */
  validation: { legal: boolean, issues: Array<ValidationTextSource | string> } | null
  missing: Array<{ catalogCardId: number, name: string, needed: number, owned: number }>
  /** The format-independent deck warnings (`warningDetails`, #148); none on previews stored before. */
  warnings: ValidationTextSource[]
  /** Computed with the other pending proposals of this answer for the same deck applied (a package, ADR 0026). */
  combined: boolean
}

const PREVIEW_ISSUES_SHOWN = 5

function isIssueDetail(value: unknown): value is ValidationTextSource {
  return isPlainObject(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

/** `payload.preview`, if the action carries a well-formed one (older actions don't). */
const preview = computed<DeckPreview | null>(() => {
  const raw = props.action.payload.preview
  if (!isPlainObject(raw) || !isPlainObject(raw.counts) || !Array.isArray(raw.missing)) {
    return null
  }
  const counts = raw.counts as Record<string, unknown>
  const validation = isPlainObject(raw.validation) ? raw.validation : null
  const issueDetails = validation && Array.isArray(validation.issueDetails) ? validation.issueDetails.filter(isIssueDetail) : null
  const issueTexts = validation && Array.isArray(validation.issues)
    ? validation.issues.filter((issue): issue is string => typeof issue === 'string')
    : []
  return {
    counts: { main: Number(counts.main) || 0, extra: Number(counts.extra) || 0, side: Number(counts.side) || 0 },
    validation: validation
      ? { legal: validation.legal === true, issues: issueDetails ?? issueTexts }
      : null,
    missing: raw.missing.filter(isPlainObject).map(card => ({
      catalogCardId: Number(card.catalogCardId),
      name: String(displayCardName(card) ?? ''),
      needed: Number(card.needed) || 0,
      owned: Number(card.owned) || 0,
    })),
    warnings: Array.isArray(raw.warningDetails) ? raw.warningDetails.filter(isIssueDetail) : [],
    combined: raw.combined === true,
  }
})

const previewIssues = computed(() => (preview.value?.validation?.issues ?? []).slice(0, PREVIEW_ISSUES_SHOWN).map(issue => validationText(issue)))

// Like the deck editor: a format's validation replaces the "usual size and
// copies" hints; a retired card (ADR 0019) is not a format question, so its
// warning always shows.
const previewWarnings = computed(() => {
  const current = preview.value
  if (!current) {
    return []
  }
  const shown = current.validation ? current.warnings.filter(warning => warning.code === 'card_retired') : current.warnings
  return shown.map(warning => validationText(warning))
})
const hiddenIssueCount = computed(() => Math.max(0, (preview.value?.validation?.issues.length ?? 0) - PREVIEW_ISSUES_SHOWN))

const previewCounts = computed(() => {
  const counts = preview.value?.counts ?? { main: 0, extra: 0, side: 0 }
  return t('assistant.action.preview.counts', { main: integer(counts.main), extra: integer(counts.extra), side: integer(counts.side) })
})

const legalityBadge = computed(() => {
  const validation = preview.value?.validation
  if (!validation) {
    return { color: 'neutral' as const, label: t('assistant.action.preview.noFormat') }
  }
  if (validation.legal) {
    return { color: 'success' as const, label: t('assistant.action.preview.legal') }
  }
  const count = validation.issues.length
  return { color: 'error' as const, label: t('assistant.action.preview.notLegal', { count: integer(count) }, count) }
})

// An applied create_deck / set_deck_format stores the (new or updated) deck's
// detail as its result — link to it.
const openDeckId = computed(() => {
  const { kind, status } = props.action
  if ((kind !== 'create_deck' && kind !== 'set_deck_format') || status !== 'applied') {
    return null
  }
  const result = props.action.result
  return isPlainObject(result) && typeof result.id === 'string' ? result.id : null
})

// Top-level scalars worth showing above the row table (e.g. create_deck's
// name/format, update_deck_cards' deck, set_deck_format's old/new format)
// — arrays are rendered as rows instead, everything else in the payload is
// internal detail.
const metaEntries = computed(() => {
  const entries: Array<{ key: string, label: string, value: string }> = []
  const payload = props.action.payload
  const add = (key: string, value: string) => entries.push({ key, label: t(`assistant.action.meta.${key}`), value })
  if (typeof payload.name === 'string') {
    add('name', payload.name)
  }
  // The deck by name — stored with the proposal, else its current name
  // (#69, for proposals stored without one); never its id.
  if (typeof payload.deckName === 'string') {
    add('deck', payload.deckName)
  }
  else if (typeof payload.deckId === 'string') {
    add('deck', props.action.display?.deckName ?? t('assistant.action.meta.unknownDeck'))
  }
  if (props.action.kind === 'set_deck_format') {
    add('previousFormat', formatLabel(payload.previousFormatId, payload.previousFormatName, 'assistant.action.meta.noFormat'))
    add('newFormat', formatLabel(payload.formatId, payload.formatName, 'assistant.action.meta.noFormat'))
  }
  else if (typeof payload.formatName === 'string' || typeof payload.formatId === 'string') {
    add('format', formatLabel(payload.formatId, payload.formatName, 'assistant.action.meta.noFormat'))
  }
  return entries
})

const hasDetails = computed(() => rows.value.length > 0 || metaEntries.value.length > 0)

/** apply/reject: the action, plus the other proposals of its package with their recomputed previews (ADR 0026). */
interface ResolveResponse {
  action: AssistantActionView
  related?: AssistantActionView[]
}

function emitResolved(response: ResolveResponse) {
  emit('updated', response.action)
  for (const view of response.related ?? []) {
    emit('updated', view)
  }
}

async function apply() {
  if (isApplying.value || isRejecting.value) {
    return
  }
  isApplying.value = true
  errorMessage.value = ''
  try {
    const response = await $fetch<ResolveResponse>(
      `/api/assistant/chat/actions/${props.action.id}/apply`,
      { method: 'POST' },
    )
    emitResolved(response)
  }
  catch (error) {
    errorMessage.value = apiError(error, 'assistant.action.errors.apply')
  }
  finally {
    isApplying.value = false
  }
}

async function reject() {
  if (isApplying.value || isRejecting.value) {
    return
  }
  isRejecting.value = true
  errorMessage.value = ''
  try {
    const response = await $fetch<ResolveResponse>(
      `/api/assistant/chat/actions/${props.action.id}/reject`,
      { method: 'POST' },
    )
    emitResolved(response)
  }
  catch (error) {
    errorMessage.value = apiError(error, 'assistant.action.errors.reject')
  }
  finally {
    isRejecting.value = false
  }
}
</script>

<template>
  <!-- An "activated spell" (ADR 0016): a spell-colored stripe on top, a
       gold glow while it waits for a decision. -->
  <div
    class="panel relative w-full max-w-md overflow-hidden p-3 pt-4 text-sm transition-[box-shadow,opacity] duration-200"
    :class="cardStateClass"
    data-frame="spell"
  >
    <span
      class="frame-stripe absolute inset-x-0 top-0 h-[3px]"
      aria-hidden="true"
    />
    <!-- The status badge wraps under the title when both don't fit (a phone),
         so the title is never cut off. -->
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span
        class="inline-flex min-w-0 items-center gap-2 font-semibold text-highlighted"
        data-testid="action-title"
      >
        <UIcon
          name="i-lucide-scroll-text"
          class="size-4 shrink-0 text-secondary"
          aria-hidden="true"
        />
        <span class="min-w-0 break-words">{{ t(`assistant.action.kind.${action.kind}`) }}</span>
      </span>
      <UBadge
        :color="statusColor"
        variant="subtle"
        class="shrink-0"
        :label="t(`assistant.action.status.${action.status}`)"
      />
    </div>

    <p class="mt-1 text-toned">
      {{ summary }}
    </p>

    <div
      v-if="preview"
      class="mt-2 space-y-2 rounded-lg bg-elevated/60 p-2.5 text-xs ring-1 ring-default"
      data-testid="action-preview"
    >
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          :color="legalityBadge.color"
          variant="subtle"
          size="sm"
          :label="legalityBadge.label"
        />
        <span class="text-toned">
          {{ previewCounts }}
        </span>
      </div>

      <ul
        v-if="previewIssues.length > 0"
        class="list-inside list-disc space-y-0.5 text-error"
      >
        <li
          v-for="(issue, index) in previewIssues"
          :key="index"
        >
          {{ issue }}
        </li>
        <li
          v-if="hiddenIssueCount > 0"
          class="list-none text-muted"
        >
          {{ t('assistant.action.preview.moreIssues', { count: integer(hiddenIssueCount) }, hiddenIssueCount) }}
        </li>
      </ul>

      <div
        v-if="previewWarnings.length > 0"
        data-testid="action-preview-warnings"
      >
        <p class="font-medium text-highlighted">
          {{ t('decks.warningsTitle') }}
        </p>
        <ul class="mt-0.5 list-inside list-disc space-y-0.5 text-warning">
          <li
            v-for="(warning, index) in previewWarnings"
            :key="index"
          >
            {{ warning }}
          </li>
        </ul>
      </div>

      <div v-if="preview.missing.length > 0">
        <p class="font-medium text-highlighted">
          {{ t('assistant.action.preview.missingTitle') }}
        </p>
        <ul class="mt-0.5 space-y-0.5 text-warning">
          <li
            v-for="card in preview.missing"
            :key="card.catalogCardId"
          >
            {{ t('assistant.action.preview.missingCard', { name: card.name, needed: integer(card.needed), owned: integer(card.owned) }) }}
          </li>
        </ul>
      </div>

      <p
        v-if="preview.combined"
        class="flex items-start gap-1.5 text-toned"
        data-testid="action-preview-combined"
      >
        <UIcon
          name="i-lucide-layers"
          class="mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span>{{ t('assistant.action.preview.combined') }}</span>
      </p>

      <p class="text-muted">
        {{ t('assistant.action.preview.snapshot') }}
      </p>
    </div>

    <UButton
      v-if="hasDetails"
      color="neutral"
      variant="link"
      size="xs"
      class="tap-target mt-1 px-0"
      :label="isExpanded ? t('assistant.action.hideDetails') : t('assistant.action.showDetails')"
      :trailing-icon="isExpanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
      @click="() => { isExpanded = !isExpanded }"
    />

    <div
      v-if="isExpanded"
      class="mt-2 space-y-2"
    >
      <dl
        v-if="metaEntries.length > 0"
        class="space-y-0.5 text-xs text-muted"
      >
        <div
          v-for="entry in metaEntries"
          :key="entry.key"
          class="flex gap-1"
        >
          <dt class="font-medium">
            {{ entry.label }}:
          </dt>
          <dd>{{ entry.value }}</dd>
        </div>
      </dl>

      <div
        v-if="rows.length > 0"
        class="overflow-x-auto"
      >
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="text-[0.6875rem] tracking-wider text-muted uppercase">
              <th
                v-for="column in columns"
                :key="column"
                class="pr-3 pb-1 font-medium"
              >
                {{ columnLabel(column) }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, rowIndex) in rows"
              :key="rowIndex"
              class="border-t border-muted"
            >
              <td
                v-for="column in columns"
                :key="column"
                class="py-1 pr-3"
              >
                {{ displayValue(column, row[column]) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p
      v-if="errorMessage"
      class="mt-2 text-xs text-error"
    >
      {{ errorMessage }}
    </p>

    <div
      v-if="action.status === 'pending'"
      class="mt-3 flex gap-2"
    >
      <UButton
        size="xs"
        icon="i-lucide-check"
        :label="t('assistant.action.apply')"
        :loading="isApplying"
        :disabled="isRejecting"
        class="tap-target"
        @click="apply"
      />
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-x"
        :label="t('assistant.action.reject')"
        :loading="isRejecting"
        :disabled="isApplying"
        class="tap-target"
        @click="reject"
      />
    </div>

    <UButton
      v-if="openDeckId"
      :to="`/decks/${openDeckId}`"
      size="xs"
      color="neutral"
      variant="outline"
      icon="i-lucide-layers"
      :label="t('assistant.action.openDeck')"
      class="tap-target mt-3"
    />
  </div>
</template>
