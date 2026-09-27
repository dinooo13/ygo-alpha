#!/usr/bin/env bash
# Deploys the current checkout to the Plesk Node.js host (docs/adr/0028-plesk-deployment.md).
#
#   DEPLOY_SSH=user@host DEPLOY_PATH=/example.com DEPLOY_URL=https://example.com scripts/deploy-plesk.sh
#
# DEPLOY_SSH   SSH target; the key must already be loaded (ssh-agent, ~/.ssh).
# DEPLOY_PATH  the app root on the server, as the SSH session sees it. It holds
#              server.cjs, .env, data/ and .output/, and httpdocs/ (the document root).
# DEPLOY_URL   optional; checked for a 200 on /login after the restart.
# DEPLOY_NODE_ABI  Node ABI of the server's Node.js (default 137 = Node 24).
# DEPLOY_ALLOW_DIRTY=1  deploy with uncommitted changes (local runs only).
#
# The server has no Node.js in the SSH shell and no rsync: the build happens
# here, better-sqlite3's native addon is swapped for the official linux-x64
# build, and the release goes up as a tarball. .env and data/ are never touched.
set -euo pipefail

: "${DEPLOY_SSH:?set DEPLOY_SSH (user@host)}"
: "${DEPLOY_PATH:?set DEPLOY_PATH (app root on the server)}"
NODE_ABI="${DEPLOY_NODE_ABI:-137}"

if [[ ! "$DEPLOY_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "DEPLOY_PATH must be an absolute path of letters, digits, '.', '_', '-' and '/'." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" && "${DEPLOY_ALLOW_DIRTY:-}" != 1 ]]; then
  echo "Uncommitted changes; commit them or set DEPLOY_ALLOW_DIRTY=1." >&2
  exit 1
fi
revision="$(git rev-parse HEAD)"
echo "Deploying $(git log -1 --format='%h %s')"

ssh_run() {
  ssh -o BatchMode=yes "$DEPLOY_SSH" "$@"
}

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

echo "== Upload"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C "$stage" . \
  | ssh_run "set -e; cd '$DEPLOY_PATH'; rm -rf .deploy-incoming; mkdir .deploy-incoming; tar -xzf - -C .deploy-incoming"

echo "== Switch over"
ssh_run bash -s -- "$DEPLOY_PATH" <<'REMOTE'
set -euo pipefail
cd "$1"
incoming=.deploy-incoming
test -f "$incoming/.output/server/index.mjs"

# Database backup before the restart runs any new migration; keep the last 5.
if [ -f data/app.db ]; then
  backup="data/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  cp -p data/app.db* "$backup/"
  ls -1d data/backups/*/ | sort | head -n -5 | xargs -r rm -rf
fi

# The previous build stays as .output.prev for a manual rollback.
rm -rf .output.prev
if [ -d .output ]; then mv .output .output.prev; fi
mv "$incoming/.output" .output
mkdir -p server/db
rm -rf server/db/migrations
mv "$incoming/migrations" server/db/migrations
mv "$incoming/server.cjs" server.cjs
mv "$incoming/REVISION" REVISION
rmdir "$incoming"

# Only the document root is served; everything else stays private to this user.
chmod 600 server.cjs
chmod -R go-rwx .output server
chmod 711 .output

# Public files into the document root (Node.js serves them too, so the short
# gap while copying doesn't break a page).
mkdir -p httpdocs
find httpdocs -mindepth 1 -delete
cp -R .output/public/. httpdocs/
chmod -R u+rwX,go+rX,go-w httpdocs

mkdir -p tmp
touch tmp/restart.txt
REMOTE

if [[ -n "${DEPLOY_URL:-}" ]]; then
  echo "== Health check"
  for attempt in $(seq 1 20); do
    status="$(curl -sL -o /dev/null -w '%{http_code}' --max-time 20 "$DEPLOY_URL/login" || true)"
    if [[ "$status" == 200 ]]; then
      echo "/login answers 200"
      break
    fi
    if [[ "$attempt" == 20 ]]; then
      echo "/login still answers $status; see tmp/startup.log on the server." >&2
      exit 1
    fi
    sleep 3
  done
fi

echo "Deployed $revision"
