import { describe, expect, it } from 'vitest'
import { computeStandings } from '../../shared/tournament-standings'
import type { StandingsMatch, StandingsOptions, StandingsParticipant } from '../../shared/tournament-standings'

function participant(id: string, seed: number, dropped = false, withdrawn = false): StandingsParticipant {
  return { id, seed, dropped, withdrawn }
}

/** What every tournament created before ADR 0028 was backfilled with. */
const LEGACY: StandingsOptions = { scoring: 'match', byeScoring: 'win', pairingSystem: 'swiss' }
const GAMES_SWISS: StandingsOptions = { scoring: 'games', byeScoring: 'none', pairingSystem: 'swiss' }

function won(a: string, b: string, gamesA: number, gamesB: number): StandingsMatch {
  return {
    participantAId: a,
    participantBId: b,
    winnerParticipantId: gamesA > gamesB ? a : b,
    gamesA,
    gamesB,
    isDraw: false,
    reported: true,
  }
}

describe('computeStandings', () => {
  it('ranks a 4-player, 2-round field by points then the standard tiebreakers', () => {
    const participants = [
      participant('p1', 1),
      participant('p2', 2),
      participant('p3', 3),
      participant('p4', 4),
    ]
    const matches: StandingsMatch[] = [
      { participantAId: 'p1', participantBId: 'p2', winnerParticipantId: 'p1', gamesA: 2, gamesB: 0, isDraw: false, reported: true },
      { participantAId: 'p3', participantBId: 'p4', winnerParticipantId: 'p3', gamesA: 2, gamesB: 1, isDraw: false, reported: true },
      { participantAId: 'p1', participantBId: 'p3', winnerParticipantId: 'p1', gamesA: 2, gamesB: 1, isDraw: false, reported: true },
      { participantAId: 'p2', participantBId: 'p4', winnerParticipantId: null, gamesA: 1, gamesB: 1, isDraw: true, reported: true },
    ]

    const rows = computeStandings(participants, matches, LEGACY)
    const byId = Object.fromEntries(rows.map(row => [row.participantId, row]))

    expect(rows.map(row => row.participantId)).toEqual(['p1', 'p3', 'p2', 'p4'])

    expect(byId.p1).toMatchObject({
      rank: 1, points: 6, wins: 2, losses: 0, draws: 0,
      gamesWon: 4, gamesLost: 1,
      gameWinRate: 0.8, matchWinRate: 1,
      opponentMatchWinRate: 0.4167, opponentGameWinRate: 0.4167,
    })
    expect(byId.p3).toMatchObject({
      rank: 2, points: 3, wins: 1, losses: 1, draws: 0,
      gamesWon: 3, gamesLost: 3,
      gameWinRate: 0.5, matchWinRate: 0.5,
      opponentMatchWinRate: 0.6667, opponentGameWinRate: 0.6,
    })
    expect(byId.p2).toMatchObject({
      rank: 3, points: 1, wins: 0, losses: 1, draws: 1,
      gamesWon: 1, gamesLost: 3,
      gameWinRate: 0.3333, matchWinRate: 0.3333,
      opponentMatchWinRate: 0.6667, opponentGameWinRate: 0.6,
    })
    expect(byId.p4).toMatchObject({
      rank: 4, points: 1, wins: 0, losses: 1, draws: 1,
      gamesWon: 2, gamesLost: 3,
      gameWinRate: 0.4, matchWinRate: 0.3333,
      opponentMatchWinRate: 0.4167, opponentGameWinRate: 0.4167,
    })
  })

  it('scores a bye as a 2-0 win that contributes no opponent', () => {
    const participants = [participant('p1', 1), participant('p2', 2), participant('p3', 3)]
    const matches: StandingsMatch[] = [
      { participantAId: 'p1', participantBId: 'p2', winnerParticipantId: 'p1', gamesA: 2, gamesB: 0, isDraw: false, reported: true },
      { participantAId: 'p3', participantBId: null, winnerParticipantId: 'p3', gamesA: 2, gamesB: 0, isDraw: false, reported: true },
    ]

    const rows = computeStandings(participants, matches, LEGACY)
    const byId = Object.fromEntries(rows.map(row => [row.participantId, row]))

    expect(byId.p1!.points).toBe(3)
    expect(byId.p3!.points).toBe(3)
    expect(byId.p3!.byes).toBe(1)
    expect(byId.p3!.wins).toBe(1)
    expect(byId.p3!.gameWinRate).toBe(1)
    expect(byId.p3!.opponentMatchWinRate).toBe(0)
    expect(byId.p1!.opponentMatchWinRate).toBe(0.3333)

    expect(rows.map(row => row.participantId)).toEqual(['p1', 'p3', 'p2'])
  })

  it('ignores unreported matches, keeps dropped participants, and skips unknown ids', () => {
    const participants = [participant('p1', 1), participant('p2', 2, true)]
    const matches: StandingsMatch[] = [
      { participantAId: 'p1', participantBId: 'p2', winnerParticipantId: 'p1', gamesA: 2, gamesB: 0, isDraw: false, reported: false },
      { participantAId: 'p1', participantBId: 'unknown', winnerParticipantId: 'p1', gamesA: 2, gamesB: 0, isDraw: false, reported: true },
    ]

    const rows = computeStandings(participants, matches, LEGACY)
    for (const row of rows) {
      expect(row.matchesPlayed).toBe(0)
      expect(row.points).toBe(0)
      expect(row.matchWinRate).toBe(0)
      expect(row.gameWinRate).toBe(0)
      expect(row.opponentMatchWinRate).toBe(0)
      expect(row.opponentGameWinRate).toBe(0)
    }
    expect(rows.map(row => row.participantId)).toEqual(['p1', 'p2'])
    expect(rows.find(row => row.participantId === 'p2')!.dropped).toBe(true)
  })

  it('returns an empty table for no participants', () => {
    expect(computeStandings([], [], LEGACY)).toEqual([])
  })
  describe('games scoring', () => {
    it('awards 3 / 2 / 1 / 0 by games, so a 2:0 outranks a 2:1', () => {
      const participants = [participant('p1', 1), participant('p2', 2), participant('p3', 3), participant('p4', 4)]
      const rows = computeStandings(participants, [
        won('p1', 'p2', 2, 0),
        won('p3', 'p4', 2, 1),
      ], GAMES_SWISS)
      const byId = Object.fromEntries(rows.map(row => [row.participantId, row]))

      expect(byId.p1!.points).toBe(3)
      expect(byId.p2!.points).toBe(0)
      expect(byId.p3!.points).toBe(2)
      expect(byId.p4!.points).toBe(1)
      expect(rows.map(row => row.participantId)).toEqual(['p1', 'p3', 'p4', 'p2'])
    })

    it('scores a manual 1:0 win as a win without a dropped game', () => {
      const rows = computeStandings([participant('p1', 1), participant('p2', 2)], [won('p1', 'p2', 1, 0)], GAMES_SWISS)
      expect(rows.find(row => row.participantId === 'p1')!.points).toBe(3)
      expect(rows.find(row => row.participantId === 'p2')!.points).toBe(0)
    })

    it('keeps match-win rates a share of the 3 available points', () => {
      const rows = computeStandings([participant('p1', 1), participant('p2', 2)], [won('p1', 'p2', 2, 1)], GAMES_SWISS)
      const byId = Object.fromEntries(rows.map(row => [row.participantId, row]))
      expect(byId.p1!.matchWinRate).toBe(0.6667)
      expect(byId.p2!.matchWinRate).toBe(0.3333)
      expect(byId.p1!.opponentMatchWinRate).toBe(0.3333)
    })

    it('still scores a legacy draw as one point each', () => {
      const rows = computeStandings([participant('p1', 1), participant('p2', 2)], [
        { participantAId: 'p1', participantBId: 'p2', winnerParticipantId: null, gamesA: 1, gamesB: 1, isDraw: true, reported: true },
      ], GAMES_SWISS)
      expect(rows.map(row => [row.points, row.draws])).toEqual([[1, 1], [1, 1]])
    })
  })

  describe('byes', () => {
    const bye: StandingsMatch = { participantAId: 'p3', participantBId: null, winnerParticipantId: null, gamesA: 0, gamesB: 0, isDraw: false, reported: true }

    it('gives a bye no points, no match played and no games by default', () => {
      const rows = computeStandings([participant('p1', 1), participant('p2', 2), participant('p3', 3)], [
        won('p1', 'p2', 2, 0),
        bye,
      ], GAMES_SWISS)
      const p3 = rows.find(row => row.participantId === 'p3')!
      expect(p3).toMatchObject({ points: 0, matchesPlayed: 0, wins: 0, byes: 1, gamesWon: 0, gamesLost: 0 })
    })

    it('scores a bye as a 2:0 win under byeScoring win, whatever the scoring scheme', () => {
      const rows = computeStandings([participant('p1', 1), participant('p2', 2), participant('p3', 3)], [bye], {
        ...GAMES_SWISS,
        byeScoring: 'win',
      })
      expect(rows.find(row => row.participantId === 'p3')).toMatchObject({ points: 3, matchesPlayed: 1, wins: 1, byes: 1, gamesWon: 2 })
    })
  })

  describe('withdrawn participants', () => {
    it('ignores every match with them for everybody and ranks them last', () => {
      const participants = [participant('p1', 1), participant('p2', 2, false, true), participant('p3', 3)]
      const rows = computeStandings(participants, [
        won('p1', 'p2', 2, 0),
        won('p3', 'p2', 2, 0),
        won('p3', 'p1', 2, 1),
      ], GAMES_SWISS)

      expect(rows.map(row => row.participantId)).toEqual(['p3', 'p1', 'p2'])
      expect(rows.map(row => row.rank)).toEqual([1, 2, 3])
      const byId = Object.fromEntries(rows.map(row => [row.participantId, row]))
      expect(byId.p3).toMatchObject({ points: 2, matchesPlayed: 1, wins: 1 })
      expect(byId.p1).toMatchObject({ points: 1, matchesPlayed: 1, losses: 1 })
      expect(byId.p2).toMatchObject({ points: 0, matchesPlayed: 0, withdrawn: true })
      expect(byId.p3!.opponentMatchWinRate).toBe(0.3333)
    })

    it('is reversible: standings are a pure function of the flag', () => {
      const matches = [won('p1', 'p2', 2, 0)]
      const withdrawn = computeStandings([participant('p1', 1), participant('p2', 2, false, true)], matches, GAMES_SWISS)
      const reinstated = computeStandings([participant('p1', 1), participant('p2', 2)], matches, GAMES_SWISS)
      expect(withdrawn.find(row => row.participantId === 'p1')!.points).toBe(0)
      expect(reinstated.find(row => row.participantId === 'p1')!.points).toBe(3)
    })
  })

  describe('league table (round robin)', () => {
    const LEAGUE_MATCH: StandingsOptions = { scoring: 'match', byeScoring: 'none', pairingSystem: 'round_robin' }
    const ids = (rows: Array<{ participantId: string }>) => rows.map(row => row.participantId)

    it('ranks by points, then game difference', () => {
      // p1 and p2 each win once (3 pts); p2 by 3:0 in games, p1 by 2:1.
      const rows = computeStandings(
        [participant('p1', 1), participant('p2', 2), participant('p3', 3), participant('p4', 4)],
        [won('p1', 'p3', 2, 1), won('p2', 'p4', 3, 0)],
        LEAGUE_MATCH,
      )
      expect(ids(rows)).toEqual(['p2', 'p1', 'p3', 'p4'])
    })

    it('settles exactly two level teams by their direct match, against the seed', () => {
      // p1 and p2 are level on 6 points and +2 games; p2 beat p1 directly.
      // p3 and p4 are level on 3 points and -2 games; p3 beat p4 directly.
      const rows = computeStandings(
        [participant('p1', 1), participant('p2', 2), participant('p3', 3), participant('p4', 4)],
        [
          won('p2', 'p1', 2, 0),
          won('p1', 'p3', 2, 0),
          won('p1', 'p4', 2, 0),
          won('p2', 'p3', 2, 0),
          won('p4', 'p2', 2, 0),
          won('p3', 'p4', 2, 0),
        ],
        LEAGUE_MATCH,
      )
      expect(ids(rows)).toEqual(['p2', 'p1', 'p3', 'p4'])
    })

    it('does not apply head-to-head to three level teams: games won, then seed', () => {
      // p1 > p2 > p3 > p1 in a cycle, all three beat p4 2:0: identical records.
      const rows = computeStandings(
        [participant('p3', 1), participant('p1', 2), participant('p2', 3), participant('p4', 4)],
        [
          won('p1', 'p2', 2, 0),
          won('p2', 'p3', 2, 0),
          won('p3', 'p1', 2, 0),
          won('p1', 'p4', 2, 0),
          won('p2', 'p4', 2, 0),
          won('p3', 'p4', 2, 0),
        ],
        LEAGUE_MATCH,
      )
      expect(ids(rows)).toEqual(['p3', 'p1', 'p2', 'p4'])
    })

    it('falls back to games won when two level teams never met, then to the seed', () => {
      const rows = computeStandings(
        [participant('p1', 1), participant('p2', 2), participant('p3', 3), participant('p4', 4)],
        [won('p1', 'p3', 2, 0), won('p2', 'p4', 3, 1)],
        LEAGUE_MATCH,
      )
      // p1/p2: 3 pts, +2 -> p2 has more games won. p3/p4: 0 pts, -2 -> p4 won a game.
      expect(ids(rows)).toEqual(['p2', 'p1', 'p4', 'p3'])
      expect(ids(computeStandings([participant('p1', 1), participant('p2', 2)], [], LEAGUE_MATCH))).toEqual(['p1', 'p2'])
    })

    it('does not use OMW% to order a league table', () => {
      const rows = computeStandings(
        [participant('p1', 1), participant('p2', 2), participant('p3', 3)],
        [won('p1', 'p3', 2, 0), won('p2', 'p3', 2, 0)],
        LEAGUE_MATCH,
      )
      expect(ids(rows)).toEqual(['p1', 'p2', 'p3'])
    })
  })
})
