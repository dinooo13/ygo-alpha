import { createUnauthorizedHandler, isProtectedApiRequest } from '~/utils/api-unauthorized'
import { getAuthSession } from '~/utils/session'

/**
 * Sends the user to `/login?redirect=<page>` when one of the app's API calls
 * answers 401 on a protected page (#148). The auth middleware checks the
 * session only when the path changes, so a session that ends while the user
 * stays on one page (filters, `?card=` overlays) is noticed here, by the
 * page's next API call.
 *
 * The hook sits on `window.fetch`, not on `globalThis.$fetch`: since Nuxt 4.5
 * the auto-imported `$fetch` is a snapshot taken at app boot, before plugins
 * run, so a replaced `globalThis.$fetch` no longer reaches `$fetch` or
 * `useFetch` calls. ofetch looks up `globalThis.fetch` on every request, so
 * this covers them all, and plain `fetch` calls too.
 */
export default defineNuxtPlugin({
  name: 'api-unauthorized',
  setup(nuxtApp) {
    const router = useRouter()
    const onUnauthorized = createUnauthorizedHandler({
      currentRoute: () => router.currentRoute.value,
      hasSession: async () => Boolean(await getAuthSession()),
      redirect: target => nuxtApp.runWithContext(() => navigateTo(target)),
    })

    const fetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (response.status === 401 && isProtectedApiRequest(input, window.location.origin)) {
        // Not awaited: the caller gets its response at once and shows its own state meanwhile.
        void onUnauthorized()
      }
      return response
    }
  },
})
