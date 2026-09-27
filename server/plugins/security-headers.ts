import { setResponseHeaders } from 'h3'
import { contentSecurityPolicy, HSTS_HEADER, inlineScriptHashes, STATIC_SECURITY_HEADERS } from '../utils/security-headers'

/**
 * Security headers on every response, and a hash-based CSP on rendered HTML
 * (ADR 0029). Not in dev: Vite's client and Nuxt devtools need more than the
 * production policy allows, and HSTS has no business on localhost.
 */
export default defineNitroPlugin((nitroApp) => {
  if (import.meta.dev) {
    return
  }

  nitroApp.hooks.hook('request', (event) => {
    setResponseHeaders(event, { ...STATIC_SECURITY_HEADERS, 'strict-transport-security': HSTS_HEADER })
  })

  nitroApp.hooks.hook('render:response', (response) => {
    const contentType = String(response.headers?.['content-type'] ?? '')
    if (typeof response.body !== 'string' || !contentType.includes('text/html')) {
      return
    }
    response.headers = {
      ...response.headers,
      'content-security-policy': contentSecurityPolicy(inlineScriptHashes(response.body)),
    }
  })
})
