# Analytics by stack depth

Which stack depths does the player win at, which do they lose at, and why.
It shows a winrate per effective-stack bucket with its uncertainty, a
verdict only where the sample supports one, and below it the leaks that
explain a bad bucket: solver-graded decisions and stat deviations, ranked
by what they cost. Desktop Reports (`#/reports`) and web `/stats` render
the same shared screen (`packages/ui/reports`), so they ship together.

Written 2026-11-22 from five research passes: Hand2Note's public docs, 21
YouTube tutorials (transcripts in `~/Projects/rail-learn-research/hand2note-yt/`),
PokerStrategy and the other written sources, the statistics method, and a
map of today's code.

## 1. What the others do

### Hand2Note (hand2note.com help, blog and changelog)

- **No automatic leak finder.** H2N's own comparison page lists no leak
  tracker; leaks are found by hand, with filters, drill-downs and *Action
  Profit*.
- **Two moments for the stack.**
  - At hand start: stack, eff stack (the largest other dealt-in stack,
    capped at the player's), eff stack vs Hero, eff stack among players to
    the left.
  - At the decision: eff stack on the player's first action against
    players still in, and the same against only players who put money in.
  - Custom stats also have eff stack / pot and bet / eff stack.
- **All-in rule:** a bet counts as all-in at or within 1.5 bb of the
  effective stack.
- **Reports:**
  - Stats, graph (won, all-in EV, showdown, non-showdown) and range tabs,
    with a hand list behind every row.
  - Chained drill-downs ("Faced next", "Next actions").
  - Pin to compare two reports side by side.
  - Editable bucket ranges ("Edit Level Ranges", 4.1.262, Oct 2026).
- **H2N's blog example:** a table by stack depth with hands, EV bb/100 and
  variance. Variance grows with depth.
- **A "Stack Sizes" report tab** (VPIP, PFR, 3bet, WTSD, W$SD, WWSF, EV
  winrate, drill-down) is described only by third-party guides, not
  confirmed on hand2note.com.
- **Action Profit:** the player's stack at the end of the hand minus their
  stack just before the action, so a fold is 0, in bb per occurrence. Two
  actions in the same spot are compared, for example cbet 6.5 bb against
  check 3.3 bb. The docs give no confidence intervals.

### PokerTracker 4 and Hold'em Manager 3

- **PT4 effective stack:** fixed at the player's first action, capped by
  the largest stack still live. A walk gives 0, which drops BB walks out of
  stack filters. HM3 has the same walk problem.
- **PT4 LeakTracker:** a bar per stat with the winning-player band for the
  game, stake and table size, and a marker for the player. Anything outside
  the band is a *potential* leak; coaches want 10–20k hands first.
- **HM3 Leak Explorer:**
  - Filters come first: players, effective stack range (90–200 bb is the
    "deep cash" example), stakes.
  - It is benchmarked against winners, in the player's database or a
    vendor pool.
  - It ranks hundreds of stats by *leak size*, the distance to the
    benchmark times how often the spot comes up.
  - Drill-down: stat → position → 13×13 grid with differences highlighted →
    hands.
- **HM3 Leak Buster** (add-on): a 1–10 severity score per category; the
  formula is not public.
- **PT4 stack leak finding** (Daryl Jace video): a report by position ×
  stack bucket with bb/100 and all-in-adjusted bb/100. Every bucket should
  manage about +5 bb/100; a bucket near 0 is where to look. Widen the
  bucket (25–45 rather than 30–40) to get hands.

### How coaches review a database (YouTube, DeucesCracked, BlackRain79)

1. **Check the sample.**
   - 30–40k hands before real analysis.
   - Preflop frequencies settle within a few thousand hands.
   - Postflop nodes need 100k hands.
   - The opportunities of the stat count, not the total hands.
2. **Results.**
   - Graph with red/blue lines.
   - Winrate by position: the "positional ramp" from early position to the
     button, and the blind loss.
   - Winrate by sub-game against GTO and a pool.
   - Variance (all-in EV).
3. **Preflop grid:** position × open size × response.
4. **Postflop by node:** pot type, position, role, bet-size bucket. The
   earliest street that is off gets fixed first.
5. **Rank leaks** by frequency × size of the error, then drill to the
   hands.

Benchmarks are rake- and stake-specific solver numbers or winning regulars.
All the stack-depth videos agree that targets move with depth: shallow
means wider stack-offs, 3bet-or-jam and high cards; deep means tighter
stack-offs, suited and connected hands, more checking and polar 4bets.
**Nobody publishes cash baselines by depth**, and no cash tracker ships
winrate by depth with confidence intervals. That is where Rail can be
better: our solver and chart sets can give the depth-specific reference.

### Statistics

- **Spread:** 6-max NL has an SD of about 90 bb/100 (range 75–120). The
  SD grows with depth.
- **Standard error:** SE = 100 · sd(per-hand bb) / √n.
  - At 10k hands the 95% CI is about ±18 bb/100.
  - At 100k hands it is about ±5.6.
  - A single bucket's bb/100 is therefore mostly noise until it is large.
- **All-in EV** replaces the result of an all-in hand by its equity share.
  It matters most in short buckets, where all-ins are common.
- **Test a bucket against the rest**, not against an overall rate that
  contains it:
  - z = (x_k − x_rest) / √(SE_k² + SE_rest²)
  - With about 8 buckets, use |z| ≥ 2.73 (Bonferroni at 5%).
- **Shrinkage** toward the overall rate, with a fixed prior τ ≈ 6 bb/100:
  - w = τ² / (τ² + SE²), so the estimate is w·x + (1 − w)·μ.
  - Small buckets cannot then top a "best/worst" ranking.
- **Confounders:**
  - Depth correlates with stake, opponent type and straddles.
  - A deep hero is deep partly because they just won.
  - A stake-reweighted view controls the first; the rest are noted, not
    corrected.

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| Name in the UI | "Stack" tab in Reports, labelled as the owner calls the screen | The screen is Reports (desktop) / Stats (web); no new screen. |
| Stack axis | **Effective stack at the hero's first preflop action**, against players still live, in **big blinds of the largest forced blind** (straddle counts) | PT4's definition and H2N's "first action". A 200 bb hero against a 40 bb short stack plays a 40 bb hand. |
| Walks | Fall back to the hero's starting stack | Otherwise BB walks vanish from low buckets (a known PT4/HM3 bug). |
| Second axis | The hero's own starting stack, as a toggle | It answers "what should I buy in for / top up to". It is today's tab. |
| Buckets | **Fine:** <30 · 30–45 · 45–62 · 62–87 · 87–125 · 125–175 · 175–250 · 250+. **Coarse:** <62 · 62–125 · 125+ | Centred on solver depths (20, 40, 50, 75, 100, 150, 200, 300), so 100 bb sits in the middle of a bucket instead of on an edge (today 70–100 / 100–150 splits it). Coarse is the default until a sample is big. |
| One definition | Bucket edges live in one JSON (`config/stats/stack-buckets.json`), read by Rust, SQL (generated) and TS | Today the filter chips (0-40/40-80/80-120/120+) and the report bands (0-20 … 250+) disagree. |
| Headline metric | All-in EV bb/100, with actual bb/100 beside it | It removes all-in luck, which is biggest in short buckets. |
| Verdict | Colour a bucket only when \|z vs rest\| ≥ 2.73 and the bucket has ≥ 1,000 hands. 1.96–2.73 is "leaning", in words only. Everything else is neutral. | Otherwise colour is noise. Same idea as `Z_CLEAR` / `Z_LEANING` in `web/src/lib/analysis/leaks.ts`. |
| Colours | Results: green/red signed, per the clean-UI rules and `packages/ui/README.md` rule 7. Stat deviations: the existing tones (`data-tone`, `stats/range.ts`), plus an ↑/↓ for too loose/aggressive or too passive. **Not** red/blue. | Blue and red are reserved for the showdown/non-showdown lines. |
| Pro | The Stack tab stays behind the existing `situationsLock` | Same as the other situation tabs. |

## 3. Step by step

Each step is one worktree agent cut from `origin/prestaging`. It pushes to
`prestaging` after the area's local checks from `CLAUDE.md`. Steps run in
order, in the evenings and at weekends. Step 0 is design only, and code
starts when the owner picks a design.

### Step 0 — Design on the canvas

- Own canvas page `ideas-stacks` ("Ideas — Stacks"), never the shared
  Ideas page.
- Boards:
  - `ST-A-Forest`: one row per bucket, an EV dot with 95% CI whiskers, a
    hollow dot for actual, a reference line at the overall rate, hands per
    row, colour only on significant rows.
  - `ST-B-Table`: today's breakdown table with CI and verdict columns, and
    a mini bar per row.
  - `ST-C-Funnel`: winrate against hands with 2σ/3σ limits.
  - `ST-Leaks`: a clicked bucket opens its leaks (Step 7).
  - `ST-States`: small sample, one bucket, no EV yet.
- Toolbar: Effective | Hero stack, Fine | Coarse, bb | $.
- **Done when:** the owner picks a variant.

### Step 1 — Effective stack per hand, stored

- **Rust, `core/rail-stats/src/events.rs`:**
  - Next to `effective_bb` (hand start, against everyone dealt in), add
    `effective_first_action_bb`: the hero's stack against the largest
    stack still live at the hero's first preflop action, divided by the
    largest forced blind.
  - Walk → `stack_bb`.
  - Expose it to custom stats (`custom.rs`) and in `docs/STATS-SPEC.md`.
- **Desktop store:**
  - Column `hero_eff_bb_tenths` on `hand_list` (new migration in
    `core/rail-store/migrations/`), filled where `hero_stack_bb_tenths` is.
  - Recompute pass for existing hands, using the `0012_recompute.sql`
    pattern.
- **Web:**
  - Column on `hand_stats` (or `hand_facts`) and on `hero_report_rows`.
  - The writer fills it on import.
  - A backfill RPC runs in batches.
- **Filter facts:** add `effStack` to `core/rail-store/src/facts.rs` and
  its TS port `web/src/lib/stats/builderFacts.ts`, with golden parity.
- **Done when:**
  - Unit tests cover a walk, a straddle, multiway with a short stack that
    folds before the hero acts, and the hero all-in short.
  - Golden parity passes.
  - The backfill is idempotent.

### Step 2 — One bucket definition

- `config/stats/stack-buckets.json`: fine and coarse edges in tenths of a
  big blind, plus labels.
- Rust: a `stack_bucket(tenths, scheme)` in `rail-stats`, replacing
  `STACK_BANDS` and `stack_band()` in `core/rail-store/src/report.rs` and
  `STACK_DEPTHS` in `hand_list.rs`.
- SQL: a generated immutable function `rail_stack_bucket(tenths int,
  scheme text)`. Today the band lives as a `case` in
  `20270707090000_report_summaries.sql`.
- TS: `packages/ui/hands/filter.ts` `STACK_ORDER` read from the same JSON.
  Strings go in `packages/ui/strings/reports.*.ts`.
- **Migration:** `hero_report_rows.stack` changes bands, so rows are
  recomputed.
- **Done when:** one test per language reads the JSON and checks the same
  edges.

### Step 3 — Report engine: group by effective stack, with variance

- **Desktop** (`core/rail-store/src/report.rs`, `breakdown_pass` /
  `breakdown_chunk`):
  - Add an `eff_stack` map beside `stack`.
  - Per row, also sum:
    - `net_bb_sq` (Σ of per-hand bb², in milli units);
    - `ev_bb` and `ev_bb_sq` from `ev_rows`;
    - `sd_net` and `nsd_net` (the showdown/non-showdown split).
  - `app/src-tauri/src/reports.rs` `totals_row` gets all-in EV, which it
    lacks today.
- **Web:**
  - `report_situations` gets an `eff_stack` grouping set.
  - It also returns the same sums: `sum(net_bb_milli::numeric^2)` and the
    EV join from `hand_stats_ev`.
  - pgTAP tests are required.
- **Model:** `Breakdowns.effStack` in `packages/ui/reports/model.ts`, and
  `StatGroup` gains `evBbMilli`, `netBbSq` and `evBbSq`.
- **Done when:** a fixture database gives the same rows on desktop and
  web.

### Step 4 — Statistics module

- One pure module with a Rust and a TS twin, like `display.rs` /
  `display.ts`. `packages/ui` stays display-only.
- **Inputs per bucket:** n, Σx, Σx² (actual and EV).
- **Outputs per bucket:**
  - bb/100, SE, 95% CI;
  - z against the rest of the report, and the verdict:
    - `clear-good` / `clear-bad`: \|z\| ≥ 2.73 and n ≥ 1,000;
    - `leaning-good` / `leaning-bad`: 1.96 ≤ \|z\| < 2.73;
    - `none`;
  - shrunk estimate (τ = 6 bb/100).
- **Coarse mode:** auto-merge a fine bucket into its smaller neighbour
  when its CI half-width is over 25 bb/100. A shown row stays labelled
  with its real edges.
- **Done when:** golden vectors pass in both languages, and a property
  test holds: verdicts never fire below n = 1,000.

### Step 5 — The Stack tab

- `packages/ui/reports/Breakdown.tsx`:
  - The `stack` tab becomes "Stack" with the toggles Effective | Hero and
    Fine | Coarse.
  - It renders the design picked in Step 0.
  - The chart follows rule 7: total green, EV yellow dashed.
  - Keep a table view; colour never carries meaning alone.
- Columns: hands, bb/100, EV bb/100 ± CI, then the existing
  `BREAKDOWN_COLUMNS` stats.
- Clean UI rules apply: no titles, signed and coloured results in the
  chosen unit, rows look clickable.
- **Done when:**
  - lint, lint:css and typecheck pass in `packages/ui`, `web` and `app`;
  - both apps are previewed (desktop through a mockIPC harness, never
    committed);
  - screenshots are taken in light and dark.

### Step 6 — Filter and drill-down

- `packages/ui/hands/groups.ts`, `stacks` pane:
  - `effStack` chips (the coarse buckets) and a typed range, beside
    `stacks` and `heroStack`.
  - Rust `hand_list.rs`, SQL `library_number(...'effStackMin')` in a new
    migration next to `20271116130000_hand_facts.sql`.
- Clicking a bucket row opens Hands with the current report filter plus
  that bucket, and the existing `ReportFilter.hands` carries it back.
- **Done when:** from a red bucket, two clicks reach a replayed hand.

### Step 7 — Why a bucket is bad: leaks per stack

- **7a, graded leaks by stack** (cheapest and strongest):
  - Add `depth_band` (coarse bucket) to `analysis_leak_rows`, both
    desktop (`0016_analysis.sql` successor) and web, from the decision's
    `facts.effStackBb`.
  - `LeakFilters` and `groupLeaks` / `rankTopLeaks` get a stack filter.
  - The bucket panel shows that bucket's top 3 leaks by EV lost, with the
    existing confidence wording.
- **7b, stat deviations by stack** (H2N/PT4 style):
  - A curated list of stats:
    - RFI by position;
    - 3bet, fold to 3bet, 4bet and 4bet-jam;
    - BB defence by open size;
    - flop cbet in single-raised and 3bet pots, fold to cbet;
    - WTSD and W$SD.
  - Per bucket, hero against two references:
    - **Self:** the same stat in the hero's 87–125 bucket ("how you change
      with depth").
    - **Reference:** the chart set nearest the bucket centre, for preflop
      (`web/src/lib/charts/data/`, today 100 bb, with more depths as the
      own-ranges plan in `docs/PREFLOP-PLAN.md` lands). Postflop uses
      the flop library at 100/150 bb. Without a reference for that depth,
      only the self comparison is shown; never borrow another depth's.
  - Score: z = (hero − ref) / binomial SE on the stat's opportunities.
  - **Leak cost** (bb/100) = (hero's Action Profit per occurrence − the
    reference action's) × occurrences per 100 hands. Ranked by cost,
    shown only when \|z\| ≥ 1.96 and opportunities ≥ the stat's
    `sample.min`.
  - Action Profit per decision is new: the stack after the hand minus the
    stack before the action, fold = 0. Add it as a counter in
    `rail-stats` (a money key) so it sums like the rest.
- **Done when:** a fixture hero who over-folds to 3bets only at 40 bb shows
  that leak in the 30–45 / <62 bucket and not at 100 bb.

### Step 8 — Confounders (optional, after feedback)

- A "Stake-adjusted" toggle: each bucket's rate is reweighted to the
  hero's overall stake mix.
- A per-bucket line showing how many hands had a straddle and how many
  were multiway.
- No regression model until a user asks for it.

### Step 9 — Guide and rollout

- `docs/GUIDE.md` Reports section:
  - what effective stack means here;
  - why most buckets stay grey;
  - how to read the whiskers.
- Prod migrations: apply them before the main promotion, per
  `CLAUDE.md`. Run the backfill RPC on prod in batches out
  of hours.

## 4. Open questions for the owner

1. Is the screen to stay named Reports/Stats, or be renamed Analytics?
2. Should the coarse buckets be the default, with fine as a toggle?
3. Should Step 7b ship without a depth reference (self comparison only)
   until the own preflop sets at 50/150/200 bb exist?
