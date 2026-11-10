#!/usr/bin/env bash
# Deploys the current checkout to the Plesk Node.js host (docs/adr/0028-plesk-deployment.md).
#
#   DEPLOY_SSH=user@host DEPLOY_PATH=/example.com DEPLOY_URL=https://example.com scripts/deploy-plesk.sh
#   … scripts/deploy-plesk.sh --rollback   # swap .output and .output.prev back
#
# DEPLOY_SSH   SSH target; the key must already be loaded (ssh-agent, ~/.ssh).
# DEPLOY_PATH  the app root on the server, as the SSH session sees it. It holds
#              server.cjs, .env, data/ and .output/, and httpdocs/ (the document root).
# DEPLOY_URL   optional; checked for a 200 on /login after the restart.
# DEPLOY_NODE_ABI  Node ABI of the server's Node.js (default 137 = Node 24).
# DEPLOY_ALLOW_DIRTY=1  deploy with uncommitted changes (local runs only).
# DEPLOY_REQUIRE_LOCKED_KEY=1  fail unless the key can run nothing but the
#              receive script (set in CI, docs/adr/0033-deploy-key-forced-command.md).
#
# The server has no Node.js in the SSH shell and no rsync: the build happens
# here, better-sqlite3's native addon is swapped for the official linux-x64
# build, and the release goes up as a tarball to deploy/plesk/receive.sh,
# installed on the server as $DEPLOY_PATH/deploy-receive.sh. That script checks
# it and switches over. .env and data/ are never touched.
set -euo pipefail

mode=deploy
case "${1:-}" in
  '') ;;
  --rollback) mode=rollback ;;
  *) echo "usage: $0 [--rollback]" >&2; exit 1 ;;
esac

: "${DEPLOY_SSH:?set DEPLOY_SSH (user@host)}"
: "${DEPLOY_PATH:?set DEPLOY_PATH (app root on the server)}"
NODE_ABI="${DEPLOY_NODE_ABI:-137}"

if [[ ! "$DEPLOY_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "DEPLOY_PATH must be an absolute path of letters, digits, '.', '_', '-' and '/'." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

ssh_run() {
  ssh -o BatchMode=yes "$DEPLOY_SSH" "$@"
}

# With the deploy key the server ignores the path and only reads the verb
# (forced command); an unrestricted key runs the script itself.
receive="$DEPLOY_PATH/deploy-receive.sh"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

echo "== Check the server's receive script"
expected="$(sha256 deploy/plesk/receive.sh)"
installed="$(ssh_run "$receive version" < /dev/null || true)"
if [[ "$installed" != "$expected" ]]; then
  echo "The server's $receive is missing or differs from deploy/plesk/receive.sh" >&2
  echo "(server: ${installed:-none}, here: $expected). Install it by hand; see docs/adr/0033-deploy-key-forced-command.md." >&2
  exit 1
fi
if [[ "${DEPLOY_REQUIRE_LOCKED_KEY:-}" == 1 ]]; then
  # The forced command answers anything but its verbs with exit 2 and runs nothing.
  set +e
  probe="$(ssh_run 'id' < /dev/null 2>&1)"
  probe_status=$?
  set -e
  if [[ "$probe_status" != 2 || "$probe" == *uid=* ]]; then
    echo "The deploy key can still run other commands (exit $probe_status); expected the forced command to refuse 'id'." >&2
    exit 1
  fi
  echo "The key runs the receive script only"
fi

health_check() {
  [[ -n "${DEPLOY_URL:-}" ]] || return 0
  echo "== Health check"
  for attempt in $(seq 1 20); do
    status="$(curl -sL -o /dev/null -w '%{http_code}' --max-time 20 "$DEPLOY_URL/login" || true)"
    if [[ "$status" == 200 ]]; then
      echo "/login answers 200"
      return 0
    fi
    if [[ "$attempt" == 20 ]]; then
      echo "/login still answers $status; see tmp/startup.log on the server." >&2
      exit 1
    fi
    sleep 3
  done
}

if [[ "$mode" == rollback ]]; then
  echo "== Roll back"
  ssh_run "$receive rollback" < /dev/null
  health_check
  exit 0
fi

if [[ -n "$(git status --porcelain)" && "${DEPLOY_ALLOW_DIRTY:-}" != 1 ]]; then
  echo "Uncommitted changes; commit them or set DEPLOY_ALLOW_DIRTY=1." >&2
  exit 1
fi
revision="$(git rev-parse HEAD)"
echo "Deploying $(git log -1 --format='%h %s')"

echo "== Build"
pnpm build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

echo "== Stage the release"
cp -R .output "$stage/.output"
cp -R server/db/migrations "$stage/migrations"
cp deploy/plesk/server.cjs "$stage/server.cjs"
echo "$revision" > "$stage/REVISION"

# The build's better-sqlite3 addon is compiled for this machine; the server
# needs the official prebuilt one for linux-x64 and its Node ABI. A local
# compile on a newer distro could also need a newer glibc than the server has.
addon_dir="$stage/.output/server/node_modules/better-sqlite3"
sqlite_version="$(node -p "require('./.output/server/node_modules/better-sqlite3/package.json').version")"
prebuild="better-sqlite3-v${sqlite_version}-node-v${NODE_ABI}-linux-x64.tar.gz"
curl -fsSL -o "$stage/prebuild.tgz" "https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqlite_version}/${prebuild}"
tar -xzf "$stage/prebuild.tgz" -C "$stage" build/Release/better_sqlite3.node
cp "$stage/build/Release/better_sqlite3.node" "$addon_dir/build/Release/better_sqlite3.node"
rm -rf "$stage/prebuild.tgz" "$stage/build"
if ! file "$addon_dir/build/Release/better_sqlite3.node" | grep -q 'ELF 64-bit.*x86-64'; then
  echo "better-sqlite3 addon is not a linux-x64 build." >&2
  exit 1
fi
echo "better-sqlite3 ${sqlite_version}: linux-x64, Node ABI ${NODE_ABI}"

echo "== Upload and switch over"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C "$stage" . | ssh_run "$receive deploy"

health_check

echo "Deployed $revision"
