#!/usr/bin/env node
// Fills a running dev server (pnpm dev:agent) with a made-up demo account so
// every screen has something to show. Goes through the real HTTP API, so it
// needs the server's E2E catalog fixture (NUXT_E2E_SEED_CATALOG=1) and open
// sign-up (NUXT_INVITE_CODE empty, or pass --invite-code).
//
// Idempotent: when the demo account already has decks, it only logs in and
// prints the credentials again.

import { parseArgs } from 'node:util'

const HELP = `Usage: node scripts/seed-demo.mjs [--url URL] [--invite-code CODE]

Creates the demo account on a running server and fills it with collections,
inventory, an own format, decks (legal, short of copies, illegal), a wishlist, a public
profile with a shared deck and a running Swiss tournament.

  --url URL           server to seed (default http://localhost:$PORT, PORT
                      defaulting to 3400, as pnpm dev:agent does)
  --invite-code CODE  invite code, when the server requires one
  -h, --help          show this help

Login afterwards: demo@example.com / demo-duelist-2026
Exit code 0 = seeded (or already seeded); 1 = a request failed.`

const { values } = parseArgs({
  options: {
    'url': { type: 'string' },
    'invite-code': { type: 'string' },
    'help': { type: 'boolean', short: 'h' },
  },
})
if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const BASE = (values.url ?? `http://localhost:${process.env.PORT || 3400}`).replace(/\/$/, '')
const DEMO = {
  name: 'Demo Duelist',
  email: 'demo@example.com',
  password: 'demo-duelist-2026',
  handle: 'demo-duelist',
}

// Passcodes of the E2E catalog fixture (server/db/fixtures/catalog-fixture.ts).
const CARD = {
  darkMagician: 46986414,
  blueEyes: 89631139,
  summonedSkull: 70781052,
  kuriboh: 40640057,
  potOfGreed: 55144522,
  raigeki: 12580477,
  monsterReborn: 83764719,
  mirrorForce: 44095762,
  blueEyesUltimate: 23995346,
  stardust: 44508094,
  utopia: 84013237,
  decodeTalker: 1861629,
  oddEyes: 16178683,
  effectVeiler: 97268402,
  tenThousand: 10000,
}

let cookie = ''

async function api(method, path, body, { allow = [] } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      // Better Auth rejects requests whose Origin isn't the server's own URL.
      'origin': BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookies = response.headers.getSetCookie()
  if (setCookies.length > 0) {
    cookie = setCookies.map(c => c.split(';')[0]).join('; ')
  }
  const text = await response.text()
  if (!response.ok && !allow.includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  }
  try {
    return { status: response.status, data: text ? JSON.parse(text) : null }
  }
  catch {
    throw new Error(`${method} ${path} -> ${response.status}, not JSON (is --url this app?): ${text.slice(0, 120)}`)
  }
}

async function login() {
  const signUp = await api('POST', '/api/auth/sign-up/email', {
    name: DEMO.name,
    email: DEMO.email,
    password: DEMO.password,
    ...(values['invite-code'] ? { inviteCode: values['invite-code'] } : {}),
  }, { allow: [422] }) // 422 = the email is taken: log in instead
  if (signUp.status === 200) {
    return true
  }
  await api('POST', '/api/auth/sign-in/email', { email: DEMO.email, password: DEMO.password })
  return false
}

async function seed() {
  await api('PATCH', '/api/profile', {
    handle: DEMO.handle,
    displayName: DEMO.name,
    bio: 'Spielt seit Legend of Blue Eyes. Sucht noch eine dritte Mirror Force.',
  })

  const binder = (await api('POST', '/api/collections', { name: 'Ordner Blau', description: 'Die Karten fürs GOAT-Deck' })).data
  const trade = (await api('POST', '/api/collections', { name: 'Tauschbox' })).data

  // Some copies in collections, some without; Summoned Skull, Raigeki and
  // Mirror Force are one short each for the GOAT deck below.
  await api('POST', '/api/inventory/bulk', {
    items: [
      { catalogCardId: CARD.darkMagician, quantity: 3, collectionId: binder.id },
      { catalogCardId: CARD.summonedSkull, quantity: 2, collectionId: binder.id },
      { catalogCardId: CARD.kuriboh, quantity: 3, collectionId: binder.id },
      { catalogCardId: CARD.monsterReborn, quantity: 1, collectionId: binder.id },
      { catalogCardId: CARD.mirrorForce, quantity: 1, collectionId: binder.id, note: 'Ecke leicht geknickt' },
      { catalogCardId: CARD.blueEyes, quantity: 3 },
      { catalogCardId: CARD.blueEyesUltimate, quantity: 1 },
      { catalogCardId: CARD.potOfGreed, quantity: 2, collectionId: trade.id },
      { catalogCardId: CARD.stardust, quantity: 1, collectionId: trade.id },
      { catalogCardId: CARD.utopia, quantity: 2 },
      { catalogCardId: CARD.decodeTalker, quantity: 1 },
      { catalogCardId: CARD.effectVeiler, quantity: 3 },
      { catalogCardId: CARD.oddEyes, quantity: 1 },
      { catalogCardId: CARD.tenThousand, quantity: 3 },
    ],
  })

  const card = (catalogCardId, quantity, section = 'main') => ({ catalogCardId, quantity, section })

  // The built-in formats want 40+ Main Deck cards, more than the 14-card
  // fixture allows at 3 copies each; this own format makes a legal deck possible.
  const casual = (await api('POST', '/api/formats', {
    name: 'Spieletreff Casual',
    description: 'Kurze Decks für den Spieleabend: 20 bis 60 Karten, sonst TCG-Banliste.',
    rules: {
      rules: [
        { kind: 'deck_size', section: 'main', min: 20, max: 60 },
        { kind: 'deck_size', section: 'extra', max: 15 },
        { kind: 'deck_size', section: 'side', max: 15 },
        { kind: 'copies', maxCopies: 3 },
        { kind: 'banlist', source: 'tcg' },
      ],
    },
  })).data

  // Legal in its format, and every copy owned.
  const dragons = (await api('POST', '/api/decks', {
    name: 'Weißer Drache',
    description: 'Klassiker mit Fusion im Extra Deck.',
    formatId: casual.id,
    coverCardId: CARD.blueEyes,
    cards: [
      card(CARD.blueEyes, 3),
      card(CARD.kuriboh, 3),
      card(CARD.effectVeiler, 3),
      card(CARD.darkMagician, 3),
      card(CARD.summonedSkull, 2),
      card(CARD.monsterReborn, 1),
      card(CARD.mirrorForce, 1),
      card(CARD.oddEyes, 1),
      card(CARD.tenThousand, 3),
      card(CARD.utopia, 2, 'extra'),
      card(CARD.blueEyesUltimate, 1, 'extra'),
    ],
  })).data

  // GOAT: 3 copies short (see above), and illegal there: too small, Raigeki
  // and Monster Reborn forbidden, Mirror Force limited but played twice.
  const goat = (await api('POST', '/api/decks', {
    name: 'Dunkler Magier GOAT',
    formatId: 'goat',
    coverCardId: CARD.darkMagician,
    cards: [
      card(CARD.darkMagician, 3),
      card(CARD.summonedSkull, 3),
      card(CARD.kuriboh, 2),
      card(CARD.monsterReborn, 1),
      card(CARD.raigeki, 1),
      card(CARD.mirrorForce, 1),
      card(CARD.mirrorForce, 1, 'side'),
    ],
  })).data

  // Illegal in TCG Advanced: Pot of Greed is forbidden there.
  const illegal = (await api('POST', '/api/decks', {
    name: 'Gier-Test',
    formatId: 'tcg-advanced',
    cards: [
      card(CARD.potOfGreed, 2),
      card(CARD.oddEyes, 1),
      card(CARD.stardust, 1, 'extra'),
      card(CARD.utopia, 2, 'extra'),
      card(CARD.decodeTalker, 1, 'extra'),
    ],
  })).data

  await api('PUT', `/api/sharing/deck/${dragons.id}`, { visibility: 'public' })
  await api('PUT', `/api/sharing/collection/${trade.id}`, { visibility: 'link' })
  await api('PUT', '/api/sharing/inventory/me', { visibility: 'public' })

  await api('POST', '/api/wishlist', { catalogCardId: CARD.mirrorForce, quantity: 2, note: '1st Edition bitte' })
  await api('POST', '/api/wishlist', { catalogCardId: CARD.raigeki, quantity: 1 })
  await api('PUT', '/api/profile/wishlist-visibility', { visibility: 'public' })

  await seedTournament(goat.id)

  return { dragons, goat, illegal }
}

// A Swiss tournament with the demo user and four guests (five players, so
// someone gets a bye), round 1 finished and round 2 waiting for results.
async function seedTournament(deckId) {
  let tournament = (await api('POST', '/api/tournaments', {
    name: 'Freitagsturnier im Spieletreff',
    description: 'GOAT, drei Runden Schweizer System.',
    formatId: 'goat',
    pairingSystem: 'swiss',
    plannedRounds: 3,
    includeSelf: true,
  })).data
  for (const name of ['Mara Kessler', 'Jonas Brandt', 'Ilka Vogt', 'Timo Haas']) {
    tournament = (await api('POST', `/api/tournaments/${tournament.id}/participants`, { name })).data
  }
  const self = tournament.participants.find(p => p.isSelf)
  if (!self) {
    throw new Error('the new tournament has no participant for the demo user')
  }
  await api('PUT', `/api/tournaments/${tournament.id}/participants/${self.id}/deck`, { deckId })
  tournament = (await api('POST', `/api/tournaments/${tournament.id}/start`)).data

  const scores = [{ gamesA: 2, gamesB: 0 }, { gamesA: 1, gamesB: 2 }, { gamesA: 2, gamesB: 1 }]
  const round1 = tournament.rounds[0]
  let i = 0
  for (const match of round1.matches) {
    if (match.isBye) {
      continue
    }
    await api('PATCH', `/api/tournaments/${tournament.id}/matches/${match.id}`, scores[i++ % scores.length])
  }
  await api('POST', `/api/tournaments/${tournament.id}/rounds/${round1.id}/complete`)
  await api('POST', `/api/tournaments/${tournament.id}/rounds`)
  return tournament
}

try {
  const created = await login()
  // The tournament is created last, so it marks a complete seed.
  const seeded = !created && (await api('GET', '/api/tournaments')).data.items.length > 0
  if (seeded) {
    console.log(`seed-demo: ${BASE} already has the demo account; nothing to do`)
  }
  else {
    await seed()
    console.log(`seed-demo: seeded ${BASE}`)
  }
  console.log(`  login: ${DEMO.email} / ${DEMO.password}`)
  console.log(`  public profile: ${BASE}/players/${DEMO.handle}`)
}
catch (error) {
  console.error(`seed-demo: ${error.message}`)
  console.error('  after a failed run: stop the server, delete .agent/, start it again and rerun')
  if (error.cause?.code === 'ECONNREFUSED') {
    console.error(`  is the server running? start it with: PORT=${new URL(BASE).port || 80} pnpm dev:agent`)
  }
  process.exit(1)
}
