<script setup lang="ts">
/**
 * "Karte hinzufügen": adds copies of a picked card (inventory picker,
 * catalog), optionally with their printing (set code + rarity, ADR 0034).
 * Adding to a card's existing stack (same collection and printing) merges
 * into it (ADR 0017).
 * Owned copies are edited in the card's detail panel
 * (`InventoryOwnedCardEditor`, #135), not here.
 */
interface CatalogCardOption {
  id: number
  name: string
  nameDe?: string | null
  type: string
}

interface CollectionOption {
  id: string
  name: string
}

const props = defineProps<{
  open: boolean
  card: CatalogCardOption | null
  collections?: CollectionOption[]
  presetCollectionId?: string | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const { t } = useI18n()
const { cardName, cardValue } = useCardText()
const apiError = useApiError()

const noCollectionValue = '__no_collection__'

const form = reactive({
  quantity: 1,
  collectionId: noCollectionValue,
  printingId: null as string | null,
  note: '',
})

const { printings, loading: printingsLoading } = useCardPrintings(() => props.open ? props.card?.id ?? null : null)

const isSubmitting = ref(false)
const errorMessage = ref('')

const collectionItems = computed(() => [
  { label: t('inventory.noCollectionOption'), value: noCollectionValue },
  ...(props.collections ?? []).map(collection => ({
    label: collection.name,
    value: collection.id,
  })),
])

const openProxy = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

watch(
  () => [props.open, props.card?.id] as const,
  () => {
    if (!props.open) {
      return
    }

    form.quantity = 1
    form.collectionId = props.presetCollectionId ?? noCollectionValue
    form.printingId = null
    form.note = ''
    errorMessage.value = ''
  },
  { immediate: true },
)

async function save() {
  const catalogCardId = props.card?.id
  if (!catalogCardId) {
    errorMessage.value = t('inventory.addModal.noCard')
    return
  }

  isSubmitting.value = true
  errorMessage.value = ''

  const payload = {
    catalog_card_id: catalogCardId,
    collection_id: form.collectionId === noCollectionValue ? null : form.collectionId,
    printing_id: form.printingId,
    quantity: form.quantity,
    note: form.note || null,
  }

  try {
    await $fetch('/api/inventory', {
      method: 'POST',
      body: payload,
    })

    emit('saved')
    openProxy.value = false
  }
  catch (error) {
    errorMessage.value = apiError(error, 'inventory.addModal.saveFailed')
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="openProxy"
    :title="t('inventory.addModal.addTitle')"
  >
    <template #body>
      <form
        class="space-y-4"
        @submit.prevent="save"
      >
        <div v-if="card">
          <p class="text-sm font-medium text-highlighted">
            {{ cardName(card) }}
          </p>
          <p class="text-xs text-muted">
            {{ cardValue('type', card.type) }}
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('card.field.quantity')">
            <CardQuantityStepper
              v-model="form.quantity"
              :min="1"
              size="md"
              name="quantity"
              :input-label="t('card.field.quantity')"
              :decrease-label="t('inventory.addModal.decrease')"
              :increase-label="t('inventory.addModal.increase')"
            />
          </UFormField>

          <UFormField :label="t('card.field.collection')">
            <USelect
              v-model="form.collectionId"
              :items="collectionItems"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          :label="t('card.field.printing')"
          :hint="t('common.optional')"
          :description="t('inventory.printing.hint')"
        >
          <InventoryPrintingSelect
            v-model="form.printingId"
            :printings="printings"
            :loading="printingsLoading"
            :label="t('card.field.printing')"
          />
        </UFormField>

        <UFormField :label="t('card.field.note')">
          <UTextarea
            v-model="form.note"
            name="note"
            :rows="3"
            class="w-full"
          />
        </UFormField>

        <!-- Form-level: the card is picked before this modal opens, so there is
             no card field a "Bitte zuerst eine Karte auswählen." could describe. -->
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
            icon="i-lucide-save"
            :loading="isSubmitting"
            :label="t('common.add')"
          />
        </div>
      </form>
    </template>
  </UModal>
</template>
