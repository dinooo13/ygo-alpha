<script setup lang="ts">
import { POINTS_DRAW, POINTS_LOSS_WITH_GAME, POINTS_WIN, POINTS_WIN_DROPPED_GAME } from '~~/shared/tournaments'
import type { TournamentDetail, TournamentStandingRow } from '~~/shared/tournaments'

const props = defineProps<{
  tournament: TournamentDetail
}>()

const { t, n } = useI18n()

const standings = computed(() => props.tournament.standings)

// Round robin reads as a league table (ADR 0028); the OMW%/GW%/OGW%
// tiebreakers belong to Swiss only.
const isLeague = computed(() => props.tournament.pairingSystem === 'round_robin')
// "U" exists only for tournaments scored the classic way, which can hold
// draws from before ADR 0028.
const showDraws = computed(() => props.tournament.scoring === 'match')
const hasWithdrawn = computed(() => standings.value.some(row => row.withdrawn))

type View = 'table' | 'crosstable'
const view = ref<View>('table')

/** 0.6667 → "66,7 %" (de) / "66.7%" (en) for the standings tie-breakers. */
function formatRate(rate: number): string {
  return t('tournaments.standings.rate', { value: n(rate * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

const legend = computed(() => {
  const params = {
    win: POINTS_WIN,
    draw: POINTS_DRAW,
    narrowWin: POINTS_WIN_DROPPED_GAME,
    narrowLoss: POINTS_LOSS_WITH_GAME,
  }
  const key = isLeague.value
    ? (showDraws.value ? 'legendLeagueMatch' : 'legendLeague')
    : (showDraws.value ? 'legendMatch' : 'legendGames')
  return t(`tournaments.standings.${key}`, params)
})

function recordLabel(row: TournamentStandingRow): string {
  return showDraws.value
    ? `${row.wins}-${row.losses}-${row.draws}`
    : `${row.wins}-${row.losses}`
}

function gamesLabel(row: TournamentStandingRow): string {
  return `${row.gamesWon}:${row.gamesLost}`
}

function differenceLabel(row: TournamentStandingRow): string {
  const difference = row.gamesWon - row.gamesLost
  return difference > 0 ? `+${difference}` : String(difference)
}

/** Withdrawn rows are listed last without a place (ADR 0028). */
function rankLabel(row: TournamentStandingRow): string {
  return row.withdrawn ? t('tournaments.standings.withdrawnRank') : String(row.rank)
}

// The first-ranked row of a finished tournament, i.e. the winner (#36). Rank
// 1 while still running is just the current leader, not a final result, so
// the trophy/"Sieger" treatment is finished-only.
const winner = computed(() => {
  if (props.tournament.status !== 'finished') {
    return null
  }
  return standings.value.find(row => row.rank === 1 && !row.withdrawn) ?? null
})

// The podium: gold, silver, bronze.
const MEDAL_CLASSES = ['bg-secondary', 'bg-medal-silver', 'bg-medal-bronze'] as const

function isPodium(row: TournamentStandingRow): boolean {
  return !row.withdrawn && row.rank <= 3
}

const viewItems = computed(() => [
  { label: t('tournaments.standings.view.table'), value: 'table' as const },
  { label: t('tournaments.standings.view.crosstable'), value: 'crosstable' as const },
])
</script>

<template>
  <section class="panel p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-highlighted">
        {{ isLeague ? t('tournaments.standings.titleLeague') : t('tournaments.standings.title') }}
      </h2>
      <p
        v-if="winner"
        class="flex items-center gap-1.5 text-sm font-semibold text-secondary"
      >
        <UIcon
          name="i-lucide-trophy"
          class="size-4"
          aria-hidden="true"
        />
        {{ t('tournaments.standings.winner', { name: winner.name }) }}
      </p>
      <div
        v-if="isLeague && standings.length > 0"
        class="flex gap-2"
        role="group"
        :aria-label="t('tournaments.standings.view.label')"
      >
        <UButton
          v-for="item in viewItems"
          :key="item.value"
          size="xs"
          :color="view === item.value ? 'primary' : 'neutral'"
          :variant="view === item.value ? 'subtle' : 'outline'"
          :aria-pressed="view === item.value"
          :label="item.label"
          class="tap-target"
          @click="() => { view = item.value }"
        />
      </div>
    </div>

    <p
      v-if="standings.length === 0"
      class="mt-4 text-sm text-muted"
    >
      {{ t('tournaments.standings.empty') }}
    </p>

    <TournamentsCrosstable
      v-else-if="isLeague && view === 'crosstable'"
      class="mt-4"
      :standings="standings"
      :rounds="tournament.rounds"
    />

    <!-- League table (round robin): a plain, compact table that scrolls
         sideways on a phone instead of restyling rows as cards. -->
    <div
      v-else-if="isLeague"
      class="mt-4 overflow-x-auto"
    >
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-default bg-elevated/50 text-[0.6875rem] tracking-wider text-muted uppercase">
            <th class="py-2 pr-2 pl-3">
              {{ t('tournaments.standings.columns.position') }}
            </th>
            <th class="px-2 py-2">
              {{ t('tournaments.standings.columns.name') }}
            </th>
            <th class="px-2 py-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.playedTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.played') }}</abbr>
            </th>
            <th class="px-2 py-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.winsTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.wins') }}</abbr>
            </th>
            <th
              v-if="showDraws"
              class="px-2 py-2 text-right"
            >
              <abbr
                :title="t('tournaments.standings.league.drawsTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.draws') }}</abbr>
            </th>
            <th class="px-2 py-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.lossesTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.losses') }}</abbr>
            </th>
            <th class="px-2 py-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.gamesTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.games') }}</abbr>
            </th>
            <th class="px-2 py-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.differenceTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.difference') }}</abbr>
            </th>
            <th class="py-2 pr-3 pl-2 text-right">
              <abbr
                :title="t('tournaments.standings.league.pointsTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.columns.pointsShort') }}</abbr>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="row in standings"
            :key="row.participantId"
            data-testid="standings-row"
            class="transition-colors hover:bg-elevated/40"
            :class="[
              row.rank === 1 && !row.withdrawn ? 'bg-secondary/8' : undefined,
              row.withdrawn ? 'text-muted' : undefined,
            ]"
          >
            <td
              class="py-2 pr-2 pl-3 font-numeric font-semibold tracking-[0.04em] text-muted tabular-nums"
              :class="row.rank === 1 && !row.withdrawn ? 'shadow-[inset_3px_0_0_var(--ui-secondary)]' : undefined"
            >
              <span class="inline-flex items-center gap-1.5">
                <span
                  v-if="isPodium(row)"
                  class="size-2.5 rounded-full ring-1 ring-default"
                  :class="MEDAL_CLASSES[row.rank - 1]"
                  aria-hidden="true"
                />
                {{ rankLabel(row) }}
              </span>
            </td>
            <td
              class="px-2 py-2 font-medium"
              :class="row.withdrawn ? undefined : 'text-highlighted'"
            >
              {{ row.name }}
              <UBadge
                v-if="row.withdrawn"
                size="sm"
                class="ml-1"
                color="neutral"
                variant="subtle"
                :label="t('tournaments.withdrawn')"
              />
              <UBadge
                v-else-if="row.dropped"
                size="sm"
                class="ml-1"
                color="neutral"
                variant="subtle"
                :label="t('tournaments.dropped')"
              />
            </td>
            <td class="px-2 py-2 text-right font-numeric tabular-nums">
              {{ row.matchesPlayed }}
            </td>
            <td class="px-2 py-2 text-right font-numeric tabular-nums">
              {{ row.wins }}
            </td>
            <td
              v-if="showDraws"
              class="px-2 py-2 text-right font-numeric tabular-nums"
            >
              {{ row.draws }}
            </td>
            <td class="px-2 py-2 text-right font-numeric tabular-nums">
              {{ row.losses }}
            </td>
            <td class="px-2 py-2 text-right font-numeric tabular-nums">
              {{ gamesLabel(row) }}
            </td>
            <td class="px-2 py-2 text-right font-numeric tabular-nums">
              {{ differenceLabel(row) }}
            </td>
            <td
              class="py-2 pr-3 pl-2 text-right font-numeric font-bold tracking-[0.04em] tabular-nums"
              :class="row.withdrawn ? undefined : 'text-highlighted'"
            >
              {{ row.points }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Swiss: same single-<table> card pattern as the participants panel (#28):
         below `sm` each row is a card with rank, name and points up top and
         the tie-breakers as a small definition list underneath. -->
    <div
      v-else
      class="mt-4 overflow-x-auto"
    >
      <table
        role="table"
        class="block w-full text-left text-sm sm:table"
      >
        <thead
          role="rowgroup"
          class="hidden sm:table-header-group"
        >
          <tr
            role="row"
            class="border-b border-default bg-elevated/50 text-[0.6875rem] tracking-wider text-muted uppercase"
          >
            <th
              role="columnheader"
              class="py-2 pr-2 pl-3"
            >
              {{ t('tournaments.standings.columns.rank') }}
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              {{ t('tournaments.standings.columns.player') }}
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              {{ t('tournaments.standings.columns.points') }}
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              <abbr
                :title="showDraws ? t('tournaments.standings.recordTitle') : t('tournaments.standings.recordWinLossTitle')"
                class="cursor-help"
              >{{ showDraws ? t('tournaments.standings.record') : t('tournaments.standings.recordWinLoss') }}</abbr>
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              <abbr
                :title="t('tournaments.standings.omwTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.omw') }}</abbr>
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              <abbr
                :title="t('tournaments.standings.gwTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.gw') }}</abbr>
            </th>
            <th
              role="columnheader"
              class="px-2 py-2"
            >
              <abbr
                :title="t('tournaments.standings.ogwTitle')"
                class="cursor-help"
              >{{ t('tournaments.standings.ogw') }}</abbr>
            </th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          class="block space-y-2 sm:table-row-group sm:space-y-0 sm:divide-y sm:divide-default"
        >
          <tr
            v-for="row in standings"
            :key="row.participantId"
            role="row"
            data-testid="standings-row"
            class="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 rounded-lg border p-3 transition-colors sm:table-row sm:rounded-none sm:border-0 sm:p-0 sm:hover:bg-elevated/40"
            :class="[
              row.rank === 1 && !row.withdrawn ? 'border-secondary/40 bg-secondary/8' : 'border-default',
              row.withdrawn ? 'text-muted' : undefined,
            ]"
          >
            <!-- Gold, silver and bronze dots for the podium (decorative; the
                 rank is written next to them); a gold edge on first place. -->
            <td
              role="cell"
              class="font-numeric font-semibold tracking-[0.04em] text-muted tabular-nums sm:py-2 sm:pr-2 sm:pl-3"
              :class="row.rank === 1 && !row.withdrawn ? 'sm:shadow-[inset_3px_0_0_var(--ui-secondary)]' : undefined"
            >
              <span class="inline-flex items-center gap-1.5">
                <span
                  v-if="isPodium(row)"
                  class="size-2.5 rounded-full ring-1 ring-default"
                  :class="MEDAL_CLASSES[row.rank - 1]"
                  aria-hidden="true"
                />
                {{ rankLabel(row) }}
              </span>
            </td>
            <td
              role="cell"
              class="font-medium sm:px-2 sm:py-2"
              :class="row.withdrawn ? undefined : 'text-highlighted'"
            >
              {{ row.name }}
              <UBadge
                v-if="row.withdrawn"
                size="sm"
                class="ml-1"
                color="neutral"
                variant="subtle"
                :label="t('tournaments.withdrawn')"
              />
              <UBadge
                v-else-if="row.dropped"
                size="sm"
                class="ml-1"
                color="neutral"
                variant="subtle"
                :label="t('tournaments.dropped')"
              />
            </td>
            <td
              role="cell"
              class="text-right font-numeric font-bold tracking-[0.04em] tabular-nums sm:px-2 sm:py-2 sm:text-left"
              :class="row.withdrawn ? undefined : 'text-highlighted'"
            >
              {{ row.points }}<span class="text-xs font-normal text-muted sm:hidden"> {{ t('tournaments.standings.pointsShort') }}</span>
            </td>
            <td
              role="cell"
              class="hidden font-numeric tracking-[0.02em] tabular-nums sm:table-cell sm:px-2 sm:py-2"
            >
              {{ recordLabel(row) }}
            </td>
            <td
              role="cell"
              class="hidden font-numeric tracking-[0.02em] tabular-nums sm:table-cell sm:px-2 sm:py-2"
            >
              {{ formatRate(row.opponentMatchWinRate) }}
            </td>
            <td
              role="cell"
              class="hidden font-numeric tracking-[0.02em] tabular-nums sm:table-cell sm:px-2 sm:py-2"
            >
              {{ formatRate(row.gameWinRate) }}
            </td>
            <td
              role="cell"
              class="hidden font-numeric tracking-[0.02em] tabular-nums sm:table-cell sm:px-2 sm:py-2"
            >
              {{ formatRate(row.opponentGameWinRate) }}
            </td>
            <!-- Phone-only: the tie-breaker columns above are hidden below
                 `sm`, so the card repeats them as labelled pairs. -->
            <td
              role="cell"
              class="col-span-full sm:hidden"
            >
              <dl class="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <dt class="text-muted">
                    {{ showDraws ? t('tournaments.standings.record') : t('tournaments.standings.recordWinLoss') }}
                  </dt>
                  <dd class="tabular-nums text-highlighted">
                    {{ recordLabel(row) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    {{ t('tournaments.standings.omw') }}
                  </dt>
                  <dd class="tabular-nums text-highlighted">
                    {{ formatRate(row.opponentMatchWinRate) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    {{ t('tournaments.standings.gw') }}
                  </dt>
                  <dd class="tabular-nums text-highlighted">
                    {{ formatRate(row.gameWinRate) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted">
                    {{ t('tournaments.standings.ogw') }}
                  </dt>
                  <dd class="tabular-nums text-highlighted">
                    {{ formatRate(row.opponentGameWinRate) }}
                  </dd>
                </div>
              </dl>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- A visible legend rather than tooltips only: `title` never shows on
         touch devices (#28). -->
    <p class="mt-3 text-xs text-muted">
      {{ legend }}
    </p>
    <p
      v-if="hasWithdrawn"
      class="mt-1 text-xs text-muted"
    >
      {{ t('tournaments.standings.legendWithdrawn') }}
    </p>
  </section>
</template>
