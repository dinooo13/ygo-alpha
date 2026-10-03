import { describe, expect, it } from 'vitest'
import {
  pairRoundRobinRound,
  pairSwissRound,
  roundRobinSchedule,
} from '../../shared/tournament-pairing'
import type { PairingParticipant } from '../../shared/tournament-pairing'
import { roundRobinRoundCount, swissRoundCount } from '../../shared/tournaments'

function p(id: string, seed: number, over: Partial<PairingParticipant> = {}): PairingParticipant {
  return {
    id,
    seed,
    points: 0,
    tiebreak: 0,
    dropped: false,
    withdrawn: false,
    opponentIds: [],
    hadBye: false,
    ...over,
  }
}

describe('pairSwissRound', () => {
  it('pairs round 1 by seed when everyone is tied', () => {
    const result = pairSwissRound([p('p1', 1), p('p2', 2), p('p3', 3), p('p4', 4)])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p2' },
      { tableNumber: 2, participantAId: 'p3', participantBId: 'p4' },
    ])
  })

  it('pairs round 2 by points after 1-2 / 3-4 wins', () => {
    const result = pairSwissRound([
      p('p1', 1, { points: 3, opponentIds: ['p2'] }),
      p('p2', 2, { points: 0, opponentIds: ['p1'] }),
      p('p3', 3, { points: 3, opponentIds: ['p4'] }),
      p('p4', 4, { points: 0, opponentIds: ['p3'] }),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p3' },
      { tableNumber: 2, participantAId: 'p2', participantBId: 'p4' },
    ])
  })

  it('avoids a rematch even when it means not pairing straight down the sorted list', () => {
    const result = pairSwissRound([
      p('p1', 1, { points: 3, opponentIds: ['p3'] }),
      p('p2', 2, { points: 0, opponentIds: ['p4'] }),
      p('p3', 3, { points: 3, opponentIds: ['p1'] }),
      p('p4', 4, { points: 0, opponentIds: ['p2'] }),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p2' },
      { tableNumber: 2, participantAId: 'p3', participantBId: 'p4' },
    ])
  })

  it('excludes withdrawn players from Swiss pairings, like dropped ones', () => {
    const result = pairSwissRound([
      p('p1', 1),
      p('p2', 2, { withdrawn: true }),
      p('p3', 3),
      p('p4', 4),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p3' },
      { tableNumber: 2, participantAId: 'p4', participantBId: null },
    ])
  })

  it('gives the bye to the lowest-ranked player with an odd field', () => {
    const result = pairSwissRound([p('p1', 1), p('p2', 2), p('p3', 3)])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p2' },
      { tableNumber: 2, participantAId: 'p3', participantBId: null },
    ])
  })

  it('skips a player who already had a bye', () => {
    const result = pairSwissRound([p('p1', 1), p('p2', 2), p('p3', 3, { hadBye: true })])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p3' },
      { tableNumber: 2, participantAId: 'p2', participantBId: null },
    ])
  })

  it('gives a second bye to the lowest-ranked player when everyone already had one', () => {
    const result = pairSwissRound([
      p('p1', 1, { hadBye: true }),
      p('p2', 2, { hadBye: true }),
      p('p3', 3, { hadBye: true }),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p2' },
      { tableNumber: 2, participantAId: 'p3', participantBId: null },
    ])
  })

  it('excludes dropped players from pairings and byes', () => {
    const result = pairSwissRound([
      p('p1', 1),
      p('p2', 2, { dropped: true }),
      p('p3', 3),
      p('p4', 4),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p3' },
      { tableNumber: 2, participantAId: 'p4', participantBId: null },
    ])
  })

  it('returns an empty pairing set with zero active participants', () => {
    expect(pairSwissRound([p('p1', 1, { dropped: true })])).toEqual([])
  })

  it('gives one bye with a single active participant', () => {
    expect(pairSwissRound([p('p1', 1)])).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: null },
    ])
  })

  it('falls back to a rematch when no rematch-free pairing exists', () => {
    const result = pairSwissRound([
      p('p1', 1, { opponentIds: ['p2'] }),
      p('p2', 2, { opponentIds: ['p1'] }),
    ])
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'p1', participantBId: 'p2' },
    ])
  })

  it('is deterministic regardless of input order', () => {
    const participants = [
      p('p1', 1, { points: 3, opponentIds: ['p2'] }),
      p('p2', 2, { points: 0, opponentIds: ['p1'] }),
      p('p3', 3, { points: 3, opponentIds: ['p4'] }),
      p('p4', 4, { points: 0, opponentIds: ['p3'] }),
    ]
    const shuffled = [participants[3]!, participants[0]!, participants[2]!, participants[1]!]
    expect(pairSwissRound(shuffled)).toEqual(pairSwissRound(participants))
  })
})

describe('roundRobinSchedule', () => {
  it('produces every unordered pair exactly once for an even field', () => {
    const rounds = roundRobinSchedule(['a', 'b', 'c', 'd'])
    expect(rounds).toHaveLength(3)
    expect(rounds[0]).toEqual([['a', 'd'], ['b', 'c']])

    const sortPair = ([x, y]: [string, string | null]) => [x, y].sort().join('-')
    const allPairs = new Set(rounds.flat().map(sortPair))
    expect(allPairs.size).toBe(6)
  })

  it('gives each player exactly one bye for an odd field', () => {
    const rounds = roundRobinSchedule(['a', 'b', 'c'])
    expect(rounds).toHaveLength(3)

    const byeCounts = new Map<string, number>()
    for (const round of rounds) {
      const byes = round.filter(([, b]) => b === null)
      expect(byes).toHaveLength(1)
      for (const [player] of byes) {
        byeCounts.set(player, (byeCounts.get(player) ?? 0) + 1)
      }
    }
    expect(byeCounts.get('a')).toBe(1)
    expect(byeCounts.get('b')).toBe(1)
    expect(byeCounts.get('c')).toBe(1)
  })
})

describe('pairRoundRobinRound', () => {
  it('turns a dropped participant into a bye for their scheduled opponent', () => {
    const participants = [
      p('a', 1),
      p('b', 2, { dropped: true }),
      p('c', 3),
      p('d', 4),
    ]
    // Round 1 schedule for seeds [a,b,c,d] is [[a,d],[b,c]] -> b is dropped,
    // so c gets a bye instead of playing b.
    const result = pairRoundRobinRound(participants, 1)
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'a', participantBId: 'd' },
      { tableNumber: 2, participantAId: 'c', participantBId: null },
    ])
  })

  it('discards a pairing where both scheduled participants are dropped', () => {
    const participants = [
      p('a', 1, { dropped: true }),
      p('b', 2),
      p('c', 3),
      p('d', 4, { dropped: true }),
    ]
    const result = pairRoundRobinRound(participants, 1)
    expect(result).toEqual([
      { tableNumber: 1, participantAId: 'b', participantBId: 'c' },
    ])
  })

  it('keeps a withdrawn participant in the fixed schedule instead of rearranging it', () => {
    const participants = [p('a', 1), p('b', 2, { withdrawn: true }), p('c', 3), p('d', 4)]
    // Same fixtures as without the withdrawal: b still meets c in round 1,
    // the standings and the UI treat that match as void.
    expect(pairRoundRobinRound(participants, 1)).toEqual(pairRoundRobinRound(
      [p('a', 1), p('b', 2), p('c', 3), p('d', 4)],
      1,
    ))
  })

  it('lets withdrawn win over dropped: the fixture is kept, not turned into a bye', () => {
    const participants = [p('a', 1), p('b', 2, { dropped: true, withdrawn: true }), p('c', 3), p('d', 4)]
    // Round 1 is [[a,d],[b,c]]: b stays paired with c (a void match) instead of c getting a bye.
    expect(pairRoundRobinRound(participants, 1)).toEqual([
      { tableNumber: 1, participantAId: 'a', participantBId: 'd' },
      { tableNumber: 2, participantAId: 'b', participantBId: 'c' },
    ])
  })

  it('returns an empty pairing set beyond the schedule length', () => {
    const participants = [p('a', 1), p('b', 2), p('c', 3), p('d', 4)]
    expect(pairRoundRobinRound(participants, 4)).toEqual([])
  })
})

describe('round counts', () => {
  it('computes the Swiss round count', () => {
    expect(swissRoundCount(2)).toBe(1)
    expect(swissRoundCount(3)).toBe(2)
    expect(swissRoundCount(4)).toBe(2)
    expect(swissRoundCount(5)).toBe(3)
    expect(swissRoundCount(8)).toBe(3)
    expect(swissRoundCount(9)).toBe(4)
    expect(swissRoundCount(16)).toBe(4)
    expect(swissRoundCount(64)).toBe(6)
  })

  it('computes the round robin round count', () => {
    expect(roundRobinRoundCount(4)).toBe(3)
    expect(roundRobinRoundCount(5)).toBe(5)
    expect(roundRobinRoundCount(1)).toBe(0)
  })
})
