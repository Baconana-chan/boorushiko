#!/usr/bin/env bash
# End-to-end smoke test: builds are done by the caller, this starts the compiled
# engine on a scratch database, seeds demo posts and walks the public surface
# plus one authenticated favorite round-trip. No network and no mirrors.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

tmp="$(mktemp -d)"
port="${SMOKE_PORT:-3123}"
base="http://127.0.0.1:${port}"
pid=""

cleanup() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

export DB_PATH="$tmp/smoke.db"
export STAGING_DIR="$tmp/staging"
export PORT="$port"
export HOST="127.0.0.1"
export PUBLIC_BASE_URL="$base"
export UPLOAD_TOKEN="smoke-token-smoke-token"
export MIRRORS="catbox"
export LOG_LEVEL="error"
export BACKUP_ENABLED="0"
export MONITOR_ENABLED="0"
export SOURCE_AUTO_ENABLED="0"
export RATE_LIMIT_ENABLED="0"

echo "smoke: seeding demo posts into $DB_PATH"
npx tsx scripts/seed-demo.ts >/dev/null

echo "smoke: starting the built engine on $base"
node dist/index.js >"$tmp/server.log" 2>&1 &
pid=$!

ready=""
for _ in $(seq 1 60); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "smoke: server exited during startup" >&2
    cat "$tmp/server.log" >&2
    exit 1
  fi
  if curl -fsS --max-time 2 "$base/healthz" >/dev/null 2>&1; then
    ready="yes"
    break
  fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "smoke: /healthz did not answer within 30s" >&2
  cat "$tmp/server.log" >&2
  exit 1
fi

fail() {
  echo "smoke: $1" >&2
  cat "$tmp/server.log" >&2
  exit 1
}

expect_ok() {
  local path="$1"
  local code
  code="$(curl -s -o "$tmp/body" -w '%{http_code}' --max-time 5 "$base$path")"
  [ "$code" = "200" ] || fail "GET $path returned $code (expected 200)"
  echo "  ok  GET $path"
}

expect_contains() {
  local path="$1"
  local needle="$2"
  expect_ok "$path"
  grep -q -- "$needle" "$tmp/body" || fail "GET $path did not contain '$needle'"
}

echo "smoke: public surface"
expect_contains "/healthz" '"ok":true'
expect_contains "/readyz" '"ok":true'
expect_contains "/api/v1/posts?limit=5" '"posts"'
expect_contains "/api/v1/posts/1" '"url":"/i/1"'
expect_contains "/api/v1/posts/1/related" '"postId":1'
expect_contains "/api/v1/posts/random?rating_mode=safe" '"post"'
expect_contains "/api/v1/pools" '"pools"'
expect_contains "/api/v1/tags?search=nekotime" '"tags"'
expect_contains "/api/v1/stats" '"posts"'
expect_contains "/api/v1/openapi.json" 'openapi'
expect_contains "/feed.xml" '<rss version="2.0"'
expect_contains "/post/1" 'property="og:title"'
expect_contains "/robots.txt" 'Sitemap:'
expect_contains "/sitemap.xml" '<sitemapindex'
expect_contains "/.well-known/security.txt" 'Contact:'

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/i/1")"
[ "$code" = "302" ] || fail "GET /i/1 returned $code (expected 302)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/t/1")"
[ "$code" = "302" ] || fail "GET /t/1 returned $code (expected 302)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/api/v1/me/favorites")"
[ "$code" = "401" ] || fail "guest favorites returned $code (expected 401)"
echo "  ok  /i/1 and /t/1 redirect, guest favorites 401"

echo "smoke: account and favorites"
code="$(curl -s -c "$tmp/cookies.txt" -o /dev/null -w '%{http_code}' --max-time 5 \
  -X POST "$base/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d '{"username":"smoke_user","password":"smoke-password"}')"
[ "$code" = "201" ] || fail "registration returned $code (expected 201)"

code="$(curl -s -b "$tmp/cookies.txt" -o "$tmp/body" -w '%{http_code}' --max-time 5 \
  -X POST "$base/api/v1/posts/1/favorite")"
[ "$code" = "200" ] || fail "favorite returned $code (expected 200)"
grep -q '"favorited":true' "$tmp/body" || fail "favorite response did not confirm the save"

code="$(curl -s -b "$tmp/cookies.txt" -o "$tmp/body" -w '%{http_code}' --max-time 5 \
  "$base/api/v1/me/favorites")"
[ "$code" = "200" ] || fail "favorites list returned $code (expected 200)"
grep -q '"id":1' "$tmp/body" || fail "favorites list did not contain post 1"
echo "  ok  register, save favorite, list it"

echo "smoke: passed"
