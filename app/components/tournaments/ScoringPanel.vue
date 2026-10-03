<script setup lang="ts">
import { BYE_SCORINGS, SCORING_SYSTEMS } from '~~/shared/tournaments'
import type { ByeScoring, ScoringSystem, TournamentDetail } from '~~/shared/tournaments'

// How points are awarded (ADR 0031). Editable by the organizer until the
// tournament starts; once results exist, changing it would silently re-rank
// them, so the server refuses (and the panel is no longer shown).

const props = defineProps<{
  tournament: TournamentDetail
}>()

const emit = defineEmits<{
  updated: [detail: TournamentDetail]
}>()

const { t } = useI18n()
const apiError = useApiError()

const isSaving = ref(false)
const errorMessage = ref('')

const scoringItems = computed(() =>
  SCORING_SYSTEMS.map(value => ({ label: t(`tournaments.scoring.${value}.label`), value })))
const byeScoringItems = computed(() =>
  BYE_SCORINGS.map(value => ({ label: t(`tournaments.byeScoring.${value}.label`), value })))

async function save(patch: { scoring?: ScoringSystem, byeScoring?: ByeScoring }) {
  if (isSaving.value) {
    return
  }

  isSaving.value = true
  errorMessage.value = ''

  try {
    const detail = await $fetch<TournamentDetail>(`/api/tournaments/${props.tournament.id}`, {
      method: 'PATCH',
      body: patch,
    })
    emit('updated', detail)
  }
  catch (error) {
    errorMessage.value = apiError(error, 'tournaments.scoringPanel.saveFailed')
  }
  finally {
    isSaving.value = false
  }
}
</script>

<template>
  <section class="panel space-y-4 p-4">
    <div>
      <h2 class="text-base font-semibold text-highlighted">
        {{ t('tournaments.scoringPanel.title') }}
      </h2>
      <p class="mt-1 text-xs text-muted">
        {{ t('tournaments.scoringPanel.editHint') }}
      </p>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('tournaments.scoringPanel.scoring')">
        <USelect
          :model-value="tournament.scoring"
          :items="scoringItems"
          :disabled="isSaving"
          :aria-label="t('tournaments.scoringPanel.scoring')"
          class="w-full"
          @update:model-value="(value: ScoringSystem) => save({ scoring: value })"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t(`tournaments.scoring.${tournament.scoring}.description`) }}
        </p>
      </UFormField>

      <UFormField :label="t('tournaments.scoringPanel.byeScoring')">
        <USelect
          :model-value="tournament.byeScoring"
          :items="byeScoringItems"
          :disabled="isSaving"
          :aria-label="t('tournaments.scoringPanel.byeScoring')"
          class="w-full"
          @update:model-value="(value: ByeScoring) => save({ byeScoring: value })"
        />
        <p class="mt-1 text-xs text-muted">
          {{ t(`tournaments.byeScoring.${tournament.byeScoring}.description`) }}
        </p>
      </UFormField>
    </div>

    <p
      v-if="errorMessage"
      role="alert"
      class="text-sm text-error"
    >
      {{ errorMessage }}
    </p>
  </section>
</template>
