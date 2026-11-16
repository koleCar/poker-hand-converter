#!/bin/zsh
# The nightly flop solves on the GTO Wizard chart sets, on the owner's machine.
# launchd starts it (`rail-floplib-out/bin/start.sh` execs it: Mon-Fri 16:00,
# Sat/Sun 00:00) and `stop.sh` kills it Mon-Fri 08:00.
#
#     tests/scripts/flop-library/nightly.sh            # from any checkout of the repo
#     RAIL_FORCE=1 tests/scripts/flop-library/nightly.sh   # also during working hours (owner's word only)
#
# Each round:
#  1. the queue (`nightlyQueue.test.ts`): the hands marked Review in the
#     desktop app on their exact flop first, then the representative flops
#     of the owner's heads-up flops by how often they were played. The
#     played part is rebuilt once per night, the review part every round, so
#     a hand marked tonight is solved next;
#  2. the next batch: the set of the first spot not solved yet, and up to
#     NIGHTLY_BATCH unsolved spots of that set in queue order. A spot whose
#     batch ran to the end twice without a chunk (a line the charts cannot
#     play, a failed solve) is left out (`tries.json`);
#  3. the flop solves (`npm run floplib -- --queue`): flop only, as the
#     library keeps them - the turn and river are solved live in the Solver;
#  4. the upload of what is new and the manifest (`upload.sh`): a chunk is
#     read by the analysis and the Solver once its set's manifest lists it.
#
# Stops on its own in working hours and below NIGHTLY_MIN_FREE_GB of disk.
set -uo pipefail
setopt nullglob

HERE=${0:A:h}
TESTS=${HERE:h:h}
OUT=${NIGHTLY_OUT:-$HOME/Projects/rail-floplib-out/gtow}
STORE=${NIGHTLY_STORE:-"$HOME/Library/Application Support/app.rail.desktop/rail.db"}
THREADS=${NIGHTLY_THREADS:-6}
MEM=${NIGHTLY_MEM:-12}
BATCH=${NIGHTLY_BATCH:-12}
MIN_FREE_GB=${NIGHTLY_MIN_FREE_GB:-20}
TREE=flop-m1
mkdir -p "$OUT"
LOG="$OUT/nightly.log"
log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }

working_hours() { local d=$(date +%u) h=$(date +%H); (( d <= 5 && 10#$h >= 8 && 10#$h < 16 )); }
free_gb() { df -g "$OUT" | awk 'NR == 2 { print $4 }'; }

queue() { # [review only]
  NIGHTLY_REVIEW_ONLY=${1:-0} NIGHTLY_STORE="$STORE" NIGHTLY_QUEUE="$OUT/queue.json" \
    npx vitest run --config scripts/flop-library/vitest.config.ts nightlyQueue > "$OUT/queue.log" 2>&1
}

# Prints the next batch's set and writes its spots to batch.json; prints nothing when the queue is done.
next_batch() {
  python3 - "$OUT" "$TREE" "$BATCH" <<'PY'
import json, os, sys
out, tree, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
queue = json.load(open(os.path.join(out, "queue.json")))
tries_file = os.path.join(out, "tries.json")
tries = json.load(open(tries_file)) if os.path.exists(tries_file) else {}
def solved(q): return os.path.exists(os.path.join(out, q["set"], tree, q["line"], q["flop"] + ".bin"))
todo, seen = [], set()
for q in queue.get("review", []) + queue.get("played", []):
    key = f'{q["set"]}/{q["line"]}/{q["flop"]}'
    if key in seen or solved(q) or tries.get(key, 0) >= 2: continue
    seen.add(key); todo.append(q)
if not todo: sys.exit(0)
target = todo[0]["set"]
batch = [q for q in todo if q["set"] == target][:size]
json.dump([{"line": q["line"], "flop": q["flop"]} for q in batch], open(os.path.join(out, "batch.json"), "w"))
print(target)
PY
}

# After a batch ran to the end: one more try for each of its spots still without a chunk.
note_tries() {
  python3 - "$OUT" "$TREE" "$1" <<'PY'
import json, os, sys
out, tree, set_id = sys.argv[1:4]
tries_file = os.path.join(out, "tries.json")
tries = json.load(open(tries_file)) if os.path.exists(tries_file) else {}
for q in json.load(open(os.path.join(out, "batch.json"))):
    if not os.path.exists(os.path.join(out, set_id, tree, q["line"], q["flop"] + ".bin")):
        key = f'{set_id}/{q["line"]}/{q["flop"]}'
        tries[key] = tries.get(key, 0) + 1
json.dump(tries, open(tries_file, "w"), indent=1)
PY
}

cd "$TESTS" || exit 1
log "start (threads $THREADS, memory $MEM GB, batch $BATCH, out $OUT)"
full=1
while true; do
  if [[ -z ${RAIL_FORCE:-} ]] && working_hours; then log "stop: working hours"; break; fi
  if (( $(free_gb) < MIN_FREE_GB )); then log "stop: under $MIN_FREE_GB GB free"; break; fi
  if (( full )); then queue 0; else queue 1; fi || { log "queue failed (see queue.log)"; break; }
  full=0
  set_id=$(next_batch)
  if [[ -z $set_id ]]; then log "queue done: nothing left to solve"; break; fi
  log "batch: $set_id $(python3 -c 'import json,sys; print(" ".join(q["line"] + "/" + q["flop"] for q in json.load(open(sys.argv[1]))))' "$OUT/batch.json")"
  nice -n 10 npm run -s floplib -- --set "$set_id" --queue "$OUT/batch.json" --out "$OUT" --threads "$THREADS" --mem "$MEM" >> "$OUT/solve.log" 2>&1
  note_tries "$set_id"
  log "solved: $(grep -c '^  done ' "$OUT/solve.log") in all; failed: $(grep -c 'FAILED' "$OUT/solve.log")"
  if [[ -f "$OUT/$set_id/$TREE/manifest.json" ]]; then
    "$HERE/upload.sh" "$OUT" "$set_id" "$TREE" >> "$OUT/upload.log" 2>&1 && log "uploaded $set_id" || log "upload of $set_id failed (see upload.log; retried next round)"
  fi
done
log "end"
