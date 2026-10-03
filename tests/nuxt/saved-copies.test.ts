import { describe, expect, it } from 'vitest'
import { createEntryRows } from '~/utils/card-entry'
import type { EntryCandidate, EntrySuggestResult } from '~/utils/card-entry'
import { applyMovedCopies, mergeSavedCopies, savedCopiesOf } from '~/utils/saved-copies'
import type { SavedCopy } from '~/utils/saved-copies'

function candidate(cardId: number, name: string, nameDe: string | null = null): EntryCandidate {
  return { cardId, name, nameDe, type: 'Normal Monster', frameType: 'normal', imageSmall: null, score: 1, matchedBy: 'exact' }
}

function result(raw: string, ...candidates: EntryCandidate[]): EntrySuggestResult {
  return { input: { raw, quantity: 1, query: raw }, candidates }
}

function copy(overrides: Partial<SavedCopy> = {}): SavedCopy {
  return { ownedCardId: 's1', catalogCardId: 1, name: 'Dark Magician', nameDe: null, quantity: 1, collectionId: null, ...overrides }
}

describe('savedCopiesOf', () => {
  it('pairs the server\'s stacks with the saved lines, in order', () => {
    const rows = createEntryRows([
      result('Dark Magician', candidate(46986414, 'Dark Magician', 'Dunkler Magier')),
      result('Pot of Greed', candidate(55144522, 'Pot of Greed')),
    ])
    rows[0]!.quantity = 3
    const entries = [
      { rowId: rows[0]!.id, item: { catalogCardId: 46986414, collectionId: 'box-1', quantity: 3 } },
      { rowId: rows[1]!.id, item: { catalogCardId: 55144522, collectionId: null, quantity: 1 } },
    ]

    expect(savedCopiesOf(entries, [{ id: 'stack-a' }, { id: 'stack-b' }], rows)).toEqual([
      { ownedCardId: 'stack-a', catalogCardId: 46986414, name: 'Dark Magician', nameDe: 'Dunkler Magier', quantity: 3, collectionId: 'box-1' },
      { ownedCardId: 'stack-b', catalogCardId: 55144522, name: 'Pot of Greed', nameDe: null, quantity: 1, collectionId: null },
    ])
  })

  it('counts the saved copies, not the stack\'s total, and folds lines of one stack together', () => {
    const rows = createEntryRows([
      result('Dark Magician', candidate(46986414, 'Dark Magician')),
      result('2x Dark Magician', candidate(46986414, 'Dark Magician')),
    ])
    const entries = rows.map((row, index) => ({
      rowId: row.id,
      item: { catalogCardId: 46986414, collectionId: null, quantity: index + 1 },
    }))

    // Both lines merged into one stack, which already held 5 copies.
    expect(savedCopiesOf(entries, [{ id: 'stack-a' }, { id: 'stack-a' }], rows)).toEqual([
      expect.objectContaining({ ownedCardId: 'stack-a', quantity: 3 }),
    ])
  })

  it('has nothing to follow without the server\'s items', () => {
    const rows = createEntryRows([result('Dark Magician', candidate(46986414, 'Dark Magician'))])
    const entries = [{ rowId: rows[0]!.id, item: { catalogCardId: 46986414, collectionId: null, quantity: 1 } }]

    expect(savedCopiesOf(entries, undefined, rows)).toEqual([])
    expect(savedCopiesOf(entries, [], rows)).toEqual([])
  })
})

describe('mergeSavedCopies', () => {
  it('adds up copies of the same stack and keeps the others', () => {
    const merged = mergeSavedCopies(
      [copy({ ownedCardId: 's1', quantity: 2 }), copy({ ownedCardId: 's2', quantity: 1 })],
      [copy({ ownedCardId: 's1', quantity: 3 }), copy({ ownedCardId: 's3', quantity: 1 })],
    )

    expect(merged.map(entry => [entry.ownedCardId, entry.quantity])).toEqual([['s1', 5], ['s2', 1], ['s3', 1]])
  })
})

describe('applyMovedCopies', () => {
  it('follows the copies into the target collection and the stack they ended up in', () => {
    const moved = applyMovedCopies(
      [copy({ ownedCardId: 's1', collectionId: null }), copy({ ownedCardId: 's2', catalogCardId: 2, collectionId: null })],
      [{ ownedCardId: 's1', resultId: 'new-stack' }],
      'box-2',
    )

    expect(moved).toEqual([
      expect.objectContaining({ ownedCardId: 'new-stack', collectionId: 'box-2' }),
      expect.objectContaining({ ownedCardId: 's2', collectionId: null }),
    ])
  })

  it('folds entries that merged into the same target stack', () => {
    const moved = applyMovedCopies(
      [copy({ ownedCardId: 's1', quantity: 2, collectionId: null }), copy({ ownedCardId: 's2', quantity: 1, collectionId: 'box-1' })],
      [{ ownedCardId: 's1', resultId: 'target' }, { ownedCardId: 's2', resultId: 'target' }],
      'box-2',
    )

    expect(moved).toEqual([expect.objectContaining({ ownedCardId: 'target', quantity: 3, collectionId: 'box-2' })])
  })

  it('can move back to "ohne Sammlung"', () => {
    expect(applyMovedCopies([copy({ collectionId: 'box-1' })], [{ ownedCardId: 's1', resultId: 's1' }], null)[0]!.collectionId).toBeNull()
  })
})
