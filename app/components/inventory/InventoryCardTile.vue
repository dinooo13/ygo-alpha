<script setup lang="ts">
import { breakdownKey, breakdownLabel } from '~/utils/inventory-search-result'
import { cardFrame } from '~~/shared/card-frame'
import { printingShortLabel } from '~~/shared/printing'
import type { InventorySearchResultItem } from '~/utils/inventory-search-result'

const props = defineProps<{
  item: InventorySearchResultItem
}>()

const emit = defineEmits<{
  open: []
}>()

const breakdown = computed(() => props.item.collectionBreakdown ?? [])
const showInline = computed(() => breakdown.value.length <= 2)
const { t, n } = useI18n()
const { cardName, cardValue } = useCardText()

const frame = computed(() => cardFrame(props.item))

// The known printings (ADR 0034) as one line: "LOB-001 (UR) ×2 · SDY-006 (UR) ×1".
const printingLine = computed(() => (props.item.printingBreakdown ?? [])
  .map(entry => t('inventory.breakdown.entry', { name: printingShortLabel(entry), count: n(entry.quantity, 'integer') }))
  .join(' · '))
</script>

<template>
  <!-- The card name is the tile's button; `stretched-link` makes the whole
       tile open the detail panel (#135, like the catalog tiles). The
       breakdown sits above it, and so does the retired badge (a click/tap
       popover that raises itself), so their own popovers stay usable. -->
  <article class="group panel relative flex min-w-0 flex-col transition-[translate,box-shadow,border-color] duration-200 ease-out-expo hover:border-primary/40 hover:shadow-lift motion-safe:hover:-translate-y-0.5">
    <!-- Plain thumbnail, not `enlargeable`: the tile already opens the card. -->
    <CardThumb
      :src="item.imageSmall"
      :src-large="item.imageLarge"
      :alt="cardName(item)"
      :frame="frame?.frame"
      :pendulum="frame?.pendulum"
      size="full"
      foil
      sizes="(min-width: 1280px) 270px, (min-width: 640px) 30vw, 48vw"
      class="p-2 pb-0"
    />

    <div class="flex flex-1 flex-col gap-2 p-3">
      <h2 class="text-sm font-semibold leading-5 text-highlighted transition-colors group-hover:text-primary sm:text-base">
        <button
          type="button"
          aria-haspopup="dialog"
          class="stretched-link block w-full text-left"
          @click="emit('open')"
        >
          <span class="line-clamp-2">{{ cardName(item) }}</span>
        </button>
      </h2>
      <div
        v-if="item.retired"
        class="w-fit"
      >
        <CardRetiredBadge />
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <CardTypeChip
          :type="item.type"
          size="xs"
        />
        <CardAttributeOrb
          v-if="item.attribute"
          :attribute="item.attribute"
          size="xs"
        />
        <span
          v-if="item.race"
          class="min-w-0 truncate text-[0.6875rem] text-muted"
        >{{ cardValue('race', item.race) }}</span>
      </div>

      <p
        v-if="printingLine"
        class="line-clamp-2 font-mono text-[0.6875rem] leading-4 text-muted"
        :title="printingLine"
        data-testid="tile-printings"
      >
        <span class="sr-only">{{ t('inventory.printing.label') }}: </span>{{ printingLine }}
      </p>

      <p class="font-numeric text-sm font-semibold tracking-[0.04em] text-highlighted tabular-nums">
        {{ t('card.totalQuantity', { count: n(item.totalQuantity, 'integer') }) }}
      </p>

      <div class="relative z-10 flex min-w-0 flex-wrap items-center gap-1">
        <template v-if="showInline">
          <UBadge
            v-for="entry in breakdown"
            :key="breakdownKey(entry)"
            color="neutral"
            variant="subtle"
            class="max-w-full"
          >
            <span class="truncate">{{ t('inventory.breakdown.entry', { name: breakdownLabel(entry, t), count: n(entry.quantity, 'integer') }) }}</span>
          </UBadge>
        </template>
        <UPopover v-else>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            trailing-icon="i-lucide-chevron-down"
            :label="t('inventory.breakdown.toggle')"
            class="tap-target"
          />
          <template #content>
            <div class="min-w-48 space-y-1 p-3">
              <div
                v-for="entry in breakdown"
                :key="breakdownKey(entry)"
                class="flex items-center justify-between gap-4 text-sm"
              >
                <span class="text-default">{{ breakdownLabel(entry, t) }}</span>
                <span class="font-medium tabular-nums text-highlighted">×{{ n(entry.quantity, 'integer') }}</span>
              </div>
            </div>
          </template>
        </UPopover>
      </div>
    </div>
  </article>
</template>
