import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'

// Security headers (ADR 0029): the production build sends a hash-based CSP;
// no page may trip it.

/** Collects CSP violations the browser reports, from the DOM event and the console. */
function trackCspViolations(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/content security policy|refused to (load|execute|apply)/i.test(message.text())) {
      violations.push(message.text())
    }
  })
  return violations
}

async function collectDomViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store: string[] = []
    ;(window as unknown as { __cspViolations: string[] }).__cspViolations = store
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`)
    })
  })
}

async function domViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
}

test.describe('security headers', () => {
  test('HTML pages carry the CSP and the other headers', async ({ page }) => {
    const response = await page.goto('/login')
    const headers = response!.headers()

    expect(headers['content-security-policy']).toMatch(/script-src 'self' 'sha256-/)
    expect(headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['strict-transport-security']).toBe('max-age=31536000')
  })

  test('API responses carry the static headers', async ({ request }) => {
    const response = await request.get('/api/auth/get-session')

    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['x-frame-options']).toBe('DENY')
  })

  test('no page trips the CSP', async ({ page }) => {
    const violations = trackCspViolations(page)
    await collectDomViolations(page)

    await page.goto('/register')
    await waitForHydration(page)
    await registerAndLogin(page)

    for (const path of ['/', '/catalog', '/inventory', '/decks', '/formats', '/wishlist', '/tournaments', '/assistant', '/profile']) {
      await page.goto(path)
      await waitForHydration(page)
      expect.soft(await domViolations(page), path).toEqual([])
    }

    expect(violations).toEqual([])
  })
})
