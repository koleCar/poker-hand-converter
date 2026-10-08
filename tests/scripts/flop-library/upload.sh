#!/bin/zsh
# Uploads a solved flop library to the public, read-only Storage bucket
# `flop-library` (migration 20270331090000), under the layout the analysis
# worker reads: <set>/<tree>/manifest.json and <set>/<tree>/<line>/<flop>.bin.
#
#     tests/scripts/flop-library/upload.sh <out-dir> <set> [tree]
#     tests/scripts/flop-library/upload.sh ~/Projects/rail-floplib-out nlhe-cash-6max-100bb
#
# Run by the owner on their own machine. The service-role key is fetched
# from the Supabase Management API with the CLI's personal access token
# (macOS keychain), lives only in this process and a 0600 temp header file
# deleted on exit, and is never printed. Chunks first, the manifest last, so
# a half-finished upload never lists a chunk that is not there yet.
set -euo pipefail
setopt nullglob

OUT=${1:?out dir}; SET=${2:?chart set id}; TREE=${3:-flop-m1}
REF=${SUPABASE_PROJECT_REF:-riybwcfnclphacnfawiq}
URL="https://$REF.supabase.co/storage/v1/object/flop-library"
DIR="$OUT/$SET/$TREE"
[[ -f "$DIR/manifest.json" ]] || { echo "no manifest at $DIR" >&2; exit 1; }

PAT=$(security find-generic-password -s "Supabase CLI" -a supabase -w | sed 's/^go-keyring-base64://' | base64 -d)
HEADERS=$(mktemp); chmod 600 "$HEADERS"; trap 'rm -f "$HEADERS"' EXIT
curl -sSf "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" -H "Authorization: Bearer $PAT" \
  | python3 -c '
import json, sys
keys = json.load(sys.stdin)
key = next((k["api_key"] for k in keys if k.get("name") == "service_role"), None) \
   or next((k["api_key"] for k in keys if k.get("type") == "secret" and k.get("api_key")), None)
if not key: sys.exit("no service-role key returned")
print(f"Authorization: Bearer {key}\napikey: {key}")
' > "$HEADERS"
unset PAT

upload() { # <local file> <object path> <content type>
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL/$2" -H @"$HEADERS" \
    -H "x-upsert: true" -H "Content-Type: $3" -H "cache-control: max-age=86400" --data-binary @"$1")
  [[ $code == 200 ]] || { echo "upload $2: HTTP $code" >&2; return 1; }
}

PATHS=$(python3 -c 'import json,sys; print("\n".join(e["path"] for e in json.load(open(sys.argv[1]))["entries"]))' "$DIR/manifest.json")
total=$(print -r -- "$PATHS" | wc -l | tr -d ' ')
n=0
for p in ${(f)PATHS}; do
  upload "$DIR/$p" "$SET/$TREE/$p" application/octet-stream &
  n=$((n + 1))
  (( n % 8 == 0 )) && wait
  (( n % 200 == 0 )) && echo "$n / $total"
done
wait
upload "$DIR/manifest.json" "$SET/$TREE/manifest.json" application/json
echo "uploaded $total chunks and the manifest to flop-library/$SET/$TREE"
