// Pure standings computation (ADR 0008, ADR 0028). Match points under one of
// two scoring schemes, then either the Swiss tiebreakers (OMW% → GW% → OGW%)
// or the league-table ones (game difference → head-to-head → games won).

import type { ByeScoring, PairingSystem, ScoringSystem } from './tournaments'

export interface StandingsParticipant {
  id: string
  seed: number
  dropped: boolean
  /** Taken out of the standings: every match with them is ignored, they rank last. */
  withdrawn: boolean
}

export interface StandingsOptions {
  scoring: ScoringSystem
  byeScoring: ByeScoring
  /** Picks the tiebreakers: Swiss uses OMW% → GW% → OGW%, round robin a league table. */
  pairingSystem: PairingSystem
}

export interface StandingsMatch {
  participantAId: string
  /** null = bye for A. */
  participantBId: string | null
  winnerParticipantId: string | null
  gamesA: number
  gamesB: number
  isDraw: boolean
  /** Unreported matches are ignored entirely. */
  reported: boolean
}

export interface StandingsRow {
  participantId: string
  /** 1-based, dense, no shared ranks (the seed tiebreak makes the order total). */
  rank: number
  /** Matches played; a bye counts only under `byeScoring: 'win'`. */
  matchesPlayed: number
  wins: number
  losses: number
  /** Legacy results only: new results are never draws (ADR 0028). */
  draws: number
  byes: number
  points: number
  gamesWon: number
  gamesLost: number
  /** Own match-win percentage, floored at 1/3. 0..1, rounded to 4 decimals. */
  matchWinRate: number
  /** Own game-win percentage, floored at 1/3. */
  gameWinRate: number
  /** Opponents' match-win percentage (OMW%). */
  opponentMatchWinRate: number
  /** Opponents' game-win percentage (OGW%). */
  opponentGameWinRate: number
  dropped: boolean
  /** Withdrawn rows carry no results of their own and rank after everyone else. */
  withdrawn: boolean
}

// Canonical home for the scoring constants; `shared/tournaments.ts` re-exports
// these rather than redeclaring them, so the pairing/round-creation path and
// the standings path can never drift apart.
export const POINTS_WIN = 3
export const POINTS_DRAW = 1
/** `games` scoring: a win that dropped at least one game (2:1) is worth less than a 2:0. */
export const POINTS_WIN_DROPPED_GAME = 2
/** `games` scoring: a loss in which the loser still won a game (1:2) earns a point. */
export const POINTS_LOSS_WITH_GAME = 1

/** Floor applied to every *own* win rate before it is averaged into an opponent rate. */
export const MIN_WIN_RATE = 1 / 3

/** A bye under `byeScoring: 'win'` is scored as a 2–0 win (3 match points). */
export const BYE_GAMES = 2

/**
 * The most a single match is worth under either scheme. Own and opponents'
 * match-win percentages divide points by this, so OMW% means the same under
 * `match` (3/0) and `games` (3/2/1/0) scoring: the share of the available
 * points that was earned.
 */
export const MAX_MATCH_POINTS = POINTS_WIN

/** Points one side earns from a decided match; `ownGames`/`opponentGames` are from that side's view. */
export function matchPoints(
  scoring: ScoringSystem,
  outcome: 'win' | 'loss',
  ownGames: number,
  opponentGames: number,
): number {
  if (scoring === 'match') {
    return outcome === 'win' ? POINTS_WIN : 0
  }
  if (outcome === 'win') {
    return opponentGames === 0 ? POINTS_WIN : POINTS_WIN_DROPPED_GAME
  }
  return ownGames > 0 ? POINTS_LOSS_WITH_GAME : 0
}

interface Accumulator {
  matchesPlayed: number
  wins: number
  losses: number
  draws: number
  byes: number
  points: number
  gamesWon: number
  gamesLost: number
  opponentIds: string[]
  /** Points earned against each opponent, for the league table's head-to-head. */
  pointsAgainst: Map<string, number>
}

function newAccumulator(): Accumulator {
  return {
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    byes: 0,
    points: 0,
    gamesWon: 0,
    gamesLost: 0,
    opponentIds: [],
    pointsAgainst: new Map(),
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

type RowComparator = (x: StandingsRow, y: StandingsRow) => number

/**
 * League-table order (like a football table): points → game difference →
 * head-to-head (only when exactly two are level) → games won → seed. The
 * head-to-head step is not a plain comparator — with three or more level it
 * would not be transitive — so rows are sorted by the other keys first and
 * every run of exactly two level rows is then settled by their direct match.
 */
function sortLeagueTable(rows: StandingsRow[], acc: Map<string, Accumulator>, bySeed: RowComparator): void {
  const difference = (row: StandingsRow) => row.gamesWon - row.gamesLost

  rows.sort((x, y) =>
    y.points - x.points
    || difference(y) - difference(x)
    || y.gamesWon - x.gamesWon
    || bySeed(x, y))

  let start = 0
  while (start < rows.length) {
    let end = start + 1
    while (
      end < rows.length
      && rows[end]!.points === rows[start]!.points
      && difference(rows[end]!) === difference(rows[start]!)
    ) {
      end += 1
    }

    if (end - start === 2) {
      const first = rows[start]!
      const second = rows[start + 1]!
      const firstPoints = acc.get(first.participantId)!.pointsAgainst.get(second.participantId) ?? 0
      const secondPoints = acc.get(second.participantId)!.pointsAgainst.get(first.participantId) ?? 0
      if (secondPoints > firstPoints) {
        rows[start] = second
        rows[start + 1] = first
      }
    }

    start = end
  }
}

export function computeStandings(
  participants: StandingsParticipant[],
  matches: StandingsMatch[],
  options: StandingsOptions,
): StandingsRow[] {
  const { scoring, byeScoring, pairingSystem } = options
  const knownIds = new Set(participants.map(p => p.id))
  const withdrawnIds = new Set(participants.filter(p => p.withdrawn).map(p => p.id))
  const acc = new Map<string, Accumulator>()
  for (const participant of participants) {
    acc.set(participant.id, newAccumulator())
  }

  for (const match of matches) {
    if (!match.reported) {
      continue
    }
    if (!knownIds.has(match.participantAId)) {
      continue
    }
    // A withdrawn player's matches count for nobody, on either side.
    if (withdrawnIds.has(match.participantAId)) {
      continue
    }

    const a = acc.get(match.participantAId)!

    if (match.participantBId === null) {
      a.byes += 1
      if (byeScoring === 'win') {
        a.wins += 1
        a.matchesPlayed += 1
        a.points += POINTS_WIN
        a.gamesWon += BYE_GAMES
      }
      continue
    }

    if (!knownIds.has(match.participantBId) || withdrawnIds.has(match.participantBId)) {
      continue
    }
    const b = acc.get(match.participantBId)!

    a.matchesPlayed += 1
    b.matchesPlayed += 1
    a.gamesWon += match.gamesA
    a.gamesLost += match.gamesB
    b.gamesWon += match.gamesB
    b.gamesLost += match.gamesA
    a.opponentIds.push(match.participantBId)
    b.opponentIds.push(match.participantAId)

    let pointsA = 0
    let pointsB = 0
    if (match.isDraw) {
      // Legacy only: draws can no longer be reported (ADR 0028).
      a.draws += 1
      b.draws += 1
      pointsA = POINTS_DRAW
      pointsB = POINTS_DRAW
    }
    else if (match.winnerParticipantId === match.participantAId) {
      a.wins += 1
      b.losses += 1
      pointsA = matchPoints(scoring, 'win', match.gamesA, match.gamesB)
      pointsB = matchPoints(scoring, 'loss', match.gamesB, match.gamesA)
    }
    else if (match.winnerParticipantId === match.participantBId) {
      b.wins += 1
      a.losses += 1
      pointsB = matchPoints(scoring, 'win', match.gamesB, match.gamesA)
      pointsA = matchPoints(scoring, 'loss', match.gamesA, match.gamesB)
    }
    else {
      // Defensive: no winner and not a draw — treat as a double loss (no points).
      a.losses += 1
      b.losses += 1
    }

    a.points += pointsA
    b.points += pointsB
    a.pointsAgainst.set(match.participantBId, (a.pointsAgainst.get(match.participantBId) ?? 0) + pointsA)
    b.pointsAgainst.set(match.participantAId, (b.pointsAgainst.get(match.participantAId) ?? 0) + pointsB)
  }

  // Own rates, floored at MIN_WIN_RATE (see StandingsRow.matchWinRate):
  // computed unrounded here, rounded once at the very end.
  const flooredMatchWinRate = new Map<string, number>()
  const flooredGameWinRate = new Map<string, number>()

  for (const participant of participants) {
    const a = acc.get(participant.id)!
    const totalGames = a.gamesWon + a.gamesLost

    const rawMwr = a.matchesPlayed === 0 ? 0 : a.points / (MAX_MATCH_POINTS * a.matchesPlayed)
    const rawGwr = totalGames === 0 ? 0 : a.gamesWon / totalGames

    flooredMatchWinRate.set(participant.id, a.matchesPlayed > 0 ? Math.max(rawMwr, MIN_WIN_RATE) : 0)
    flooredGameWinRate.set(participant.id, totalGames > 0 ? Math.max(rawGwr, MIN_WIN_RATE) : 0)
  }

  const rows: StandingsRow[] = participants.map((participant) => {
    const a = acc.get(participant.id)!

    const opponentMwr = a.opponentIds.length === 0
      ? 0
      : a.opponentIds.reduce((sum, id) => sum + (flooredMatchWinRate.get(id) ?? 0), 0) / a.opponentIds.length
    const opponentGwr = a.opponentIds.length === 0
      ? 0
      : a.opponentIds.reduce((sum, id) => sum + (flooredGameWinRate.get(id) ?? 0), 0) / a.opponentIds.length

    return {
      participantId: participant.id,
      rank: 0,
      matchesPlayed: a.matchesPlayed,
      wins: a.wins,
      losses: a.losses,
      draws: a.draws,
      byes: a.byes,
      points: a.points,
      gamesWon: a.gamesWon,
      gamesLost: a.gamesLost,
      matchWinRate: round4(flooredMatchWinRate.get(participant.id) ?? 0),
      gameWinRate: round4(flooredGameWinRate.get(participant.id) ?? 0),
      opponentMatchWinRate: round4(opponentMwr),
      opponentGameWinRate: round4(opponentGwr),
      dropped: participant.dropped,
      withdrawn: participant.withdrawn,
    }
  })

  const seedById = new Map(participants.map(p => [p.id, p.seed]))
  const bySeed: RowComparator = (x, y) =>
    (seedById.get(x.participantId) ?? 0) - (seedById.get(y.participantId) ?? 0)

  const ranked = rows.filter(row => !row.withdrawn)
  const withdrawn = rows.filter(row => row.withdrawn).sort(bySeed)

  if (pairingSystem === 'round_robin') {
    sortLeagueTable(ranked, acc, bySeed)
  }
  else {
    ranked.sort((x, y) =>
      y.points - x.points
      || y.opponentMatchWinRate - x.opponentMatchWinRate
      || y.gameWinRate - x.gameWinRate
      || y.opponentGameWinRate - x.opponentGameWinRate
      || bySeed(x, y))
  }

  const ordered = [...ranked, ...withdrawn]
  ordered.forEach((row, index) => {
    row.rank = index + 1
  })

  return ordered
}
