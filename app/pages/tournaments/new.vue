<script setup lang="ts">
import {
  BYE_SCORINGS,
  DEFAULT_BYE_SCORING,
  DEFAULT_SCORING,
  MAX_PLANNED_ROUNDS,
  PAIRING_SYSTEMS,
  SCORING_SYSTEMS,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  TOURNAMENT_NAME_MAX_LENGTH,
} from '~~/shared/tournaments'
import type { ByeScoring, PairingSystem, ScoringSystem, TournamentDetail } from '~~/shared/tournaments'

usePageTitle('tournaments.new.title')

const { t } = useI18n()
const apiError = useApiError()
const { formatName, sortFormats } = useFormatLabel()

// reka-ui reserves the empty string for "clear selection", so "no format"
// uses a sentinel that maps back to `null` on the wire (same convention as
// the deck editor's format select).
const NO_FORMAT = 'none'

interface RuleFormatListItem {
  id: string
  name: string
  isBuiltin: boolean
}

const { data: formatsData } = await useFetch<{ items: RuleFormatListItem[] }>('/api/formats', {
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
  default: () => ({ items: [] }),
})

// Built-in formats first, sorted by their name in the interface language.
const formatItems = computed(() => [
  { label: t('tournaments.noFormat'), value: NO_FORMAT },
  ...sortFormats(formatsData.value?.items ?? []).map(format => ({ label: formatName(format), value: format.id })),
])

const pairingSystemItems = computed(() =>
  PAIRING_SYSTEMS.map(system => ({ label: t(`tournaments.pairingSystem.${system}.label`), value: system })))

const scoringItems = computed(() =>
  SCORING_SYSTEMS.map(scoring => ({ label: t(`tournaments.scoring.${scoring}.label`), value: scoring })))
const byeScoringItems = computed(() =>
  BYE_SCORINGS.map(byeScoring => ({ label: t(`tournaments.byeScoring.${byeScoring}.label`), value: byeScoring })))

const form = reactive({
  name: '',
  description: '',
  formatId: NO_FORMAT,
  pairingSystem: 'swiss' as PairingSystem,
  scoring: DEFAULT_SCORING as ScoringSystem,
  byeScoring: DEFAULT_BYE_SCORING as ByeScoring,
  plannedRounds: '',
  includeSelf: true,
})

const isSubmitting = ref(false)
// The name check belongs to its UFormField (aria-describedby/aria-invalid);
// errorMessage is for the server's answer.
// Bound as `|| undefined`: UFormField's `error` is Boolean|String, so '' would count as true.
const nameError = ref('')
const errorMessage = ref('')

watch(() => form.name, (name) => {
  if (name.trim()) {
    nameError.value = ''
  }
})

const plannedRoundsHint = computed(() => t(form.pairingSystem === 'round_robin'
  ? 'tournaments.new.plannedRoundsRoundRobinHint'
  : 'tournaments.new.plannedRoundsHint'))

async function submit() {
  if (isSubmitting.value) {
    return
  }
  if (!form.name.trim()) {
    nameError.value = t('tournaments.new.nameRequired')
    return
  }

  isSubmitting.value = true
  errorMessage.value = ''

  try {
    const created = await $fetch<TournamentDetail>('/api/tournaments', {
      method: 'POST',
      body: {
        name: form.name,
        description: form.description || null,
        formatId: form.formatId === NO_FORMAT ? null : form.formatId,
        pairingSystem: form.pairingSystem,
        scoring: form.scoring,
        byeScoring: form.byeScoring,
        plannedRounds: form.plannedRounds.trim() === '' ? null : Number(form.plannedRounds),
        includeSelf: form.includeSelf,
      },
    })
    await navigateTo(`/tournaments/${created.id}`)
  }
  catch (error) {
    errorMessage.value = apiError(error, 'tournaments.new.createFailed')
  }
  finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <div class="space-y-2">
      <LayoutBackLink
        to="/tournaments"
        :label="t('tournaments.backToList')"
      />
      <LayoutPageHeader
        :title="t('tournaments.new.title')"
        :description="t('tournaments.new.description')"
      />
    </div>

    <form
      class="space-y-4 panel p-4"
      @submit.prevent="submit"
    >
      <UFormField
        :label="t('tournaments.new.name')"
        :error="nameError || undefined"
      >
        <UInput
          v-model="form.name"
          class="w-full"
          :placeholder="t('tournaments.new.namePlaceholder')"
          :maxlength="TOURNAMENT_NAME_MAX_LENGTH"
          :aria-label="t('tournaments.new.name')"
        />
      </UFormField>

      <UFormField :label="t('tournaments.new.descriptionLabel')">
        <UTextarea
          v-model="form.description"
          :rows="3"
          :maxlength="TOURNAMENT_DESCRIPTION_MAX_LENGTH"
          :aria-label="t('tournaments.new.descriptionAriaLabel')"
          class="w-full"
        />
      </UFormField>

      <UFormField :label="t('tournaments.new.format')">
        <USelect
          v-model="form.formatId"
          :items="formatItems"
          :aria-label="t('tournaments.new.format')"
          class="w-full"
        />
      </UFormField>

      <UFormField :label="t('tournaments.new.pairingSystem')">
        <USelect
          v-model="form.pairingSystem"
          :items="pairingSystemItems"
          :aria-label="t('tournaments.new.pairingSystem')"
          class="w-full"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t(`tournaments.pairingSystem.${form.pairingSystem}.description`) }}
        </p>
      </UFormField>

      <UFormField :label="t('tournaments.new.scoring')">
        <USelect
          v-model="form.scoring"
          :items="scoringItems"
          :aria-label="t('tournaments.new.scoring')"
          class="w-full"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t(`tournaments.scoring.${form.scoring}.description`) }}
        </p>
      </UFormField>

      <UFormField :label="t('tournaments.new.byeScoring')">
        <USelect
          v-model="form.byeScoring"
          :items="byeScoringItems"
          :aria-label="t('tournaments.new.byeScoring')"
          class="w-full"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t(`tournaments.byeScoring.${form.byeScoring}.description`) }}
        </p>
      </UFormField>

      <UFormField :label="t('tournaments.new.plannedRounds')">
        <UInput
          v-model="form.plannedRounds"
          type="number"
          min="1"
          :max="MAX_PLANNED_ROUNDS"
          :placeholder="t('tournaments.new.plannedRoundsPlaceholder')"
          :aria-label="t('tournaments.new.plannedRounds')"
          :disabled="form.pairingSystem === 'round_robin'"
          class="w-full sm:w-48"
        />
        <p class="mt-1 text-xs text-muted">
          {{ plannedRoundsHint }}
        </p>
      </UFormField>

      <UCheckbox
        v-model="form.includeSelf"
        :label="t('tournaments.new.includeSelf')"
      />

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
          to="/tournaments"
        />
        <UButton
          type="submit"
          icon="i-lucide-plus"
          :label="t('tournaments.new.submit')"
          :loading="isSubmitting"
        />
      </div>
    </form>
  </div>
</template>
