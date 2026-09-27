# 0028: Deployment to the Plesk host

## Status

Accepted.

## Context

Production runs on a Plesk webhosting account (netcup) through Plesk's
Node.js support (Phusion Passenger). The first deployments were done by hand,
and that host has constraints a normal VPS doesn't:

- The SSH shell is a chroot with basic tools only: no Node.js, no pnpm, no
  `rsync`. Only Passenger runs Node.js, outside the shell.
- The server is Linux x86-64 (Debian 12, glibc 2.36). `better-sqlite3`'s
  native addon from a macOS build doesn't load there, and one compiled on a
  newer distro (GitHub's Ubuntu runners) may need a newer glibc.
- Plesk wants the document root inside the application root, and only
  accepts folders it created itself (group `psaserv`); folders created over
  SSH get `psacln` and can't be changed.

## Decision

1. **Layout on the server.** Application root = the domain folder (e.g.
   `/ygo-alpha.de`), document root = its `httpdocs`, startup file
   `server.cjs`. Next to `httpdocs`: `server.cjs`, `.env`, `data/`,
   `.output/`, `server/db/migrations/`, `tmp/`. Only `httpdocs` is served,
   and it only holds the build's public files. `.env`, `server.cjs`, `data/`
   and `.output/server` are readable by the hosting user only.
2. **`deploy/plesk/server.cjs` is the startup file.** Passenger needs a
   CommonJS entry, so it loads `.env` (`process.loadEnvFile`) and then
   `import()`s the Nitro server. Startup errors go to `tmp/startup.log`,
   because Passenger's own log isn't reachable over SSH.
3. **One script, `scripts/deploy-plesk.sh`, for local and CI deploys.** It
   builds, swaps in the official linux-x64 `better-sqlite3` prebuild for the
   server's Node ABI (137 = Node 24), uploads a tarball over SSH, backs up the
   database (last 5 kept), switches `.output` (the previous one stays as
   `.output.prev`), migrations and `server.cjs`, refreshes `httpdocs`, touches
   `tmp/restart.txt` and checks that `/login` answers 200. It never touches
   `.env` or `data/`. Server details come from `DEPLOY_SSH`, `DEPLOY_PATH` and
   `DEPLOY_URL`, not from the (public) repository.
4. **GitHub Actions deploy, started by hand.** `.github/workflows/deploy.yml`
   runs on `workflow_dispatch` only, only for `main`, one at a time. Its
   secrets (`DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_SSH`,
   `DEPLOY_PATH`) live in a `production` environment whose deployment branch
   policy allows `main` only; `DEPLOY_URL` is an environment variable. The
   actions that see the key are pinned to commits. The key is a dedicated
   deploy key, marked `restrict` in the server's `authorized_keys`.

## Consequences

- A deploy doesn't wait for CI by itself; start it after CI is green. An
  automatic deploy after a green CI run on `main` (`workflow_run`) can come
  later; it must then check that the run was a push to `main` in this
  repository, since `workflow_run` also fires for pull requests from forks.
- Whoever can start the workflow or holds the key can run code on the
  server. Write access to the repository is the real boundary.
- Rolling back is manual: move `.output.prev` back to `.output` and touch
  `tmp/restart.txt`. A migration can't be rolled back that way; the database
  backups in `data/backups/` are the fallback.
- Changing the server's Node.js major version means changing
  `DEPLOY_NODE_ABI` (and the workflow's `node-version`).
