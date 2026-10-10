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
npm run floplib -- --validate --loo                 # each representative from its nearest other one (held out)
npm run floplib                                     # the full run: 12 lines x 100 flops
```

| Option | Default | |
|---|---|---|
| `--out DIR` | `tests/scripts/flop-library/out` (git-ignored) | where chunks go: `<out>/<set>/<tree>/<line>/<flop>.bin` |
| `--set ID` | `nlhe-cash-6max-100bb` | the chart set (`frontend/src/lib/charts/data/<ID>.json`) the ranges come from |
| `--lines a,b` | every line of the set's table (`flopLinesFor`: 12 for 6-max, 13 for the 9-max sets) | line ids |
| `--flops a,b` | the 100 representatives, most-covering first | any flops (any suits; canonicalised) |
| `--only N` | all | the first N jobs of the queue (flops in order, each with every line) |
| `--threads N` | half the cores | solves at a time, one process each |
| `--mem GB` | half the RAM | no new solve starts while the predicted memory of those running would pass it |
| `--progress S` | 60 | seconds between progress lines per solve |
| `--dry` | | list the jobs to run and stop |
| `--estimate` | | print the full-run estimate and stop |
| `--validate` | | compare every solved non-representative flop with its representative, by hand category (the analysis's reading and the coarse one before `analysis/12`, with medians) |
| `--loo` | | with `--validate`: read every solved representative from its nearest other representative on the line instead (held out; `--lines` narrows it) |

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
It also reports the hero's flop decisions in multiway pots (by source,
action and grade) and grades every heads-up flop call or fold the library
grades a second time by the approximate multiway flop call (`analysis/15`),
comparing the two. The same for the turn (`analysis/16`): the hero's turn
decisions in pots three or more saw the turn of, and, under
`FLOPLIB_TURN_SAMPLE`, every heads-up turn call or fold the turn solver
grades graded again by the approximate turn call, with its factor and with
R = 1. `FLOPLIB_TURN_BEFORE=0` skips the turn sample's pass without the
library (about 40 minutes for 5,448 hands instead of twice that). Since
`analysis/17` it also lists, at the approximate flop and turn grades, the
preflop lines of the opponents whose range is a placeholder.

**The flop realisation table.** `FLOPLIB_DIR=... npm run floplib:realisation`
measures `FLOP_REALISATION` (`lib/analysis/multiway.ts`) on a local library
(`realisation.ts`: every node facing a bet, every third combo, exact equity
against the node's range) and prints it next to the committed table, then
its held-out agreement with the library (fitted on half the flops, judged on
the other half) at several margins. All-in calls are measured apart (they
realise their equity exactly) and left out of the fit (`analysis/17`). About
ten minutes for 1,700 chunks.

**The turn realisation table.** `npm run floplib:turn-realisation` measures
`TURN_REALISATION` on Rail's own turn solves (`turnRealisation.ts`): every
flop ending of a chunk that both ranges reach (3% or more) is dealt one fixed
turn card and solved with A5a's turn solver (plus a third of a pot to the bet
menu); every turn node facing a bet short of an all-in call is measured like
the flop's. Two steps, the first resumable and run in shards side by side:

    cd tests && FLOPLIB_DIR=... TURNREAL_OUT=/path/to/samples TURNREAL_SHARD=0/3 npm run floplib:turn-realisation   # also 1/3, 2/3
    cd tests && TURNREAL_OUT=/path/to/samples [TURNREAL_JUDGE=/path/to/other] npm run floplib:turn-realisation

The 6-max 100bb set (1,200 chunks, 6,505 turns) took about 1 h 40 min on three
processes beside the batch. The report prints the table (rows of 50+ nodes)
next to the committed one and the held-out agreement; `TURNREAL_JUDGE` judges
it on a second corpus too (`FLOPLIB_SETS=nlhe-cash-9max-100bb` with
`TURNREAL_SHARD=k/12` for a slice of the full-ring set).
