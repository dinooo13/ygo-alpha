#!/bin/bash
# The only thing the deploy key may run on the Plesk host (docs/adr/0033-deploy-key-forced-command.md).
#
# Installed by hand (never by a deploy) as <app root>/deploy-receive.sh, mode
# 700, and pinned to the deploy key in ~/.ssh/authorized_keys:
#
#   restrict,command="/ygo-alpha.de/deploy-receive.sh" ssh-ed25519 AAAA… github-actions-deploy ygo-alpha
#
# sshd then runs this script for every connection with that key and puts what
# the client asked for into SSH_ORIGINAL_COMMAND. Only these are accepted, alone
# or after this script's own path ("/ygo-alpha.de/deploy-receive.sh deploy"):
#
#   deploy    read a release tarball from stdin, check it, back up the
#             database, switch .output (old one -> .output.prev), restart
#   rollback  swap .output and .output.prev back, restart
#   version   print this script's sha256, so the deploy can tell it is current
#
# Anything else is refused. Without SSH_ORIGINAL_COMMAND (an unrestricted key
# running the script directly) the verb is the first argument.
#
# .env and data/ (apart from data/backups/) are never written.
set -euo pipefail
umask 077
export LC_ALL=C

readonly MAX_UPLOAD_BYTES=$((128 * 1024 * 1024))   # compressed tarball
readonly MAX_UNPACKED_BYTES=$((768 * 1024 * 1024)) # sum of member sizes
readonly MAX_MEMBERS=50000
readonly KEEP_BACKUPS=5

self="$(readlink -f "${BASH_SOURCE[0]}")"
root="$(dirname "$self")"
cd "$root"

die() {
  echo "deploy-receive: $*" >&2
  log "failed: $*"
  exit 1
}

log() {
  local client="${SSH_CLIENT:-local}"
  mkdir -p tmp
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${client%% *}" "$*" >> tmp/deploy.log 2>/dev/null || true
}

refuse() {
  echo "deploy-receive: refused; only 'deploy', 'rollback' and 'version' are allowed." >&2
  log "refused a command"
  exit 2
}

# --- Which verb ---------------------------------------------------------------

if [[ -n "${SSH_ORIGINAL_COMMAND+set}" ]]; then
  request="$SSH_ORIGINAL_COMMAND"
else
  request="${1:-}"
fi
if [[ "$request" =~ ^(/[A-Za-z0-9._/-]+/deploy-receive\.sh[[:space:]]+)?(deploy|rollback|version)$ ]]; then
  verb="${BASH_REMATCH[2]}"
else
  refuse
fi

if [[ "$verb" == version ]]; then
  sha256sum "$self" | cut -d' ' -f1
  exit 0
fi

# --- One deploy at a time -----------------------------------------------------

lock=.deploy-lock
if ! mkdir "$lock" 2>/dev/null; then
  die "another deploy or rollback is running (remove $root/$lock if none is)"
fi
incoming=.deploy-incoming
tarball=.deploy-incoming.tgz
cleanup() {
  rm -rf "$incoming" "$tarball"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT

# --- Steps shared by deploy and rollback --------------------------------------

lock_down_and_publish() {
  # Only the document root is served; everything else stays private to this user.
  chmod 600 server.cjs
  chmod -R go-rwx .output server
  chmod 711 .output

  # Public files into the document root (Node.js serves them too, so the short
  # gap while copying doesn't break a page). The release check keeps symlinks
  # out of .output/public, so nothing here can point outside the docroot.
  mkdir -p httpdocs
  find httpdocs -mindepth 1 -delete
  cp -R .output/public/. httpdocs/
  # The folder itself keeps Plesk's permissions; only its contents are ours.
  find httpdocs -mindepth 1 ! -type l -exec chmod u+rwX,go+rX,go-w {} +

  mkdir -p tmp
  touch tmp/restart.txt
}

# --- rollback -----------------------------------------------------------------

if [[ "$verb" == rollback ]]; then
  [[ -d .output.prev ]] || die "no .output.prev to roll back to"
  [[ -f .output.prev/server/index.mjs ]] || die ".output.prev has no server/index.mjs"
  # Swap, so a second rollback rolls forward again. Migrations stay applied;
  # data/backups/ holds the database from before each deploy.
  mv .output .output.rollback
  mv .output.prev .output
  mv .output.rollback .output.prev
  current="$(cat REVISION 2>/dev/null || echo unknown)"
  previous="$(cat REVISION.prev 2>/dev/null || echo unknown)"
  printf '%s\n' "$previous" > REVISION
  printf '%s\n' "$current" > REVISION.prev
  lock_down_and_publish
  log "rolled back to $previous"
  echo "Rolled back to $previous"
  exit 0
fi

# --- deploy: receive and check the release ------------------------------------

rm -rf "$incoming" "$tarball"
head -c "$((MAX_UPLOAD_BYTES + 1))" > "$tarball"
size="$(wc -c < "$tarball")"
(( size > 0 )) || die "no release on stdin"
(( size <= MAX_UPLOAD_BYTES )) || die "release is larger than $MAX_UPLOAD_BYTES bytes"

# One line per member: "<mode> <uid>/<gid> <size> <date> <time> <name>" plus
# " -> <target>" for a symlink. GNU tar escapes unusual characters with a
# backslash, which the name pattern below rejects, so splitting on spaces is safe.
listing="$(tar -tvzf "$tarball" --numeric-owner --quoting-style=escape)" || die "release is not a gzipped tarball"

# A path inside the release: plain components only ("node_modules",
# ".nitro", "h3@1.15.11"), never "", "." or "..".
readonly PART='\.?[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*'
readonly NAME_RE="^${PART}(/${PART})*\$"
readonly TARGET_RE="^((\.\./)*)${PART}(/${PART})*\$"

declare -A symlinks=()
declare -a names=()
total=0
count=0
while IFS= read -r line; do
  read -r -a field <<< "$line"
  mode="${field[0]}"
  count=$((count + 1))
  (( count <= MAX_MEMBERS )) || die "release has more than $MAX_MEMBERS members"

  case "${mode:0:1}" in
    -|d) (( ${#field[@]} == 6 )) || die "unexpected listing line: $line" ;;
    l)   (( ${#field[@]} == 8 )) && [[ "${field[6]}" == '->' ]] || die "unexpected listing line: $line" ;;
    *)   die "release holds a member that is not a file, directory or symlink: ${field[5]:-?}" ;;
  esac

  member_size="${field[2]}"
  [[ "$member_size" =~ ^[0-9]+$ ]] || die "unexpected listing line: $line"
  total=$((total + member_size))
  (( total <= MAX_UNPACKED_BYTES )) || die "release unpacks to more than $MAX_UNPACKED_BYTES bytes"

  name="${field[5]}"
  name="${name#./}"
  name="${name%/}"
  [[ -z "$name" && "${mode:0:1}" == d ]] && continue # the archive's own "./"
  [[ "$name" =~ $NAME_RE ]] || die "release holds a path that is absolute, has '..' or odd characters: $name"

  case "$name" in
    .output|.output/*|migrations|migrations/*) ;;
    server.cjs|REVISION) [[ "${mode:0:1}" == - ]] || die "$name must be a regular file" ;;
    *) die "release holds something other than .output, migrations, server.cjs and REVISION: $name" ;;
  esac

  if [[ "${mode:0:1}" == l ]]; then
    target="${field[7]}"
    # Nitro links duplicate packages inside .output/server/node_modules
    # (node_modules/h3 -> .nitro/h3@1.15.11). Nothing else needs one, and
    # .output/public is copied into the docroot.
    [[ "$name" == .output/server/* ]] || die "symlink outside .output/server: $name"
    # Relative only: a run of "../", then plain components, and it must not
    # climb out of .output/server from the link's own directory.
    [[ "$target" =~ $TARGET_RE ]] || die "symlink $name points to an absolute path or uses '.'/'..' inside: $target"
    ups="${BASH_REMATCH[1]}"
    up_count=$(( ${#ups} / 3 ))
    slashes="${name//[^\/]/}"
    (( up_count <= ${#slashes} - 2 )) || die "symlink $name points outside .output/server: $target"
    symlinks["$name"]=1
  fi
  names+=("$name")
done <<< "$listing"

# No member may sit below a symlink: then every link's directory is a real
# one, and the "../" check above means what it says.
for name in "${names[@]}"; do
  parent="$name"
  while [[ "$parent" == */* ]]; do
    parent="${parent%/*}"
    [[ -z "${symlinks[$parent]+set}" ]] || die "$name lies below the symlink $parent"
  done
done

mkdir "$incoming"
tar -xzf "$tarball" -C "$incoming" --no-same-owner --no-same-permissions
rm -f "$tarball"
[[ -f "$incoming/.output/server/index.mjs" ]] || die "release has no .output/server/index.mjs"
[[ -d "$incoming/.output/public" ]] || die "release has no .output/public"
[[ -d "$incoming/migrations" ]] || die "release has no migrations"
[[ -f "$incoming/server.cjs" ]] || die "release has no server.cjs"
[[ -f "$incoming/REVISION" ]] || die "release has no REVISION"
revision="$(head -c 64 "$incoming/REVISION" | tr -dc 'A-Za-z0-9._-')"
[[ -n "$revision" ]] || die "REVISION is empty"

# --- deploy: switch over --------------------------------------------------------

# Database backup before the restart runs any new migration; keep the last 5.
if [[ -f data/app.db ]]; then
  backup="data/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  cp -p data/app.db* "$backup/"
  find data/backups -mindepth 1 -maxdepth 1 -type d | sort | head -n "-$KEEP_BACKUPS" | xargs -r rm -rf
fi

# The previous build stays as .output.prev for `rollback`.
rm -rf .output.prev
if [[ -d .output ]]; then mv .output .output.prev; fi
mv "$incoming/.output" .output
mkdir -p server/db
rm -rf server/db/migrations
mv "$incoming/migrations" server/db/migrations
mv "$incoming/server.cjs" server.cjs
if [[ -f REVISION ]]; then mv REVISION REVISION.prev; fi
printf '%s\n' "$revision" > REVISION

lock_down_and_publish
log "deployed $revision"
echo "Switched to $revision"
