<script setup lang="ts">
import type { TournamentDetail, TournamentMatchDto, TournamentRoundDto } from '~~/shared/tournaments'

const props = defineProps<{
  tournament: TournamentDetail
}>()

const emit = defineEmits<{
  updated: [detail: TournamentDetail]
}>()

const { t } = useI18n()
const apiError = useApiError()

// Rounds are shown newest first; only the current (pending) round is
// rendered expanded, everything else lives in a collapsed section.
const orderedRounds = computed(() => [...props.tournament.rounds].reverse())

// A round robin is a league: its rounds are "Spieltage" (ADR 0031).
const isRoundRobin = computed(() => props.tournament.pairingSystem === 'round_robin')

function roundLabel(round: TournamentRoundDto): string {
  return isRoundRobin.value
    ? t('tournaments.rounds.matchday', { number: round.number })
    : t('tournaments.rounds.round', { number: round.number })
}

const withdrawnIds = computed(() =>
  props.tournament.participants.filter(participant => participant.withdrawn).map(participant => participant.id))

function isCurrentRound(round: TournamentRoundDto): boolean {
  return props.tournament.currentRound?.id === round.id
}

function canEditRound(round: TournamentRoundDto): boolean {
  return props.tournament.role === 'organizer'
    && props.tournament.status === 'running'
    && round.status === 'pending'
}

function onMatchUpdated(detail: TournamentDetail) {
  emit('updated', detail)
}

// --- Pairing swap ------------------------------------------------------------

const swapMode = ref(false)
const swapSelection = ref<Array<{ matchId: string, slot: 'a' | 'b' }>>([])
const swapError = ref('')
const isSwapping = ref(false)
const { confirm } = useConfirm()

function toggleSwapMode() {
  swapMode.value = !swapMode.value
  swapSelection.value = []
  swapError.value = ''
}

function isSlotSelected(matchId: string, slot: 'a' | 'b'): boolean {
  return swapSelection.value.some(entry => entry.matchId === matchId && entry.slot === slot)
}

function findCurrentMatch(matchId: string): TournamentMatchDto | undefined {
  return props.tournament.currentRound?.matches.find(match => match.id === matchId)
}

function participantInSlot(match: TournamentMatchDto, slot: 'a' | 'b'): string | null {
  return slot === 'a' ? match.participantAId : match.participantBId
}

function otherParticipant(match: TournamentMatchDto, slot: 'a' | 'b'): string | null {
  return slot === 'a' ? match.participantBId : match.participantAId
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('::')
}

/**
 * Whether swapping these two slots would recreate a pairing the two
 * resulting opponents already played in an earlier round (#37) — checked
 * against every completed round before the current one.
 */
function wouldRecreatePairing(
  matchAId: string,
  slotA: 'a' | 'b',
  matchBId: string,
  slotB: 'a' | 'b',
): boolean {
  const matchA = findCurrentMatch(matchAId)
  const matchB = findCurrentMatch(matchBId)
  if (!matchA || !matchB) {
    return false
  }

  const stayingInMatchA = otherParticipant(matchA, slotA)
  const stayingInMatchB = otherParticipant(matchB, slotB)
  const movingFromMatchA = participantInSlot(matchA, slotA)
  const movingFromMatchB = participantInSlot(matchB, slotB)

  const resultingPairs: Array<[string, string]> = []
  if (stayingInMatchA && movingFromMatchB) {
    resultingPairs.push([stayingInMatchA, movingFromMatchB])
  }
  if (stayingInMatchB && movingFromMatchA) {
    resultingPairs.push([stayingInMatchB, movingFromMatchA])
  }

  const priorPairs = new Set<string>()
  for (const round of props.tournament.rounds) {
    if (round.id === props.tournament.currentRound?.id) {
      continue
    }
    for (const match of round.matches) {
      if (match.participantBId) {
        priorPairs.add(pairKey(match.participantAId, match.participantBId))
      }
    }
  }

  return resultingPairs.some(([a, b]) => priorPairs.has(pairKey(a, b)))
}

async function onSelectSlot(matchId: string, slot: 'a' | 'b') {
  if (isSlotSelected(matchId, slot)) {
    swapSelection.value = swapSelection.value.filter(entry => !(entry.matchId === matchId && entry.slot === slot))
    return
  }

  swapSelection.value = [...swapSelection.value, { matchId, slot }]

  if (swapSelection.value.length < 2) {
    return
  }

  const [first, second] = swapSelection.value
  swapSelection.value = []
  swapError.value = ''

  if (wouldRecreatePairing(first!.matchId, first!.slot, second!.matchId, second!.slot)) {
    const confirmed = await confirm({
      title: t('tournaments.rounds.confirmRepeat.title'),
      description: t('tournaments.rounds.confirmRepeat.description'),
    })
    if (!confirmed) {
      return
    }
  }

  isSwapping.value = true

  try {
    const detail = await $fetch<TournamentDetail>(`/api/tournaments/${props.tournament.id}/matches/swap`, {
      method: 'POST',
      body: { matchAId: first!.matchId, slotA: first!.slot, matchBId: second!.matchId, slotB: second!.slot },
    })
    emit('updated', detail)
  }
  catch (error) {
    swapError.value = apiError(error, 'tournaments.rounds.swapFailed')
  }
  finally {
    isSwapping.value = false
  }
}
</script>

<template>
  <section class="panel p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-highlighted">
        {{ isRoundRobin ? t('tournaments.rounds.titleRoundRobin') : t('tournaments.rounds.title') }}
      </h2>
      <UButton
        v-if="tournament.canEditPairings"
        size="xs"
        :color="swapMode ? 'error' : 'neutral'"
        :variant="swapMode ? 'solid' : 'outline'"
        :label="swapMode ? t('tournaments.rounds.stopSwap') : t('tournaments.rounds.startSwap')"
        class="tap-target"
        @click="toggleSwapMode"
      />
    </div>

    <p
      v-if="swapMode"
      class="mt-2 text-xs text-muted"
    >
      {{ t('tournaments.rounds.swapHint') }}
    </p>
    <p
      v-if="swapError"
      class="mt-2 text-sm text-error"
    >
      {{ swapError }}
    </p>

    <p
      v-if="orderedRounds.length === 0"
      class="mt-4 text-sm text-muted"
    >
      {{ isRoundRobin ? t('tournaments.rounds.emptyRoundRobin') : t('tournaments.rounds.empty') }}
    </p>

    <div class="mt-4 space-y-3">
      <template
        v-for="round in orderedRounds"
        :key="round.id"
      >
        <div
          v-if="isCurrentRound(round)"
          class="space-y-2"
        >
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-highlighted">
              {{ roundLabel(round) }}
            </h3>
            <UBadge
              size="sm"
              variant="subtle"
              color="warning"
              :label="t(`tournaments.roundStatus.${round.status}`)"
            />
          </div>
          <TournamentsMatchRow
            v-for="match in round.matches"
            :key="match.id"
            :match="match"
            :tournament-id="tournament.id"
            :bye-scoring="tournament.byeScoring"
            :withdrawn-ids="withdrawnIds"
            :can-edit="canEditRound(round)"
            :swap-mode="swapMode && isCurrentRound(round)"
            :selected-a="isSlotSelected(match.id, 'a')"
            :selected-b="isSlotSelected(match.id, 'b')"
            @updated="onMatchUpdated"
            @select-slot="(slot) => onSelectSlot(match.id, slot)"
          />
        </div>

        <UCollapsible
          v-else
          :default-open="false"
        >
          <UButton
            color="neutral"
            variant="ghost"
            block
            class="justify-start max-lg:min-h-11"
            trailing-icon="i-lucide-chevron-down"
          >
            <span class="flex items-center gap-2">
              <span class="text-sm font-semibold text-highlighted">{{ roundLabel(round) }}</span>
              <UBadge
                size="sm"
                variant="subtle"
                color="neutral"
                :label="t(`tournaments.roundStatus.${round.status}`)"
              />
            </span>
          </UButton>
          <template #content>
            <div class="mt-2 space-y-2">
              <TournamentsMatchRow
                v-for="match in round.matches"
                :key="match.id"
                :match="match"
                :tournament-id="tournament.id"
                :bye-scoring="tournament.byeScoring"
                :withdrawn-ids="withdrawnIds"
                :can-edit="false"
                :swap-mode="false"
                :selected-a="false"
                :selected-b="false"
                @updated="onMatchUpdated"
              />
            </div>
          </template>
        </UCollapsible>
      </template>
    </div>
  </section>
</template>
