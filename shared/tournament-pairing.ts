// Pure pairing algorithms. No database, no h3, no Vue — the server passes
// plain rows in and writes the returned pairings out.

import type { PairingSystem } from './tournaments'

export interface PairingParticipant {
  id: string
  /** 1-based, frozen when the tournament starts; final ordering tiebreak. */
  seed: number
  /** Match points so far (see shared/tournament-standings.ts). Ignored by round robin. */
  points: number
  /** Secondary sort key, normally OMW% from computeStandings(). Ignored by round robin. */
  tiebreak: number
  dropped: boolean
  /**
   * Taken out of the standings (ADR 0028). Swiss pairs them no more; round
   * robin keeps their fixed fixtures, which are simply not scored.
   */
  withdrawn: boolean
  /** Ids of every previous opponent; byes are not included. */
  opponentIds: string[]
  hadBye: boolean
}

export interface Pairing {
  tableNumber: number
  participantAId: string
  /** null = bye (worth a 2–0 win or nothing, per the tournament's `byeScoring`). */
  participantBId: string | null
}

export interface PairingContext {
  system: PairingSystem
  /** 1-based round number about to be created. */
  roundNumber: number
  participants: PairingParticipant[]
}

/** Upper bound on backtracking nodes before falling back to plain greedy pairing. */
export const MAX_PAIRING_STEPS = 20_000

interface StepBudget {
  steps: number
}

/**
 * Recursive top-down matching over an even-length, pre-sorted list: pairs
 * `list[0]` with the first later entry that is not a previous opponent, then
 * recurses on the rest. Returns `null` when no rematch-free perfect matching
 * exists (or the search budget is exhausted).
 */
function tryPair(list: PairingParticipant[], budget: StepBudget): PairingParticipant[][] | null {
  if (list.length === 0) {
    return []
  }

  budget.steps += 1
  if (budget.steps > MAX_PAIRING_STEPS) {
    return null
  }

  const [a, ...rest] = list
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i]!
    if (a!.opponentIds.includes(b.id)) {
      continue
    }

    const remaining = [...rest.slice(0, i), ...rest.slice(i + 1)]
    const sub = tryPair(remaining, budget)
    if (sub !== null) {
      return [[a!, b], ...sub]
    }
    if (budget.steps > MAX_PAIRING_STEPS) {
      return null
    }
  }

  return null
}

export function pairSwissRound(participants: PairingParticipant[]): Pairing[] {
  const active = participants.filter(p => !p.dropped && !p.withdrawn)
  if (active.length === 0) {
    return []
  }

  const sorted = [...active].sort((a, b) =>
    b.points - a.points || b.tiebreak - a.tiebreak || a.seed - b.seed)

  let byeParticipant: PairingParticipant | null = null
  let rest = sorted

  if (sorted.length % 2 === 1) {
    let byeIndex = -1
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (!sorted[i]!.hadBye) {
        byeIndex = i
        break
      }
    }
    if (byeIndex === -1) {
      byeIndex = sorted.length - 1
    }

    byeParticipant = sorted[byeIndex]!
    rest = [...sorted.slice(0, byeIndex), ...sorted.slice(byeIndex + 1)]
  }

  const budget: StepBudget = { steps: 0 }
  let matched = tryPair(rest, budget)

  if (matched === null) {
    // Fallback: no rematch-free perfect matching exists (or the budget blew).
    // Pair the sorted list straight down the middle, allowing rematches.
    matched = []
    for (let i = 0; i < rest.length; i += 2) {
      matched.push([rest[i]!, rest[i + 1]!])
    }
  }

  const pairings: Pairing[] = matched.map(([a, b], index) => ({
    tableNumber: index + 1,
    participantAId: a!.id,
    participantBId: b!.id,
  }))

  if (byeParticipant) {
    pairings.push({
      tableNumber: pairings.length + 1,
      participantAId: byeParticipant.id,
      participantBId: null,
    })
  }

  return pairings
}

/** The full circle-method schedule for a seed-ordered id list; `null` marks a bye. */
export function roundRobinSchedule(participantIds: string[]): Array<Array<[string, string | null]>> {
  const arr: Array<string | null> = [...participantIds]
  if (arr.length % 2 === 1) {
    arr.push(null)
  }

  const n = arr.length
  if (n === 0) {
    return []
  }

  const rounds: Array<Array<[string, string | null]>> = []
  let current = arr

  for (let round = 0; round < n - 1; round++) {
    const pairs: Array<[string, string | null]> = []
    for (let i = 0; i < n / 2; i++) {
      const a = current[i]!
      const b = current[n - 1 - i]!
      pairs.push(a === null ? [b as string, null] : [a, b])
    }
    rounds.push(pairs)

    // Rotate: fix current[0], rotate the rest one position to the right.
    const fixed = current[0]!
    current = [fixed, current[n - 1]!, ...current.slice(1, n - 1)]
  }

  return rounds
}

/**
 * `pairRoundRobinRound(participants, roundNumber)` takes the schedule slice
 * for `roundNumber`. Dropped participants stay in the seed-ordered circle (so
 * the schedule never shifts mid-tournament) and are only turned into a bye —
 * or dropped entirely, when both sides of a pair are dropped — after the
 * slice is taken. Withdrawn participants win over dropped ones: they are never
 * turned into a bye, even when also dropped. Their fixtures are still created
 * (so reinstating them restores a complete schedule) and the standings and the
 * UI treat those matches as void — a bye for the opponent would score under
 * `byeScoring: 'win'`, but nothing against a withdrawn player may count.
 */
export function pairRoundRobinRound(participants: PairingParticipant[], roundNumber: number): Pairing[] {
  const droppedIds = new Set(participants.filter(p => p.dropped && !p.withdrawn).map(p => p.id))
  const seedOrderedIds = [...participants].sort((a, b) => a.seed - b.seed).map(p => p.id)
  const schedule = roundRobinSchedule(seedOrderedIds)
  const slice = schedule[roundNumber - 1]

  if (!slice) {
    return []
  }

  const normalPairs: Array<{ participantAId: string, participantBId: string }> = []
  const byePairs: Array<{ participantAId: string, participantBId: null }> = []

  for (const [rawA, rawB] of slice) {
    const a = droppedIds.has(rawA) ? null : rawA
    const b = rawB === null || droppedIds.has(rawB) ? null : rawB

    if (a === null && b === null) {
      continue
    }
    else if (a === null) {
      byePairs.push({ participantAId: b!, participantBId: null })
    }
    else if (b === null) {
      byePairs.push({ participantAId: a, participantBId: null })
    }
    else {
      normalPairs.push({ participantAId: a, participantBId: b })
    }
  }

  return [...normalPairs, ...byePairs].map((pair, index) => ({ tableNumber: index + 1, ...pair }))
}

export function pairRound(context: PairingContext): Pairing[] {
  return context.system === 'round_robin'
    ? pairRoundRobinRound(context.participants, context.roundNumber)
    : pairSwissRound(context.participants)
}
