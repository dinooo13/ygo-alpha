import { createHash } from 'node:crypto'

/**
 * Security headers (ADR 0029). Every response gets the static ones; rendered
 * HTML also gets a Content-Security-Policy whose `script-src` allows the
 * page's own inline scripts by hash (Nuxt's config script and the color-mode
 * script) instead of `'unsafe-inline'`.
 */

export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // The assistant's photo button is a file input with `capture`, which
  // Permissions Policy doesn't gate; nothing uses the microphone or location.
  'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
}

/** Sent in production only (browsers ignore it over plain HTTP anyway). */
export const HSTS_HEADER = 'max-age=31536000'

/** Card images are hotlinked from YGOPRODeck (ADR 0001). */
const IMAGE_HOSTS = ['https://images.ygoprodeck.com']

// Script types the browser doesn't execute, so they need no hash.
const DATA_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json', 'importmap'])

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/** The `'sha256-…'` sources for the executable inline scripts in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>()
  for (const [, attributes = '', content = ''] of html.matchAll(INLINE_SCRIPT)) {
    if (/\bsrc\s*=/i.test(attributes)) {
      continue
    }
    const type = attributes.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase()
    if (type && DATA_SCRIPT_TYPES.has(type)) {
      continue
    }
    hashes.add(`'sha256-${createHash('sha256').update(content).digest('base64')}'`)
  }
  return [...hashes]
}

export function contentSecurityPolicy(scriptHashes: readonly string[]): string {
  return [
    `default-src 'self'`,
    `script-src 'self' ${scriptHashes.join(' ')}`.trimEnd(),
    // Vue and Nuxt UI set inline `style` attributes and SSR inlines component CSS.
    `style-src 'self' 'unsafe-inline'`,
    // data:/blob: are the assistant's photo previews.
    `img-src 'self' data: blob: ${IMAGE_HOSTS.join(' ')}`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `worker-src 'self'`,
    `manifest-src 'self'`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ')
}
