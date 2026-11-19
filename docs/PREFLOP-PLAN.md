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

Status: **proposal**. §2's catalogue needs the owner's OK before any solve
starts. Nothing here runs during working hours (Mon–Fri 08–16).

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

## 2. Rail's catalogue (proposal)

### 2.1 Fixed per format, not choices

- **Rake:** one online structure for every set (5 % capped at 3bb,
  NL50-style, no flop no drop). Live rake is a later option only if live
  hands show up in numbers.
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

Questions for the owner (defaults above until answered):
1. 9-max: 100 + 150, or 100 + 200?
2. Is one online rake enough, or does 9-max need live rake (10 %)?
3. Straddle: 6-max only, or also 9-max live straddle?

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
| P1 | Owner approves §2 catalogue; tree spec per set (sizes, rake, snapping) in `registry.ts` | code | approved + merged |
| P2 | v0 ranges for all 11 sets with the existing DCFR | Mac, minutes | charts on canvas |
| P3 | Pilot of §4.2 on 6-max 100bb: 4 rounds, convergence report | Mac off-hours ≈ 2 weeks (after the sizing test) | totals stable, owner OK |
| P4 | §4.2 on the other 10 sets | rented server ≈ 2 weeks, or Mac ≈ 4 months | all sets stable |
| P5 | Replace the GTO Wizard sets in the app and web (`charts/12`), bump `ANALYSIS_VERSION`, delete transcribed data | code | released |
| P6 | Flop library on the frozen ranges: 95 flops × every line | rented ≈ 1 week or Mac ≈ 8 weeks | library live |
| P7 | 6-max 100bb to all 1,755 flops; then other sets by hands played | rented | — |
| P8 (later) | Faster, deeper solving: Rust/WASM SIMD solver core; a value network for depth-limited solving (the GTO Wizard / Deepsolver approach), which would also allow custom preflop solves on demand | research | — |

### 4.5 Decisions and costs for the owner

- Approve the catalogue (§2, three questions).
- Mac-only vs renting compute: Mac-only gets v1 ranges + 95-flop library in
  roughly 6 months of nights and weekends; one rented 48-core server cuts
  that to about 3–4 weeks. Prices change; check current dedicated-server
  pricing before deciding.
- Until P5, the transcribed GTO Wizard ranges stay as they are, never
  behind a paywall.

## 5. Related

- `CHARTS.md` — the transcribed sets (§0) and the old generator (rest).
- `NODELOCK.md` — nodelock, including range locks at the flop (2026-11-19).
