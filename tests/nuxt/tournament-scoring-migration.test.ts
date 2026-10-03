// Migration 0018 (ADR 0031): per-tournament `scoring` / `bye_scoring` and
// `tournament_participant.withdrawn`. New rows get the new defaults, but every
// tournament that already exists was played under the old rules, so the
// migration backfills it with 'match' scoring and a bye worth a win: its
// standings must come out exactly as before. This runs 0000–0017 on an
// in-memory DB, seeds a running tournament, applies 0018 the way the
// migrator does, and reads the standings back through the real reader.

import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, it } from 'vitest'
import * as schema from '../../server/db/schema'
import { getTournamentDetail } from '../../server/utils/tournaments'

const MIGRATIONS = './server/db/migrations'
const SCORING_MIGRATION = 18

interface JournalEntry { idx: number, tag: string }

const journal = (JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] }).entries

function statements(entry: JournalEntry): string[] {
  return readFileSync(`${MIGRATIONS}/${entry.tag}.sql`, 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.trim())
    .filter(statement => statement !== '')
}

function applyMigrations(sqlite: Database.Database, include: (entry: JournalEntry) => boolean) {
  for (const entry of journal.filter(include)) {
    sqlite.exec('BEGIN')
    try {
      for (const statement of statements(entry)) {
        sqlite.prepare(statement).run()
      }
      sqlite.exec('COMMIT')
    }
    catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
}

/** An in-memory DB at migration 0017 (production's state), foreign keys on as in the app. */
function databaseBeforeScoring() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite, entry => entry.idx < SCORING_MIGRATION)
  return sqlite
}

/** A running round-1 Swiss tournament: Alice beat Bob 2:0, Carla has the bye. */
function seedLegacyTournament(sqlite: Database.Database) {
  const now = Date.now()
  sqlite.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run('user-a', 'User A', 'a@example.com', now, now)
  sqlite.prepare('INSERT INTO tournament (id, organizer_user_id, name, pairing_system, status, planned_rounds, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('t-legacy', 'user-a', 'Altes Turnier', 'swiss', 'running', 2, now, now, now)
  const participant = sqlite.prepare('INSERT INTO tournament_participant (id, tournament_id, name, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
  participant.run('p-alice', 't-legacy', 'Alice', 1, now, now)
  participant.run('p-bob', 't-legacy', 'Bob', 2, now, now)
  participant.run('p-carla', 't-legacy', 'Carla', 3, now, now)
  sqlite.prepare('INSERT INTO tournament_round (id, tournament_id, number, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('r1', 't-legacy', 1, 'pending', now)
  const match = sqlite.prepare('INSERT INTO tournament_match (id, round_id, tournament_id, table_number, participant_a_id, participant_b_id, winner_participant_id, games_a, games_b, is_draw, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  match.run('m1', 'r1', 't-legacy', 1, 'p-alice', 'p-bob', 'p-alice', 2, 1, 0, now)
  match.run('m2', 'r1', 't-legacy', 2, 'p-carla', null, 'p-carla', 2, 0, 0, now)
}

describe('migration 0018: scoring, bye scoring and withdrawn participants (ADR 0031)', () => {
  it('is the generated ALTER TABLEs plus a backfill of the existing tournaments', () => {
    const entry = journal.find(item => item.idx === SCORING_MIGRATION)!
    expect(entry.tag).toBe('0018_tournament_scoring_withdrawn')
    const sql = statements(entry).map(statement => statement.split('\n').filter(line => !line.startsWith('--')).join('\n').trim())
    expect(sql).toEqual([
      expect.stringMatching(/^ALTER TABLE `tournament` ADD `scoring`/),
      expect.stringMatching(/^ALTER TABLE `tournament` ADD `bye_scoring`/),
      expect.stringMatching(/^ALTER TABLE `tournament_participant` ADD `withdrawn`/),
      'UPDATE `tournament` SET `scoring` = \'match\', `bye_scoring` = \'win\';',
    ])
  })

  it('backfills existing tournaments with match scoring and a bye worth a win, and leaves participants unwithdrawn', () => {
    const sqlite = databaseBeforeScoring()
    seedLegacyTournament(sqlite)

    applyMigrations(sqlite, entry => entry.idx === SCORING_MIGRATION)

    expect(sqlite.prepare('SELECT scoring, bye_scoring AS byeScoring FROM tournament').all())
      .toEqual([{ scoring: 'match', byeScoring: 'win' }])
    expect(sqlite.prepare('SELECT DISTINCT withdrawn FROM tournament_participant').all()).toEqual([{ withdrawn: 0 }])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it('gives tournaments created afterwards the new defaults', () => {
    const sqlite = databaseBeforeScoring()
    seedLegacyTournament(sqlite)
    applyMigrations(sqlite, entry => entry.idx === SCORING_MIGRATION)

    const now = Date.now()
    sqlite.prepare('INSERT INTO tournament (id, organizer_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('t-new', 'user-a', 'Neues Turnier', now, now)

    expect(sqlite.prepare('SELECT scoring, bye_scoring AS byeScoring FROM tournament WHERE id = ?').get('t-new'))
      .toEqual({ scoring: 'games', byeScoring: 'none' })
  })

  it('keeps a legacy tournament\'s standings exactly as they were: 3/0 points and a bye counted as a win', () => {
    const sqlite = databaseBeforeScoring()
    seedLegacyTournament(sqlite)
    applyMigrations(sqlite, entry => entry.idx === SCORING_MIGRATION)

    const detail = getTournamentDetail(drizzle(sqlite, { schema }), 'user-a', 't-legacy')

    expect(detail).toMatchObject({ scoring: 'match', byeScoring: 'win' })
    const byName = Object.fromEntries(detail.standings.map(row => [
      detail.participants.find(p => p.id === row.participantId)!.name,
      row,
    ]))
    // A 2:1 win is 3 points (not 2), the loser 0 (not 1), the bye a 2:0 win.
    expect(byName.Alice).toMatchObject({ points: 3, wins: 1, matchesPlayed: 1 })
    expect(byName.Bob).toMatchObject({ points: 0, losses: 1 })
    expect(byName.Carla).toMatchObject({ points: 3, wins: 1, byes: 1, matchesPlayed: 1, gamesWon: 2 })
  })
})
