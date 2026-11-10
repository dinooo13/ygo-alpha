# 0033: The deploy key runs one fixed script

## Status

Accepted. Changes points 3 and 4 of [0028](0028-plesk-deployment.md).

## Context

The GitHub Actions deploy (ADR 0028) logs in with a dedicated key, marked
`restrict` in the server's `authorized_keys`. `restrict` turns off forwarding,
the pty and `~/.ssh/rc`, but the key could still run any command as the
hosting account, and that account owns every site on the hosting, not only
this app. The deploy sent two commands: an inline `tar -x` into
`.deploy-incoming`, and a shell script on stdin (`bash -s`). A `command=`
restriction can't whitelist "any script on stdin" in a meaningful way.

The SSH shell is Plesk's chroot jail: `/` is the subscription's folder, the app
root is `/<domain>`. sshd runs every command, a forced one too, through the
account's login shell, which enters the jail first, so a forced command's path
is the path as the jail sees it.

## Decision

1. **The remote steps live in `deploy/plesk/receive.sh`**, installed by hand
   as `<app root>/deploy-receive.sh` (mode 700). It takes one verb:
   - `deploy` reads the release tarball from stdin and checks it before
     touching anything: at most 128 MiB compressed and 768 MiB unpacked, at
     most 50,000 members; only regular files, directories and symlinks; only
     `.output/`, `migrations/`, `server.cjs` and `REVISION` at the top; no
     absolute paths, no `.` or `..` components, no unusual characters. Symlinks
     (Nitro's `node_modules/h3 -> .nitro/h3@…`) must be relative, stay inside
     `.output/server`, and no member may lie below one; none in
     `.output/public`, which is copied into the document root. Then it does
     what the inline script did: database backup (last 5), `.output` →
     `.output.prev`, migrations, `server.cjs`, `httpdocs`, `tmp/restart.txt`.
     The previous `REVISION` is kept as `REVISION.prev`.
   - `rollback` swaps `.output` and `.output.prev` (and the two revisions),
     refreshes `httpdocs` and restarts.
   - `version` prints the script's sha256.

   Anything else is refused with exit 2. It holds a lock, so two runs can't
   overlap, and writes one line per run to `tmp/deploy.log`.
2. **The key is pinned to it.** Its `authorized_keys` line becomes
   `restrict,command="/<domain>/deploy-receive.sh" ssh-ed25519 …`. sshd puts
   what the client asked for into `SSH_ORIGINAL_COMMAND`; the script accepts
   only `deploy`, `rollback` or `version`, alone or after the script's own path.
   With an unrestricted key the same `ssh host /<domain>/deploy-receive.sh
   deploy` runs the script directly, so local deploys keep working.
3. **The deploy checks the server first.** `scripts/deploy-plesk.sh` compares
   the installed script's `version` with the repository's copy and stops
   before building if they differ. In CI (`DEPLOY_REQUIRE_LOCKED_KEY=1`) it
   also sends `id` and stops unless the server refuses it, so a loosened
   `authorized_keys` line turns the deploy red.
4. **A deploy never installs the receive script.** Changing it is a manual
   step with an unrestricted key (docs/DEVELOPMENT.md), so the deploy key
   can't widen its own restriction.

## Consequences

- A leaked deploy key can no longer run commands, read `.env` or other sites,
  or plant files outside the release. It can still deploy a release, and a
  release's `server.cjs` and `.output` run under Passenger as the same
  account. So the key still amounts to code execution on the next restart;
  what changed is that this takes a visible deploy (a `tmp/deploy.log` line,
  a new `REVISION`, a restart) instead of a quiet `ssh host '…'`. Making the
  key harmless would need releases signed by a key that CI doesn't hold.
- Rolling back is a workflow run (or `scripts/deploy-plesk.sh --rollback`), no
  longer a manual `mv` on the server. Migrations still can't be rolled back;
  `data/backups/` is the fallback.
- Changing `receive.sh` needs a manual install before the next deploy; the
  version check says so.
