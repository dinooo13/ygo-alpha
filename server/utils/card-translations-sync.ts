// Sync of German card names and texts (ADR 0015).
//
// Source: the ygoresources card-history repo, one JSON file per card per
// language (`de/<konamiId>.json`), keyed by Konami id and joined to the
// catalog through `catalog_card.konami_id` (filled by the YGOPRODeck sync).
// One GitHub API request tells whether `main` moved since the last successful
// run; only then is the tarball for that commit downloaded (codeload, not
// counted against the API rate limit) and streamed, reading only `de/`.
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { foldCardName } from '../../shared/card-name-fold'
import type { AppLocale } from '../../shared/locale'
import type { useDb } from '../db'
import { catalogCard, catalogCardTranslation, catalogSync, type CardTranslationSource } from '../db/schema'
import { chunkRows } from './catalog-sync'
import { readTarGzEntries } from './tar-gz-reader'
import { CARD_TRANSLATION_REPO, CARD_TRANSLATION_REPO_URL } from '../../shared/card-text'

type Db = ReturnType<typeof useDb>

export const TRANSLATION_REPO = CARD_TRANSLATION_REPO
export const TRANSLATION_REPO_URL = CARD_TRANSLATION_REPO_URL
export const TRANSLATION_SOURCE: CardTranslationSource = 'ygoresources-git'

/** Folder in the repo per locale. English comes from YGOPRODeck. */
export const TRANSLATION_DIRS: Partial<Record<AppLocale, string>> = { de: 'de' }

/** Below this many valid files per locale, the archive is treated as broken. */
export const DEFAULT_MIN_TRANSLATION_FILES = 5000

const USER_AGENT = 'ygo-alpha catalog sync (https://github.com/dinooo13/ygo-alpha)'
const HEAD_SHA_TIMEOUT_MS = 15_000
const TARBALL_TIMEOUT_MS = 120_000
const CHUNK_SIZE = 500

/** Section labels of a German Pendulum card text, mirroring YGOPRODeck's English layout. */
const PENDULUM_EFFECT_LABEL = '[ Pendeleffekt ]'
const MONSTER_EFFECT_LABEL = '[ Monstereffekt ]'

export interface TranslationSyncDeps {
  /** The current commit SHA of the repo's `main` branch. */
  fetchHeadSha(): Promise<string>
  /** The gzipped tarball of the repo at `sha`, as a byte stream. */
  fetchTarball(sha: string): Promise<AsyncIterable<Uint8Array>>
}

export interface TranslationSyncOptions {
  /** Import even when the SHA equals the last successful run's. */
  force?: boolean
  deps?: TranslationSyncDeps
  minFiles?: number
}

export interface TranslationSyncResult {
  runId: number
  status: 'success' | 'skipped'
  /** The commit SHA the run looked at. */
  revision: string
  /** Files read from the translation folders (valid and invalid). */
  files: number
  /** Translation rows written (one per matching passcode). */
  rows: number
  /** Valid files whose Konami id matches no catalog card (OCG-only, tokens, …). */
  unmappedFiles: number
  /** Files that aren't valid card JSON; skipped. */
  invalidFiles: number
  /** Catalog cards without a Konami id; they can't get a translation. */
  cardsWithoutKonamiId: number
}

export const defaultTranslationSyncDeps: TranslationSyncDeps = {
  async fetchHeadSha() {
    const response = await fetch(`https://api.github.com/repos/${TRANSLATION_REPO}/commits/main`, {
      headers: { 'Accept': 'application/vnd.github.sha', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(HEAD_SHA_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status} for the translation repo's head commit`)
    }
    const sha = (await response.text()).trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('GitHub API returned an unexpected head commit SHA')
    }
    return sha
  },
  async fetchTarball(sha) {
    const response = await fetch(`https://codeload.github.com/${TRANSLATION_REPO}/tar.gz/${sha}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS),
    })
    if (!response.ok || !response.body) {
      throw new Error(`codeload responded ${response.status} for the translation tarball`)
    }
    return Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>)
  },
}

interface ParsedTranslation {
  name: string
  desc: string | null
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null
  }
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : undefined
}

/**
 * Validates and maps one `<locale>/<konamiId>.json` file; `null` when the
 * file isn't usable. A Pendulum card's text becomes
 * `[ Pendeleffekt ]\n…\n\n[ Monstereffekt ]\n…`, like YGOPRODeck's English.
 */
export function parseTranslationFile(data: Buffer | string): ParsedTranslation | null {
  let json: unknown
  try {
    json = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
  }
  catch {
    return null
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return null
  }
  const record = json as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.trim() === '') {
    return null
  }
  const effectText = optionalText(record.effectText)
  const pendEffect = optionalText(record.pendEffect)
  if (effectText === undefined || pendEffect === undefined) {
    return null
  }

  const desc = pendEffect
    ? `${PENDULUM_EFFECT_LABEL}\n${pendEffect}\n\n${MONSTER_EFFECT_LABEL}\n${effectText ?? ''}`
    : effectText
  return { name: record.name.trim(), desc }
}

function translationPathPattern(): { pattern: RegExp, localeByDir: Map<string, AppLocale> } {
  const localeByDir = new Map<string, AppLocale>()
  for (const [locale, dir] of Object.entries(TRANSLATION_DIRS) as [AppLocale, string][]) {
    localeByDir.set(dir, locale)
  }
  // "<repo>-<ref>/<dir>/<konamiId>.json"
  return { pattern: /^[^/]+\/([^/]+)\/(\d+)\.json$/, localeByDir }
}

// Active cards only: retired rows (ADR 0019) left YGOPRODeck before it sent
// Konami ids and would inflate the count for good.
function countCardsWithoutKonamiId(db: Db): number {
  const [row] = db
    .select({ count: sql<number>`count(*)` })
    .from(catalogCard)
    .where(and(isNull(catalogCard.konamiId), isNull(catalogCard.retiredAt)))
    .all()
  return row?.count ?? 0
}

/**
 * A `synced_at` strictly after every existing row of this source. The column
 * has second precision, so two runs within one second would otherwise share
 * a timestamp and the stale-row cleanup couldn't tell them apart.
 */
function nextSyncedAt(db: Db): Date {
  const [row] = db
    .select({ latest: sql<number | null>`max(${catalogCardTranslation.syncedAt})` })
    .from(catalogCardTranslation)
    .where(eq(catalogCardTranslation.source, TRANSLATION_SOURCE))
    .all()
  const nowSeconds = Math.floor(Date.now() / 1000)
  return new Date(Math.max(nowSeconds, (row?.latest ?? 0) + 1) * 1000)
}

/**
 * Imports German card names and texts from the ygoresources repo into
 * `catalog_card_translation`, logging the run in `catalog_sync` (source
 * `ygoresources-git`, revision = commit SHA).
 *
 * - Skips (status `skipped`, no download) when `main` still points at the
 *   commit of the last successful run, unless `force` is set.
 * - Needs `catalog_card.konami_id`, so fails until `catalog:sync` has run.
 * - Nothing is written unless the archive was read completely and has at
 *   least `minFiles` valid files per locale; existing translations survive
 *   any failure before the write phase.
 * - Rows for files that disappeared are deleted after the upsert.
 */
export async function syncCardTranslations(
  db: Db,
  options: TranslationSyncOptions = {},
): Promise<TranslationSyncResult> {
  const deps = options.deps ?? defaultTranslationSyncDeps
  const minFiles = options.minFiles ?? DEFAULT_MIN_TRANSLATION_FILES

  const [run] = db
    .insert(catalogSync)
    .values({ startedAt: new Date(), status: 'running', source: TRANSLATION_SOURCE })
    .returning()
    .all()
  if (!run) {
    throw new Error('Failed to create catalog_sync run row')
  }

  try {
    const sha = await deps.fetchHeadSha()

    if (!options.force) {
      const [lastSuccess] = db
        .select({ revision: catalogSync.revision })
        .from(catalogSync)
        .where(and(eq(catalogSync.source, TRANSLATION_SOURCE), eq(catalogSync.status, 'success')))
        .orderBy(desc(catalogSync.id))
        .limit(1)
        .all()
      if (lastSuccess?.revision === sha) {
        db.update(catalogSync)
          .set({ status: 'skipped', revision: sha, finishedAt: new Date() })
          .where(eq(catalogSync.id, run.id))
          .run()
        return {
          runId: run.id,
          status: 'skipped',
          revision: sha,
          files: 0,
          rows: 0,
          unmappedFiles: 0,
          invalidFiles: 0,
          cardsWithoutKonamiId: countCardsWithoutKonamiId(db),
        }
      }
    }

    const konamiToCards = new Map<number, number[]>()
    for (const card of db
      .select({ id: catalogCard.id, konamiId: catalogCard.konamiId })
      .from(catalogCard)
      .where(isNotNull(catalogCard.konamiId))
      .all()) {
      const ids = konamiToCards.get(card.konamiId!)
      if (ids) {
        ids.push(card.id)
      }
      else {
        konamiToCards.set(card.konamiId!, [card.id])
      }
    }
    if (konamiToCards.size === 0) {
      throw new Error('catalog has no konami ids; run catalog:sync first')
    }

    // Read the archive completely before writing anything.
    const { pattern, localeByDir } = translationPathPattern()
    const parsed: { locale: AppLocale, konamiId: number, translation: ParsedTranslation }[] = []
    const validFilesByLocale = new Map<AppLocale, number>()
    let files = 0
    let invalidFiles = 0
    const tarball = await deps.fetchTarball(sha)
    const accept = (path: string) => {
      const match = pattern.exec(path)
      return match !== null && localeByDir.has(match[1]!)
    }
    for await (const entry of readTarGzEntries(tarball, accept)) {
      const match = pattern.exec(entry.path)!
      const locale = localeByDir.get(match[1]!)!
      files += 1
      const translation = parseTranslationFile(entry.data)
      if (!translation) {
        invalidFiles += 1
        continue
      }
      validFilesByLocale.set(locale, (validFilesByLocale.get(locale) ?? 0) + 1)
      parsed.push({ locale, konamiId: Number(match[2]), translation })
    }

    const locales = Object.keys(TRANSLATION_DIRS) as AppLocale[]
    for (const locale of locales) {
      const count = validFilesByLocale.get(locale) ?? 0
      if (count < minFiles) {
        throw new Error(`archive looks incomplete: ${count} valid ${locale} files, expected at least ${minFiles}`)
      }
    }

    const syncedAt = nextSyncedAt(db)
    const rows: (typeof catalogCardTranslation.$inferInsert)[] = []
    let unmappedFiles = 0
    for (const { locale, konamiId, translation } of parsed) {
      const cardIds = konamiToCards.get(konamiId)
      if (!cardIds) {
        unmappedFiles += 1
        continue
      }
      for (const cardId of cardIds) {
        rows.push({
          cardId,
          locale,
          name: translation.name,
          nameSearch: foldCardName(translation.name),
          desc: translation.desc,
          source: TRANSLATION_SOURCE,
          syncedAt,
        })
      }
    }

    for (const batch of chunkRows(rows, CHUNK_SIZE)) {
      db.transaction((tx) => {
        for (const row of batch) {
          tx.insert(catalogCardTranslation)
            .values(row)
            .onConflictDoUpdate({
              target: [catalogCardTranslation.cardId, catalogCardTranslation.locale],
              set: {
                name: row.name,
                nameSearch: row.nameSearch,
                desc: row.desc,
                source: row.source,
                syncedAt: row.syncedAt,
              },
            })
            .run()
        }
      })
    }

    // Files that disappeared upstream (or cards that lost their Konami id).
    db.delete(catalogCardTranslation)
      .where(and(
        inArray(catalogCardTranslation.locale, locales),
        eq(catalogCardTranslation.source, TRANSLATION_SOURCE),
        lt(catalogCardTranslation.syncedAt, syncedAt),
      ))
      .run()

    db.update(catalogSync)
      .set({ status: 'success', cardCount: rows.length, revision: sha, finishedAt: new Date() })
      .where(eq(catalogSync.id, run.id))
      .run()

    return {
      runId: run.id,
      status: 'success',
      revision: sha,
      files,
      rows: rows.length,
      unmappedFiles,
      invalidFiles,
      cardsWithoutKonamiId: countCardsWithoutKonamiId(db),
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.update(catalogSync)
      .set({ status: 'error', error: message, finishedAt: new Date() })
      .where(eq(catalogSync.id, run.id))
      .run()
    throw error
  }
}
