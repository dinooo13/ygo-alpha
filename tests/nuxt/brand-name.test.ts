import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guard of the product name (docs/adr/0018-product-name-ygo-alpha.md): the
// app is "YGO Alpha" (slug `ygo-alpha`). "Yu-Gi-Oh!" may only describe the
// game, so "yugioh" never shows up in shipped code, messages or config —
// except in the name of the external source `yugioh-card-history`.

const ROOT = process.cwd()
const DIRECTORIES = [
  { dir: 'app', extensions: ['.vue', '.ts'] },
  { dir: 'i18n/locales', extensions: ['.json'] },
  { dir: 'server', extensions: ['.ts'] },
  { dir: 'shared', extensions: ['.ts'] },
]
const FILES = ['nuxt.config.ts', 'pwa.config.ts', 'package.json']

const OLD_NAME = /yugioh(?!-card-history)/i

function listFiles(dir: string, extensions: string[]): string[] {
  const entries = readdirSync(resolve(ROOT, dir), { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && extensions.some(extension => entry.name.endsWith(extension)))
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)))
}

const scanned = [...DIRECTORIES.flatMap(({ dir, extensions }) => listFiles(dir, extensions)), ...FILES].sort()

describe('product name', () => {
  it('scans the app, the server, the messages and the config', () => {
    expect(scanned).toContain('app/components/layout/BrandMark.vue')
    expect(scanned).toContain('i18n/locales/de/app.json')
    expect(scanned).toContain('server/utils/assistant-model.ts')
    expect(scanned).toContain('pwa.config.ts')
  })

  it('never calls the app "yugioh"', () => {
    const hits = scanned.flatMap((file) => {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      return source.split('\n').flatMap((line, index) =>
        OLD_NAME.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])
    })

    expect(hits).toEqual([])
  })
})
