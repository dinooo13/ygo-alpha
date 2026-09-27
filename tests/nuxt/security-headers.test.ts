// Security headers (ADR 0029): the hash-based CSP for rendered HTML.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, inlineScriptHashes } from '../../server/utils/security-headers'

function sha256(content: string) {
  return `'sha256-${createHash('sha256').update(content).digest('base64')}'`
}

const CONFIG_SCRIPT = 'window.__NUXT__={};window.__NUXT__.config={public:{}}'
const COLOR_MODE_SCRIPT = '"use strict";(()=>{const e=document.documentElement})()'

const PAGE = `<!DOCTYPE html><html><head>
<script>${COLOR_MODE_SCRIPT}</script>
<script type="module" src="/_nuxt/entry.js" crossorigin></script>
</head><body><div id="__nuxt"></div>
<script type="application/json" data-nuxt-data="nuxt-app" id="__NUXT_DATA__">[{"state":1}]</script>
<script>${CONFIG_SCRIPT}</script>
</body></html>`

describe('inlineScriptHashes', () => {
  it('hashes the executable inline scripts only', () => {
    expect(inlineScriptHashes(PAGE)).toEqual([sha256(COLOR_MODE_SCRIPT), sha256(CONFIG_SCRIPT)])
  })

  it('skips scripts with a src and data scripts', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script><script type="application/ld+json">{}</script>')).toEqual([])
  })

  it('hashes an inline module script', () => {
    expect(inlineScriptHashes('<script type="module">import "/a.js"</script>')).toEqual([sha256('import "/a.js"')])
  })

  it('lists the same script once', () => {
    expect(inlineScriptHashes(`<script>${CONFIG_SCRIPT}</script><script>${CONFIG_SCRIPT}</script>`)).toHaveLength(1)
  })
})

describe('contentSecurityPolicy', () => {
  it('allows the hashed scripts and no inline script otherwise', () => {
    const policy = contentSecurityPolicy([sha256(CONFIG_SCRIPT)])
    const scriptSrc = policy.split('; ').find(directive => directive.startsWith('script-src'))

    expect(scriptSrc).toBe(`script-src 'self' ${sha256(CONFIG_SCRIPT)}`)
    expect(scriptSrc).not.toContain('unsafe-inline')
  })

  it('allows YGOPRODeck card images and photo previews', () => {
    expect(contentSecurityPolicy([])).toContain(`img-src 'self' data: blob: https://images.ygoprodeck.com`)
  })

  it('keeps the page out of frames and plugins', () => {
    const policy = contentSecurityPolicy([])
    expect(policy).toContain(`frame-ancestors 'none'`)
    expect(policy).toContain(`object-src 'none'`)
    expect(policy).toContain(`base-uri 'self'`)
  })
})
