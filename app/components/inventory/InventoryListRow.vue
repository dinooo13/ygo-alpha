<script setup lang="ts">
/**
 * One "Liste" row of the inventory (#135): for reading, not editing. Name,
 * type, attribute and the start of the card text in the card language
 * (ADR 0015), the note, the quantity and the collection. The whole row
 * opens the card's detail panel, where the copies are edited.
 *
 * The card name is the row's button; `stretched-link` makes the whole row
 * clickable (square, and its focus ring inset: the list clips anything
 * outside a row). The retired badge is a click/tap popover that raises
 * itself above it (`CardRetiredBadge`), so a tap opens its hint instead of
 * the card; it is focusable and must never be inside the button. So are the
 * "Verschieben" button and, while the page is selecting, the checkbox.
 */
import { CARD_TEXT_EXCERPT_LENGTH } from '~~/shared/inventory'
import { cardFrame } from '~~/shared/card-frame'

interface InventoryListItem {
  id: string
  collectionId: string | null
  quantity: number
  note?: string | null
  cardName: string
  /** Official German name (ADR 0015); null when there is none. */
  cardNameDe?: string | null
  cardType: string
  cardAttribute?: string | null
  /** The first `CARD_TEXT_EXCERPT_LENGTH` characters of the card text, English and German. */
  cardTextExcerpt?: string | null
  cardTextExcerptDe?: string | null
  /** YGOPRODeck no longer lists the card (ADR 0019). */
  cardRetired?: boolean
  imageUrlSmall: string | null
}

const props = defineProps<{
  item: InventoryListItem
  /** The row's collection, already resolved to a label. */
  collectionLabel: string
  /** False when the page is already scoped to one collection (or to none). */
  showCollection: boolean
  /** The page is selecting rows: a checkbox shows in front of the row. */
  selectable?: boolean
  selected?: boolean
}>()

const emit = defineEmits<{
  open: []
  move: []
  toggle: []
}>()

const { t, n } = useI18n()
const { cardName, cardDesc } = useCardText()
const frame = computed(() => cardFrame({ type: props.item.cardType }))
const displayName = computed(() => cardName({ name: props.item.cardName, nameDe: props.item.cardNameDe }))
const metaId = useId()

// One flowing line of text: the card's line breaks (some stored as "\r\n",
// which the HTML parser would turn into "\n" and so break hydration) become
// spaces. "…" when the server cut the text.
const excerpt = computed(() => {
  const raw = cardDesc({ desc: props.item.cardTextExcerpt ?? null, descDe: props.item.cardTextExcerptDe })
  const text = raw?.replace(/\s+/g, ' ').trim()
  if (!raw || !text) {
    return null
  }
  return raw.length >= CARD_TEXT_EXCERPT_LENGTH ? `${text}…` : text
})
</script>

<template>
  <!-- One markup for every width: stacked on phones, the quantity and
       collection in a column on the right from `sm` up. -->
  <li class="group relative flex gap-3 px-4 py-3 transition-colors hover:bg-elevated/40 focus-within:bg-elevated/40">
    <UCheckbox
      v-if="selectable"
      :model-value="selected"
      class="relative z-10 self-center"
      :aria-label="t('inventory.select.row', { name: displayName })"
      @update:model-value="emit('toggle')"
    />

    <CardThumb
      :src="item.imageUrlSmall"
      :alt="displayName"
      size="lg"
      class="sm:w-12"
      :frame="frame?.frame"
      :pendulum="frame?.pendulum"
    />

    <div class="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:gap-4">
      <div class="min-w-0 flex-1 space-y-1.5">
        <p class="text-sm font-medium text-highlighted">
          <button
            type="button"
            aria-haspopup="dialog"
            :aria-describedby="metaId"
            class="stretched-link line-clamp-2 text-left transition-colors group-hover:text-primary after:rounded-none focus-visible:after:-outline-offset-2"
            @click="emit('open')"
          >
            {{ displayName }}
          </button>
        </p>
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <CardTypeChip
            :type="item.cardType"
            size="xs"
          />
          <CardAttributeOrb
            v-if="item.cardAttribute"
            :attribute="item.cardAttribute"
            size="xs"
          />
        </div>
        <p
          v-if="excerpt"
          class="line-clamp-2 text-xs leading-5 text-toned"
          data-testid="card-text-excerpt"
        >
          <span class="sr-only">{{ t('card.detail.cardText') }}: </span>{{ excerpt }}
        </p>
        <p
          v-if="item.note"
          class="line-clamp-1 text-xs text-muted"
          :title="item.note"
        >
          <span class="sr-only">{{ t('card.field.note') }}: </span>{{ item.note }}
        </p>
        <div
          v-if="item.cardRetired"
          class="w-fit"
        >
          <CardRetiredBadge />
        </div>
      </div>

      <div
        :id="metaId"
        class="flex min-w-0 shrink-0 items-baseline gap-2 sm:w-40 sm:flex-col sm:items-end sm:gap-1"
      >
        <span class="font-numeric text-sm font-semibold tracking-[0.04em] text-highlighted tabular-nums">
          <span class="sr-only">{{ t('card.field.quantity') }}: </span>×{{ n(item.quantity, 'integer') }}
        </span>
        <span
          v-if="showCollection"
          class="inline-flex min-w-0 max-w-full items-center gap-1 text-xs text-muted"
        >
          <UIcon
            name="i-lucide-folder"
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t('card.field.collection') }}: </span>
          <span class="truncate">{{ collectionLabel }}</span>
        </span>
      </div>
    </div>

    <UButton
      icon="i-lucide-folder-input"
      color="neutral"
      variant="ghost"
      size="sm"
      class="tap-target relative z-10 shrink-0 self-start sm:self-center"
      :aria-label="t('inventory.move.rowAction', { name: displayName })"
      :title="t('inventory.move.title')"
      @click="emit('move')"
    />
  </li>
</template>
