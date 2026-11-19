# PREFLOP-PLAN — Rail's own preflop ranges (2026-11-19)

Owner's decisions in this round (chat, 2026-11-19):

- Pro is not on sale until Stripe is connected. Every buy action opens a
  "Pro is coming" waitlist modal instead, so no transcribed GTO Wizard range
  sits behind a paywall.
- Rail offers **few** preflop solutions: a handful for heads-up, 6-max,
  9-max and straddle. GTO Wizard's catalogue has too many variants for a
  player to choose between.
- Rail will solve its **own** ranges. This document fixes the catalogue
  (§2), estimates the postflop work on it from what we measured (§3), and
  lays out how the ranges get built and improved over time (§4).

Status: **§2's catalogue approved by the owner on 2026-11-19** (9-max 100 +
150, one online rake, straddle 6-max only). Nothing here runs during working
hours (Mon–Fri 08–16).

---

## 1. What GTO Wizard offers, and why it is too much

GTO Wizard's cash library is the cross product of these filters (screenshot
of its Solutions library, 2026-11-19):

| Filter | Values |
|---|---|
| Type | Classic, Short, Ante, Straddle, Straddle+Ante, Double Straddle, Mississippi Straddle |
| Players | Heads-up, 6-max, 8-max, 9-max |
| Stack | 20, 40, 50, 75, 100, 150, 200 |
| Rake | NL50, NL500, NL50 GG, NL1k GG, Live… |
| Opening size | GTO, 2.5x |
| 3-bet size | GTO, Smaller |
| Bet sizes (tree) | Simple, Simplified, General |
| Postflop sizes | Single size, Multi size |

6-max · Classic · 100bb · General · GTO 3-bets alone lists **six**
solutions, which differ only in rake and open size. A player cannot tell
which one to study, and the differences are mostly smaller than the noise
in their own play. A full catalogue of every combination does not exist,
but the product of the filters runs into the thousands.

**Rail's rule: one solution per game a player actually sits in.** Rake,
open size, 3-bet size and tree are not choices the player makes. They are
fixed per format and stated once in the solution's info.

## 2. Rail's catalogue (approved 2026-11-19)

### 2.1 Fixed per format, not choices

- **Rake:** one online structure for every set (5 % capped at 3bb,
  NL50-style, no flop no drop). No live rake (owner, 2026-11-19).
- **Sizes:** one open size per position (2.5x, the SB 3x; heads-up SB 2.5x),
  one 3-bet scheme (IP 3x, OOP 4x), one 4-bet scheme (2.2x IP, 2.5x OOP),
  all-in above that. Limps only where a solver keeps them (SB complete,
  heads-up limp). Cold calls kept (they are real in the hands we store).
- **Postflop tree:** whatever the bet-size selection test settles
  (`sizing-test`, at most 3 sizes per node, 1 when one dominates). Until it
  ends no library solve starts, because the tree changes every chunk.
- **Stack snapping:** a hand reads the set whose depth band holds its
  effective stack in big blinds (bands below). Ante, straddle and table
  size never cross over (as today, §0 of `CHARTS.md`).

### 2.2 The sets

| # | Set | Depths | Depth bands (effective stack) |
|---|---|---|---|
| 1–2 | Heads-up | 100, 150 | < 125 → 100, ≥ 125 → 150 |
| 3–6 | 6-max | 50, 100, 150, 200 | < 75 → 50, 75–124 → 100, 125–174 → 150, ≥ 175 → 200 |
| 7 | 6-max ante | 100 | all |
| 8–9 | 9-max | 100, 150 | < 125 → 100, ≥ 125 → 150 |
| 10 | 9-max ante | 100 | all |
| 11 | 6-max straddle | 100 | all |

**11 sets** in place of the 20 transcribed ones (today's plan:
6-max 40/60/100/150/200, five 6-max ante, HU 100/150, 9-max 100/150/200,
four 9-max ante, straddle). Why these depths: the owner's own hands by set
are 6-max 100 (37k), 6-max 150 (8.8k), 9-max 100 (8.8k), 9-max 150 (2.9k),
6-max 60 (2.1k), HU 100 (1.8k), 6-max 200 (1.5k), 6-max 40 (1.3k),
9-max 200 (1.1k), HU 150 (0.6k), straddle (88). 40 and 60bb merge into one
50bb set; 9-max 200 snaps to 150; ante hands on WePlay are mostly bomb
pots (no preflop), so one ante depth per table size is enough.

Short stacks (20–40bb, push/fold) and 8-max are left out of v1; add them
only if hands at those depths reach a few thousand.

Owner's answers (2026-11-19): 9-max is 100 + 150; one online rake for every
set, no live rake; straddle is 6-max only.

## 3. Postflop estimate on that catalogue

### 3.1 What we measured (flop library, `flop-m1` tree, 2026-11-15/16)

352 GTO Wizard–range flop chunks solved by the nightly runner (6 solves in
parallel on the M2 Pro, one thread each, to ~1 % pot exploitability):

- **Time per flop:** median 27 min, mean 34 min, p90 58 min
  (≈ 0.55 core-hours per chunk on average). Single-raised pots out of the
  blinds are the slowest (sb-bb 35 min, btn-bb 33 min); 3-bet pots 4–8 min.
- **Size per flop:** median 95 KB, mean 106 KB (flop only; turn and river
  are solved live in a few seconds).
- **Throughput on the Mac, off-hours only:** 128 h a week
  (weeknights 16–08 plus weekends) × 6 parallel solves ≈ **770 core-hours,
  ≈ 1,350 flops a week**.

### 3.2 Heads-up lines per set

Postflop is solved per *line* (who opened, who called, 3-bet or not) that
reaches a heads-up flop:

| Set | Lines | Note |
|---|---|---|
| Heads-up | 4 | SB open–BB call, limp, 3-bet pot, 4-bet pot |
| 6-max | 12 | today's fixed lines (each open vs BB, BTN vs SB, SB vs BB, SB limp, three 3-bet pots) |
| 6-max ante | 10 | no cold calls in the ante tree |
| 9-max | 14 | 8 opens vs BB, BTN vs SB, SB vs BB, SB limp, three 3-bet pots |
| 9-max ante | 12 | |
| 6-max straddle | 12 | |

The catalogue has **118 lines** (HU 2×4, 6-max 4×12, 6-max ante 10,
9-max 2×14, 9-max ante 12, straddle 12). Rarer lines (squeezes, cold-call
3-bets, `x-…` lines) stay demand-driven: solved when a played or Review
hand lands on them, as the nightly queue does today.

### 3.3 Flop coverage options

| Coverage per line | Flops | Chunks | Core-hours | Storage | Mac, off-hours | One rented 48-core server |
|---|---|---|---|---|---|---|
| Starter subset | 49 | 5,782 | ≈ 3,200 | ≈ 0.6 GB | ≈ 4 weeks | ≈ 3 days |
| Standard subset | 95 | 11,210 | ≈ 6,200 | ≈ 1.1 GB | ≈ 8 weeks | ≈ 5–6 days |
| Study subset | 184 | 21,712 | ≈ 11,900 | ≈ 2.2 GB | ≈ 15–16 weeks | ≈ 10–11 days |
| Every flop | 1,755 | 207,090 | ≈ 114,000 | ≈ 21 GB | not feasible (≈ 3 years) | ≈ 100 days (≈ 10 days on 10 servers) |

Every other flop maps to its nearest solved flop (as the representative-flop
mapping does now), and Review hands are solved on their exact flop.

**Recommendation:** ship v1 on the **95-flop subset** for every line of the
11 sets (≈ 8 weeks of nights and weekends on the Mac, or under a week on a
rented server), then grow 6-max 100bb (most hands by far) to all 1,755
flops on rented compute, then the other big sets.

Caveats: the estimate uses `flop-m1`; the sizing test's final tree may be
cheaper (its pilot reached 0.94 % in 207 s on 7 threads against flop-m1's
409 s) or dearer with three sizes per node. Re-measure on the first 50
chunks of the new tree before booking compute. **Every chunk is tied to the
preflop ranges** (`lineHash`), so the postflop library is solved only once
§4's ranges are frozen for a version.

## 4. Building our own preflop ranges

### 4.1 What we have and what went wrong before

- `charts/1`–`charts/10` (see `CHARTS.md` after §0): our own DCFR preflop
  solver over the full preflop tree, with postflop value from a
  **realisation model** (a fitted formula of equity, position, initiative and
  stack-to-pot). It solves a set in minutes.
- Its weakness (`realisation` finding, 2026-10-28): the model understated
  the in-position aggressor's edge and the postflop rake, so UTG folded
  55–22 and A5s–A2s that GTO Wizard opens. Refitting the formula on the
  flop library did not help: UTG stayed tight and BB's defence collapsed,
  because the formula had to extrapolate to hands that never reached the
  flop in the old ranges.

### 4.2 The method: preflop solver + measured postflop values, iterated

Replace the realisation formula with **values measured by solving the
flops**, and iterate until the ranges stop moving:

1. **v0 ranges:** solve each set with today's DCFR + realisation model
   (minutes).
2. **Measure:** solve a small flop sample per line (the 49-flop subset) from
   the v0 ranges. Read every one of the 1,326 combos' counterfactual value at
   the flop root — the solver computes it for every hand, **including hands
   with zero weight in the range**, so nothing is extrapolated (the gap that
   broke the 2026-10-28 refit).
3. **Plug in:** the preflop solver's leaf value for "this line reaches the
   flop" becomes the measured per-combo EV table (averaged over flops,
   weighted by their frequency, rake included as measured) instead of the
   formula.
4. **Re-solve preflop**, compare range totals per position (RFI %, 3-bet %,
   BB defence %) — totals, not single hands, which flip at the margin.
5. Repeat 2–4 with the new ranges until the totals move < 0.5 pp between
   rounds (expect 3–5 rounds). Damp each step (average the new EV table
   with the previous one) so it converges instead of oscillating.

Cost per set: one round ≈ lines × 49 flops ≈ 600 chunks for 6-max
(≈ 330 core-hours); 4 rounds ≈ 1,300 core-hours ≈ 1.7 weeks of Mac
off-hours per 6-max set. All 11 sets (118 lines): ≈ 12,700 core-hours,
≈ 4 months on the Mac, or about **2 weeks on one rented 48-core server**. Then §3's postflop library is
solved once on the frozen ranges.

### 4.3 Checking the ranges are right

- **Exploitability:** best response to the final preflop + postflop
  strategy on the sampled flops, reported per set (target < 1 % pot on the
  flops, < 0.5 bb/100 preflop leak by the measured EV tables).
- **Sanity totals:** RFI by position, BB defence, SB strategy, 3-bet
  frequencies against published solver figures (totals only; we compare to
  public articles, never by crawling another tool).
- **Stability:** two runs from different seeds give the same totals within
  0.5 pp.
- **Owner review:** charts on the canvas side by side with the previous
  version before a set ships; a set ships with a version (`charts/12`…) and
  its flop library is tied to that version.

### 4.4 Phases

| Phase | What | Where it runs | Done when |
|---|---|---|---|
| P0 | Waitlist modal live, GTO Wizard ranges stay free only (now) | web | shipped |
| P1 | §2 catalogue (approved 2026-11-19) as `charts/12-draft` specs: `web/src/lib/charts/railSets.ts` (`RAIL_SETS`, ids `rail-…`; §4.6). Depth-band picker `pickRailSet`, pure and tested, **not wired in** (P5). Nothing ships from it | code | **done** (prestaging, 2026-11-19) |
| P2 | v0 ranges for all 11 sets with the existing DCFR + realisation model: runner `tests/scripts/preflop-v0/`, `~/Projects/rail-preflop-out/bin/run-v0.sh` (§4.6) | Mac off-hours, one set at a time; ≤ ~9 h for all 11 (probe, upper bound) | charts on canvas |
| P3 | Pilot of §4.2 on 6-max 100bb: 4 rounds, convergence report | Mac off-hours ≈ 2 weeks (after the sizing test) | totals stable, owner OK |
| P4 | §4.2 on the other 10 sets | rented server ≈ 2 weeks, or Mac ≈ 4 months | all sets stable |
| P5 | Replace the GTO Wizard sets in the app and web (`charts/12`), bump `ANALYSIS_VERSION`, delete transcribed data | code | released |
| P6 | Flop library on the frozen ranges: 95 flops × every line | rented ≈ 1 week or Mac ≈ 8 weeks | library live |
| P7 | 6-max 100bb to all 1,755 flops; then other sets by hands played | rented | — |
| P8 (later) | Faster, deeper solving: Rust/WASM SIMD solver core; a value network for depth-limited solving (the GTO Wizard / Deepsolver approach), which would also allow custom preflop solves on demand | research | — |

### 4.5 Decisions and costs for the owner

- Mac-only vs renting compute: Mac-only gets v1 ranges + 95-flop library in
  roughly 6 months of nights and weekends; one rented 48-core server cuts
  that to about 3–4 weeks. Prices change; check current dedicated-server
  pricing before deciding.
- Until P5, the transcribed GTO Wizard ranges stay as they are, never
  behind a paywall.

### 4.6 P1 and P2 as built (2026-11-19)

**The specs (P1).** `RAIL_SETS` in `web/src/lib/charts/railSets.ts`, version
`charts/12-draft`: `rail-hu-100bb`, `rail-hu-150bb`, `rail-6max-50bb`,
`rail-6max-100bb`, `rail-6max-150bb`, `rail-6max-200bb`,
`rail-6max-100bb-ante`, `rail-9max-100bb`, `rail-9max-150bb`,
`rail-9max-100bb-ante`, `rail-6max-100bb-straddle`. Each has its seats,
depth (the stack behind), ante (0.166bb from every seat, the transcribed ante
sets' 1/6), straddle (2bb by UTG), every size (§2.1; the straddle set's are
`charts/5`'s, doubled), the rake (`STANDARD_RAKE`: 5% capped at 3bb, no flop
no drop), no open limps (`maxLimpers` 0: the small blind completes,
heads-up the button limps), at most four entrants, cold calls of an open
kept, and its depth band (§2.2, `minBb` inclusive, `maxBb` exclusive).
`pickRailSet({ kind, players, effectiveBb })` picks kind, then table (2;
3-6 → 6-max; 7-9 → 9-max), then band; a kind with no set at that table is
refused (`ante`, `straddle`), never read on another kind. Whether a hand's
straddle or ante is the one modelled stays `registry.ts`'s
`straddleMismatch` / `anteMismatch`. Nothing imports it but the tests and
the runner; `CHART_SETS` and every page still read the GTO Wizard sets.
`loadCharts` accepts `charts/12-draft` files so the runner and later P5 can
read them.

**The generator, unchanged but for the ante.** The ante sets needed one
addition: `PreflopTreeConfig.ante`, dead money in every pot (`potAt`, the
solver's terminal pots and the rake) and in no seat's bets, so the tree and
the sizes are the unanted ones. Every existing set solves to the same bytes
(the ante defaults to 0). EVs of an ante set are net from the start of the
hand, ante included, and `game.stackBb` is the depth plus the ante, as the
format's ante convention says.

**The runner (P2).** `tests/scripts/preflop-v0/` (`run.ts`, `solve.ts`,
`guard.ts`, `summary.ts`, `report.mjs`), run through `cli.mjs`, which bundles
it with esbuild. Per set it calls `generateChartSet` (or, with `--rounds N`,
`generateRealisedChartSet`: measure-and-fit rounds on turn+river solves
over `--threads` workers) on the realisation fit of the nearest old Rail set,
kept in `tests/scripts/preflop-v0/fits.json` because `charts/11` deleted
those files (own table and depth; 6-max 50bb from 60bb; ante sets from the
classic set of their table). 3,000 iterations, heads-up 9,000. Output, all
outside the repo:

```
~/Projects/rail-preflop-out/
  bin/run-v0.sh          runs the runner (nice -n 10) from the checkout it names: ~/Projects/poker-hand-converter-wt/preflop-p1
  bin/report.sh          markdown table of every set's totals
  cache/                 the equity table (120,000 boards, ~110 s once)
  v0/run.log  v0/run.lock  v0/plan.json
  v0/<set-id>/charts.json  v0/<set-id>/summary.json   (RFI by seat, SB fold/limp/raise, BB defence vs each open, 3-bet % per seat, NashConv, time)
```

```bash
~/Projects/rail-preflop-out/bin/run-v0.sh                       # every set not done yet, in §2.2's order
~/Projects/rail-preflop-out/bin/run-v0.sh --sets rail-6max-100bb --force
~/Projects/rail-preflop-out/bin/run-v0.sh --dry-run --probe 20  # tree sizes and timed estimates; solves nothing
~/Projects/rail-preflop-out/bin/report.sh
```

- **Working hours:** refuses Mon–Fri 08:00–16:00 Europe/Zagreb (exit 2) and
  does not start a set whose estimate × 1.5 would reach 08:00 on a weekday
  (exit 0; the next run resumes there). `RAIL_FORCE=1` overrides; a run
  estimated under a minute (heads-up at a few hundred iterations, a smoke
  test) is let through.
- **Resumable:** a set with a `summary.json` for the same spec, iterations,
  rounds and fit is skipped; a set cut off mid-solve starts again.
- **One at a time:** `run.lock` holds the pid (exit 3 while it lives; a stale
  lock is removed). The preflop solve is one thread; `RAIL_THREADS` (default
  4) caps the `--rounds` workers, since the sizing test also runs off-hours.
- **Time** (dry-run probe, 20 iterations per set, 2026-11-19 in working hours
  under load; early iterations are the slowest, so upper bounds): heads-up
  under 2 min each; 6-max 50bb ~22 min; 6-max 100/150/200bb and ante
  17–39 min; straddle ~4 min; 9-max 100/150bb and ante 70–130 min. All 11
  ≤ ~9 h, one weeknight. `charts/2`'s 6-max 100bb final solve took ~3.5 min
  (docs/CHARTS.md §10), so expect much less.

Not run yet: the real solves (working hours on 2026-11-19), and `--rounds`
(no smoke: one heads-up round is minutes of turn+river solves).

## 5. Related

- `CHARTS.md` — the transcribed sets (§0) and the old generator (rest).
- `NODELOCK.md` — nodelock, including range locks at the flop (2026-11-19).
