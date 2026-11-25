import { expect, test } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'
import { CARD } from './helpers/cards'

test.describe('Schnellerfassung', () => {
  test('turns a pasted list into reviewed inventory entries', async ({ page }) => {
    await registerAndLogin(page)

    await page.goto('/inventory')
    await waitForHydration(page)
    await page.getByRole('link', { name: 'Schnellerfassung' }).click()
    await expect(page).toHaveURL('/inventory/quick-entry')

    // "SDY-006" is a Dark Magician printing in the seeded catalog fixture.
    await page.getByLabel('Kartenliste').fill('2x Dark Magician\nPot of Greed\nSDY-006')
    await page.getByRole('button', { name: 'Karten erkennen' }).click()

    await expect(page.getByText('3 gesamt')).toBeVisible()
    await expect(page.getByText('3 sicher')).toBeVisible()
    await expect(page.getByText('0 unsicher')).toBeVisible()
    await expect(page.getByText('0 ohne Treffer')).toBeVisible()
    await expect(page.getByText('Kein Treffer')).toHaveCount(0)

    // The quantity is a stepper (#148); a line stands for at least one copy.
    await expect(page.getByRole('button', { name: 'Eine Kopie weniger für Pot of Greed' })).toBeDisabled()
    await page.getByRole('button', { name: 'Eine Kopie mehr für Pot of Greed' }).click()
    await expect(page.getByRole('spinbutton', { name: 'Anzahl für Pot of Greed' })).toHaveValue('2')
    await expect(page.getByRole('spinbutton', { name: 'Anzahl für 2x Dark Magician' })).toHaveValue('2')

    const saveAll = page.getByRole('button', { name: 'Alle speichern' })
    await expect(saveAll).toBeEnabled()
    await saveAll.click()

    // The toast title is also announced in an aria-live region, so match the first occurrence.
    await expect(page.getByText('Karten gespeichert').first()).toBeVisible()
    await expect(page.getByText('Noch nichts zu prüfen')).toBeVisible()

    await page.goto('/inventory')
    await waitForHydration(page)
    // "SDY-006" has one rarity for Dark Magician, so quick entry kept that
    // printing (ADR 0034): its copy is a stack of its own next to the two
    // copies without a printing.
    await expect(page.getByRole('button', { name: CARD.darkMagician, exact: true })).toHaveCount(2)
    await expect(page.getByTestId('row-printing')).toHaveText('Printing: SDY-006 (UR)')
    await page.getByRole('button', { name: 'Galerie' }).click()

    // 2 + 1 copies of Dark Magician on one tile, the printing listed.
    await expect(page.getByText(CARD.darkMagician).first()).toBeVisible()
    await expect(page.getByText('×3 ges.')).toBeVisible()
    await expect(page.getByTestId('tile-printings')).toHaveText('Printings: SDY-006 (UR) ×1')
    await expect(page.getByText(CARD.potOfGreed).first()).toBeVisible()
  })

  test('asks for the rarity when a set code comes in several (ADR 0034)', async ({ page }) => {
    await registerAndLogin(page)
    await page.goto('/inventory/quick-entry')
    await waitForHydration(page)

    // LC01-EN004 is Blue-Eyes White Dragon in two rarities in the fixture.
    await page.getByLabel('Kartenliste').fill('LC01-EN004')
    await page.getByRole('button', { name: 'Karten erkennen' }).click()

    await expect(page.getByText('1 sicher')).toBeVisible()
    await expect(page.getByText('LC01-EN004 gibt es in 2 Seltenheiten. Bitte wähle deine aus.')).toBeVisible()
    // The rarities YGOPRODeck lists for LC01-EN004 first; any other one via
    // "Andere Seltenheit…".
    await page.getByRole('button', { name: 'Printing für LC01-EN004' }).click()
    await expect(page.getByRole('option', { name: 'Andere Seltenheit…' })).toBeVisible()
    await page.getByRole('option', { name: 'Quarter Century Secret Rare (QCScR)' }).click()
    await expect(page.getByText('Seltenheiten')).toHaveCount(0)

    await page.getByRole('button', { name: 'Alle speichern' }).click()
    await expect(page.getByText('Karten gespeichert').first()).toBeVisible()

    await page.goto('/inventory')
    await waitForHydration(page)
    await expect(page.getByTestId('row-printing')).toHaveText('Printing: LC01-EN004 (QCScR)')
  })

  test('recognizes German card names (ADR 0015)', async ({ page }) => {
    await registerAndLogin(page)
    await page.goto('/inventory/quick-entry')
    await waitForHydration(page)

    await page.getByLabel('Kartenliste').fill('2x Dunkler Magier\nTopf der Gier')
    await page.getByRole('button', { name: 'Karten erkennen' }).click()

    await expect(page.getByText('2 gesamt')).toBeVisible()
    await expect(page.getByText('2 sicher')).toBeVisible()
    await expect(page.getByText('0 ohne Treffer')).toBeVisible()
    // The matched cards, shown with their German names (card language, F3c).
    await expect(page.getByText(CARD.darkMagician).first()).toBeVisible()
    await expect(page.getByText(CARD.potOfGreed).first()).toBeVisible()
  })

  // Photo/voice input moved to the chat assistant (see e2e/assistant-chat.spec.ts,
  // added alongside docs in the following stage) — /inventory/quick-entry now only
  // links there instead of offering its own Foto/Sprache modes.
  test('points to the assistant for photo input', async ({ page }) => {
    await registerAndLogin(page)
    await page.goto('/inventory/quick-entry')

    await expect(page.getByText('Karten per Foto? Nutze den Assistenten')).toBeVisible()
    await page.getByRole('link', { name: 'Zum Assistenten' }).click()
    await expect(page).toHaveURL(/\/assistant/)
  })
})
