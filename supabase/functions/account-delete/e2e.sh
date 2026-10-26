#!/usr/bin/env bash
# The account deletion end to end against a LOCAL Supabase stack
# (docs/RAIL-PLAN.md R6.5). Never against production: it creates a user and
# deletes it.
#
# Usage: supabase/functions/account-delete/e2e.sh <workdir>
#
# <workdir> holds a copy of this repository's `supabase/` folder with its own
# `project_id` and ports, started (with storage) and serving the functions -
# see `../desktop-handoff/e2e.sh` for the setup and why `.temp` goes:
#
#   supabase start --workdir "$WORKDIR" -x studio,imgproxy,logflare,vector,supavisor,postgres-meta
#   supabase functions serve --workdir "$WORKDIR" &
#
# The checks are in `e2e.ts`. Prints no key, token or password.
set -euo pipefail

workdir="${1:?usage: e2e.sh <supabase workdir>}"
here="$(cd "$(dirname "$0")" && pwd)"

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

RAIL_E2E_URL="$api_url" RAIL_E2E_ANON_KEY="$anon_key" RAIL_E2E_SERVICE_KEY="$service_key" \
  deno run --allow-net --allow-env=RAIL_E2E_URL,RAIL_E2E_ANON_KEY,RAIL_E2E_SERVICE_KEY,RAIL_E2E_FUNCTIONS_URL "$here/e2e.ts"
