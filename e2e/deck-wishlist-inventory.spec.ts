import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'
import { CARD } from './helpers/cards'

// #178: the deck editor puts a deck's cards on the wishlist and into the
// inventory (row "…" menu, card overlay footer), and the deck's "…" menu puts
// every missing card on the wishlist at once.
const DARK_MAGICIAN = 46986414
const STARDUST_DRAGON = 44508094
const KURIBOH = 40640057

interface WishlistItem { catalogCardId: number, quantity: number, note: string | null }

async function seedInventory(page: Page, cards: Array<[number, number]>) {
  for (const [catalogCardId, quantity] of cards) {
    const response = await page.request.post('/api/inventory', { data: { catalog_card_id: catalogCardId, quantity } })
    expect(response.ok()).toBe(true)
  }
}

async function createDeck(page: Page, name: string, cards: Array<{ catalog_card_id: number, section: string, quantity: number }>): Promise<string> {
  const response = await page.request.post('/api/decks', { data: { name, cards } })
  expect(response.ok()).toBe(true)
  return (await response.json() as { id: string }).id
}

async function wishlistItems(page: Page): Promise<WishlistItem[]> {
  const response = await page.request.get('/api/wishlist')
  expect(response.ok()).toBe(true)
  return (await response.json() as { items: WishlistItem[] }).items
}

async function wishlistIds(page: Page): Promise<number[]> {
  const response = await page.request.get('/api/wishlist/ids')
  expect(response.ok()).toBe(true)
  return (await response.json() as { ids: number[] }).ids
}

function deckRow(page: Page, name: string, section: string) {
  return page.locator('main li').filter({ has: page.getByRole('spinbutton', { name: `Anzahl von ${name} im ${section}` }) })
}

async function rowAction(page: Page, name: string, section: string, action: string) {
  await deckRow(page, name, section).getByRole('button', { name: `Optionen für ${name}` }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

// "Karte hinzufügen" with the quantity it opened with; saves and waits for the deck to reload.
async function saveAddDialog(page: Page, expectedQuantity: string) {
  const dialog = page.getByRole('dialog', { name: 'Karte hinzufügen' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('spinbutton', { name: 'Anzahl' })).toHaveValue(expectedQuantity)
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/inventory'))
  await dialog.getByRole('button', { name: 'Hinzufügen', exact: true }).click()
  expect((await saved).ok()).toBe(true)
  await expect(dialog).toBeHidden()
}

/** 3 Dunkler Magier in Main (2 owned), 1 Sternenstaubdrache in Extra, 1 Kuriboh in Side (none owned). */
async function seedShortDeck(page: Page): Promise<string> {
  await seedInventory(page, [[DARK_MAGICIAN, 2]])
  return createDeck(page, 'Wunsch-Deck', [
    { catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 3 },
    { catalog_card_id: STARDUST_DRAGON, section: 'extra', quantity: 1 },
    { catalog_card_id: KURIBOH, section: 'side', quantity: 1 },
  ])
}

test.describe('deck editor: wishlist and inventory per card', () => {
  test('row menus and the card overlay add to the inventory and the wishlist', async ({ page }) => {
    await registerAndLogin(page)
    const deckId = await seedShortDeck(page)

    await page.goto(`/decks/${deckId}`)
    await waitForHydration(page)

    // --- Main row: "Zum Inventar" with the shortfall (1) ---------------------
    const mainRow = deckRow(page, CARD.darkMagician, 'Main Deck')
    await expect(mainRow.getByTitle('Du besitzt nur 2')).toHaveText('3/2')
    await rowAction(page, CARD.darkMagician, 'Main Deck', 'Zum Inventar')
    await saveAddDialog(page, '1')
    await expect(mainRow.getByTitle('Du besitzt nur 2')).toHaveCount(0)
    await expect(mainRow.getByText('3/3', { exact: true })).toBeVisible()

    // --- Extra row: "Zur Wunschliste" ---------------------------------------
    const extraRow = deckRow(page, CARD.stardustDragon, 'Extra Deck')
    await expect(extraRow.getByText('Auf der Wunschliste')).toHaveCount(0)
    await rowAction(page, CARD.stardustDragon, 'Extra Deck', 'Zur Wunschliste')
    await expect(extraRow.getByText('Auf der Wunschliste')).toBeVisible()
    await expect(page.getByText(`${CARD.stardustDragon} auf die Wunschliste gesetzt (1 Exemplar)`).first()).toBeVisible()
    expect(await wishlistItems(page)).toEqual([expect.objectContaining({ catalogCardId: STARDUST_DRAGON, quantity: 1 })])

    await extraRow.getByRole('button', { name: `Optionen für ${CARD.stardustDragon}` }).click()
    await expect(page.getByRole('menuitem', { name: 'Von der Wunschliste entfernen' })).toBeVisible()
    await page.keyboard.press('Escape')

    await page.reload()
    await waitForHydration(page)
    await expect(extraRow.getByText('Auf der Wunschliste')).toBeVisible()

    // --- Side row, through the overlay --------------------------------------
    const sideRow = deckRow(page, CARD.kuriboh, 'Side Deck')
    await expect(sideRow.getByTitle('Du besitzt nur 0')).toHaveText('1/0')
    await sideRow.getByRole('button', { name: CARD.kuriboh, exact: true }).click()
    const overlay = page.getByRole('dialog', { name: CARD.kuriboh })
    await expect(overlay.getByText('Besitz: 0 · im Deck: 1')).toBeVisible()

    await overlay.getByRole('button', { name: 'Zur Wunschliste' }).click()
    await expect(overlay.getByRole('button', { name: 'Auf der Wunschliste' })).toBeVisible()

    // "Zum Inventar" stacks on top of the overlay.
    await overlay.getByRole('button', { name: 'Zum Inventar' }).click()
    await saveAddDialog(page, '1')
    await expect(overlay).toBeVisible()
    await expect(overlay.getByText('Besitz: 1 · im Deck: 1')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(overlay).toBeHidden()
    // Checked once the overlay is closed: behind it, the rows are hidden from roles.
    await expect(sideRow.getByText('1/1', { exact: true })).toBeVisible()
    await expect(sideRow.getByText('Auf der Wunschliste')).toBeVisible()

    // The wishlist entry stays after the inventory add.
    expect((await wishlistIds(page)).sort()).toEqual([KURIBOH, STARDUST_DRAGON].sort())

    // --- Off and on again: never a duplicate --------------------------------
    await rowAction(page, CARD.kuriboh, 'Side Deck', 'Von der Wunschliste entfernen')
    await expect(sideRow.getByText('Auf der Wunschliste')).toHaveCount(0)
    await expect.poll(() => wishlistIds(page)).toEqual([STARDUST_DRAGON])
    await rowAction(page, CARD.kuriboh, 'Side Deck', 'Zur Wunschliste')
    await expect(sideRow.getByText('Auf der Wunschliste')).toBeVisible()
    const ids = await wishlistIds(page)
    expect(ids.filter(id => id === KURIBOH)).toHaveLength(1)
  })
})

test.describe('deck editor: missing cards to the wishlist', () => {
  test('adds the missing cards with their shortfall and keeps an existing entry', async ({ page }) => {
    await registerAndLogin(page)
    await seedInventory(page, [[DARK_MAGICIAN, 1]])
    const deckId = await createDeck(page, 'Fehlende Karten', [
      { catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 3 },
      { catalog_card_id: STARDUST_DRAGON, section: 'extra', quantity: 1 },
    ])
    // Already wished, with its own quantity and note.
    const wished = await page.request.post('/api/wishlist', { data: { catalogCardId: STARDUST_DRAGON, quantity: 4, note: 'Nur in Ultra Rare' } })
    expect(wished.ok()).toBe(true)

    await page.goto(`/decks/${deckId}`)
    await waitForHydration(page)
    await expect(deckRow(page, CARD.darkMagician, 'Main Deck').getByText('Auf der Wunschliste')).toHaveCount(0)
    await expect(deckRow(page, CARD.stardustDragon, 'Extra Deck').getByText('Auf der Wunschliste')).toBeVisible()

    await page.getByRole('button', { name: 'Weitere Aktionen' }).click()
    await page.getByRole('menuitem', { name: 'Fehlende Karten auf die Wunschliste' }).click()

    const dialog = page.getByRole('dialog', { name: 'Fehlende Karten auf die Wunschliste' })
    const list = dialog.getByRole('list', { name: 'Fehlende Karten' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('listitem').filter({ hasText: CARD.darkMagician })).toContainText('2 fehlen')
    const stardust = list.getByRole('listitem').filter({ hasText: CARD.stardustDragon })
    await expect(stardust).toContainText('schon auf der Wunschliste')
    await expect(stardust).toContainText('1 fehlt')

    await dialog.getByRole('button', { name: '1 Karte auf die Wunschliste' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('1 Karte auf die Wunschliste gesetzt').first()).toBeVisible()

    // The rows follow without a reload.
    await expect(deckRow(page, CARD.darkMagician, 'Main Deck').getByText('Auf der Wunschliste')).toBeVisible()

    const items = await wishlistItems(page)
    expect(items).toHaveLength(2)
    expect(items.find(item => item.catalogCardId === DARK_MAGICIAN)).toMatchObject({ quantity: 2, note: null })
    expect(items.find(item => item.catalogCardId === STARDUST_DRAGON)).toMatchObject({ quantity: 4, note: 'Nur in Ultra Rare' })

    // Now everything missing is wished: the dialog says so and offers no confirm.
    await page.getByRole('button', { name: 'Weitere Aktionen' }).click()
    await page.getByRole('menuitem', { name: 'Fehlende Karten auf die Wunschliste' }).click()
    await expect(dialog.getByText('Alle fehlenden Karten sind schon auf der Wunschliste.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /auf die Wunschliste/ })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Schließen' }).last().click()
    await expect(dialog).toBeHidden()
  })
})

test.describe('deck editor wishlist and inventory on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('both row menu actions work without horizontal scrolling', async ({ page }) => {
    await registerAndLogin(page)
    const deckId = await seedShortDeck(page)

    await page.goto(`/decks/${deckId}`)
    await waitForHydration(page)

    const mainRow = deckRow(page, CARD.darkMagician, 'Main Deck')
    await rowAction(page, CARD.darkMagician, 'Main Deck', 'Zur Wunschliste')
    await expect(mainRow.getByText('Auf der Wunschliste')).toBeVisible()
    expect(await wishlistItems(page)).toEqual([expect.objectContaining({ catalogCardId: DARK_MAGICIAN, quantity: 1 })])

    await rowAction(page, CARD.darkMagician, 'Main Deck', 'Zum Inventar')
    await saveAddDialog(page, '1')
    await expect(mainRow.getByText('3/3', { exact: true })).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
