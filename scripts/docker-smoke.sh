#!/usr/bin/env bash
# Smoke test for the Docker setup (compose.yaml, Dockerfile), run by
# .github/workflows/docker.yml. Builds the image once, then starts it the way
# a self-hoster would: a custom host port, a data folder outside the
# checkout, the image's own user and a Synology-style uid:gid. Each run signs
# up, restarts and signs in again, so the database must persist in the host
# folder.
#
# Needs Docker with Compose >= 2.24, curl, jq and sudo (the data folders
# belong to other uids). Run it from a checkout without a `.env`: compose.yaml
# hands that file to the container, which would change what is tested.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=ygo-alpha-smoke
tmp=$(mktemp -d)
env_file="$tmp/smoke.env"
secret=$(openssl rand -hex 32)

# Shell variables win over the env file in Compose interpolation.
unset NUXT_BETTER_AUTH_SECRET NUXT_PUBLIC_BETTER_AUTH_URL \
  YGO_ALPHA_PORT YGO_ALPHA_DATA_DIR YGO_ALPHA_USER \
  COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES

if [ -e "$repo/.env" ]; then
  echo "error: $repo/.env exists; compose.yaml passes it to the container." >&2
  echo "Run this in a clean checkout (as CI does) or move .env aside." >&2
  exit 1
fi

compose() {
  docker compose -f "$repo/compose.yaml" -p "$project" --env-file "$env_file" "$@"
}

cleanup() {
  local status=$?
  if [ -s "$env_file" ]; then
    if [ "$status" -ne 0 ]; then
      echo "::group::docker compose logs"
      compose logs --no-color || true
      echo "::endgroup::"
    fi
    compose down -v --rmi local >/dev/null 2>&1 || true
  fi
  sudo rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# write_env <port> <data dir> [<uid:gid>]: the settings a self-hoster would
# put in .env. Empty port/dir = leave the compose default.
write_env() {
  {
    echo "NUXT_BETTER_AUTH_SECRET=$secret"
    if [ -n "$1" ]; then echo "YGO_ALPHA_PORT=$1"; fi
    if [ -n "$2" ]; then echo "YGO_ALPHA_DATA_DIR=$2"; fi
    if [ -n "${3:-}" ]; then echo "YGO_ALPHA_USER=$3"; fi
  } > "$env_file"
}

# assert_config <port> <data dir> <uid:gid or empty>: what Compose makes of the
# env file. Empty user = none set, so the image's own user applies.
assert_config() {
  compose config --format json | jq -e \
    --arg port "$1" --arg data "$2" --arg user "$3" '
      .services.app as $app
      | ($app.ports | length) == 1
      and ($app.ports[0].published | tostring) == $port
      and ($app.ports[0].target | tostring) == "3000"
      and $app.environment.NUXT_PUBLIC_BETTER_AUTH_URL == "http://localhost:\($port)"
      and $app.environment.NITRO_PORT == "3000"
      and $app.environment.NUXT_DB_FILE_PATH == "/app/data/app.db"
      and ($app.user // "") == $user
      and $app.volumes[0].source == $data
      and $app.volumes[0].target == "/app/data"
    ' > /dev/null || {
    compose config >&2
    fail "compose config does not match port $1, data $2, user $3"
  }
}

wait_for_login() {
  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://localhost:$1/login" 2> /dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "http://localhost:$1/login did not answer within 90 s"
}

# auth <path> <origin> <json body>: prints the HTTP status. Better Auth checks
# the Origin header against NUXT_PUBLIC_BETTER_AUTH_URL; the Sec-Fetch-*
# headers make the request look like a browser's.
auth() {
  curl -sS -o "$tmp/response.json" -w '%{http_code}' \
    -X POST "http://localhost:$port/api/auth/$1" \
    -H 'Content-Type: application/json' \
    -H "Origin: $2" \
    -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: cors' -H 'Sec-Fetch-Dest: empty' \
    --data "$3"
}

expect_status() {
  local want=$1 got=$2 what=$3
  if [ "$got" != "$want" ]; then
    cat "$tmp/response.json" >&2 || true
    fail "$what: HTTP $got, expected $want"
  fi
}

docker compose version

echo "== Configuration"
: > "$env_file"
if compose config > /dev/null 2> "$tmp/config.err"; then
  fail "compose config accepted a missing NUXT_BETTER_AUTH_SECRET"
fi
grep -q 'Set NUXT_BETTER_AUTH_SECRET' "$tmp/config.err" ||
  fail "unexpected error without a secret: $(cat "$tmp/config.err")"
write_env '' ''
assert_config 3000 "$repo/data" ''

echo "== Build"
compose build

port3000_was_free=true
if curl -s -o /dev/null --max-time 3 http://localhost:3000/; then
  port3000_was_free=false
fi

# scenario <name> <port> <uid:gid> <user flag>: <user flag> 'default' leaves
# YGO_ALPHA_USER unset.
scenario() {
  local name=$1 uid_gid=$3 user_flag=$4
  port=$2
  local data="$tmp/data-$name"
  local url="http://localhost:$port"
  local email="smoke-$name@example.com" password="smoke-password-$name"
  echo "== Scenario $name: port $port, user $uid_gid"

  mkdir -p "$data"
  sudo chown "$uid_gid" "$data"
  if [ "$user_flag" = default ]; then
    write_env "$port" "$data"
    assert_config "$port" "$data" ''
  else
    write_env "$port" "$data" "$uid_gid"
    assert_config "$port" "$data" "$uid_gid"
  fi

  compose up -d --no-build
  wait_for_login "$port"

  sudo test -s "$data/app.db" || fail "$data/app.db is missing or empty"
  [ "$(sudo stat -c %u:%g "$data/app.db")" = "$uid_gid" ] ||
    fail "app.db belongs to $(sudo stat -c %u:%g "$data/app.db"), expected $uid_gid"
  [ "$(compose exec -T app sh -c 'echo "$(id -u):$(id -g)"')" = "$uid_gid" ] ||
    fail "the app does not run as $uid_gid"
  if $port3000_was_free && curl -s -o /dev/null --max-time 3 http://localhost:3000/; then
    fail "something answers on host port 3000"
  fi

  local body
  body=$(jq -nc --arg e "$email" --arg p "$password" --arg n "Smoke $name" \
    '{email: $e, password: $p, name: $n}')
  expect_status 200 "$(auth sign-up/email "$url" "$body")" "sign-up"

  # Login from any other origin than NUXT_PUBLIC_BETTER_AUTH_URL is refused
  # (the docs' "URL rule").
  local login
  login=$(jq -nc --arg e "$email" --arg p "$password" '{email: $e, password: $p}')
  expect_status 403 "$(auth sign-in/email "http://127.0.0.1:$port" "$login")" "sign-in from another origin"

  compose down
  compose up -d --no-build
  wait_for_login "$port"
  expect_status 200 "$(auth sign-in/email "$url" "$login")" "sign-in after a restart"
  jq -e --arg e "$email" '.user.email == $e' "$tmp/response.json" > /dev/null ||
    fail "sign-in answered without the user"

  compose down
}

scenario default 8765 1001:1001 default
scenario synology 8766 1026:100 custom

echo "Docker smoke test passed."
