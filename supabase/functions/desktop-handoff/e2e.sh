#!/usr/bin/env bash
# The desktop sign-in end to end against a LOCAL Supabase stack
# (docs/RAIL-PLAN.md R1.7). Never against production: it creates a user.
#
# Usage: supabase/functions/desktop-handoff/e2e.sh <workdir>
#
# <workdir> holds a copy of this repository's `supabase/` folder with its own
# `project_id` and ports, started and serving the function:
#
#   cp -R supabase "$WORKDIR/"          # then edit project_id and the ports
#   rm -rf "$WORKDIR/supabase/.temp"     # see below
#   supabase start --workdir "$WORKDIR" -x studio,imgproxy,logflare,vector,supavisor,postgres-meta,realtime,storage-api,mailpit
#   supabase functions serve --workdir "$WORKDIR" &
#
# Why `.temp` goes: it pins the linked project's GoTrue (v2.187.0), and with
# CLI 2.75's local keys (an ES256 signing key next to the legacy HS256 service
# key) that GoTrue refuses the service-role key on every admin call ("signing
# method HS256 is invalid"), so neither this script nor the function's
# generate_link works. The CLI's own default GoTrue (v2.186.0) accepts both.
#
# What it does: reads the stack's URL and keys from `supabase status`, creates
# a fresh confirmed user through the local admin API, and runs
# `cargo run -p rail-sync --example desktop_sign_in_e2e` (see that file for the
# checks). Prints no key, token or password.
set -euo pipefail

workdir="${1:?usage: e2e.sh <supabase workdir>}"
repo="$(cd "$(dirname "$0")/../../.." && pwd)"

status_env="$(supabase status -o env --workdir "$workdir" 2>/dev/null)"
value() { printf '%s\n' "$status_env" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -n 1; }
api_url="$(value API_URL)"
anon_key="$(value ANON_KEY)"
service_key="$(value SERVICE_ROLE_KEY)"
if [ -z "$api_url" ] || [ -z "$anon_key" ] || [ -z "$service_key" ]; then
  echo "could not read the stack's URL and keys from 'supabase status' in $workdir" >&2
  exit 1
fi
case "$api_url" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "refusing: $api_url is not a local stack" >&2; exit 1 ;;
esac

email="desktop-e2e-$(date +%s)-$RANDOM@example.test"
password="$(openssl rand -hex 16)"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$api_url/auth/v1/admin/users" \
  -H "apikey: $service_key" -H "Authorization: Bearer $service_key" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}")"
if [ "$code" != "200" ]; then
  echo "could not create the test user (HTTP $code)" >&2
  exit 1
fi
echo "test user: $email"

cd "$repo"
RAIL_E2E_SUPABASE_URL="$api_url" RAIL_E2E_ANON_KEY="$anon_key" \
RAIL_E2E_EMAIL="$email" RAIL_E2E_PASSWORD="$password" \
  cargo run --quiet -p rail-sync --example desktop_sign_in_e2e
