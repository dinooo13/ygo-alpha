The product roadmap and phase plan live in `docs/Roadmap.md`.
The dev workflow (branching, PRs, CI gates) lives in `docs/WORKFLOW.md`.

## Verify

Install once per checkout (worktrees start without `node_modules`):
`corepack pnpm install --frozen-lockfile`.

Checks, for every change: `pnpm lint`, `pnpm typecheck`, `pnpm test`. For a
UI or API flow, also `E2E_PORT=<33xx> pnpm test:e2e` (builds the app and uses
its own `e2e-data/`; set a port of your own so it doesn't collide with another
agent's run on 3300).

See it work in the T3 preview browser, for every UI change:

1. Start your own dev server as a background command:
   `PORT=<34xx> pnpm dev:agent`. It runs on that port only (`--strictPort`:
   pick another if it's taken), with a scratch database in `.agent/`, the
   ~14-card E2E catalog, the fake assistant (scripted answers, no network)
   and open sign-up. It answers once `curl -fsS localhost:<port>/login`
   succeeds (about 20 s).
2. `PORT=<34xx> pnpm seed:demo` adds the demo account:
   `demo@example.com` / `demo-duelist-2026`, with collections, an inventory,
   decks (legal, short of copies, illegal), shares, a public profile at
   `/players/demo-duelist`, a wishlist and a Swiss tournament in round 2.
   Delete `.agent/` while the server is stopped for a fresh database.
3. Open it with the T3 preview tools: `preview_open` with
   `target: {kind: "environment-port", port: <34xx>}` and
   `profileId: "incognito"` (cookies for `localhost` ignore the port, so the
   user's own profile would lose its session). Click through what you
   changed, check the hard states that apply (an empty account: register a
   second user; logged out; phone width; light and dark; English), and keep
   the preview's screenshots as proof.
4. Close your preview tab and stop the background command. If something still
   listens on your port, stop that PID (`lsof -ti tcp:<port>`), nothing else.

A dev server takes about 1.5 GB of memory on a 5 GB box: run one at a time and
stop it when done. The dev log's "Error during dependency optimization"
(`@tiptap/core`) is a known lockfile mismatch and doesn't stop the server.

Only a human can check: the real assistant model, the full catalog and German
card texts (`catalog:sync` needs the network), the service worker
(`PWA_DEV_SW=1`), real phones, and production-only behaviour such as the
Content Security Policy (it is off in dev; `e2e/security-headers.spec.ts`
covers the built app).

## Ship

- **Verify:** lint, typecheck, unit and E2E tests pass, and every UI change was
  seen in the preview browser as above.
- **Merge:** a PR per `docs/WORKFLOW.md`; CI green; `gh pr merge --rebase`.
- **After merge:** deploying is manual and the user's call: Actions → Deploy →
  Run workflow on `main`.
- **Live check:** after a deploy, `https://ygo-alpha.de/login` answers 200 and
  the changed screen works there.

## Working next to the user

- The user's own copy runs `pnpm dev` on port 3000 against `data/app.db` and
  `.env`. Never use port 3000, `data/` or `.env`, and don't work in the main
  checkout (`~/Developer/ygo-alpha`).
- Stop only what you started: your background command, or the PID on your own
  port. Never `pkill`, `killall` or `fuser -k` node or nuxt.
- In the preview browser, use your own tab in the incognito profile and close
  it when done; never act on a tab the user is driving.
