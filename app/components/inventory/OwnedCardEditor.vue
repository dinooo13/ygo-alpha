<script setup lang="ts">
/**
 * "Im Inventar": the user's copies of one card, one row per collection and
 * printing (ADR 0017, ADR 0034), edited in place. The inventory's section of the card detail
 * overlay (`CardDetailModal`, #88/#135), the same from "Galerie" and "Liste".
 *
 * - Per row: the collection (a select; picking one that already holds the
 *   card in the same printing merges the copies into it), the quantity
 *   (− / input / +; 0 asks to remove the row), a remove button, the printing
 *   (set code and rarity, each optional; picking a printing the collection
 *   already holds merges too) and the note (explicit save).
 * - "Zu Sammlung hinzufügen" adds one copy to a collection the card isn't in
 *   yet; it stays when the last row is gone, so the card can come back.
 * - The rows come from `GET /api/inventory?catalogCardId=`. They are sorted
 *   here (no collection first, then by name, then by printing) so they don't
 *   jump around after an edit; the API orders by `updatedAt`.
 * - Every change is saved at once and optimistically. All writes run one
 *   after another through one queue, so a quick "+ + +" sends 2, 3, 4 in
 *   order and the last value wins. A failed write shows the translated error
 *   and reloads the rows. Controls stay enabled while a write is in flight:
 *   disabling a focused button would drop keyboard focus to the page.
 */
import { printingLabel } from '~~/shared/printing'
import type { StackPrinting } from '~~/shared/printing'

interface OwnedRow {
  id: string
  collectionId: string | null
  /** Set code and rarity key, `null` = unknown (ADR 0034). */
  setCode: string | null
  rarity: string | null
  quantity: number
  note: string | null
}

interface OwnedRowResponse {
  id: string
  collectionId: string | null
  setCode?: string | null
  rarity?: string | null
  quantity: number
  note: string | null
}

interface CollectionOption {
  id: string
  name: string
}

const props = defineProps<{
  catalogCardId: number
  /** The card's display name, for the removal question. */
  cardLabel: string
  collections: CollectionOption[]
  /** The row the overlay was opened from ("Liste"): highlighted and scrolled into view. */
  focusRowId?: string | null
  /**
   * Called after every successful write, so the page behind the overlay can
   * refresh. A function prop rather than an emit on purpose: a queued write
   * can finish after the overlay has closed, and Vue drops the emits of an
   * unmounted component.
   */
  afterWrite?: () => void
}>()

const NONE = '__no_collection__'

const { t, n } = useI18n()
const apiError = useApiError()
const { confirm } = useConfirm()
const toast = useToast()

const rows = ref<OwnedRow[]>([])
const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMessage = ref('')
const liveMessage = ref('')
const editingNoteId = ref<string | null>(null)
const noteDraft = ref('')

const root = useTemplateRef<HTMLElement>('root')
const heading = useTemplateRef<HTMLElement>('heading')

const total = computed(() => rows.value.reduce((sum, row) => sum + row.quantity, 0))

function collectionName(collectionId: string | null): string {
  if (collectionId === null) {
    return t('inventory.breakdown.noCollection')
  }
  return props.collections.find(c => c.id === collectionId)?.name ?? t('inventory.breakdown.unnamedCollection')
}

// The row in the controls' labels: its collection and, when known, its
// printing, so two printings in one collection stay apart.
function collectionLabel(row: OwnedRow): string {
  const name = collectionName(row.collectionId)
  const printing = printingLabel(row)
  return printing ? `${name} · ${printing}` : name
}

const { setCodes, loading: printingsLoading } = useCardPrintings(() => props.catalogCardId)

function toOwnedRow(item: OwnedRowResponse): OwnedRow {
  return {
    id: item.id,
    collectionId: item.collectionId,
    setCode: item.setCode ?? null,
    rarity: item.rarity ?? null,
    quantity: item.quantity,
    note: item.note,
  }
}

const collectionItems = computed(() => [
  { label: t('inventory.noCollectionOption'), value: NONE },
  ...props.collections.map(c => ({ label: c.name, value: c.id })),
])

// The collections the card isn't in yet ("(keine Sammlung)" first).
const addItems = computed(() => {
  const used = new Set(rows.value.map(row => row.collectionId))
  const targets: Array<string | null> = [
    ...(used.has(null) ? [] : [null]),
    ...props.collections.filter(c => !used.has(c.id)).map(c => c.id),
  ]
  return targets.map(collectionId => ({
    label: collectionName(collectionId),
    onSelect: () => addTo(collectionId),
  }))
})

function compareCollections(a: string | null, b: string | null): number {
  if (a === b) {
    return 0
  }
  if (a === null || b === null) {
    return a === null ? -1 : 1
  }
  return collectionName(a).localeCompare(collectionName(b)) || a.localeCompare(b)
}

function sortRows(list: OwnedRow[]): OwnedRow[] {
  // No collection first, then by collection name; within a collection
  // "printing unknown" first, then by printing.
  return [...list].sort((a, b) =>
    compareCollections(a.collectionId, b.collectionId)
    || (printingLabel(a) ?? '').localeCompare(printingLabel(b) ?? ''))
}

let latest = 0

async function loadRows() {
  if (import.meta.server) {
    return
  }
  const request = ++latest
  try {
    const { items } = await $fetch<{ items: OwnedRowResponse[] }>('/api/inventory', {
      query: { catalogCardId: props.catalogCardId, pageSize: 100 },
    })
    if (request !== latest) {
      return
    }
    rows.value = sortRows(items.map(toOwnedRow))
    loadState.value = 'ready'
  }
  catch {
    if (request === latest) {
      loadState.value = 'error'
    }
  }
}

function rowElement(id: string): HTMLElement | undefined {
  return [...(root.value?.querySelectorAll<HTMLElement>('[data-row-id]') ?? [])].find(el => el.dataset.rowId === id)
}

async function focusRowControl(id: string, control: 'collection' | 'printing' | 'note' = 'collection') {
  await nextTick()
  const selector = control === 'collection'
    ? '[data-collection-select]'
    : control === 'printing' ? '[data-printing-select] button, [data-printing-select] input' : '[data-note-button]'
  rowElement(id)?.querySelector<HTMLElement>(selector)?.focus()
}

watch(() => props.catalogCardId, async () => {
  loadState.value = 'loading'
  rows.value = []
  await loadRows()
  if (props.focusRowId) {
    await nextTick()
    rowElement(props.focusRowId)?.scrollIntoView?.({ block: 'nearest' })
  }
}, { immediate: true })

// One write after another (`useQueuedWrites`). `afterWrite` and the reload
// after a failure run inside the queued task, so the next write waits for
// them, as before.
const writes = useQueuedWrites()

async function enqueue(task: () => Promise<void>): Promise<boolean> {
  errorMessage.value = ''
  const result = await writes.enqueue(async () => {
    try {
      await task()
    }
    catch (error) {
      errorMessage.value = apiError(error, 'inventory.editor.saveFailed')
      await loadRows()
      return false
    }
    props.afterWrite?.()
    return true
  })
  return result.ok && result.value
}

function setQuantity(row: OwnedRow, value: number) {
  if (value < 1) {
    requestRemove(row)
    return
  }
  const { id } = row
  row.quantity = value
  enqueue(async () => {
    await $fetch(`/api/inventory/${id}`, { method: 'PATCH', body: { quantity: value } })
    // A reload in between (after a move) may have brought an older value.
    const current = rows.value.find(r => r.id === id)
    if (current) {
      current.quantity = value
    }
    liveMessage.value = t('inventory.editor.status', { collection: collectionLabel(row), count: n(value, 'integer') }, value)
  })
}

function moveRow(row: OwnedRow, value: string) {
  const collectionId = value === NONE ? null : value
  if (collectionId === row.collectionId) {
    return
  }
  const { id } = row
  const target = collectionName(collectionId)
  row.collectionId = collectionId
  enqueue(async () => {
    const saved = await $fetch<{ id: string }>(`/api/inventory/${id}`, { method: 'PATCH', body: { collectionId } })
    if (saved.id !== id) {
      toast.add({ title: t('inventory.editor.merged', { collection: target }), color: 'success', icon: 'i-lucide-merge' })
    }
    await loadRows()
    await focusRowControl(saved.id)
  })
}

function setPrinting(row: OwnedRow, printing: StackPrinting) {
  if (printing.setCode === row.setCode && printing.rarity === row.rarity) {
    return
  }
  const { id } = row
  const target = collectionName(row.collectionId)
  row.setCode = printing.setCode
  row.rarity = printing.rarity
  enqueue(async () => {
    const saved = await $fetch<{ id: string }>(`/api/inventory/${id}`, {
      method: 'PATCH',
      body: { setCode: printing.setCode, rarity: printing.rarity },
    })
    if (saved.id !== id) {
      toast.add({ title: t('inventory.editor.merged', { collection: target }), color: 'success', icon: 'i-lucide-merge' })
    }
    await loadRows()
    await focusRowControl(saved.id, 'printing')
  })
}

async function requestRemove(row: OwnedRow) {
  const confirmed = await confirm({
    title: t('inventory.confirm.removeRow.title'),
    description: t('inventory.confirm.removeRow.description', { name: props.cardLabel, collection: collectionLabel(row) }),
  })
  if (!confirmed) {
    return
  }
  const { id } = row
  enqueue(async () => {
    await $fetch(`/api/inventory/${id}`, { method: 'DELETE' })
    rows.value = rows.value.filter(r => r.id !== id)
    await nextTick()
    heading.value?.focus()
  })
}

// Adding focuses the new row once it's there, so the menu must not hand
// focus back to its button when it closes.
let adding = false

function addTo(collectionId: string | null) {
  adding = true
  enqueue(async () => {
    try {
      const created = await $fetch<{ id: string }>('/api/inventory', {
        method: 'POST',
        body: { catalog_card_id: props.catalogCardId, collection_id: collectionId, quantity: 1 },
      })
      await loadRows()
      await focusRowControl(created.id)
    }
    catch (error) {
      await nextTick()
      root.value?.querySelector<HTMLElement>('[data-add-button]')?.focus()
      throw error
    }
    finally {
      adding = false
    }
  })
}

function onAddMenuCloseAutoFocus(event: Event) {
  if (adding) {
    event.preventDefault()
  }
}

function startNote(row: OwnedRow) {
  editingNoteId.value = row.id
  noteDraft.value = row.note ?? ''
}

function cancelNote(row: OwnedRow) {
  editingNoteId.value = null
  focusRowControl(row.id, 'note')
}

function saveNote(row: OwnedRow) {
  const { id } = row
  const note = noteDraft.value.trim() || null
  row.note = note
  editingNoteId.value = null
  focusRowControl(id, 'note')
  enqueue(async () => {
    await $fetch(`/api/inventory/${id}`, { method: 'PATCH', body: { note } })
    const current = rows.value.find(r => r.id === id)
    if (current) {
      current.note = note
    }
  })
}

function retry() {
  loadState.value = 'loading'
  loadRows()
}
</script>

<template>
  <section
    ref="root"
    class="space-y-3"
  >
    <div class="flex items-baseline justify-between gap-3">
      <h3
        ref="heading"
        tabindex="-1"
        class="text-sm font-semibold text-highlighted focus:outline-none"
      >
        {{ t('inventory.preview.owned') }}
      </h3>
      <p
        v-if="loadState === 'ready' && rows.length > 0"
        class="font-numeric text-sm font-semibold tracking-[0.04em] text-highlighted tabular-nums"
      >
        {{ t('card.totalQuantity', { count: n(total, 'integer') }) }}
      </p>
    </div>

    <p
      v-if="errorMessage"
      role="alert"
      class="text-sm text-error"
    >
      {{ errorMessage }}
    </p>
    <span
      class="sr-only"
      aria-live="polite"
    >{{ liveMessage }}</span>

    <div
      v-if="loadState === 'loading'"
      class="space-y-2"
    >
      <USkeleton
        v-for="i in 2"
        :key="i"
        class="h-20 w-full rounded-lg"
      />
    </div>

    <div
      v-else-if="loadState === 'error'"
      class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-default p-3"
    >
      <p class="text-sm text-toned">
        {{ t('inventory.editor.loadFailed') }}
      </p>
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        size="sm"
        class="tap-target"
        :label="t('common.retry')"
        @click="retry"
      />
    </div>

    <template v-else>
      <p
        v-if="rows.length === 0"
        class="text-sm text-muted"
      >
        {{ t('inventory.editor.notOwned') }}
      </p>

      <ul
        v-else
        class="space-y-2"
      >
        <li
          v-for="row in rows"
          :key="row.id"
          :data-row-id="row.id"
          :data-focused="row.id === focusRowId ? '' : undefined"
          class="rounded-lg border border-default bg-elevated/40 p-3"
          :class="{ 'ring-1 ring-primary/50': row.id === focusRowId }"
        >
          <!-- The select takes the whole line on phones; the stepper and
               the remove button wrap below it. -->
          <div class="flex flex-wrap items-center gap-2">
            <USelect
              data-collection-select
              :model-value="row.collectionId ?? NONE"
              :items="collectionItems"
              :aria-label="t('inventory.editor.collection', { collection: collectionLabel(row) })"
              size="sm"
              class="min-w-0 flex-1 basis-40 max-lg:min-h-11"
              @update:model-value="(value: string) => moveRow(row, value)"
            />
            <div class="flex items-center gap-1">
              <CardQuantityStepper
                :model-value="row.quantity"
                :min="0"
                size="sm"
                :input-label="t('inventory.editor.quantity', { collection: collectionLabel(row) })"
                :decrease-label="t('inventory.editor.decrease', { collection: collectionLabel(row) })"
                :increase-label="t('inventory.editor.increase', { collection: collectionLabel(row) })"
                @update:model-value="(value: number) => setQuantity(row, value)"
              />
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                class="tap-target"
                :aria-label="t('inventory.editor.remove', { collection: collectionLabel(row) })"
                @click="requestRemove(row)"
              />
            </div>
          </div>

          <div
            data-printing-select
            class="mt-2"
          >
            <InventoryPrintingSelect
              :model-value="{ setCode: row.setCode, rarity: row.rarity }"
              :set-codes="setCodes"
              :loading="printingsLoading"
              :label="collectionLabel(row)"
              size="sm"
              @update:model-value="(value: StackPrinting) => setPrinting(row, value)"
            />
          </div>

          <form
            v-if="editingNoteId === row.id"
            class="mt-2 space-y-2"
            @submit.prevent="saveNote(row)"
          >
            <UTextarea
              v-model="noteDraft"
              :rows="2"
              autoresize
              autofocus
              :aria-label="t('inventory.editor.noteFor', { collection: collectionLabel(row) })"
              class="w-full"
            />
            <div class="flex justify-end gap-2">
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                size="sm"
                class="tap-target"
                :label="t('common.cancel')"
                @click="cancelNote(row)"
              />
              <UButton
                type="submit"
                size="sm"
                class="tap-target"
                :label="t('common.save')"
              />
            </div>
          </form>
          <div
            v-else
            class="mt-2 flex items-start justify-between gap-2"
          >
            <p
              v-if="row.note"
              class="min-w-0 flex-1 self-center whitespace-pre-line break-words text-xs text-muted"
            >
              <span class="sr-only">{{ t('card.field.note') }}: </span>{{ row.note }}
            </p>
            <UButton
              data-note-button
              icon="i-lucide-notebook-pen"
              color="neutral"
              variant="ghost"
              size="xs"
              class="tap-target ms-auto shrink-0"
              :label="row.note ? t('inventory.editor.editNote') : t('inventory.editor.addNote')"
              @click="startNote(row)"
            />
          </div>
        </li>
      </ul>

      <UDropdownMenu
        v-if="addItems.length > 0"
        :items="addItems"
        :content="{ align: 'start', onCloseAutoFocus: onAddMenuCloseAutoFocus }"
      >
        <UButton
          data-add-button
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="sm"
          class="tap-target"
          :label="t('inventory.editor.addToCollection')"
        />
      </UDropdownMenu>
    </template>
  </section>
</template>
