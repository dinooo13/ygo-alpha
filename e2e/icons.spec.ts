import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { registerAndLogin, waitForHydration } from './helpers/auth'

// Icons a page needs but its SSR HTML didn't carry (a page reached by
// client-side navigation) must come from the client bundle. With
// @nuxt/icon 2.6.2 + @iconify/vue 5.0.5 a runtime fetch goes to
// api.iconify.design, which the CSP blocks, and the icon stays blank
// (`clientBundle.scan` in nuxt.config.ts).

/** Class names of `.iconify` spans that render nothing (no mask image). */
async function blankIcons(page: Page): Promise<string[]> {
  return page.locator('.iconify').evaluateAll(elements => elements
    .filter((element) => {
      const style = getComputedStyle(element)
      return style.maskImage === 'none' && style.webkitMaskImage === 'none'
    })
    .map(element => element.className))
}

test('icons render after client-side navigation, without fetching any', async ({ page }) => {
  const iconRequests: string[] = []
  page.on('request', (request) => {
    if (/_nuxt_icon|iconify/.test(request.url()))
      iconRequests.push(request.url())
  })
  const iconWarnings: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('[Icon]'))
      iconWarnings.push(message.text())
  })

  await registerAndLogin(page)
  await waitForHydration(page)

  // /profile (save, share-2), /decks (file-up) and /assistant (camera) used
  // icons that only the client loaded.
  for (const path of ['/profile', '/decks', '/assistant']) {
    await page.locator(`a[href="${path}"]`).first().click()
    await expect(page).toHaveURL(path)
    await expect.poll(() => blankIcons(page), { message: `blank icons on ${path}` }).toEqual([])
  }

  expect(iconWarnings).toEqual([])
  expect(iconRequests).toEqual([])
})
