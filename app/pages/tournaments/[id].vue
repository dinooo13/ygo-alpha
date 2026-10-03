<script setup lang="ts">
import { MIN_PARTICIPANTS_TO_START } from '~~/shared/tournaments'
import type { TournamentDetail, TournamentStatus } from '~~/shared/tournaments'

const route = useRoute()
const tournamentId = computed(() => String(route.params.id ?? ''))

const {
  data: tournament,
  pending,
  error,
} = await useFetch<TournamentDetail>(() => `/api/tournaments/${tournamentId.value}`, {
  headers: import.meta.server ? useRequestHeaders(['cookie']) : undefined,
})

const { t, n } = useI18n()
const apiError = useApiError()
const { formatName } = useFormatLabel()

usePageTitle(() => tournament.value?.name ?? t('tournaments.detail.pageTitleFallback'))

const errorMessage = ref('')
const busy = ref(false)
const { confirm } = useConfirm()

/** `fallbackKey`: the message when the error carries no known `data.code`. */
async function run(action: () => Promise<TournamentDetail>, fallbackKey: string) {
  errorMessage.value = ''
  busy.value = true
  try {
    tournament.value = await action()
  }
  catch (requestError) {
    errorMessage.value = apiError(requestError, fallbackKey)
  }
  finally {
    busy.value = false
  }
}

function onUpdated(detail: TournamentDetail) {
  tournament.value = detail
}

function startTournament() {
  return run(
    () => $fetch<TournamentDetail>(`/api/tournaments/${tournamentId.value}/start`, { method: 'POST' }),
    'tournaments.detail.errors.startFailed',
  )
}

function createNextRound() {
  return run(
    () => $fetch<TournamentDetail>(`/api/tournaments/${tournamentId.value}/rounds`, { method: 'POST' }),
    'tournaments.detail.errors.createRoundFailed',
  )
}

function completeRound() {
  const roundId = tournament.value?.currentRound?.id
  if (!roundId) {
    return
  }
  return run(
    () => $fetch<TournamentDetail>(
      `/api/tournaments/${tournamentId.value}/rounds/${roundId}/complete`,
      { method: 'POST' },
    ),
    'tournaments.detail.errors.completeRoundFailed',
  )
}

function finishTournament() {
  return run(
    () => $fetch<TournamentDetail>(`/api/tournaments/${tournamentId.value}/finish`, { method: 'POST' }),
    'tournaments.detail.errors.finishFailed',
  )
}

async function onFinishClick() {
  const confirmed = await confirm({
    title: t('tournaments.detail.confirm.finish.title'),
    description: t('tournaments.detail.confirm.finish.description'),
  })
  if (!confirmed) {
    return
  }
  await finishTournament()
}

async function deleteTournament() {
  if (!tournament.value) {
    return
  }
  const confirmed = await confirm({
    title: t('tournaments.detail.confirm.delete.title'),
    description: t('tournaments.detail.confirm.delete.description', { name: tournament.value.name }),
  })
  if (!confirmed) {
    return
  }

  errorMessage.value = ''
  busy.value = true
  try {
    await $fetch(`/api/tournaments/${tournamentId.value}`, { method: 'DELETE' })
  }
  catch (requestError) {
    errorMessage.value = apiError(requestError, 'tournaments.detail.errors.deleteFailed')
    busy.value = false
    return
  }
  await navigateTo('/tournaments')
}

const STATUS_COLORS: Record<TournamentStatus, 'info' | 'warning' | 'neutral'> = {
  registration: 'info',
  running: 'warning',
  finished: 'neutral',
}

const isRoundRobin = computed(() => tournament.value?.pairingSystem === 'round_robin')

const roundProgress = computed(() => {
  if (!tournament.value) {
    return ''
  }
  return t(isRoundRobin.value ? 'tournaments.detail.matchdayProgress' : 'tournaments.detail.roundProgress', {
    current: n(tournament.value.rounds.length, 'integer'),
    planned: tournament.value.plannedRounds === null ? '–' : n(tournament.value.plannedRounds, 'integer'),
  })
})

// --- Header actions (#29) ---------------------------------------------------
// Only the actions relevant to the current status are rendered at all, and
// only the one obvious next action is styled as primary — the rest are
// neutral outline buttons. Disabled buttons always carry a `title` so the
// user understands why, instead of a mute grey button.

type RunningAction = 'complete' | 'next' | 'finish'

const primaryRunningAction = computed<RunningAction>(() => {
  if (!tournament.value) {
    return 'complete'
  }
  if (tournament.value.canCreateRound) {
    return 'next'
  }
  if (tournament.value.canFinish) {
    return 'finish'
  }
  return 'complete'
})

const startTitle = computed(() => {
  if (!tournament.value || tournament.value.canStart) {
    return undefined
  }
  return t('tournaments.detail.hints.minParticipants', { min: MIN_PARTICIPANTS_TO_START })
})

const completeRoundTitle = computed(() => {
  if (!tournament.value || tournament.value.canCompleteRound) {
    return undefined
  }
  return t('tournaments.detail.hints.resultsMissing')
})

const createRoundTitle = computed(() => {
  if (!tournament.value || tournament.value.canCreateRound) {
    return undefined
  }
  if (tournament.value.currentRound) {
    return t('tournaments.detail.hints.completeCurrentRoundFirst')
  }
  return t('errors.api.planned_rounds_reached')
})

const finishTitle = computed(() => {
  if (!tournament.value || tournament.value.canFinish) {
    return undefined
  }
  if (tournament.value.currentRound) {
    return t('errors.api.round_not_complete')
  }
  if (tournament.value.rounds.length === 0) {
    return t('errors.api.no_rounds')
  }
  return undefined
})

// A `title` tooltip never shows on touch devices, so the reason the one
// obvious next action is disabled is also spelled out under the buttons.
const actionHint = computed(() => {
  if (!tournament.value) {
    return undefined
  }
  if (tournament.value.status === 'registration') {
    return startTitle.value
  }
  if (tournament.value.status === 'running') {
    const titles: Record<RunningAction, string | undefined> = {
      complete: completeRoundTitle.value,
      next: createRoundTitle.value,
      finish: finishTitle.value,
    }
    return titles[primaryRunningAction.value]
  }
  return undefined
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <LayoutBackLink
        to="/tournaments"
        :label="t('tournaments.backToList')"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('tournaments.detail.loadFailed.title')"
      :description="apiError(error, 'tournaments.detail.loadFailed.description')"
    />

    <div
      v-else-if="pending && !tournament"
      class="space-y-4"
    >
      <USkeleton class="h-10 w-64" />
      <USkeleton class="h-64 w-full" />
    </div>

    <template v-else-if="tournament">
      <LayoutPageHeader
        :title="tournament.name"
        :description="tournament.description ?? undefined"
        truncate
      >
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <UBadge
            :color="STATUS_COLORS[tournament.status]"
            variant="subtle"
            :label="t(`tournaments.status.${tournament.status}`)"
          />
          <UBadge
            v-if="tournament.format"
            color="neutral"
            variant="subtle"
            icon="i-lucide-scroll-text"
            :label="formatName(tournament.format)"
          />
          <span
            v-else
            class="text-sm text-muted"
          >{{ t('tournaments.noFormat') }}</span>
        </div>

        <div class="mt-2 space-y-0.5 text-sm text-muted">
          <div>
            {{ t('tournaments.detail.pairingSystem', { name: t(`tournaments.pairingSystem.${tournament.pairingSystem}.label`) }) }}
          </div>
          <div>
            {{ t('tournaments.detail.scoring', { name: t(`tournaments.scoring.${tournament.scoring}.label`) }) }}
          </div>
          <div>
            {{ t('tournaments.detail.byeScoring', { name: t(`tournaments.byeScoring.${tournament.byeScoring}.label`) }) }}
          </div>
          <div v-if="tournament.rounds.length === 0">
            {{ t('tournaments.detail.notStarted') }}
          </div>
          <div v-else>
            {{ roundProgress }}
          </div>
          <div>{{ t('tournaments.detail.organizer', { name: tournament.organizerName }) }}</div>
        </div>

        <template
          v-if="tournament.role === 'organizer'"
          #actions
        >
          <div class="flex flex-col gap-1.5 sm:items-end">
            <div class="flex flex-wrap items-center gap-2 sm:justify-end">
              <template v-if="tournament.status === 'registration'">
                <UButton
                  :label="t('tournaments.detail.actions.start')"
                  color="primary"
                  :disabled="!tournament.canStart || busy"
                  :title="startTitle"
                  @click="startTournament"
                />
              </template>
              <template v-else-if="tournament.status === 'running'">
                <UButton
                  :label="isRoundRobin ? t('tournaments.detail.actionsRoundRobin.completeRound') : t('tournaments.detail.actions.completeRound')"
                  :color="primaryRunningAction === 'complete' ? 'primary' : 'neutral'"
                  :variant="primaryRunningAction === 'complete' ? 'solid' : 'outline'"
                  :disabled="!tournament.canCompleteRound || busy"
                  :title="completeRoundTitle"
                  @click="completeRound"
                />
                <UButton
                  :label="isRoundRobin ? t('tournaments.detail.actionsRoundRobin.nextRound') : t('tournaments.detail.actions.nextRound')"
                  :color="primaryRunningAction === 'next' ? 'primary' : 'neutral'"
                  :variant="primaryRunningAction === 'next' ? 'solid' : 'outline'"
                  :disabled="!tournament.canCreateRound || busy"
                  :title="createRoundTitle"
                  @click="createNextRound"
                />
                <UButton
                  :label="t('tournaments.detail.actions.finish')"
                  :color="primaryRunningAction === 'finish' ? 'primary' : 'neutral'"
                  :variant="primaryRunningAction === 'finish' ? 'solid' : 'outline'"
                  :disabled="!tournament.canFinish || busy"
                  :title="finishTitle"
                  @click="onFinishClick"
                />
              </template>
              <UButton
                color="error"
                variant="outline"
                :label="t('tournaments.detail.actions.delete')"
                :disabled="busy"
                @click="deleteTournament"
              />
            </div>
            <p
              v-if="actionHint"
              class="text-xs text-muted"
            >
              {{ actionHint }}
            </p>
          </div>
        </template>
      </LayoutPageHeader>

      <UAlert
        v-if="tournament.status === 'finished'"
        color="neutral"
        variant="subtle"
        :description="t('tournaments.detail.finishedBanner')"
      />
      <UAlert
        v-else-if="tournament.role === 'participant'"
        color="info"
        variant="subtle"
        :description="t('tournaments.detail.participantBanner')"
      />

      <p
        v-if="errorMessage"
        class="text-sm text-error"
      >
        {{ errorMessage }}
      </p>

      <!-- Once finished, the final table is what people come for — lead with it. -->
      <TournamentsStandingsTable
        v-if="tournament.status === 'finished'"
        :tournament="tournament"
      />

      <TournamentsScoringPanel
        v-if="tournament.role === 'organizer' && tournament.status === 'registration'"
        :tournament="tournament"
        @updated="onUpdated"
      />

      <TournamentsParticipantsPanel
        :tournament="tournament"
        @updated="onUpdated"
      />

      <TournamentsRoundsPanel
        :tournament="tournament"
        @updated="onUpdated"
      />

      <TournamentsStandingsTable
        v-if="tournament.status !== 'finished'"
        :tournament="tournament"
      />
    </template>
  </div>
</template>
