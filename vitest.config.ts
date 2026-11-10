import { defineVitestConfig } from '@nuxt/test-utils/config'

// Nuxt 4.5 auto-imports `$fetch` from `#build/fetch.mjs`, which snapshots
// `globalThis.$fetch` when the app boots. Tests replace the global with
// `vi.stubGlobal('$fetch', …)`, so serve a `$fetch` that always calls the
// current global (the Nuxt 4.4 behaviour). Nuxt resolves the template to its
// own `virtual:nuxt:…/.nuxt/fetch.mjs` id before other plugins see it, so the
// shim matches that resolved id in `load` (`pre` makes it run first).
// Revisit on Nuxt 5: it splits the template into fetch.client/fetch.server.mjs.
const NUXT_FETCH_TEMPLATE = /^virtual:nuxt:.*\.nuxt(?:%2F|\/)fetch\.mjs$/
const liveFetch = {
  name: 'ygo:test-live-fetch',
  enforce: 'pre' as const,
  load(id: string) {
    if (!NUXT_FETCH_TEMPLATE.test(id)) return
    return [
      'const current = () => globalThis.$fetch',
      'export const $fetch = new Proxy(function () {}, {',
      '  apply: (_t, self, args) => Reflect.apply(current(), self, args),',
      '  get: (_t, key) => Reflect.get(current(), key),',
      '})',
    ].join('\n')
  },
}

export default defineVitestConfig({
  plugins: [liveFetch],
  test: {
    environment: 'nuxt',
    include: ['tests/nuxt/**/*.{test,spec}.ts'],
    // Each test file boots its own Nuxt test environment; under full file
    // parallelism that can exceed Vitest's 10s default hook timeout on
    // slower/contended machines. Give `beforeAll` more headroom rather than
    // serializing the whole suite.
    hookTimeout: 30_000,
  },
})
