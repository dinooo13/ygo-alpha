import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { registerAndLogin, uniqueEmail, waitForHydration } from './helpers/auth'
import { acceptConfirm, cancelConfirm } from './helpers/confirm'

// Passcodes from the seeded E2E catalog fixture
// (server/db/fixtures/catalog-fixture.ts).
const DARK_MAGICIAN = 46986414
const KURIBOH = 40640057
const POT_OF_GREED = 55144522
const MIRROR_FORCE = 44095762
const STARDUST_DRAGON = 44508094 // extra deck

/**
 * A match row (`data-testid="match-row"`). Scoping to it lets the same
 * "2:0" / "Tisch N" labels be reused unambiguously across every round.
 */
function matchRow(page: import('@playwright/test').Page, tableNumber: number) {
  return page.getByTestId('match-row').filter({ hasText: `Tisch ${tableNumber}` })
}

/**
 * The participants table row for a given name. Standings render a row per
 * participant too (with zero stats before any round is played), so a plain
 * `getByRole('row').filter({ hasText })` matches both tables once standings
 * are non-empty. The participants table is the first `<table>` on the page
 * (ParticipantsPanel renders before StandingsTable), so scoping to it keeps
 * the lookup unambiguous.
 */
function participantRow(page: import('@playwright/test').Page, name: string) {
  return page.locator('table').first().getByRole('row').filter({ hasText: name })
}

test.describe('tournaments', () => {
  test('runs a Swiss tournament from creation to finish', async ({ page }) => {
    const organizer = await registerAndLogin(page)

    // Seed a deck through the API with the page's session cookie (same
    // trick as e2e/decks.spec.ts). It is deliberately too small (13 cards)
    // to be legal against a standard 40-card-minimum format.
    const deckResponse = await page.request.post('/api/decks', {
      data: {
        name: 'Turnierdeck',
        cards: [
          { catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 3 },
          { catalog_card_id: KURIBOH, section: 'main', quantity: 3 },
          { catalog_card_id: POT_OF_GREED, section: 'main', quantity: 3 },
          { catalog_card_id: MIRROR_FORCE, section: 'main', quantity: 3 },
          { catalog_card_id: STARDUST_DRAGON, section: 'extra', quantity: 1 },
        ],
      },
    })
    expect(deckResponse.ok()).toBe(true)

    // --- Empty state, create the tournament ---------------------------------
    await page.goto('/tournaments')
    await waitForHydration(page)
    await expect(page.getByText('Noch keine Turniere')).toBeVisible()

    // "Neues Turnier" is a `<UButton to="...">`, rendered as a link, not a button.
    await page.getByRole('link', { name: 'Neues Turnier' }).first().click()
    await expect(page).toHaveURL('/tournaments/new')

    await page.getByLabel('Turniername').fill('Freitagsturnier')
    await page.getByLabel('Format').click()
    await page.getByRole('option', { name: 'Ohne Banliste' }).click()
    await page.getByLabel('Paarungssystem').click()
    await page.getByRole('option', { name: 'Schweizer System' }).click()
    // "Geplante Runden" stays empty — resolved from the participant count at
    // start. "Ich spiele selbst mit" stays checked (default).

    await page.getByRole('button', { name: 'Turnier anlegen' }).click()

    await expect(page).toHaveURL(/\/tournaments\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { name: 'Freitagsturnier' })).toBeVisible()
    await expect(page.getByText('Anmeldung')).toBeVisible()

    // --- Add three guests ----------------------------------------------------
    await page.getByRole('button', { name: 'Als Gast' }).click()
    const guestNameField = page.getByLabel('Name')
    for (const name of ['Alice', 'Bob', 'Carla']) {
      // The field is only guaranteed empty (cleared by the previous
      // successful submit) once its own row is visible — wait for that
      // first, otherwise a fast `fill` can land before the clear and be
      // immediately overwritten, submitting an empty name.
      await expect(guestNameField).toHaveValue('')
      await guestNameField.fill(name)
      await page.getByRole('button', { name: 'Teilnehmer hinzufügen' }).click()
      await expect(participantRow(page, name)).toBeVisible()
    }
    await expect(page.getByRole('heading', { name: 'Teilnehmer (4)' })).toBeVisible()

    // --- Register the organizer's own deck -----------------------------------
    const organizerRow = participantRow(page, organizer.name)
    await organizerRow.getByRole('button', { name: 'Deck anmelden' }).click()

    // exact: true — otherwise this also matches the "Deck anmelden" dialog title.
    await page.getByLabel('Deck', { exact: true }).click()
    await page.getByRole('option', { name: 'Turnierdeck' }).click()
    await page.getByRole('button', { name: 'Anmelden' }).click()

    await expect(organizerRow.getByText('Turnierdeck')).toBeVisible()
    await expect(organizerRow.getByText('Nicht legal')).toBeVisible()

    // --- Start the tournament -------------------------------------------------
    await page.getByRole('button', { name: 'Turnier starten' }).click()
    await expect(page.getByText('Läuft')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Runde 1' })).toBeVisible()
    await expect(page.getByText('Tisch 1')).toBeVisible()
    await expect(page.getByText('Tisch 2')).toBeVisible()

    // Seeds are 1 organizer, 2 Alice, 3 Bob, 4 Carla — table 1 is organizer vs
    // Alice, table 2 is Bob vs Carla. The A side wins both, 2:0.
    await matchRow(page, 1).getByRole('button', { name: '2:0' }).click()
    await matchRow(page, 2).getByRole('button', { name: '2:0' }).click()

    await expect(page.getByRole('button', { name: 'Runde abschließen' })).toBeEnabled()
    await page.getByRole('button', { name: 'Runde abschließen' }).click()

    const round1Collapsed = page.getByRole('button').filter({ hasText: 'Runde 1' })
    await expect(round1Collapsed).toContainText('Abgeschlossen')

    // --- Round 2: organizer vs Bob (both on 3 points), Alice vs Carla (0) -------
    await page.getByRole('button', { name: 'Nächste Runde' }).click()
    await expect(page.getByRole('heading', { name: 'Runde 2' })).toBeVisible()

    const round2Table1 = matchRow(page, 1)
    await round2Table1.getByLabel(`Spiele ${organizer.name}`).fill('2')
    await round2Table1.getByLabel('Spiele Bob').fill('1')
    await round2Table1.getByRole('button', { name: 'Ergebnis speichern' }).click()

    await matchRow(page, 2).getByRole('button', { name: '1:2' }).click()

    await expect(page.getByRole('button', { name: 'Runde abschließen' })).toBeEnabled()
    await page.getByRole('button', { name: 'Runde abschließen' }).click()

    // --- Finish the tournament -------------------------------------------------
    await page.getByRole('button', { name: 'Turnier abschließen' }).click()
    await acceptConfirm(page)
    await expect(page.getByText('Dieses Turnier ist abgeschlossen und kann nicht mehr geändert werden.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Nächste Runde' })).toHaveCount(0)

    // --- Standings under games scoring: organizer (3 + 2 for the 2:1 win),
    // Bob (3 + 1 for a 1:2 loss), Carla (0 + 2 for a 2:1 win), Alice (0 + 1).
    await expect(page.getByRole('columnheader', { name: 'Platz' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Punkte' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'OMW%' })).toBeVisible()

    // The "Tabelle" heading now shares its row with the "Sieger: …" line
    // (#36), so it's no longer the table's direct parent — scope by the
    // enclosing <section> instead of a fixed number of `..` hops.
    const standingsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tabelle' }) })
    const standingsRows = standingsSection.locator('tbody tr')
    await expect(standingsRows).toHaveCount(4)

    // Columns are Platz, Spieler, Punkte, S-N, OMW%, GW%, OGW% — read the
    // name and points columns by index instead of matching the row's full
    // (unseparated) text, which concatenates "6" and "2-0" into "62-0".
    async function nameAndPoints(rowIndex: number) {
      const cells = standingsRows.nth(rowIndex).locator('td')
      return { name: await cells.nth(1).innerText(), points: (await cells.nth(2).innerText()).trim() }
    }

    expect(await nameAndPoints(0)).toEqual(expect.objectContaining({ points: '5' }))
    expect((await nameAndPoints(0)).name).toContain(organizer.name)
    expect(await nameAndPoints(1)).toEqual({ name: 'Bob', points: '4' })
    expect(await nameAndPoints(2)).toEqual({ name: 'Carla', points: '2' })
    expect(await nameAndPoints(3)).toEqual({ name: 'Alice', points: '1' })

    // --- History filter (#32: role and status are independent axes) ----------
    await page.goto('/tournaments')
    await waitForHydration(page)
    // Default view is "Meine Turniere" + "Aktiv" — the now-finished tournament
    // is not an active one, so it's not here.
    await expect(page.getByRole('heading', { name: 'Freitagsturnier' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Abgeschlossen' }).click()
    await expect(page.getByRole('heading', { name: 'Freitagsturnier' })).toBeVisible()

    // The organizer also played in their own tournament ("Ich spiele selbst
    // mit"), so it stays visible under "Teilnahmen" too, still filtered to
    // "Abgeschlossen" — this used to require excluding the organizer's own
    // participant row.
    await page.getByRole('button', { name: 'Teilnahmen' }).click()
    await expect(page.getByRole('heading', { name: 'Freitagsturnier' })).toBeVisible()

    // --- Delete -----------------------------------------------------------------
    await page.getByRole('link', { name: 'Freitagsturnier' }).click()
    await expect(page).toHaveURL(/\/tournaments\/[0-9a-f-]{36}$/)

    await page.getByRole('button', { name: 'Turnier löschen' }).click()
    await acceptConfirm(page)

    await expect(page).toHaveURL('/tournaments')
    await expect(page.getByText('Noch keine Turniere')).toBeVisible()
  })

  test('a linked participant sees and joins a tournament without organizer actions', async ({ page, browser }) => {
    // Register participant B first, in an isolated browser context, so their
    // account exists before the organizer adds them by e-mail.
    const bContext = await browser.newContext()
    const bPage = await bContext.newPage()
    const participant = await registerAndLogin(bPage, { email: uniqueEmail(), name: 'Teilnehmerin B' })

    // Seed B's own deck for later self-registration.
    const bDeckResponse = await bPage.request.post('/api/decks', {
      data: {
        name: 'B-Deck',
        cards: [
          { catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 3 },
          { catalog_card_id: KURIBOH, section: 'main', quantity: 3 },
        ],
      },
    })
    expect(bDeckResponse.ok()).toBe(true)

    // Organizer creates the tournament and adds B by e-mail.
    const organizer = await registerAndLogin(page)
    await page.goto('/tournaments/new')
    await waitForHydration(page)
    // The planned-rounds field is wide enough for its placeholder, on desktop
    // and on a phone (#96).
    const plannedRoundsFits = () => page.getByLabel('Geplante Runden').evaluate((input: HTMLInputElement) => {
      const style = getComputedStyle(input)
      const context = document.createElement('canvas').getContext('2d')!
      context.font = style.font
      const inner = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
      return context.measureText(input.placeholder).width <= inner - 20 // room for the number spinner
    })
    expect(await plannedRoundsFits()).toBe(true)
    const viewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await plannedRoundsFits()).toBe(true)
    await page.setViewportSize(viewport)
    await page.getByLabel('Turniername').fill('Einladungsturnier')
    await page.getByRole('button', { name: 'Turnier anlegen' }).click()
    await expect(page).toHaveURL(/\/tournaments\/[0-9a-f-]{36}$/)
    const tournamentUrl = page.url()

    await page.getByRole('button', { name: 'Per E-Mail' }).click()
    await page.getByLabel('E-Mail-Adresse').fill(participant.email)
    await page.getByRole('button', { name: 'Teilnehmer hinzufügen' }).click()
    await expect(participantRow(page, participant.name)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Teilnehmer (2)' })).toBeVisible()

    // B sees the tournament under "Teilnahmen" and can open it.
    await bPage.goto('/tournaments')
    await waitForHydration(bPage)
    await bPage.getByRole('button', { name: 'Teilnahmen' }).click()
    await expect(bPage.getByRole('heading', { name: 'Einladungsturnier' })).toBeVisible()

    await bPage.goto(tournamentUrl)
    await waitForHydration(bPage)
    await expect(bPage.getByRole('heading', { name: 'Einladungsturnier' })).toBeVisible()
    await expect(bPage.getByText('Du nimmst an diesem Turnier teil. Änderungen nimmt die Turnierleitung vor.')).toBeVisible()

    // B has no organizer-only actions and no add-participant form.
    await expect(bPage.getByRole('button', { name: 'Turnier starten' })).toHaveCount(0)
    await expect(bPage.getByRole('button', { name: 'Turnier löschen' })).toHaveCount(0)
    await expect(bPage.getByRole('button', { name: 'Teilnehmer hinzufügen' })).toHaveCount(0)

    // A linked participant without a registered deck sees a prominent
    // reminder before the tournament starts (#31).
    await expect(bPage.getByText('Melde dein Deck an, bevor das Turnier startet.')).toBeVisible()

    // B registers their own deck during registration.
    const bRow = participantRow(bPage, participant.name)
    await bRow.getByRole('button', { name: 'Deck anmelden' }).click()
    await bPage.getByLabel('Deck', { exact: true }).click()
    await bPage.getByRole('option', { name: 'B-Deck' }).click()
    await bPage.getByRole('button', { name: 'Anmelden' }).click()
    await expect(bRow.getByText('B-Deck')).toBeVisible()
    await expect(bPage.getByText('Melde dein Deck an, bevor das Turnier startet.')).toHaveCount(0)

    // B cannot register a deck for the organizer's row: no button on it.
    const organizerRowForB = participantRow(bPage, organizer.name)
    await expect(organizerRowForB.getByRole('button', { name: /Deck an/ })).toHaveCount(0)

    await bContext.close()
  })

  test('confirms before removing a participant and before finishing a tournament, and lets a cancelled confirm keep the previous state', async ({ page }) => {
    await registerAndLogin(page)

    await page.goto('/tournaments/new')
    await waitForHydration(page)
    await page.getByLabel('Turniername').fill('Bestätigungsturnier')
    await page.getByRole('button', { name: 'Turnier anlegen' }).click()
    await expect(page).toHaveURL(/\/tournaments\/[0-9a-f-]{36}$/)

    await page.getByRole('button', { name: 'Als Gast' }).click()
    const guestNameField = page.getByLabel('Name')
    await guestNameField.fill('Wegwerf Gast')
    await page.getByRole('button', { name: 'Teilnehmer hinzufügen' }).click()
    await expect(participantRow(page, 'Wegwerf Gast')).toBeVisible()

    // Cancelling "Entfernen" keeps the participant (#28).
    await page.getByRole('button', { name: 'Optionen für Wegwerf Gast' }).click()
    await page.getByRole('menuitem', { name: 'Entfernen' }).click()
    await cancelConfirm(page)
    await expect(participantRow(page, 'Wegwerf Gast')).toBeVisible()

    // Accepting it removes them.
    await page.getByRole('button', { name: 'Optionen für Wegwerf Gast' }).click()
    await page.getByRole('menuitem', { name: 'Entfernen' }).click()
    await acceptConfirm(page)
    await expect(participantRow(page, 'Wegwerf Gast')).toHaveCount(0)

    // Two participants and a completed round are needed to reach "Turnier
    // abschließen" — add one back and play it out.
    await expect(guestNameField).toHaveValue('')
    await guestNameField.fill('Mitspieler')
    await page.getByRole('button', { name: 'Teilnehmer hinzufügen' }).click()
    await expect(participantRow(page, 'Mitspieler')).toBeVisible()

    await page.getByRole('button', { name: 'Turnier starten' }).click()
    await expect(page.getByText('Läuft')).toBeVisible()

    await matchRow(page, 1).getByRole('button', { name: '2:0' }).click()
    await page.getByRole('button', { name: 'Runde abschließen' }).click()

    // Cancelling "Turnier abschließen" leaves it running (#27).
    await page.getByRole('button', { name: 'Turnier abschließen' }).click()
    await cancelConfirm(page)
    await expect(page.getByText('Läuft')).toBeVisible()

    // Accepting it finishes the tournament.
    await page.getByRole('button', { name: 'Turnier abschließen' }).click()
    await acceptConfirm(page)
    await expect(page.getByText('Dieses Turnier ist abgeschlossen und kann nicht mehr geändert werden.')).toBeVisible()

    // The winner is called out next to the standings (#36).
    await expect(page.getByText(/Sieger: /)).toBeVisible()
  })

  test('renders participants and standings as cards with 44px controls on a phone (#28)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await registerAndLogin(page)

    // The organizer plays by default, so one guest makes two players.
    const createResponse = await page.request.post('/api/tournaments', { data: { name: 'Handyturnier' } })
    expect(createResponse.ok()).toBe(true)
    const tournament = await createResponse.json() as { id: string }
    const guestResponse = await page.request.post(`/api/tournaments/${tournament.id}/participants`, { data: { name: 'Gast Anton' } })
    expect(guestResponse.ok()).toBe(true)

    /** Nothing may scroll sideways: neither the page nor the tables' scroll wrappers. */
    async function expectNoHorizontalOverflow(step: string) {
      const overflows = await page.evaluate(() => [
        document.documentElement,
        ...document.querySelectorAll<HTMLElement>('.overflow-x-auto'),
      ].map(element => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })))
      for (const { scrollWidth, clientWidth } of overflows) {
        expect(scrollWidth, `${step}: horizontal overflow`).toBeLessThanOrEqual(clientWidth)
      }
    }

    async function expectTouchTarget(locator: Locator, label: string, { width = true } = {}) {
      const box = await locator.boundingBox()
      expect(box, label).not.toBeNull()
      expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44)
      if (width) {
        expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44)
      }
    }

    // --- Registration: participant cards + "Konto" legend ---------------------
    await page.goto(`/tournaments/${tournament.id}`)
    await waitForHydration(page)

    await expect(participantRow(page, 'Gast Anton')).toBeVisible()
    // The column headers are dropped on phones — each card labels itself.
    await expect(page.getByRole('columnheader', { name: 'Deck', exact: true })).toBeHidden()
    await expect(page.getByText('Gäste ohne Konto verwaltet die Turnierleitung.')).toBeVisible()
    await expectNoHorizontalOverflow('registration')

    // --- Running: 44px row menu and result buttons ------------------------------
    const startResponse = await page.request.post(`/api/tournaments/${tournament.id}/start`)
    expect(startResponse.ok()).toBe(true)
    await page.reload()
    await waitForHydration(page)

    await expectTouchTarget(page.getByRole('button', { name: 'Optionen für Gast Anton' }), 'Optionen für Gast Anton')
    await expectTouchTarget(matchRow(page, 1).getByRole('button', { name: '2:0' }), '2:0', { width: false })
    await expectNoHorizontalOverflow('running')

    await matchRow(page, 1).getByRole('button', { name: '2:0' }).click()
    await expect(page.getByRole('button', { name: 'Runde abschließen' })).toBeEnabled()
    await page.getByRole('button', { name: 'Runde abschließen' }).click()

    // --- Standings card: record inline, abbreviations explained -----------------
    const standingsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tabelle' }) })
    await expect(standingsSection.locator('tbody tr').first()).toContainText('1-0')
    await expect(page.getByRole('columnheader', { name: 'Platz' })).toBeHidden()
    await expect(standingsSection.getByText('Siege–Niederlagen').first()).toBeVisible()
    await expectNoHorizontalOverflow('standings')
  })

  test('runs a round robin as a league: 2:1 results, a league table, a withdrawn player and the crosstable', async ({ page }) => {
    const organizer = await registerAndLogin(page)

    await page.goto('/tournaments/new')
    await waitForHydration(page)
    await page.getByLabel('Turniername').fill('Ligaturnier')
    await page.getByLabel('Paarungssystem').click()
    await page.getByRole('option', { name: 'Jeder gegen jeden' }).click()
    // New tournaments score by games and give a bye nothing (ADR 0028).
    await expect(page.getByLabel('Punktevergabe')).toContainText('Nach Spielen')
    await expect(page.getByLabel('Spielfrei (bei ungerader Spielerzahl)')).toContainText('Keine Punkte')
    await page.getByRole('button', { name: 'Turnier anlegen' }).click()
    await expect(page).toHaveURL(/\/tournaments\/[0-9a-f-]{36}$/)

    await expect(page.getByText('Wertung: Nach Spielen (3 · 2 · 1 · 0)')).toBeVisible()
    await expect(page.getByText('Spielfrei: Keine Punkte')).toBeVisible()
    // The organizer may still change the scoring while registering.
    await expect(page.getByText('Du kannst das ändern, solange das Turnier noch nicht gestartet ist.')).toBeVisible()

    await page.getByRole('button', { name: 'Als Gast' }).click()
    const guestNameField = page.getByLabel('Name')
    for (const name of ['Alice', 'Bob']) {
      await expect(guestNameField).toHaveValue('')
      await guestNameField.fill(name)
      await page.getByRole('button', { name: 'Teilnehmer hinzufügen' }).click()
      await expect(participantRow(page, name)).toBeVisible()
    }

    await page.getByRole('button', { name: 'Turnier starten' }).click()
    await expect(page.getByText('Läuft')).toBeVisible()
    // Once started the scoring is fixed, and the rounds are matchdays with fixed pairings.
    await expect(page.getByText('Du kannst das ändern, solange das Turnier noch nicht gestartet ist.')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Spieltag 1' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Paarungen tauschen' })).toHaveCount(0)

    // --- Matchday 1: Alice vs Bob, the organizer sits out (no points) --------------
    const quickResults = matchRow(page, 1).getByRole('button', { name: /^(Alice|Bob) gewinnt \d:\d$/ })
    await expect(quickResults).toHaveText(['2:0', '2:1', '1:2', '0:2'])
    await expect(matchRow(page, 2)).toContainText('Spielfrei')
    await expect(matchRow(page, 2)).toContainText('ohne Wertung')
    // Equal games are not a result: "Ergebnis speichern" stays off, and there is no draw button.
    await expect(matchRow(page, 1).getByRole('button', { name: 'Unentschieden' })).toHaveCount(0)
    await matchRow(page, 1).getByLabel('Spiele Alice').fill('1')
    await matchRow(page, 1).getByLabel('Spiele Bob').fill('1')
    await expect(matchRow(page, 1).getByRole('button', { name: 'Ergebnis speichern' })).toBeDisabled()

    await matchRow(page, 1).getByRole('button', { name: 'Alice gewinnt 2:1' }).click()
    await expect(matchRow(page, 1)).toContainText('2:1')
    await page.getByRole('button', { name: 'Spieltag abschließen' }).click()

    // --- League table: Pl., Name, Sp., S, N, Spiele, Diff., Pkt. -------------------
    const standingsSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Tabelle' }) })
    for (const header of ['Pl.', 'Name', 'Sp.', 'S', 'N', 'Spiele', 'Diff.', 'Pkt.']) {
      await expect(standingsSection.getByRole('columnheader', { name: header, exact: true })).toBeVisible()
    }
    await expect(standingsSection.getByRole('columnheader', { name: 'OMW%' })).toHaveCount(0)
    const leagueRows = standingsSection.getByTestId('standings-row')
    // A 2:1 win is 2 points, the loss 1; the organizer, sitting out, has nothing.
    await expect(leagueRows.nth(0)).toContainText('Alice')
    await expect(leagueRows.nth(0).locator('td')).toHaveText(['1', 'Alice', '1', '1', '0', '2:1', '+1', '2'])
    await expect(leagueRows.nth(1).locator('td')).toHaveText(['2', 'Bob', '1', '0', '1', '1:2', '-1', '1'])
    await expect(leagueRows.nth(2).locator('td')).toHaveText(['3', organizer.name, '0', '0', '0', '0:0', '0', '0'])

    // --- Matchday 2: organizer vs Bob, Alice sits out ---------------------------------
    await page.getByRole('button', { name: 'Nächster Spieltag' }).click()
    await expect(page.getByRole('heading', { name: 'Spieltag 2' })).toBeVisible()
    await matchRow(page, 1).getByRole('button', { name: `${organizer.name} gewinnt 2:0` }).click()
    await page.getByRole('button', { name: 'Spieltag abschließen' }).click()

    // --- Matchday 3: organizer vs Alice; Alice is taken out of the standings ----------
    await page.getByRole('button', { name: 'Nächster Spieltag' }).click()
    await expect(page.getByRole('heading', { name: 'Spieltag 3' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Spieltag abschließen' })).toBeDisabled()

    await page.getByRole('button', { name: 'Optionen für Alice' }).click()
    await page.getByRole('menuitem', { name: 'Aus der Wertung nehmen' }).click()
    await acceptConfirm(page)

    // Her match needs no result any more, and her results count for nobody.
    await expect(page.getByRole('button', { name: 'Spieltag abschließen' })).toBeEnabled()
    await expect(matchRow(page, 1)).toContainText('Spielfrei')
    await expect(matchRow(page, 1).getByRole('button', { name: /gewinnt/ })).toHaveCount(0)
    await expect(leagueRows).toHaveCount(3)
    await expect(leagueRows.nth(2)).toContainText('Alice')
    await expect(leagueRows.nth(2)).toContainText('Aus der Wertung genommen')
    await expect(leagueRows.nth(2).locator('td').first()).toHaveText('–')
    await expect(leagueRows.nth(0).locator('td')).toHaveText(['1', organizer.name, '1', '1', '0', '2:0', '+2', '3'])
    await expect(leagueRows.nth(1).locator('td')).toHaveText(['2', 'Bob', '1', '0', '1', '0:2', '-2', '0'])

    // It is reversible while the tournament runs: her match is a real one again.
    await page.getByRole('button', { name: 'Optionen für Alice' }).click()
    await page.getByRole('menuitem', { name: 'Wieder in die Wertung nehmen' }).click()
    await expect(page.getByRole('button', { name: 'Spieltag abschließen' })).toBeDisabled()
    await expect(matchRow(page, 1).getByRole('button', { name: `${organizer.name} gewinnt 2:0` })).toBeVisible()

    // Take her out again and finish.
    await page.getByRole('button', { name: 'Optionen für Alice' }).click()
    await page.getByRole('menuitem', { name: 'Aus der Wertung nehmen' }).click()
    await acceptConfirm(page)
    await page.getByRole('button', { name: 'Spieltag abschließen' }).click()
    await page.getByRole('button', { name: 'Turnier abschließen' }).click()
    await acceptConfirm(page)
    await expect(page.getByText(`Sieger: ${organizer.name}`)).toBeVisible()

    // --- Crosstable: only players who are still in the standings --------------------
    await standingsSection.getByRole('button', { name: 'Kreuztabelle' }).click()
    const crosstable = standingsSection.getByRole('table', { name: 'Kreuztabelle der Ergebnisse' })
    await expect(crosstable.locator('tbody tr')).toHaveCount(2)
    await expect(crosstable.locator('tbody tr').nth(0).locator('td')).toHaveText(['·', '2:0'])
    await expect(crosstable.locator('tbody tr').nth(1).locator('td')).toHaveText(['0:2', '·'])
    await standingsSection.getByRole('button', { name: 'Tabelle', exact: true }).click()
    await expect(leagueRows).toHaveCount(3)
  })
})
