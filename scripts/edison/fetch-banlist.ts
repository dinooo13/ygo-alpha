// Edison, the banlist: fetches the TCG Forbidden & Limited List of March 2010
// (the list SJC Edison, 2010-04-24, was played on) from the Format Library
// and writes it as server/utils/edison-banlist.json.
//
//   node scripts/edison/fetch-banlist.ts [--db path/to/app.db]
//
// The Format Library names a card by the passcode of one of its artworks
// (`card.artworkId`). The catalog keys a card by its main passcode, so with a
// catalog database (--db, default ./data/app.db) an artwork passcode is
// resolved like `resolvePasscode` does (server/utils/card-passcode.ts). Without
// one the ids are written as they are and the script says so.
//
// Sources: https://formatlibrary.com/formats/edison and
// https://edisonformat.net/rules/banlist. See docs/adr/0029-edison-format.md.

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'

const BANLIST_URL = 'https://formatlibrary.com/api/banlists/march-2010?category=TCG'
const here = dirname(fileURLToPath(import.meta.url))
const outputPath = join(here, '../../server/utils/edison-banlist.json')

const { values: args } = parseArgs({
  options: { db: { type: 'string', default: process.env.DB_FILE_PATH ?? './data/app.db' } },
})

interface BanlistEntry {
  cardName: string
  restriction: string
  card: { artworkId: string }
}

interface BanlistResponse {
  forbidden: BanlistEntry[]
  limited: BanlistEntry[]
  semiLimited: BanlistEntry[]
}

const response = await fetch(BANLIST_URL)
if (!response.ok) {
  throw new Error(`${BANLIST_URL} answered ${response.status}`)
}
const banlist = await response.json() as BanlistResponse

const catalog = existsSync(args.db!) ? new Database(args.db!, { readonly: true }) : null
if (!catalog) {
  console.warn(`No catalog database at ${args.db}: the ids stay the Format Library's artwork passcodes.`)
}

function cardId(entry: BanlistEntry): number {
  const passcode = Number(entry.card.artworkId)
  if (!Number.isInteger(passcode)) {
    throw new Error(`${entry.cardName}: artworkId ${entry.card.artworkId} is not a passcode`)
  }
  if (!catalog) {
    return passcode
  }

  const card = catalog.prepare('select id from catalog_card where id = ?').get(passcode) as { id: number } | undefined
  if (card) {
    return card.id
  }
  const artwork = catalog.prepare('select card_id as id from catalog_card_image where id = ?').get(passcode) as { id: number } | undefined
  if (artwork) {
    return artwork.id
  }
  console.warn(`${entry.cardName} (${passcode}) is not in the catalog; kept as is.`)
  return passcode
}

function ids(entries: BanlistEntry[], restriction: string): number[] {
  const wrong = entries.filter(entry => entry.restriction !== restriction)
  if (wrong.length > 0) {
    throw new Error(`Expected only "${restriction}" entries, got ${wrong.map(entry => `${entry.cardName} (${entry.restriction})`).join(', ')}`)
  }
  return [...new Set(entries.map(cardId))].sort((a, b) => a - b)
}

const result = {
  forbidden: ids(banlist.forbidden, 'forbidden'),
  limited: ids(banlist.limited, 'limited'),
  semiLimited: ids(banlist.semiLimited, 'semi-limited'),
}

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(`Edison banlist: ${result.forbidden.length} forbidden, ${result.limited.length} limited, ${result.semiLimited.length} semi-limited -> ${outputPath}`)
