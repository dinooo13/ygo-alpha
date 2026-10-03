import { expect, test } from '@playwright/test'
import type { APIResponse, Page } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'
import { CARD } from './helpers/cards'

// Passcodes from the seeded E2E catalog fixture
// (server/db/fixtures/catalog-fixture.ts).
const DARK_MAGICIAN = 46986414
const POT_OF_GREED = 55144522
const MIRROR_FORCE = 44095762
const STARDUST_DRAGON = 44508094

interface OwnedRow { id: string, catalogCardId: number, collectionId: string | null, quantity: number }

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok()).toBe(true)
  return await response.json() as T
}

async function createCollection(page: Page, name: string): Promise<string> {
  return (await json<{ id: string }>(await page.request.post('/api/collections', { data: { name } }))).id
}

async function own(page: Page, catalogCardId: number, quantity: number, collectionId: string | null = null) {
  expect((await page.request.post('/api/inventory', {
    data: { catalog_card_id: catalogCardId, quantity, collection_id: collectionId },
  })).ok()).toBe(true)
}

/** Every owned row of the user, one per (card, collection). */
async function ownedRows(page: Page): Promise<OwnedRow[]> {
  return (await json<{ items: OwnedRow[] }>(await page.request.get('/api/inventory?pageSize=100'))).items
}

function quantityIn(rows: OwnedRow[], catalogCardId: number, collectionId: string | null): number {
  return rows
    .filter(row => row.catalogCardId === catalogCardId && row.collectionId === collectionId)
    .reduce((sum, row) => sum + row.quantity, 0)
}

async function pickOption(page: Page, comboboxName: string | RegExp, option: string | RegExp) {
  await page.getByRole('combobox', { name: comboboxName }).click()
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
}

test.describe('collections built from the inventory', () => {
  test('quick capture: the copies just saved move to another collection without typing the list in again', async ({ page }) => {
    await registerAndLogin(page)
    const boxA = await createCollection(page, 'Box A')
    const boxB = await createCollection(page, 'Box B')

    await page.goto(`/inventory/quick-entry?collectionId=${boxA}`)
    await waitForHydration(page)
    await page.getByLabel('Kartenliste').fill('2x Dark Magician\nPot of Greed')
    await page.getByRole('button', { name: 'Karten erkennen' }).click()
    await expect(page.getByText('2 sicher')).toBeVisible()
    await page.getByRole('button', { name: 'Alle speichern' }).click()

    // The review table is empty; what was written stays in the panel.
    const panel = page.getByTestId('just-saved')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('heading', { name: 'Gerade gespeichert' })).toBeVisible()
    await expect(panel).toContainText('3 Kopien sind jetzt im Inventar')
    await expect(panel).toContainText(CARD.darkMagician)
    await expect(panel).toContainText('×2')
    const saved = panel.getByRole('list', { name: 'Gerade gespeicherte Karten' })
    await expect(saved.getByText('Box A')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'Prüfen und korrigieren' })).toHaveCount(0)

    await pickOption(page, 'Ziel-Sammlung', 'Box B')
    await panel.getByRole('button', { name: 'In andere Sammlung verschieben' }).click()

    await expect(page.getByText('3 Kopien nach „Box B“ verschoben').first()).toBeVisible()
    await expect(saved.getByText('Box B')).toHaveCount(2)
    await expect(saved.getByText('Box A')).toHaveCount(0)

    // Moved, not copied: Box A is empty again and the total did not change.
    const rows = await ownedRows(page)
    expect(quantityIn(rows, DARK_MAGICIAN, boxB)).toBe(2)
    expect(quantityIn(rows, POT_OF_GREED, boxB)).toBe(1)
    expect(rows.some(row => row.collectionId === boxA)).toBe(false)
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(3)

    // Saving again from the same page does not bring the old rows back.
    await panel.getByRole('button', { name: 'Schließen' }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.getByText('Noch nichts zu prüfen')).toBeVisible()
  })

  test('inventory: moves part of a stack, and a selection of stacks into a new collection', async ({ page }) => {
    await registerAndLogin(page)
    const boxA = await createCollection(page, 'Box A')
    await own(page, DARK_MAGICIAN, 3)
    await own(page, POT_OF_GREED, 1)

    await page.goto('/inventory')
    await waitForHydration(page)

    // --- Part of a stack: 2 of 3 Dark Magicians -> Box A --------------------
    await page.getByRole('button', { name: `${CARD.darkMagician} verschieben` }).click()
    const dialog = page.getByRole('dialog', { name: 'Karten verschieben' })
    await expect(dialog).toContainText('3 Kopien in (keine Sammlung)')
    await expect(dialog.getByRole('spinbutton', { name: 'Anzahl' })).toHaveValue('3')
    await dialog.getByRole('button', { name: 'Eine Kopie weniger verschieben' }).click()
    await expect(dialog.getByRole('spinbutton', { name: 'Anzahl' })).toHaveValue('2')
    await pickOption(page, 'Ziel-Sammlung', 'Box A')
    await dialog.getByRole('button', { name: 'Verschieben', exact: true }).click()

    await expect(page.getByText('2 Kopien nach „Box A“ verschoben').first()).toBeVisible()
    await expect(dialog).toHaveCount(0)
    // The stack was split: one copy stays, two are in Box A (a row per stack).
    const rows = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: CARD.darkMagician, exact: true }) })
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: '×1' })).toContainText('(keine Sammlung)')
    await expect(rows.filter({ hasText: '×2' })).toContainText('Box A')
    let owned = await ownedRows(page)
    expect(quantityIn(owned, DARK_MAGICIAN, null)).toBe(1)
    expect(quantityIn(owned, DARK_MAGICIAN, boxA)).toBe(2)

    // --- A selection of whole stacks into a collection created on the way ----
    await page.getByRole('button', { name: 'Auswählen', exact: true }).click()
    const looseRow = (name: string) => page.getByRole('listitem').filter({ hasText: name }).filter({ hasText: '(keine Sammlung)' })
    await looseRow(CARD.potOfGreed).getByRole('checkbox').click()
    await looseRow(CARD.darkMagician).getByRole('checkbox').click()
    await expect(page.getByText('2 Einträge ausgewählt')).toBeVisible()
    await page.getByRole('button', { name: 'In Sammlung verschieben' }).click()

    const selectionDialog = page.getByRole('dialog', { name: 'Karten verschieben' })
    await expect(selectionDialog).toContainText('2 Einträge, 2 Kopien')
    await pickOption(page, 'Ziel-Sammlung', 'Neue Sammlung…')
    await page.getByRole('dialog', { name: 'Neue Sammlung' }).getByLabel('Name', { exact: true }).fill('Box C')
    await page.getByRole('dialog', { name: 'Neue Sammlung' }).getByRole('button', { name: 'Erstellen' }).click()
    await expect(selectionDialog.getByRole('combobox', { name: 'Ziel-Sammlung' })).toContainText('Box C')
    await selectionDialog.getByRole('button', { name: 'Verschieben', exact: true }).click()

    await expect(page.getByText('2 Kopien nach „Box C“ verschoben').first()).toBeVisible()
    owned = await ownedRows(page)
    const boxC = (await json<{ items: Array<{ id: string, name: string }> }>(await page.request.get('/api/collections'))).items.find(item => item.name === 'Box C')!.id
    expect(quantityIn(owned, POT_OF_GREED, boxC)).toBe(1)
    // Only the stacks that were ticked moved: Box A keeps its two Dark Magicians.
    expect(quantityIn(owned, DARK_MAGICIAN, boxC)).toBe(1)
    expect(quantityIn(owned, DARK_MAGICIAN, boxA)).toBe(2)
    expect(owned.reduce((sum, row) => sum + row.quantity, 0)).toBe(4)
  })

  test('deck builder: the source is restricted to one collection, with that collection\'s counts', async ({ page }) => {
    await registerAndLogin(page)
    const boxA = await createCollection(page, 'Box A')
    await own(page, DARK_MAGICIAN, 2, boxA)
    await own(page, DARK_MAGICIAN, 1)
    await own(page, POT_OF_GREED, 1)
    const deck = await json<{ id: string }>(await page.request.post('/api/decks', { data: { name: 'Quellen-Deck' } }))

    await page.goto(`/decks/${deck.id}`)
    await waitForHydration(page)

    const panel = page.locator('#deck-add-panel')
    const row = (name: string) => panel.getByRole('listitem').filter({ hasText: name })
    await expect(panel.getByRole('combobox', { name: 'Quelle' })).toContainText('Alle Sammlungen')
    await expect(row(CARD.darkMagician)).toContainText('Besitz: 3')
    await expect(row(CARD.potOfGreed)).toBeVisible()

    // One collection: only its cards, with only its copies.
    await pickOption(page, 'Quelle', 'Box A')
    await expect(row(CARD.darkMagician)).toContainText('In Box A: 2')
    await expect(row(CARD.potOfGreed)).toHaveCount(0)

    // "Ohne Sammlung": the loose copies.
    await pickOption(page, 'Quelle', 'Ohne Sammlung')
    await expect(row(CARD.darkMagician)).toContainText('In Ohne Sammlung: 1')
    await expect(row(CARD.potOfGreed)).toContainText('In Ohne Sammlung: 1')

    // Adding still works from a collection, and the deck's own count stays the whole inventory's.
    await pickOption(page, 'Quelle', 'Box A')
    await page.getByRole('button', { name: `${CARD.darkMagician} zum Main Deck hinzufügen`, exact: true }).click()
    await expect(page.getByLabel('Anzahl im Main Deck')).toHaveText('1/40–60')
    await expect(row(CARD.darkMagician)).toContainText('In Box A: 2 · im Deck: 1')

    // Back to everything.
    await pickOption(page, 'Quelle', 'Alle Sammlungen')
    await expect(row(CARD.darkMagician)).toContainText('Besitz: 3 · im Deck: 1')
  })

  test('"Kartenart" filters by frame in the catalog and the inventory; the exact type stays finer', async ({ page }) => {
    await registerAndLogin(page)
    await own(page, POT_OF_GREED, 1)
    await own(page, DARK_MAGICIAN, 1)
    await own(page, STARDUST_DRAGON, 1)

    // "Effekt" is every monster with an effect frame, an Effect Veiler (a Tuner
    // Monster) included; the exact type "Effektmonster" is only Effect Monsters.
    await page.goto('/catalog?kind=effect')
    await waitForHydration(page)
    await expect(page.getByText(CARD.kuriboh).first()).toBeVisible()
    await expect(page.getByText(CARD.effectVeiler).first()).toBeVisible()
    await expect(page.getByText(CARD.darkMagician)).toHaveCount(0)
    await expect(page.getByText(CARD.potOfGreed)).toHaveCount(0)

    await page.goto('/catalog?type=Effect+Monster')
    await waitForHydration(page)
    await expect(page.getByText(CARD.kuriboh).first()).toBeVisible()
    await expect(page.getByText(CARD.effectVeiler)).toHaveCount(0)

    // Picked in the menu, next to the exact "Typ".
    await page.goto('/catalog')
    await waitForHydration(page)
    await pickKind(page, 'Zauber')
    await expect(page).toHaveURL(/kind=spell/)
    await expect(page.getByText(CARD.potOfGreed).first()).toBeVisible()
    await expect(page.getByText(CARD.darkMagician)).toHaveCount(0)

    // The inventory has the same filter, in the URL as ?kind=.
    await page.goto('/inventory?kind=synchro')
    await waitForHydration(page)
    await expect(page.getByRole('button', { name: CARD.stardustDragon, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: CARD.darkMagician, exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Kartenart' })).toContainText('Synchro')
  })

  test('collection from a deck: preview, move, shortfall and wishlist', async ({ page }) => {
    await registerAndLogin(page)
    const target = await createCollection(page, 'Deck-Box')
    const other = await createCollection(page, 'Altes Binder')
    await own(page, DARK_MAGICIAN, 3)
    await own(page, POT_OF_GREED, 1, other)
    await own(page, MIRROR_FORCE, 1)
    const deck = await json<{ id: string }>(await page.request.post('/api/decks', {
      data: {
        name: 'Befüll-Deck',
        cards: [
          { catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 2 },
          { catalog_card_id: DARK_MAGICIAN, section: 'side', quantity: 1 },
          { catalog_card_id: POT_OF_GREED, section: 'main', quantity: 1 },
          { catalog_card_id: MIRROR_FORCE, section: 'main', quantity: 3 },
          { catalog_card_id: STARDUST_DRAGON, section: 'extra', quantity: 1 },
        ],
      },
    }))

    await page.goto(`/inventory?collectionId=${target}`)
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Optionen für Deck-Box' }).click()
    await page.getByRole('menuitem', { name: 'Aus Deck befüllen …' }).click()

    const dialog = page.getByRole('dialog', { name: 'Sammlung aus Deck befüllen' })
    await pickOption(page, 'Deck', 'Befüll-Deck')
    // Preview: nothing is moved yet.
    await expect(dialog.getByTestId('fill-preview')).toContainText('5 zu verschieben')
    await expect(dialog.getByTestId('fill-preview')).toContainText('3 fehlen')
    await expect(dialog.getByTestId('fill-shortfall')).toContainText(CARD.mirrorForce)
    await expect(dialog.getByTestId('fill-shortfall')).toContainText('2 fehlen')
    await expect(dialog.getByTestId('fill-shortfall')).toContainText(CARD.stardustDragon)
    expect(quantityIn(await ownedRows(page), DARK_MAGICIAN, target)).toBe(0)

    // "Altes Binder" can be left out as a source.
    await dialog.getByRole('checkbox', { name: 'Altes Binder' }).click()
    await expect(dialog.getByTestId('fill-preview')).toContainText('4 zu verschieben')
    await dialog.getByRole('checkbox', { name: 'Altes Binder' }).click()
    await expect(dialog.getByTestId('fill-preview')).toContainText('5 zu verschieben')

    await dialog.getByRole('button', { name: 'Sammlung befüllen' }).click()
    await expect(dialog).toContainText('5 Karten nach „Deck-Box“ verschoben.')
    let rows = await ownedRows(page)
    expect(quantityIn(rows, DARK_MAGICIAN, target)).toBe(3)
    expect(quantityIn(rows, POT_OF_GREED, target)).toBe(1)
    expect(quantityIn(rows, MIRROR_FORCE, target)).toBe(1)
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(5)

    // The shortfall: Mirror Force x2 and Stardust Dragon are not owned at all.
    await dialog.getByRole('button', { name: '2 Karten auf die Wunschliste' }).click()
    await expect(dialog.getByRole('button', { name: 'Auf der Wunschliste' })).toBeDisabled()
    const wishlist = await json<{ items: Array<{ catalogCardId: number, quantity: number }> }>(await page.request.get('/api/wishlist'))
    expect(wishlist.items.map(item => [item.catalogCardId, item.quantity]).sort()).toEqual([[MIRROR_FORCE, 2], [STARDUST_DRAGON, 1]].sort())

    await dialog.locator('button', { hasText: 'Schließen' }).click()
    // The list behind the dialog follows: the collection now holds the deck's cards.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deck-Box')
    await expect(page.getByRole('button', { name: CARD.darkMagician, exact: true })).toBeVisible()

    // The same dialog from the deck list, with the deck given.
    await page.goto('/decks')
    await waitForHydration(page)
    await page.getByRole('button', { name: 'Optionen für Befüll-Deck' }).click()
    await page.getByRole('menuitem', { name: 'Sammlung befüllen …' }).click()
    const fromList = page.getByRole('dialog', { name: 'Sammlung aus Deck befüllen' })
    await expect(fromList.getByRole('combobox', { name: 'Deck' })).toHaveCount(0)
    await pickOption(page, 'Ziel-Sammlung', 'Deck-Box')
    // Everything is in the collection already: nothing left to move.
    await expect(fromList).toContainText('Aus den gewählten Quellen gibt es nichts zu verschieben.')
    await expect(fromList.getByRole('button', { name: 'Sammlung befüllen' })).toBeDisabled()
    rows = await ownedRows(page)
    expect(deck.id).toBeTruthy()
    expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(5)
  })
})

async function pickKind(page: Page, option: string) {
  // The facet menus are multi-select menus: a button with options.
  await page.getByRole('button', { name: 'Kartenart' }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  // A multi-select menu stays open; close it so it doesn't cover the results.
  await page.keyboard.press('Escape')
}
