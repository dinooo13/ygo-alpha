import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'
import { CARD } from './helpers/cards'

// Automated WCAG 2.1 A/AA checks (color contrast included) on the key pages,
// in both color modes (docs/adr/0016-visual-design-system.md). Complements
// e2e/a11y.spec.ts (skip link, 44px targets), which axe can't judge.

// Passcode from the seeded E2E catalog fixture (server/db/fixtures/catalog-fixture.ts).
const DARK_MAGICIAN = 46986414

const COLOR_MODES = ['dark', 'light'] as const

async function useColorMode(page: Page, mode: typeof COLOR_MODES[number]) {
  const baseURL = test.info().project.use.baseURL!
  await page.context().addCookies([{ name: 'ygo-color-mode', value: mode, url: baseURL }])
  // Mid-transition colors would make the contrast check flaky.
  await page.emulateMedia({ reducedMotion: 'reduce' })
}

/**
 * Waits until no animation is running. Opening a dialog over another can
 * cancel the lower one's animation, whose `finished` then rejects; a
 * cancelled animation is over too, and the loop picks up any that started
 * meanwhile.
 */
async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    for (let round = 0; round < 10; round++) {
      const running = document.getAnimations().filter(animation => animation.playState === 'running')
      if (running.length === 0) return
      await Promise.allSettled(running.map(animation => animation.finished))
    }
  })
}

/** Runs axe on the page as it is now; `label` names it in the violations. */
async function axeCurrent(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  return results.violations.map(violation =>
    `${label}: ${violation.id} (${violation.impact}) — ${violation.nodes.slice(0, 3).map(node => node.target.join(' ')).join(' | ')}`)
}

async function axeViolations(page: Page, path: string): Promise<string[]> {
  await page.goto(path)
  await waitForHydration(page)
  // Not a hydration wait: lets client-loaded content settle before axe runs, e.g. the card
  // overlay `/catalog?card=` opens after hydration and is still fading in (#99).
  // eslint-disable-next-line no-restricted-syntax -- settle wait, see comment above
  await page.waitForLoadState('networkidle')
  return axeCurrent(page, path)
}

test.describe('axe: no WCAG A/AA violations', () => {
  for (const mode of COLOR_MODES) {
    test(`on the key pages in ${mode} mode`, async ({ page }) => {
      test.setTimeout(120_000)
      await useColorMode(page, mode)

      const violations: string[] = []
      violations.push(...await axeViolations(page, '/login'))

      await registerAndLogin(page)
      const profile = await (await page.request.get('/api/profile')).json() as { handle: string }

      const inventoryResponse = await page.request.post('/api/inventory', {
        data: { catalog_card_id: DARK_MAGICIAN, quantity: 3 },
      })
      expect(inventoryResponse.ok()).toBe(true)
      const deckResponse = await page.request.post('/api/decks', {
        data: { name: 'Axe Deck', cards: [{ catalog_card_id: DARK_MAGICIAN, section: 'main', quantity: 3 }] },
      })
      expect(deckResponse.ok()).toBe(true)
      const deck = await deckResponse.json() as { id: string }
      const tournamentResponse = await page.request.post('/api/tournaments', { data: { name: 'Axe Turnier' } })
      expect(tournamentResponse.ok()).toBe(true)
      const tournament = await tournamentResponse.json() as { id: string }

      for (const path of [
        '/',
        '/inventory',
        '/inventory?view=gallery',
        '/catalog',
        `/catalog?card=${DARK_MAGICIAN}`,
        '/decks',
        `/decks/${deck.id}`,
        '/assistant',
        `/tournaments/${tournament.id}`,
        `/players/${profile.handle}`,
      ]) {
        violations.push(...await axeViolations(page, path))
      }

      // The card detail overlay in the inventory (#88) with its editor
      // (#135), from a gallery tile and from a list row; the catalog one is
      // `/catalog?card=` above.
      for (const [path, label] of [['/inventory?view=gallery', 'gallery'], ['/inventory', 'list']] as const) {
        await page.goto(path)
        await waitForHydration(page)
        await page.getByRole('button', { name: CARD.darkMagician, exact: true }).click()
        const overlay = page.getByRole('dialog', { name: CARD.darkMagician })
        await expect(overlay.getByRole('heading', { name: 'Im Inventar' })).toBeVisible()
        await expect(overlay.getByRole('spinbutton', { name: 'Anzahl in (keine Sammlung)' })).toBeVisible()
        // Not a hydration wait: lets the overlay's image/data requests settle before axe runs (#99).
        // eslint-disable-next-line no-restricted-syntax -- settle wait, see comment above
        await page.waitForLoadState('networkidle')
        // The open animation (fade/scale) runs even under reduced motion;
        // mid-way its colors would fail the contrast check.
        await settleAnimations(page)
        violations.push(...await axeCurrent(page, `inventory card overlay (${label})`))
      }

      // "Zum Inventar" stacks the add dialog on top of the catalog overlay.
      await page.goto(`/catalog?card=${DARK_MAGICIAN}`)
      await waitForHydration(page)
      await page.getByRole('dialog', { name: CARD.darkMagician }).getByRole('button', { name: 'Zum Inventar' }).click()
      await expect(page.getByRole('dialog', { name: 'Karte hinzufügen' })).toBeVisible()
      await settleAnimations(page)
      violations.push(...await axeCurrent(page, 'catalog card overlay + add dialog'))

      expect(violations).toEqual([])
    })
  }
})
