<script setup lang="ts">
import type { TournamentRoundDto, TournamentStandingRow } from '~~/shared/tournaments'

// Round-robin crosstable (ADR 0028): every pairing once, as "row's games :
// column's games". Players are in table order; withdrawn ones are left out
// because none of their matches counts.

const props = defineProps<{
  standings: TournamentStandingRow[]
  rounds: TournamentRoundDto[]
}>()

const { t } = useI18n()

const players = computed(() => props.standings.filter(row => !row.withdrawn))

interface Cell { own: number, other: number }

const results = computed(() => {
  const byPair = new Map<string, Cell>()
  for (const round of props.rounds) {
    for (const match of round.matches) {
      if (match.isBye || match.voided || !match.reported || match.participantBId === null) {
        continue
      }
      byPair.set(`${match.participantAId}|${match.participantBId}`, { own: match.gamesA, other: match.gamesB })
      byPair.set(`${match.participantBId}|${match.participantAId}`, { own: match.gamesB, other: match.gamesA })
    }
  }
  return byPair
})

function cell(rowId: string, columnId: string): Cell | null {
  return results.value.get(`${rowId}|${columnId}`) ?? null
}
</script>

<template>
  <div>
    <div class="overflow-x-auto">
      <table
        class="w-full text-center text-sm"
        :aria-label="t('tournaments.standings.crosstable.ariaLabel')"
      >
        <thead>
          <tr class="border-b border-default bg-elevated/50 text-[0.6875rem] tracking-wider text-muted uppercase">
            <th class="py-2 pr-2 pl-3 text-left">
              {{ t('tournaments.standings.columns.name') }}
            </th>
            <th
              v-for="column in players"
              :key="column.participantId"
              scope="col"
              class="max-w-24 truncate px-2 py-2"
              :title="column.name"
            >
              {{ column.name }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="row in players"
            :key="row.participantId"
          >
            <th
              scope="row"
              class="max-w-40 truncate py-2 pr-2 pl-3 text-left font-medium text-highlighted"
              :title="row.name"
            >
              {{ row.name }}
            </th>
            <td
              v-for="column in players"
              :key="column.participantId"
              class="px-2 py-2 font-numeric tabular-nums"
              :class="row.participantId === column.participantId ? 'bg-elevated/60' : undefined"
            >
              <template v-if="row.participantId === column.participantId">
                <span aria-hidden="true">·</span>
              </template>
              <template v-else-if="cell(row.participantId, column.participantId)">
                <span
                  :class="cell(row.participantId, column.participantId)!.own > cell(row.participantId, column.participantId)!.other ? 'font-bold text-highlighted' : 'text-muted'"
                >{{ cell(row.participantId, column.participantId)!.own }}:{{ cell(row.participantId, column.participantId)!.other }}</span>
              </template>
              <span
                v-else
                class="text-muted"
              >–</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mt-3 text-xs text-muted">
      {{ t('tournaments.standings.crosstable.caption') }}
    </p>
  </div>
</template>
