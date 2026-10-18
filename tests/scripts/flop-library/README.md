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
| `--lines a,b` | every line of the set's table (`flopLinesFor`: 12 for 6-max, 13 for the 9-max sets, 5 for the heads-up sets) | line ids |
| `--flops a,b` | the 100 representatives, most-covering first | any flops (any suits; canonicalised) |
| `--only N` | all | the first N jobs of the queue (flops in order, each with every line) |
| `--threads N` | half the cores | solves at a time, one process each |
| `--mem GB` | half the RAM | no new solve starts while the predicted memory of those running would pass it |
| `--progress S` | 60 | seconds between progress lines per solve |
| `--dry` | | list the jobs to run and stop |
| `--estimate` | | print the full-run estimate and stop |
| `--validate` | | compare every solved non-representative flop with its representative, by hand category (the analysis's reading and the coarse one before `analysis/12`, with medians) |
| `--loo` | | with `--validate`: read every solved representative from its nearest other representative on the line instead (held out; `--lines` narrows it) |

**Heads-up sets.** `--set nlhe-cash-hu-100bb` and `--set nlhe-cash-hu-150bb`
(`charts/8`, `charts/9`) solve the five heads-up lines (`FLOP_LINES_HU`)
over the same 100 flops: the small blind's open called (`sb-bb`, key `rc`),
the limp checked (`sb-limp`, `ck`), the 3-bet pot (`sb-bb-3bet`, `rrc`), the
limp raised and called (`sb-limp-raise`, `crc`) and the 4-bet pot
(`sb-bb-4bet`, `rrrc`). Heads-up the small blind is the button, so the big
blind is player 0 (out of position) of every heads-up chunk. 500 solves a
set; run one set after the other into the same `--out`:

```bash
cd tests
npm run floplib -- --set nlhe-cash-hu-100bb --estimate      # after a pilot: core-hours and memory
nice -n 10 npm run floplib -- --out ~/Projects/rail-floplib-out --set nlhe-cash-hu-100bb --threads 6 --mem 12 \
  && nice -n 10 npm run floplib -- --out ~/Projects/rail-floplib-out --set nlhe-cash-hu-150bb --threads 6 --mem 12
```

Nothing reads them until a set's manifest is uploaded (`upload.sh <out>
nlhe-cash-hu-100bb`); the analysis already maps a heads-up hand to its line
(`chunkFor`).

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

**Serving.** The full 6-max 100bb run (1,200 chunks, 86 MB), the 9-max
100bb run (1,300 chunks, 92 MB) and the 6-max 150bb run (1,200 chunks,
81 MB) are in the public, read-only Storage bucket `flop-library` (migration
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

**Multiway flop narrowing from the library (a study; nothing shipped).**
`npm run floplib:multiway-narrowing` (same `FLOPLIB_HANDS` and `FLOPLIB_DIR`)
scores the opponents shown down after a flop three or more saw on their
range as the turn came, narrowed through the flop by the heuristic and by a
narrowing read from the heads-up chunk of the closest line
(`multiwayLibrary.ts`, study code only), held out by player, and compares
the hero's approximate flop and turn call grades on both walks
(`FLOPLIB_EXAMPLES=1` prints the changed ones, `FLOPLIB_HAND=n` one hand).
About two minutes for 5,448 hands. `docs/ANALYSIS-PLAN.md` §10 2026-10-13.

**The multiway check trim (`analysis/22`).** `npm run floplib:check-trim`
(same variables) scores the same shown players, on the flop and the turn,
with multiway checks trimmed by a grid of `CHECK_VALUE`/`CHECK_AIR`/
`CHECK_DRAW` values and by a single scale on the trim, against
`analysis/21`'s constants, held out by player; a heads-up control applies
the same scales to heads-up checks. About five minutes.
`npm run floplib:check-trim-grades` with `CHECKTRIM_GRADES_OUT=file`
writes the hero's postflop grades on multiway flops (hand and action
indices, no names or cards); run it before and after a narrowing change,
the second time with `CHECKTRIM_GRADES_BEFORE=` the first file, to count the
grades that moved. Under a minute. `docs/ANALYSIS-PLAN.md` §10 2026-10-14.

**The heads-up check trim (`analysis/23`).** `npm run floplib:hu-check-trim`
(same variables) scores every shown player of a heads-up flop (with or
without the hero) and of a turn that began heads-up after a multiway flop,
with heads-up flop and turn checks trimmed by the same grid and scales,
against the shipped constants, held out by player. Each row is scored on the
heuristic walk and as analysed (the flop library's strategy where a chunk
covers the hero's flop), and the study says how many flop checks went
through the heuristic. About seven minutes. `CHECKTRIM_GRADES_HEADSUP=1`
makes `floplib:check-trim-grades` take the hero's heads-up flops instead.
`docs/ANALYSIS-PLAN.md` §10 2026-10-14 (the heads-up check trim).

**The river check trim (not shipped).** `npm run floplib:river-check-trim`
(same variables) scores every shown player who acted on the river, heads-up
or multiway flop, with or without the hero, on their range after their last
river action, with river checks trimmed by a grid of `CHECK_VALUE`/
`CHECK_AIR` values and by a single scale (heads-up, multiway and both
alike), held out by player; it also varies `CHECK_REPEAT` on every street,
scored on the flop, turn and river rows. About 13 minutes.
`docs/ANALYSIS-PLAN.md` §10 2026-10-14 (the river check trim).

**The library as an ordering of hands, multiway (not shipped).**
`npm run floplib:multiway-ordering` (same variables) scores the shown players
of multiway flops (flop rows and the turn after them) with every flop action
the library can read narrowed by a hybrid: the heuristic's share of the range
(Σ w·L) kept, the library's per-combo frequency deciding which combos carry
it (geometric, linear and rank blends, one α each), against `analysis/23`,
held out by player. About two minutes. `docs/ANALYSIS-PLAN.md` §10
2026-10-15.

**The coverage census.** `CENSUS_OUT=rows.jsonl npm run floplib:census`
(same variables) analyses every hand as the rebuild does (charts, the flop
library's shipped sets only - `CENSUS_SETS` - turn solves on, every
opponent's statistics summed over the file) and counts every hero decision
by street × outcome: graded by the charts or a solve, graded approximately
(by flag), analysed without a grade, not analysed by reason; also by table,
depth and heads-up or multiway. Rows (hand and action indices, no cards or
names) go to `CENSUS_OUT`; `CENSUS_SHARD=i/n` runs a share of the hands
(three shards: about 25 minutes on the owner's 5,448 hands, `CENSUS_TURN=0`
two). `CENSUS_REPORT=a.jsonl,b.jsonl` merges row files into one report, and
with `CENSUS_BEFORE=` an earlier census's files prints how each decision
moved. `docs/ANALYSIS-PLAN.md` §10 2026-10-16.

**Bomb pots.** `FLOPLIB_HANDS=... npm run floplib:bomb-pots` scores the
multiway heuristic on the hands opponents show down in bomb pots (started
from any two cards) against the same in other multiway pots: the shown
combo's log-likelihood at the turn's and the river's start, minus its
likelihood in the unnarrowed starting range (the lift), clustered by player.
`BOMB_GRADES=1` prints every graded hero decision of the bomb pots for a
spot check (console only). About two minutes. `docs/ANALYSIS-PLAN.md` §10
2026-10-19.

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
