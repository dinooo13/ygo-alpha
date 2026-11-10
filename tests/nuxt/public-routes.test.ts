import { describe, expect, it } from 'vitest'
import { isPublicPath } from '../../app/utils/public-routes'

// Pins the one line in app/middleware/auth.global.ts that keeps an anonymous
// visitor *in* on a shared link and a logged-in visitor from being bounced
// *out* of it — extracted to a pure helper because a route-middleware unit
// test is impractical in this repo's vitest setup (see docs/adr/0007).
describe('isPublicPath', () => {
  it('treats every /players/** path as public', () => {
    expect(isPublicPath('/players/dino')).toBe(true)
    expect(isPublicPath('/players/dino/decks/abc')).toBe(true)
    expect(isPublicPath('/players/dino/collections/abc')).toBe(true)
    expect(isPublicPath('/players/dino/inventory')).toBe(true)
  })

  it('treats the bare /players path (no trailing slash) as public too', () => {
    expect(isPublicPath('/players')).toBe(true)
  })

  it('does not treat an unrelated or look-alike path as public', () => {
    expect(isPublicPath('/profile')).toBe(false)
    expect(isPublicPath('/wishlist')).toBe(false)
    expect(isPublicPath('/playersx')).toBe(false)
    expect(isPublicPath('/')).toBe(false)
  })

  it('does not treat the old German /spieler paths as public', () => {
    // 00.legacy-routes.global.ts rewrites them to /players/** before
    // auth.global.ts runs (docs/adr/0013-english-url-scheme.md).
    expect(isPublicPath('/spieler')).toBe(false)
    expect(isPublicPath('/spieler/x')).toBe(false)
    expect(isPublicPath('/')).toBe(false)
  })

  it('does not treat a case variant of /players as public', () => {
    // vue-router matches paths case-insensitively, so /Players/x renders the
    // shared page. The allowlist stays exact: a case variant needs a session,
    // never the other way round (GHSA-hxvh-4h3w-prp9, e2e/mixed-case-paths.spec.ts).
    expect(isPublicPath('/Players/dino')).toBe(false)
    expect(isPublicPath('/PLAYERS')).toBe(false)
  })
})
