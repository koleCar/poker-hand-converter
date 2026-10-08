# The flop library batch runner (A5b)

Solves the flop library offline: every (preflop line, representative flop)
pair as a flop + turn + river game, keeping the flop-level strategies and EVs
as one chunk per pair (`frontend/src/lib/solver/flopLibrary.ts` has the
format, `docs/ANALYSIS-PLAN.md` §10 A5b the decisions and the pilot's numbers).

Not part of `npm test`: a solve takes minutes and a full run takes days.

```bash
cd tests
npm run floplib -- --estimate                       # what the full run costs, fitted on what is solved
npm run floplib -- --only 4 --threads 4             # the first four jobs of the queue
npm run floplib -- --lines btn-bb,btn-bb-3bet --flops Ts7h4d,AsKh7d --threads 4 --mem 8
npm run floplib -- --validate                       # mapped flops against their representatives
npm run floplib                                     # the full run: 12 lines x 100 flops
```

| Option | Default | |
|---|---|---|
| `--out DIR` | `tests/scripts/flop-library/out` (git-ignored) | where chunks go: `<out>/<set>/<tree>/<line>/<flop>.bin` |
| `--set ID` | `nlhe-cash-6max-100bb` | the chart set (`frontend/src/lib/charts/data/<ID>.json`) the ranges come from |
| `--lines a,b` | all 12 `FLOP_LINES` | line ids |
| `--flops a,b` | the 100 representatives, most-covering first | any flops (any suits; canonicalised) |
| `--only N` | all | the first N jobs of the queue (flops in order, each with every line) |
| `--threads N` | half the cores | solves at a time, one process each |
| `--mem GB` | half the RAM | no new solve starts while the predicted memory of those running would pass it |
| `--progress S` | 60 | seconds between progress lines per solve |
| `--dry` | | list the jobs to run and stop |
| `--estimate` | | print the full-run estimate and stop |
| `--validate` | | compare every solved non-representative flop with its representative, by hand category |

**Resumable.** Each solve runs in its own process and writes its chunk and a
stats file (`<flop>.json`: iterations, exploitability, time, memory)
atomically when it finishes. A job whose chunk exists is done; Ctrl-C kills
the solves in flight and loses only those. `manifest.json` is rebuilt from the
stats files after every solve.

**Deterministic.** A chunk depends only on its job: the chart set's ranges for
the line, the flop, the profile (`FLOP_PROFILE`). The same job writes the same
bytes on any machine; times and memory live in the stats and the manifest only.

**Memory.** A solve holds 0.2-2.5 GB (16-bit storage, `SolverConfig.storage`),
the widest single-raised and limped pots the most. The runner predicts each
job's peak from its two ranges and the turn cards it deals, calibrated on the
solves already finished, and keeps the total under `--mem`.

**The pilot** (`pilot/`, committed, < 1 MB) is ten chunks of the full run on
`charts/4` - the BTN-BB single-raised pot and its 3-bet pot on Ts7h4d, AsKh7d,
Qs8s4h, Ks6s3s and KhKs9d - copied from the run's `out/` with the manifest
filtered to them. `tests/test/flopLibraryPilot.test.ts` checks it and grades
real hands from it. A new chart set (its model hash) or tree makes it stale:
copy the same ten chunks from a new full run (or re-solve them with
`--lines btn-bb,btn-bb-3bet --flops Ts7h4d,AsKh7d,Qs8s4h,Ks6s3s,KhKs9d`).

**Serving.** The full 6-max 100bb run (1,200 chunks, 86 MB) is in the
public, read-only Storage bucket `flop-library` (migration
`20270331090000_flop_library_bucket.sql`: no client policy, so nobody but
the service role can list or write). The analysis worker fetches
`<supabase>/storage/v1/object/public/flop-library/<set>/<tree>/manifest.json`
and then single chunks on demand (`FlopLibraryLoader`, `flopLibraryBase`);
they are never bundled into a page. Upload a run with

```bash
tests/scripts/flop-library/upload.sh ~/Projects/rail-floplib-out nlhe-cash-6max-100bb
```

on the owner's machine: it fetches the service-role key from the Management
API with the CLI's token (keychain), keeps it in the process, uploads the
chunks and then the manifest.

**Measuring a library on stored hands.** `npm run floplib:measure` analyses a
JSONL export of PHF hands (`FLOPLIB_HANDS`) with and without a local library
(`FLOPLIB_DIR`, the runner's `--out`) and reports how the hero's flop grades
change; `FLOPLIB_TURN_SAMPLE=N` adds the turn and river of the first N hands.
