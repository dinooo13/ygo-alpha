#!/bin/bash
# Tests for deploy/plesk/receive.sh against a throwaway app root.
# Needs GNU tar and coreutils (CI's Ubuntu, or the server's Debian):
#
#   bash deploy/plesk/receive.test.sh
#   docker run --rm -v "$PWD:/repo:ro" debian:12 bash /repo/deploy/plesk/receive.test.sh
# Checks read as "condition && pass … || fail …"; pass never fails.
# shellcheck disable=SC2015
set -euo pipefail
export LC_ALL=C

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }

# --- Fixtures ------------------------------------------------------------------

# A fresh app root as the server has it: an old release, .env, a database.
new_root() {
  root="$work/root-$RANDOM$RANDOM"
  mkdir -p "$root/.output/server" "$root/.output/public" "$root/data" "$root/httpdocs" "$root/server/db/migrations" "$root/tmp"
  echo old > "$root/.output/server/index.mjs"
  echo old-public > "$root/.output/public/old.txt"
  echo 'SECRET=keep-me' > "$root/.env"
  echo db > "$root/data/app.db"
  echo old-rev > "$root/REVISION"
  echo old > "$root/server.cjs"
  cp "$here/receive.sh" "$root/deploy-receive.sh"
  chmod 700 "$root/deploy-receive.sh"
}

# A release staging dir like scripts/deploy-plesk.sh builds, with Nitro's
# relative symlinks into .output/server/node_modules/.nitro.
new_stage() {
  stage="$work/stage-$RANDOM$RANDOM"
  mkdir -p "$stage/.output/server/node_modules/.nitro/h3@1.15.11" \
    "$stage/.output/server/node_modules/better-call/node_modules" \
    "$stage/.output/public/_nuxt" "$stage/migrations/meta"
  echo new > "$stage/.output/server/index.mjs"
  echo h3 > "$stage/.output/server/node_modules/.nitro/h3@1.15.11/index.mjs"
  ln -s .nitro/h3@1.15.11 "$stage/.output/server/node_modules/h3"
  ln -s ../../.nitro/h3@1.15.11 "$stage/.output/server/node_modules/better-call/node_modules/h3"
  echo 'console.log(1)' > "$stage/.output/public/_nuxt/entry.js"
  echo robots > "$stage/.output/public/robots.txt"
  echo 'create table x;' > "$stage/migrations/0000_init.sql"
  echo '{}' > "$stage/migrations/meta/_journal.json"
  echo new > "$stage/server.cjs"
  echo abc123 > "$stage/REVISION"
}

pack() { tar -czf "$1" -C "$stage" .; }

# Runs the receive script the way sshd's forced command does.
receive() { # <SSH_ORIGINAL_COMMAND> [stdin file]
  local input="${2:-/dev/null}"
  set +e
  SSH_ORIGINAL_COMMAND="$1" SSH_CLIENT='203.0.113.9 50000 22' "$root/deploy-receive.sh" < "$input" > "$work/out" 2>&1
  status=$?
  set -e
}

fingerprint() { # what a refused release must leave untouched
  (cd "$root" && find . -path ./tmp -prune -o -print | sort && cat .env data/app.db REVISION .output/server/index.mjs) | sha256sum
}

# --- A good deploy -----------------------------------------------------------

new_root; new_stage; pack "$work/good.tgz"
env_before="$(sha256sum < "$root/.env")"
receive deploy "$work/good.tgz"
if [[ $status == 0 ]]; then pass "deploy succeeds"; else fail "deploy failed: $(cat "$work/out")"; fi
[[ "$(cat "$root/.output/server/index.mjs")" == new ]] && pass "new .output in place" || fail "new .output missing"
[[ "$(cat "$root/.output.prev/server/index.mjs")" == old ]] && pass "old .output kept as .output.prev" || fail ".output.prev wrong"
[[ "$(cat "$root/REVISION")" == abc123 && "$(cat "$root/REVISION.prev")" == old-rev ]] && pass "REVISION and REVISION.prev" || fail "REVISION wrong"
[[ "$(cat "$root/server.cjs")" == new && -f "$root/server/db/migrations/0000_init.sql" ]] && pass "server.cjs and migrations replaced" || fail "server.cjs/migrations"
[[ -f "$root/httpdocs/robots.txt" && -f "$root/httpdocs/_nuxt/entry.js" && ! -e "$root/httpdocs/old.txt" ]] && pass "httpdocs refreshed" || fail "httpdocs not refreshed"
[[ -f "$root/tmp/restart.txt" ]] && pass "restart.txt touched" || fail "no restart.txt"
[[ "$(readlink "$root/.output/server/node_modules/h3")" == .nitro/h3@1.15.11 ]] && pass "Nitro symlinks survive" || fail "symlink lost"
[[ "$(sha256sum < "$root/.env")" == "$env_before" && "$(cat "$root/data/app.db")" == db ]] && pass ".env and database untouched" || fail ".env or database changed"
ls "$root"/data/backups/*/app.db > /dev/null 2>&1 && pass "database backed up" || fail "no backup"
[[ ! -e "$root/.deploy-incoming" && ! -e "$root/.deploy-incoming.tgz" && ! -e "$root/.deploy-lock" ]] && pass "no leftovers" || fail "leftovers after deploy"
[[ "$(stat -c %a "$root/server.cjs")" == 600 && "$(stat -c %a "$root/.output")" == 711 ]] && pass "private modes" || fail "modes wrong"
grep -q '203.0.113.9 deployed abc123' "$root/tmp/deploy.log" && pass "deploy.log line" || fail "deploy.log missing the deploy"

# The path form an unrestricted key sends works through the forced command too.
receive "/ygo-alpha.de/deploy-receive.sh deploy" "$work/good.tgz"
[[ $status == 0 ]] && pass "'<path> deploy' is accepted" || fail "'<path> deploy' refused: $(cat "$work/out")"

# --- Backups: only the last five are kept -------------------------------------

mkdir -p "$root/data/backups"/2000010{1,2,3,4,5,6,7}-000000
receive deploy "$work/good.tgz"
[[ "$(find "$root/data/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" == 5 && ! -e "$root/data/backups/20000101-000000" ]] \
  && pass "keeps the last 5 backups" || fail "backup retention: $(ls "$root/data/backups")"

# --- rollback ------------------------------------------------------------------

new_root; new_stage; pack "$work/good.tgz"
receive deploy "$work/good.tgz"
receive rollback
[[ $status == 0 && "$(cat "$root/.output/server/index.mjs")" == old && "$(cat "$root/REVISION")" == old-rev && -f "$root/httpdocs/old.txt" ]] \
  && pass "rollback restores the previous build" || fail "rollback: $(cat "$work/out")"
receive rollback
[[ $status == 0 && "$(cat "$root/.output/server/index.mjs")" == new && "$(cat "$root/REVISION")" == abc123 ]] \
  && pass "a second rollback rolls forward" || fail "second rollback"
rm -rf "$root/.output.prev"
receive rollback
[[ $status == 1 && "$(cat "$root/.output/server/index.mjs")" == new ]] && pass "rollback without .output.prev fails" || fail "rollback without .output.prev"

# --- version -------------------------------------------------------------------

receive version
[[ $status == 0 && "$(cat "$work/out")" == "$(sha256sum "$here/receive.sh" | cut -d' ' -f1)" ]] && pass "version prints the sha256" || fail "version: $(cat "$work/out")"

# --- Anything else is refused and runs nothing -----------------------------------

new_root
marker="$work/ran"
for request in 'id' 'true' "touch $marker" "deploy; touch $marker" "deploy && touch $marker" "deploy \$(touch $marker)" \
  "deploy|touch $marker" 'deploy extra' 'rollback now' ' deploy' 'deploy ' 'DEPLOY' 'bash -i' 'scp -t /' \
  'internal-sftp' '/usr/lib/openssh/sftp-server' "deploy-receive.sh deploy" "/x/evil.sh deploy" "/a b/deploy-receive.sh deploy" $'deploy\nid' ''; do
  receive "$request"
  if [[ $status == 2 && ! -e "$marker" ]] && ! grep -q 'uid=' "$work/out"; then
    pass "refuses $(printf '%q' "$request")"
  else
    fail "did not refuse $(printf '%q' "$request") (exit $status): $(cat "$work/out")"
  fi
done
set +e
(unset SSH_ORIGINAL_COMMAND; "$root/deploy-receive.sh" > "$work/out" 2>&1 < /dev/null)
status=$?
set -e
[[ $status == 2 ]] && pass "refuses no command at all" || fail "no command: exit $status"

# --- Bad releases change nothing -----------------------------------------------

expect_rejected() { # <name> <tarball>
  new_root
  local before
  before="$(fingerprint)"
  receive deploy "$2"
  if [[ $status == 1 && "$(fingerprint)" == "$before" && ! -e "$work/escaped" && ! -e "$root/.deploy-incoming" ]]; then
    pass "rejects $1: $(tail -n1 "$work/out")"
  else
    fail "accepted $1 (exit $status): $(cat "$work/out")"
  fi
}

with_member() { # <tarball> <function that edits $stage>
  new_stage
  "$2"
  pack "$1"
}

mk_public_symlink() { ln -s ../server/index.mjs "$stage/.output/public/link"; }
mk_escaping_symlink() { ln -s ../../../.env "$stage/.output/server/node_modules/env"; }
mk_escaping_symlink_deep() { ln -s ../../../../../escaped "$stage/.output/server/node_modules/better-call/node_modules/x"; }
mk_absolute_symlink() { ln -s /etc/passwd "$stage/.output/server/node_modules/passwd"; }
mk_dotdot_symlink() { ln -s .nitro/../../../.env "$stage/.output/server/node_modules/sneaky"; }
mk_dot_symlink() { ln -s . "$stage/.output/server/node_modules/self"; }
mk_symlink_outside_server() { ln -s robots.txt "$stage/migrations/link"; }
mk_hardlink() { ln "$stage/server.cjs" "$stage/.output/server/hard"; }
mk_fifo() { mkfifo "$stage/.output/server/pipe"; }
mk_extra_top_level() { echo evil > "$stage/evil.sh"; }
mk_env() { echo 'SECRET=overwritten' > "$stage/.env"; }
mk_data() { mkdir -p "$stage/data"; echo evil > "$stage/data/app.db"; }
mk_odd_name() { echo x > "$stage/.output/server/a b"; }
mk_newline_name() { echo x > "$stage/.output/server/a"$'\n'"b"; }
mk_no_entry() { rm "$stage/.output/server/index.mjs"; }
mk_symlinked_server_cjs() { rm "$stage/server.cjs"; ln -s .output/server/index.mjs "$stage/server.cjs"; }
mk_no_revision() { rm "$stage/REVISION"; }

for case in public_symlink escaping_symlink escaping_symlink_deep absolute_symlink dotdot_symlink dot_symlink \
  symlink_outside_server hardlink fifo extra_top_level env data odd_name newline_name no_entry symlinked_server_cjs no_revision; do
  with_member "$work/$case.tgz" "mk_$case"
  expect_rejected "${case//_/ }" "$work/$case.tgz"
done

# Members with absolute paths or "..", which `tar -c` won't write on its own.
new_stage
mkdir -p "$work/abs-src"; echo x > "$work/abs-src/f"
tar -cf "$work/abs.tar" -C "$stage" .
tar -rPf "$work/abs.tar" --transform="s|^$work/abs-src/f|$work/escaped|" "$work/abs-src/f"
gzip -c "$work/abs.tar" > "$work/abs.tgz"
expect_rejected "an absolute path" "$work/abs.tgz"

new_stage
tar -cf "$work/dotdot.tar" -C "$stage" .
tar -rf "$work/dotdot.tar" -C "$stage" --transform='s|^server.cjs$|.output/../../escaped|' server.cjs
gzip -c "$work/dotdot.tar" > "$work/dotdot.tgz"
expect_rejected "a '..' path" "$work/dotdot.tgz"

# A file written through a symlink earlier in the same archive.
new_stage
mkdir -p "$work/through/.output/server/node_modules/h3"
echo x > "$work/through/.output/server/node_modules/h3/extra.mjs"
tar -cf "$work/through.tar" -C "$stage" .
tar -rf "$work/through.tar" -C "$work/through" ./.output/server/node_modules/h3/extra.mjs
gzip -c "$work/through.tar" > "$work/through.tgz"
expect_rejected "a member below a symlink" "$work/through.tgz"

head -c 4096 /dev/urandom > "$work/noise.tgz"
expect_rejected "something that is not a tarball" "$work/noise.tgz"
: > "$work/empty.tgz"
expect_rejected "an empty upload" "$work/empty.tgz"

# Size limits, with the script's limits turned down.
new_root; new_stage; pack "$work/good.tgz"
sed -i 's/^readonly MAX_UPLOAD_BYTES=.*/readonly MAX_UPLOAD_BYTES=200/' "$root/deploy-receive.sh"
receive deploy "$work/good.tgz"
[[ $status == 1 && "$(cat "$root/.output/server/index.mjs")" == old ]] && pass "rejects an oversized upload: $(tail -n1 "$work/out")" || fail "oversized upload accepted"
new_root
sed -i 's/^readonly MAX_UNPACKED_BYTES=.*/readonly MAX_UNPACKED_BYTES=10/' "$root/deploy-receive.sh"
receive deploy "$work/good.tgz"
[[ $status == 1 && "$(cat "$root/.output/server/index.mjs")" == old ]] && pass "rejects a release that unpacks too large: $(tail -n1 "$work/out")" || fail "unpacked size accepted"

# --- One at a time ---------------------------------------------------------------

new_root; mkdir "$root/.deploy-lock"
receive deploy "$work/good.tgz"
[[ $status == 1 && "$(cat "$root/.output/server/index.mjs")" == old && -d "$root/.deploy-lock" ]] && pass "a held lock stops a second deploy" || fail "lock ignored"

echo
if (( failures > 0 )); then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
