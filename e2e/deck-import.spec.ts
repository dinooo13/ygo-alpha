import { expect, test } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'
import { CARD } from './helpers/cards'
import { decodeYdke } from '../shared/decklist'

// Passcodes from the seeded E2E catalog fixture
// (server/db/fixtures/catalog-fixture.ts).
const DARK_MAGICIAN = 46986414
const KURIBOH = 40640057
const RAIGEKI = 12580477
const STARDUST_DRAGON = 44508094
const MONSTER_REBORN = 83764719

// Omega's "Recipe": headers, then one "3 Name" line per card.
const RECIPE = `Monster
3 Dark Magician
1 Kuriboh
Spell
2 Raigeki
Extra
1 Stardust Dragon
Side
2 Monster Reborn`

test.describe('deck import and export', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  test('imports a recipe with headers, then exports the deck as a ydke link', async ({ page }) => {
    await registerAndLogin(page)

    await page.goto('/decks')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Deck importieren' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Deckliste').fill(RECIPE)
    await page.screenshot({ path: '/tmp/pr-a-import-input.png' })
    await dialog.getByRole('button', { name: 'Deckliste prüfen' }).click()

    // Five card lines, no row for a header, grouped by section.
    await expect(dialog.getByText('Erkannt: Textliste')).toBeVisible()
    await expect(dialog.getByText('5 gesamt')).toBeVisible()
    await expect(dialog.getByText('5 sicher')).toBeVisible()
    await expect(dialog.getByText('Kein Treffer')).toHaveCount(0)
    await expect(dialog.locator('[data-section="main"]').getByText('6 Karten')).toBeVisible()
    await expect(dialog.locator('[data-section="extra"]').getByText('1 Karte', { exact: true })).toBeVisible()
    await expect(dialog.locator('[data-section="side"]').getByText('2 Karten')).toBeVisible()
    await expect(dialog.locator('[data-section="main"]').getByText(CARD.darkMagician, { exact: true })).toBeVisible()
    await expect(dialog.locator('[data-section="extra"]').getByText(CARD.stardustDragon, { exact: true })).toBeVisible()
    await expect(dialog.locator('[data-section="side"]').getByText(CARD.monsterReborn, { exact: true })).toBeVisible()

    // Sizes outside the usual limits warn, but don't block.
    await expect(dialog.getByText('Das Deck weicht von den üblichen Größen ab')).toBeVisible()

    await dialog.getByLabel('Deckname').fill('Importiert')
    await page.screenshot({ path: '/tmp/pr-a-import-review.png' })
    await dialog.getByRole('button', { name: 'Deck anlegen' }).click()

    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { name: 'Importiert' })).toBeVisible()
    await waitForHydration(page)
    await expect(page.getByLabel('Anzahl im Main Deck')).toHaveText('6/40–60')
    await expect(page.getByLabel('Anzahl im Extra Deck')).toHaveText('1/15')
    await expect(page.getByLabel('Anzahl im Side Deck')).toHaveText('2/15')

    // --- Export ------------------------------------------------------------
    await page.getByRole('button', { name: 'Exportieren' }).click()
    await page.screenshot({ path: '/tmp/pr-a-export-menu.png' })
    await page.getByRole('menuitem', { name: 'ydke://-Link kopieren' }).click()
    await expect(page.getByText('ydke://-Link kopiert').first()).toBeVisible()

    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toMatch(/^ydke:\/\//)
    const sections = decodeYdke(link)!
    expect([...sections.main].sort()).toEqual([DARK_MAGICIAN, DARK_MAGICIAN, DARK_MAGICIAN, KURIBOH, RAIGEKI, RAIGEKI].sort())
    expect(sections.extra).toEqual([STARDUST_DRAGON])
    expect(sections.side).toEqual([MONSTER_REBORN, MONSTER_REBORN])

    // The recipe uses the English names, like Omega's own.
    await page.getByRole('button', { name: 'Exportieren' }).click()
    await page.getByRole('menuitem', { name: 'Kartenliste kopieren (Text)' }).click()
    await expect(page.getByText('Kartenliste kopiert').first()).toBeVisible()
    const recipe = await page.evaluate(() => navigator.clipboard.readText())
    expect(recipe).toBe([
      'Monster', '3 Dark Magician', '1 Kuriboh',
      'Spell', '2 Raigeki',
      'Extra', '1 Stardust Dragon',
      'Side', '2 Monster Reborn',
    ].join('\n'))

    // The Omega deck code reads back through the import.
    await page.getByRole('button', { name: 'Exportieren' }).click()
    await page.getByRole('menuitem', { name: 'Omega-Deckcode kopieren' }).click()
    await expect(page.getByText('Omega-Deckcode kopiert').first()).toBeVisible()
    const omega = await page.evaluate(() => navigator.clipboard.readText())
    const preview = await page.request.post('/api/decks/import/preview', { data: { text: omega } })
    expect(preview.ok()).toBe(true)
    expect((await preview.json()).format).toBe('omega')

    // The YDK file.
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Exportieren' }).click()
    await page.getByRole('menuitem', { name: 'YDK-Datei herunterladen' }).click()
    const file = await download
    expect(file.suggestedFilename()).toBe('importiert.ydk')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile((await file.path())!, 'utf8')).toBe([
      '#created by ygo-alpha',
      '#main',
      DARK_MAGICIAN, DARK_MAGICIAN, DARK_MAGICIAN, KURIBOH, RAIGEKI, RAIGEKI,
      '#extra',
      STARDUST_DRAGON,
      '!side',
      MONSTER_REBORN, MONSTER_REBORN,
      '',
    ].join('\n'))
  })

  test('imports a .ydk file, and an open line has to be removed before the deck is created', async ({ page }) => {
    await registerAndLogin(page)

    await page.goto('/decks')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Deck importieren' }).click()

    const dialog = page.getByRole('dialog')
    // 99999999 is no card in the catalog.
    await dialog.getByTestId('deck-import-file').setInputFiles({
      name: 'meine-drachen.ydk',
      mimeType: 'text/plain',
      buffer: Buffer.from(`#created by someone\n#main\n${DARK_MAGICIAN}\n${DARK_MAGICIAN}\n99999999\n#extra\n${STARDUST_DRAGON}\n!side\n`),
    })
    await expect(dialog.getByLabel('Deckliste')).toHaveValue(/#main/)
    await dialog.getByRole('button', { name: 'Deckliste prüfen' }).click()

    await expect(dialog.getByText('Erkannt: YDK')).toBeVisible()
    await expect(dialog.getByLabel('Deckname')).toHaveValue('meine-drachen')
    await expect(dialog.getByText('1 ohne Treffer')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Deck anlegen' })).toBeDisabled()
    await expect(dialog.getByText('Einige Zeilen sind noch offen')).toBeVisible()

    await dialog.getByRole('button', { name: '99999999 entfernen' }).click()
    await expect(dialog.getByText('0 ohne Treffer')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Deck anlegen' })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Deck anlegen' }).click()

    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/)
    await waitForHydration(page)
    await expect(page.getByLabel('Anzahl im Main Deck')).toHaveText('2/40–60')
    await expect(page.getByLabel('Anzahl im Extra Deck')).toHaveText('1/15')
  })

  test('quick capture skips header lines instead of looking them up as cards', async ({ page }) => {
    await registerAndLogin(page)
    await page.goto('/inventory/quick-entry')
    await waitForHydration(page)

    await page.getByLabel('Kartenliste').fill('Monster\n2x Dark Magician\nZauber\nExtra Deck\n#main\n!side')
    await page.getByRole('button', { name: 'Karten erkennen' }).click()

    // Only the card: before, every header became a row ("Monster" matched Monster-Ei).
    await expect(page.getByText('1 gesamt')).toBeVisible()
    await expect(page.getByText('1 sicher')).toBeVisible()
    await expect(page.getByText('0 unsicher')).toBeVisible()
    await expect(page.getByText('0 ohne Treffer')).toBeVisible()
    await expect(page.getByRole('spinbutton', { name: 'Anzahl für 2x Dark Magician' })).toHaveValue('2')
  })
})
