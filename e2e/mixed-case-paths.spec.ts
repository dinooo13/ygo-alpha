import { expect, test } from '@playwright/test'
import { registerAndLogin } from './helpers/auth'

// vue-router matches paths case-insensitively, so /Decks renders the /decks
// page. Nuxt < 4.5.1 dropped route rules for case variants (GHSA-hxvh-4h3w-prp9,
// GHSA-vjh5-4x84-xrqp). Auth here never rests on a route rule:
// app/middleware/auth.global.ts allows an exact list of public paths, and every
// API handler calls requireUser / requireAdminToken. These tests pin that a
// case variant stays behind the login and keeps its route-rule headers.

test.describe('mixed-case paths', () => {
  for (const path of ['/Decks', '/INVENTORY', '/Profile', '/Players/gibt-es-nicht', '/API/decks', '/api/Decks', '/API/ADMIN/catalog/sync']) {
    test(`${path} sends an anonymous visitor to /login`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 })

      expect(response.status()).toBe(302)
      expect(response.headers().location).toMatch(/^(https?:\/\/[^/]+)?\/login\?redirect=/)
    })
  }

  test('a case variant of /players/** keeps the no-store header for a logged-in visitor', async ({ page }) => {
    await registerAndLogin(page)
    const profile = await (await page.request.get('/api/profile')).json()

    for (const path of [`/players/${profile.handle}`, `/Players/${profile.handle}`, `/PLAYERS/${profile.handle}`]) {
      const response = await page.request.get(path, { maxRedirects: 0 })
      expect(response.status(), path).toBe(200)
      expect(response.headers()['cache-control'], path).toBe('private, no-store')
    }
  })
})
