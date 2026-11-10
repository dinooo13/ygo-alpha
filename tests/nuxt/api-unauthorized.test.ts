// Global 401 handling (#148): an API 401 on a protected page sends the user
// to /login once, and only when the session is really gone.
import { describe, expect, it, vi } from 'vitest'
import { createUnauthorizedHandler, isProtectedApiRequest, redirectsOnUnauthorized } from '~/utils/api-unauthorized'
import { getAuthSession } from '~/utils/session'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError } from 'h3'

const signedIn = { session: {}, user: { email: 'fabian@example.com', name: 'Fabian Meyer' } }

// The auth middleware and the plugin both ask `getAuthSession`.
vi.mock('~/utils/session', () => ({
  getAuthSession: vi.fn(() => Promise.resolve({ session: {}, user: { email: 'fabian@example.com', name: 'Fabian Meyer' } })),
}))

const ORIGIN = 'http://localhost:3000'

describe('isProtectedApiRequest', () => {
  it.each([
    ['/api/inventory?page=2', true],
    ['/api/decks/d1/cards', true],
    [`${ORIGIN}/api/catalog/cards`, true],
    ['/api/auth/get-session', false],
    ['/api/auth/sign-in/email', false],
    ['/players/fabian', false],
    ['https://example.com/api/inventory', false],
  ])('%s → %s', (url, expected) => {
    expect(isProtectedApiRequest(url, ORIGIN)).toBe(expected)
  })

  it('reads Request and URL objects', () => {
    expect(isProtectedApiRequest(new Request(`${ORIGIN}/api/wishlist`), ORIGIN)).toBe(true)
    expect(isProtectedApiRequest(new URL(`${ORIGIN}/api/auth/sign-out`), ORIGIN)).toBe(false)
  })
})

describe('redirectsOnUnauthorized', () => {
  it.each([
    ['/inventory', true],
    ['/catalog', true],
    ['/', true],
    ['/login', false],
    ['/register', false],
    ['/players', false],
    ['/players/fabian/decks/d1', false],
  ])('%s → %s', (path, expected) => {
    expect(redirectsOnUnauthorized(path)).toBe(expected)
  })
})

function setup(options: { path?: string, fullPath?: string, session?: boolean } = {}) {
  const route = { path: options.path ?? '/inventory', fullPath: options.fullPath ?? '/inventory?card=1' }
  let resolveSession!: (value: boolean) => void
  const hasSession = vi.fn(() => options.session === undefined
    ? new Promise<boolean>((resolve) => {
        resolveSession = resolve
      })
    : Promise.resolve(options.session))
  const redirect = vi.fn()
  const onUnauthorized = createUnauthorizedHandler({ currentRoute: () => route, hasSession, redirect })
  return { route, hasSession, redirect, onUnauthorized, resolveSession: (value: boolean) => resolveSession(value) }
}

describe('createUnauthorizedHandler', () => {
  it('sends the user to /login with the page to come back to when the session is gone', async () => {
    const { redirect, onUnauthorized } = setup({ session: false })

    await onUnauthorized()

    expect(redirect).toHaveBeenCalledWith({ path: '/login', query: { redirect: '/inventory?card=1' } })
  })

  it('redirects once for a burst of parallel 401s', async () => {
    const { hasSession, redirect, onUnauthorized, resolveSession } = setup()

    const first = onUnauthorized()
    const second = onUnauthorized()
    const third = onUnauthorized()
    resolveSession(false)
    await Promise.all([first, second, third])

    expect(hasSession).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledTimes(1)
  })

  it('stays when a session still exists, so it can\'t loop with the login page\'s redirect', async () => {
    const { redirect, onUnauthorized } = setup({ session: true })

    await onUnauthorized()

    expect(redirect).not.toHaveBeenCalled()
  })

  it('does nothing on the login page and on shared pages', async () => {
    for (const path of ['/login', '/register', '/players/fabian']) {
      const { hasSession, redirect, onUnauthorized } = setup({ path, fullPath: path, session: false })
      await onUnauthorized()
      expect(hasSession).not.toHaveBeenCalled()
      expect(redirect).not.toHaveBeenCalled()
    }
  })

  it('does nothing when the user moved to a public page while the session was checked', async () => {
    const { route, redirect, onUnauthorized, resolveSession } = setup()

    const pending = onUnauthorized()
    route.path = '/players/fabian'
    route.fullPath = '/players/fabian'
    resolveSession(false)
    await pending

    expect(redirect).not.toHaveBeenCalled()
  })
})

function unauthorized(): never {
  throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
}

// The plugin hooks `window.fetch`, which every `$fetch`/`useFetch` call goes
// through in the app. The test environment's own `$fetch` holds the fetch it
// was created with, so these tests call `fetch` directly.
describe('the api-unauthorized plugin', () => {
  it('redirects a protected page to /login when an API call answers 401 without a session', async () => {
    const router = useRouter()
    // Signed in while the page is entered…
    vi.mocked(getAuthSession).mockResolvedValue(signedIn)
    await router.push('/inventory?q=Dark')
    expect(router.currentRoute.value.fullPath).toBe('/inventory?q=Dark')

    // …then the session ends and the page's next API call answers 401.
    vi.mocked(getAuthSession).mockResolvedValue(null)
    const unregister = registerEndpoint('/api/inventory', unauthorized)
    try {
      expect((await fetch('/api/inventory')).status).toBe(401)
      await vi.waitFor(() => {
        expect(router.currentRoute.value.path).toBe('/login')
      })
      expect(router.currentRoute.value.query.redirect).toBe('/inventory?q=Dark')
    }
    finally {
      unregister()
      vi.mocked(getAuthSession).mockResolvedValue(signedIn)
      await router.replace('/')
    }
  })

  it('leaves the auth endpoints\' own 401s alone', async () => {
    const router = useRouter()
    vi.mocked(getAuthSession).mockResolvedValue(signedIn)
    await router.push('/inventory')
    vi.mocked(getAuthSession).mockClear()
    vi.mocked(getAuthSession).mockResolvedValue(null)
    const unregister = registerEndpoint('/api/auth/sign-in/email', { method: 'POST', handler: unauthorized })
    try {
      expect((await fetch('/api/auth/sign-in/email', { method: 'POST' })).status).toBe(401)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(getAuthSession).not.toHaveBeenCalled()
      expect(router.currentRoute.value.path).toBe('/inventory')
    }
    finally {
      unregister()
      vi.mocked(getAuthSession).mockResolvedValue(signedIn)
      await router.replace('/')
    }
  })
})
