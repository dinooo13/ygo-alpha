# 0029: Security headers and a hash-based Content Security Policy

## Status

Accepted.

## Context

The app is public on `ygo-alpha.de` (ADR 0027, ADR 0028) and sent no
security headers: no Content Security Policy, no clickjacking protection, no
HSTS. The assistant renders model output as Markdown (sanitized, ADR 0023),
which is the most likely place for injected markup, so a CSP that blocks
injected scripts is worth having.

What the frontend loads (checked for this decision):

- Scripts and styles from its own origin only. Two inline scripts in every
  rendered page: Nuxt's `window.__NUXT__` config and the color-mode script.
  The `__NUXT_DATA__` payload is a JSON script, which browsers don't run.
- Card images from `https://images.ygoprodeck.com` (hotlinked, ADR 0001);
  the assistant's photo previews as `data:` and `blob:` URLs.
- Fonts bundled from `node_modules` (ADR 0016); no font CDN.
- API calls to its own origin only; the assistant's model is called by the
  server.
- The camera only through a file input with `capture`; no microphone,
  speech API, iframes or third-party embeds.

## Decision

1. **A Nitro plugin sets the headers** (`server/plugins/security-headers.ts`,
   helpers in `server/utils/security-headers.ts`), in production builds only.
   Vite's client and Nuxt devtools need more than this policy allows.
2. **Every response** gets `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
   `Permissions-Policy: camera=(self), microphone=(), geolocation=(),
   payment=(), usb=()`, `Cross-Origin-Opener-Policy: same-origin` and
   `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no
   preload; browsers ignore it over plain HTTP, so local E2E runs are fine).
3. **Rendered HTML gets a CSP with script hashes.** On `render:response` the
   plugin hashes each executable inline script of the page and puts the
   hashes into `script-src 'self' 'sha256-…'`. No `'unsafe-inline'` for
   scripts, no nonce plumbing through Nuxt, and a changed config script (a
   different `betterAuthUrl`, say) is still allowed because it is hashed as
   rendered.
4. **The rest of the policy:** `default-src 'self'`; `style-src 'self'
   'unsafe-inline'` (Vue/Nuxt UI inline styles and SSR-inlined component
   CSS; injected styles are a much smaller risk than scripts); `img-src 'self'
   data: blob: https://images.ygoprodeck.com`; `font-src 'self' data:`;
   `connect-src`, `worker-src`, `manifest-src 'self'`; `frame-src`,
   `frame-ancestors`, `object-src 'none'`; `base-uri`, `form-action 'self'`.
5. **Tested in the browser.** An E2E test checks the headers and walks the
   main pages signed in, failing on any CSP violation; the whole E2E suite
   runs against the production build with the policy active.

## Consequences

- A new external source (another image host, an analytics script, an embed)
  must be added to the policy, or the browser blocks it. The E2E test is
  meant to catch that.
- A page that adds an inline `<script>` on the client after hydration would
  be blocked; everything has to come from the SSR HTML or a bundled module.
- Static files served straight from the web server's document root (Plesk's
  `httpdocs`, ADR 0028) don't get these headers; they're JS, CSS and images,
  not documents.
- HSTS pins browsers to HTTPS for `ygo-alpha.de` for a year once they've
  seen it. Going back to plain HTTP would lock those visitors out.
