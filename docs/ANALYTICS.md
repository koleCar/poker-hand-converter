# Analytics

The screen a coach would open for a database review. It answers three
questions in order:

1. Which of my statistics are off?
2. Where exactly, and with which hands?
3. How do I practise it?

Every statistic is compared with a **target**: what Rail's charts (preflop)
and solver (after the flop) do **with the hands the player actually held,
in the same spots**. A stat is coloured only when the gap is bigger than
the sample's luck. Each gap carries what it costs in bb/100, from the
graded decisions. Every leak leads to the Trainer with that spot set up.

Desktop Reports (`#/reports`) and web `/stats` render the same shared
screen (`packages/ui/reports`), so they ship together. Both are renamed
**Analytics**; the routes stay.

Written 2026-11-22. It replaces the first version of this plan
(`STACK-ANALYTICS.md`, analytics by stack depth). The owner turned that
version down after the first design round:

> "Focus on the statistics, not on stack depths. Depth matters for
> tournaments, not much in cash."

Stack depth is now a filter (Step 11).

## 1. What the others do

### A coach's database review (Mobius poker, YouTube `I1HHEHoSmuA`)

This is the reference the owner chose. The transcript is in
`~/Projects/rail-learn-research/hand2note-yt/`. The coach reviews a 110k-hand
NL50 database in this order:

1. **Results.**
   - Hands, money, all-in EV and bb/100.
   - The graph, with the red line called out.
2. **Aggregated postflop stats.** These count "any line": the street only,
   whatever happened earlier.
   - River bet, 33%: "usually low 40s".
   - Share of river bets made with third pair or worse, 33%: about balanced.
   - River fold vs bet, 52%: "high 40s, low 50s" is fine.
   - River raise, 7.6%: should be about 15%, and the raises lean on value.
   - **Flop fold, 49%, and turn fold, 54%: both about 15 points too high.**
     This became the main note.
   - Flop raise, 10%: should be about 15%.
3. **The pool.**
   - The ratio of regular to recreational hands is about 6:1 here; around
     4:1 is good.
   - The average reg's win rate.
   - Regs fold the river 58%, so the exploit is to bluff more.
   - Fish bluff the river 39% of the time with weak hands, so call more.
   - Regs call 3-bets too much and 4-bet too little.
4. **Preflop against a solver.**
   - VPIP, PFR, 3-bet and 4-bet.
   - Then a grid of hero position against villain and open size, with
     fold / call / raise for the hero and for the solver.
   - Too passive is coloured blue, too aggressive red. For example, BB vs
     SB 3x: 3-bets 10% against the solver's 21%.
5. **Postflop against a solver, by spot and bet size.** For example, facing
   a turn probe, at sizes 30% to 150% pot: folds 66% against 38% at 70%,
   and folds 56% against 21% at 30%, with too few raises.
6. **What the folds are made of.**
   - The fold range by hand category, read from the top down.
   - Single hands, opened in a solver with their EV: "5♣3♣ calls for
     +2.43 bb: folding it is 243 bb/100 where it happens".
   - Rules of thumb: never fold a pair to a small cbet; most gutshots
     continue.
7. **What to do next.** Drill the spot in a trainer, and expect it to feel
   too loose for a while.

### Trackers

- **Hand2Note** has no automatic leak finder. The work is done by hand,
  with stat checkers that coaches build themselves (the one above is one),
  report drill-downs, and Action Profit.
  - Action Profit is the stack after the hand minus the stack before the
    action, so a fold is 0.
- **PT4 LeakTracker** shows a bar per stat with a winning-player band and a
  marker for the player. It wants 10–20k hands first.
- **HM3 Leak Explorer** benchmarks against winners and ranks stats by
  *leak size*: distance × frequency. Its drill-down goes stat → position →
  13×13 grid → hands.
- **None of them** compares against the hands the player actually held, so
  a small sample looks like a leak. None puts a bb/100 cost on a stat from
  solved decisions. None ends in a trainer. Rail does all three.

### Statistics

- **A frequency's luck:** a player who plays exactly like the target at
  frequency t over n opportunities lands within ± 1.96·√(t(1−t)/n) 95% of
  the time. At n = 400 and t = 35% that is ±4.7 points; at n = 4,000 it is
  ±1.5. Anything inside is not a leak yet.
- **Hand-adjusted target:** the mean, over the player's own decisions, of
  the reference's frequency for the action with the hand held. This is the
  method A3 already uses (`web/src/lib/analysis/reports.ts`). A perfect
  player matches it whenever the reference is pure, whatever cards they
  were dealt.
- **Win rate:** SE = 100 · sd / √n, with 6-max NL sd ≈ 90 bb/100. This
  matters only for the Pool figures and the graph.

## 2. The design (canvas page `ideas-analytics`, round 3)

The boards are `AN-Main`, `AN-Drill`, `AN-Train` and `AN-States`. The
generator is in `~/Projects/poker-hand-converter-wt/canvas-backups/ideas-analytics/`.

- **One screen, four tabs** under the filter bar:
  - **Overview.** The graph in the standard colours, then the three most
    expensive findings as cards. Each card has a headline ("You give up
    too many pots on the flop and turn"), its stats against their targets,
    and its cost.
    - A card opens to a sentence on why, the spots behind it, and
      "Practise this ▸".
    - Below the cards is a row of pills for the stats that are in range.
  - **Streets.** Four columns, Preflop → Flop → Turn → River.
    - Each column has blocks such as *Facing a bet*, *Cbet* and *Bet*.
    - A block shows a fold / call / raise bar for the player over the same
      bar for the target, the gap in words, and the cost.
    - A click opens the block's spots below.
  - **All stats** (the stat checker). Rows grouped by street, each with:
    - the player's number and a track: the target band in green, with a dot
      for the player;
    - the target and the gap in words ("Folds too much · +11 pts");
    - the opportunities and the cost.

    Sort by street or by cost; show all stats or only those off target. A
    row expands to its spots (fold / call / raise, player against target,
    with a cost).
  - **Pool.**
    - Four figures: regs : fish by hands, the regs' win rate, the player's
      win rate with a fish in the pot, and with regs only.
    - A table with columns You / Regs / Fish / Target / What it means
      ("Regs fold the river too much: bluff them more").
- **The figures row** (hands, won, all-in EV, showdown, non-showdown, bb | $)
  is shared by Overview, Streets and All stats.
- **Drill-down** (one stat):
  - Spots on the left. On the right, a table of bet sizes (20–40, 40–60,
    60–85, 85–125, 125%+), each with fold / call / raise for the player and
    the solver, and a cost.
  - **What you fold**: hand classes strongest first, each with its share of
    the folds, how often the solver folds it, and what a call is worth.
  - The folded hands the solver calls, biggest first.
  - The way out is the Trainer: "Practise <spot> ▸" at the top,
    "Practise ▸" on each class the solver keeps, and "Play it ▸" on each
    hand.
- **Trainer opened from Analytics:**
  - A *From Analytics* bar names the leak, its cost and a link back.
  - The settings are set to the spot and sizes, and the hands are dealt
    from the classes the player folds.
  - The side panel shows the goal: your fold rate here, the solver's, and
    this drill's so far.
- **Colours:**
  - Green means in range, amber off, red far off (the clean-UI rule for
    statistics).
  - The coach's blue = passive / red = aggressive is **not** used: blue and
    red are the showdown and non-showdown lines (`packages/ui/README.md`
    rule 7). The direction is written in words.
- **States:**
  - A small sample is grey with "Not sure yet".
  - A spot without a target shows the player's number only.
  - Free plan: numbers are free; targets, gaps and costs are Pro.
  - Stack depth appears as a filter chip.
  - The empty state is one line and one link.

## 3. Decisions

| Question | Decision | Why |
|---|---|---|
| Name | **Analytics** in both apps' navigation; routes `#/reports` and `/stats` stay | The owner calls it Analytics; links and bookmarks keep working. |
| Target | Hand-adjusted reference: mean of Σ `OptionAnalysis.freq` of the stat's action class, over the player's analysed decisions | Same method as A3 and the grader, so Analytics, the leak finder and the Trainer never disagree. |
| Source | Preflop: the chart set the decision was graded on. Flop: the flop library. Turn and river: the per-hand solve. Labelled *Charts* / *Solver* | These are what `decision_analysis.source` already records. |
| Which hands | Player number and target come from the **same** analysed decisions. Coverage is shown when under 90% of the stat's opportunities | Comparing all hands with an analysed subset would make a gap out of coverage. |
| Band | target ± max(floor, 1.96·√(t(1−t)/n)); floor per stat in the catalogue (default 2 pts) | Inside the band is luck or noise, not a leak. |
| Tones | In band → *ok*; outside → *off*; more than 2× the band's half-width outside → *far*; under the stat's `sample.min` → *few* (grey, "Not sure yet") | Colour only where the sample vouches for it. |
| Cost (bb/100) | Too much of the action: Σ `ev_loss_bb` of decisions that took it. Too little: Σ `ev_loss_bb` of decisions that did not take it where the best option is in it. Either sum ÷ hands × 100 | It uses the A6 EV figures, so a stat's cost and a leak's cost are the same money. |
| Weak share (composition) | Target is the solver's own share over the player's hands: Σ freq(action)·[weak] ÷ Σ freq(action) | A balanced constant (33%) ignores sizing and board; the hand-adjusted share does not. |
| Bet-size buckets | 20–40 · 40–60 · 60–85 · 85–125 · 125%+ of the pot (`facts.facingPot`) | These match the sizes the solver and the trainer use. |
| Hand classes | From `facts.made` + `facts.draws`: top pair+, middle / bottom pair, pocket pair under, strong draw, gutshot, ace high with backdoor, overcards, nothing | These are the coach's categories, and the facts already have them. |
| Pool targets | The player's own target for the same stat, marked as approximate | Opponents' cards are mostly unknown, so a hand-adjusted target cannot be computed for them. |
| Pool player types | Rail's existing rule (`hand_list.rs`): fish VPIP ≥ 40 over 30+ hands; reg VPIP 15–30 and PFR ≥ 0.6·VPIP | One definition everywhere. |
| Colours | Stats: green → amber → red (tones). Direction in words. Graph: rule 7 | Clean-UI rule; blue and red belong to the graph. |
| Pro | The player's numbers are free. Targets, gaps, costs, the drill-down and Pool are Pro (`situationsLock` successor) | Same line as the analysis. |

## 4. What already exists

- **Graded decisions.**
  - `decision_analysis` (web `20261228090000_analysis.sql`, desktop
    rail-store) stores per decision:
    - `options` (each with `freq` for the hero's exact hand, `sizePot`, EV)
      and `chosen`;
    - `ev_loss_bb`, `facing_bet`, `pot_bb` and `mdf`;
    - `facts`: `scenario`, `role`, `facing`, `facingPot`, `made`, `draws`,
      `handClass`, `inPosition` and `effStackBb`.
  - The flat copy `analysis_leak_rows` (`20270825090000_analysis_screen_summaries.sql`)
    has street, pot type, position, `spot_key`, grade and `ev_loss_bb`, and
    the preflop node columns.
- **A3 reports** (`web/src/lib/analysis/reports.ts`,
  `analysis_node_actions`): hero frequencies against the hand-adjusted
  chart reference per preflop node. This is the method the stat checker
  generalises.
- **A6 leak finder and top 3** (`leaks.ts`, `topLeaks.ts`): EV lost per
  spot, confidence wording, was / now.
- **Stats engine** (`core/rail-stats`):
  - the coded standard set (`config/stats/standard.json`);
  - the decision-event language (`custom.rs`, `docs/STATS-SPEC.md` §14) with
    `street`, `facing`, `action`, `facing_size_pot`, `in_position`,
    `preflop_raises` and more. Every "any line" stat of the coach is one
    predicate in it.
  - Player rollups (`player_rollups`, `custom_player_rollups`) count the
    same for every opponent.
- **Trainer** (`web/src/components/trainer`, `docs/TRAINER.md`):
  - `FocusTarget` (`lib/training/plan.ts`: preflop / flop / turn / river);
  - `targetSettings`;
  - "For you" areas;
  - whole hands (`HandPlayer`);
  - query parameters on `/analysis/train`.
- **Reports screen** (`packages/ui/reports`): the graph (rule 7), the
  breakdown tabs, the `situationsLock`, and the shared desktop / web model.

## 5. Step by step

Each step is one worktree agent cut from `origin/prestaging`. It pushes to
`prestaging` after the area's local checks from `CLAUDE.md`. Steps run in
order, in the evenings and at weekends. Every UI step is previewed on both
apps, in light and dark, against the canvas boards.

### Step 0 — Design (done; rounds 1–3 on the canvas)

- Round 1 (`ideas-stacks`, stack depth) was turned down.
- Round 2 (`ideas-analytics`) proposed three layouts. The owner liked all
  three as different views, so round 3 merged them into tabs and sent the
  drill-down to the Trainer.
- Comments on the round 3 stickies are folded in before Step 4.

### Step 1 — Stat catalogue

- New file `config/stats/analytics.json`, with a schema next to
  `stats.schema.json`. Each entry holds:
  - `id`, `street`, `group`, and `family` (which stats a finding merges);
  - an EN / HR label and a sub-label ("any line");
  - **membership**: a predicate in the decision-event language. Examples:
    - flop fold vs bet is `street = flop and facing = bet`;
    - the turn probe adds `barrels = 0 and not initiative`.
  - **action class**: `fold` / `call` / `raise` / `bet` / `vpip` / `pfr`;
  - the words for too much and too little;
  - `sample.min` and the band floor;
  - for composition stats, `weak` (a set of hand classes).
- The first set is the coach's list, all in the round 2 board's data:
  - Preflop: VPIP, PFR, open raise, 3-bet, BB fold vs steal, fold to
    3-bet, 4-bet.
  - Flop: fold, raise and weak share of raises vs bet; cbet.
  - Turn: fold vs bet, fold vs probe, barrel.
  - River: bet and its weak share, fold vs bet, raise and its weak share.
  - Showdown: WTSD, W$SD, WWSF.
- The predicates compile through `CustomSet`, so the same definitions count
  the player (from the events) and every opponent (into
  `custom_player_rollups`) for Pool.
- **Done when:** a golden test per stat on fixture hands passes, and the
  existing coded stats (VPIP, PFR, 3-bet, cbet) agree with their catalogue
  twins.

Status: done in 4a5c9ba7 (2026-11-22)

- **As built:**
  - `config/stats/analytics.json` and `analytics.schema.json`: 22 stats in
    three kinds.
    - **rate** (16): `count` is a predicate; its action must be exactly the
      class's actions (`actionClasses`), and its opportunity starts with
      `street = <its street>`.
    - **share** (3, the weak shares): `of` a rate, `weak` a list of hand
      classes. No predicate: Step 2 derives them from the parent's taken
      decisions and each decision's hand class. Hero only.
    - **coded** (3: WTSD, W$SD, WWSF): the player's number is the
      `standard.json` statistic. No target, so they show "no target".
  - Also in the file: `handClasses` (9, strongest first, first match wins:
    `facts.made.class` + `facts.draws`), `groups` (the Streets blocks,
    EN/HR), `families`, and per stat the words, `sample.min` and
    `band.floor`.
  - Rust `rail_stats::analytics` (`catalogue()`, `load_catalogue`):
    - validation;
    - `counts(hand, seat)` for any seat;
    - `membership(hand)`: per decision `order`, its rates and whether it took
      the class. In `first` and `any` mode the member is the first
      opportunity event;
    - `hand_class`, `in_class`;
    - `custom_defs()`: the rates as custom statistics `an_<id>`, which
      compile in `CustomSet` and validate as a user's would;
    - `MEMBERSHIP_VERSION` (`analytics/1`), pinned to the rates by a test.
  - Web: `web/src/lib/stats/events.ts`, `predicate.ts` and `analytics.ts`
    (`ANALYTICS`, `decisionMembership(hand)`,
    `ANALYTICS_MEMBERSHIP_VERSION`), plus a byte copy of the JSON. These are
    ports of `events.rs`, the grammar and the evaluator.
  - Tests:
    - `core/rail-stats/tests/analytics.rs` and `tests/test/analytics.test.ts`
      read the same per-stat goldens (`core/rail-stats/tests/data/analytics/`:
      six new pinned hands plus three of `fixtures/stats`). Every rate is
      pinned both taken and not.
    - Schema and loader refusals.
    - `analytics_corpus.rs` checks the twins against the coded counters on
      all 51 981 corpus rows, exactly: VPIP, PFR, open raise, 3-bet, fold to
      3-bet, 4-bet, cbet and turn barrel (`cbet_turn`).
    - It also checks membership against counts, and compares Rust with the
      TS port on every corpus hand via `testdata/golden-analytics/`: every
      event field as a hash, plus counts and membership.
    - CI's `golden-fresh` now checks that directory.
- **Deviations:**
  - **New event field `checked_through`.** It means the street before was
    checked through. The plan's probe test (`barrels = 0 and not
    initiative`) also caught a turn bet after the raiser called a flop
    donk or check-raise.
    - Fold vs probe is now `preflop_aggressor and checked_through and
      facing = bet` on the turn.
    - Adding a field changes no other field's meaning, so `EVENTS_VERSION`
      stays `events/1`.
  - **Events carry `order`.** It is the decision's `Decision.order`, the
    analysis row's `ord`.
  - **4-bet uses the coded definition.** That is any 4-bet opportunity, cold
    ones included, the HUD's 4-bet and an exact twin.
  - **Bomb pots are out of every postflop rate,** as they are out of the
    coded counters and the HUD sums.
  - **Hand classes.**
    - "Middle / bottom pair" is two classes: `middle_pair` (second pair, or
      a pocket pair between the board cards) and `weak_pair` (third pair or
      worse).
    - `ace_high_backdoor` needs a backdoor draw. Plain ace high is `nothing`.
- **For Step 2: membership on the web is computed in TypeScript, not in
  SQL.**
  - Why: a decision's membership needs the hand's whole action stream (raise
    levels, the steal, the cbet chain, a checked-through flop), and
    `decision_analysis` and `facts` do not hold it.
  - Both apps run the same analysis library (the desktop through
    `@rail/web-lib`). So where the rows are written,
    `decisionMembership(hand)` gives each `ord` its stat ids and `taken`.
  - Store the ids with `MEMBERSHIP_VERSION` on the decision rows. Step 2's
    SQL groups by the stored ids.
  - Backfill, with no re-analysis:
    - desktop: in Rust from the stored PHF
      (`catalogue().membership(&hand_events(&phf))`);
    - web: in the browser from `hands.phf`, a page at a time, written by an
      RPC keyed by (hand, ord).
  - Rows whose version is not the current one are the work list.

### Step 2 — Checker rows from graded decisions

- **Per analysed decision, derive:**
  - which catalogue stats it belongs to (the predicate, evaluated on the
    decision's event);
  - whether `chosen` is in each stat's action class;
  - Σ `freq` of the class (the target's share);
  - `ev_loss_bb`, and whether the best option is in the class;
  - the size bucket (`facts.facingPot`);
  - the hand class (`facts.made` + `draws`);
  - the spot.
- **Spot** = pot type + hero role + hero position + opponent position, for
  example "BB vs SB cbet". Names come from one function in `packages/ui`.
- **Storage:**
  - Web: new columns on `analysis_leak_rows`: `facing_pot`, `made_class`,
    `ref_fold`, `ref_call`, `ref_raise`, `best_class`, `opp_position`.
    Stat membership is computed in SQL from a generated function, the same
    way `rail_stack_bucket` was planned.
  - Desktop: the rail-store twin.
- **Backfill** from `decision_analysis` (the jsonb already has everything):
  batched, idempotent, with no re-analysis.
- **Reads:**
  - RPC `analytics_checker(p_filters)` returns grouped sums per
    (stat, spot, size, made class):
    - n, taken, Σ ref share;
    - Σ `ev_loss` too much, Σ `ev_loss` too little;
    - hands.
  - A second RPC returns the top example decisions per (stat, spot, size,
    class) by `ev_loss`.
  - Desktop has the same reads in Rust.
- **Done when:** a fixture library gives identical sums on desktop and web
  (pgTAP + Rust tests), and the backfill is idempotent.

Status: done in 31e3ec19 (+ fixes 943b06f8, dbe2a586) (2026-11-22)

- **As built:**
  - **One row per (analysed decision, catalogue rate it belongs to)**, the
    same in both apps:
    - `stat`, `taken` (the hero's membership entry for the decision's
      `ord`);
    - `ref_share`: Σ `freq` of the options in the *stat's* class, and
      `best_in`: the reference's best option (highest EV, then frequency,
      then first listed: `analysis_best_action`) is in it. Both null when
      the decision was not analysed (no options);
    - `ev_loss_bb` (0 without one, 3 decimals), `size` (a catalogue size
      bucket, '' preflop or no bet), `hand_class` ('' preflop), `spot`,
      `multiway` (`-mw-` scenario, for `potKind`), `action_index`, the
      hand's groups for the filters, and `membership_version`.
  - **Derivation**, one function per language held equal by a fixture:
    `web/src/lib/stats/analyticsRows.ts` (`analyticsRows(hand, decisions)`)
    and `core/rail-stats/src/analytics_rows.rs` (`analytics_rows`). Shares
    rounded to 6 decimals, EV to 3, half away from zero in both.
  - **Size buckets** live in the catalogue (`sizeBuckets` in
    `config/stats/analytics.json`, schema, Rust `Catalogue::size_bucket`,
    TS `ANALYTICS.sizeBucket`): `20-40`, `40-60`, `60-85`, `85-125`, `125+`,
    each from its `min` in thousandths of the pot (`facts.facingPot` × 1000,
    rounded). A bet under 20% counts with `20-40`. Preflop decisions have no
    bucket.
  - **Spot** = `pot|role|hero|opponent`:
    - preflop: no pot, the role is `facts.preflopScenario`, the opponent the
      last raiser ('' unopened or limped);
    - after the flop: the pot from the preflop raises (`limped`,
      `single-raised`, `3bet`, `4bet+`, `bomb`), the role `facts.role`, the
      opponent the street's last bettor or raiser, else the one opponent
      left, `multi` with two or more;
    - positions are the PHF's. Named by `packages/ui/analytics/spot.ts`
      (`spotName(key, strings.analytics.spot)`: "BB vs SB · 3-bet pot · as
      the caller"), words in `packages/ui/strings/analytics.{en,hr}.ts`
      (new `UiStrings.analytics`, wired in both apps).
  - **Web** (`20271122090000_analytics_checker_rows.sql`):
    - tables `analysis_checker_rows` (PK hand, version, ord, stat; FK to
      `decision_analysis`, cascade) and `analysis_checker_hands` (one per
      hand written at a membership version, rows or not: the backfill's
      marker);
    - writer `analytics_rows_save(p_hands)` (definer, 200 hands a call,
      keyed by hand + ord; groups, action index and EV loss copied from the
      leak row; idempotent), called by `runAnalysis` after each
      `save_hand_analysis` slice (`lib/db/analyticsRows.ts`);
    - backfill page `analytics_rows_pending(analysis_version,
      membership_version, after, limit)`: hands analysed without a marker
      at the membership version, with the stored hand and its decisions;
      `backfillAnalyticsRows()` walks it in the browser at the end of every
      complete `runAnalysis`;
    - reads `analytics_checker(p_filters)` and
      `analytics_checker_examples(p_filters, p_stat, p_spot, p_size,
      p_hand_class, p_side, p_limit)`. Filters: `analysis_filter_of`'s
      (version, dates, room, format / kind, stake, seat, pot type, the Hands
      list's `hands`) + `potKind` + `membershipVersion`.
    - All four are Pro (`require_entitlement('analysis')`, in
      `entitlement_gates`).
  - **Desktop** (rail-store version 27, `rail_store::checker`): the same
    rows in `analysis_checker_rows`, the marker as
    `hand_analysis.checker_version` / `checker_position`; written in
    `save_analysis`' transaction from the stored PHF and decisions; the
    backfill is a step of the background pass (`Step::Checked`); reads
    `Reader::checker_sums` / `checker_examples` behind the async commands
    `analytics_checker` / `analytics_checker_examples` (refused with
    `plan` when the plan has no analysis). `CheckerSource` in both apps
    (`web/src/lib/db/analyticsRows.ts`, `app/src/lib/checkerSource.ts`),
    shapes in `packages/ui/analytics/model.ts`.
  - **Tests:** the fixture `core/rail-stats/tests/data/analytics/rows/`
    (every hero decision of 22 pinned hands with a made-up stored analysis,
    57 groups): TS and Rust derive the same `rows.json`
    (`tests/test/analyticsRows.test.ts`, `core/rail-stats/tests/analytics_rows.rs`);
    pgTAP `analytics_checker` (which embeds the fixture) and
    `core/rail-store/tests/checker.rs` both return exactly `sums.json`;
    both backfills are idempotent.
- **Deviations:**
  - **A new narrow table, not columns on `analysis_leak_rows`.** A decision
    belongs to several rates and "taken" and the share are per rate, and
    the membership cannot be computed in SQL (Step 1), so the rows cannot be
    kept by the leak rows' triggers; their own version lets a catalogue
    change re-derive them without touching the analysis.
  - **No `ref_fold` / `ref_call` / `ref_raise` / `best_class` /
    `opp_position` / `facing_pot` columns:** each row carries its stat's
    class share and `best_in`, the opponent is in the spot, and the size is
    the bucket (the examples read `facts.facingPot`).
  - **Backfill from the browser / Rust, not from `decision_analysis` in
    SQL** (the membership needs the PHF): no re-analysis either way.
  - **`MEMBERSHIP_VERSION` also covers the rows:** both suites pin
    `rowsFingerprint()` (hand classes and size buckets) with it; it stays
    `analytics/1` (nothing was stored under it before).
  - **The writer and the backfill page are Pro too**, like
    `save_hand_analysis` and `hands_needing_analysis`.
  - **Desktop filters** are the store's (dates as ISO times, format / kind,
    seat, pot type, pot kind); it has no room or stake filter, like its leak
    readers.

### Step 3 — The checker module

- A pure module with a Rust and a TS twin (like `display.rs` /
  `display.ts`). `packages/ui` stays display-only.
- **Input:** the grouped sums.
- **Output per stat:**
  - the player's %, the target %, the band, the tone;
  - the gap in points and its words;
  - the cost (bb/100) and the coverage.
- The same per spot, per size and per class: "share of your folds",
  "solver folds" and "a call is worth".
- **Findings (Overview):** stats off target are merged by `family` and
  ranked by summed cost, without double counting a subset stat (the probe
  is inside turn fold).
  - A headline and a why-sentence come from templates per family and
    direction in `packages/ui/strings/analytics.*.ts`. The why-sentence
    reads its numbers from the drill-down, e.g. the top hand class among
    the folds.
- **Done when:** golden vectors pass in both languages, and a property
  test holds: no tone stronger than *few* below `sample.min`, and a player
  equal to the reference is always *ok*.

Status: done in 7186bb30 (2026-11-22)

- **As built:**
  - **Twins.** TS `web/src/lib/stats/checker.ts` (`checkStats(catalogue,
    sums, coded?)`, pure, in the server-safe stats folder; `packages/ui`
    reaches it through `model/checker.ts`, the desktop app through
    `@rail/web-lib`) and Rust `rail_stats::checker` (`check_stats`). Same
    output field for field: `f64` one operation at a time in the same
    order, groups summed in input order, numbers out rounded to 6 decimals
    half away from zero, decisions made on the unrounded values.
  - **Input:** the catalogue, `CheckerSums` (`hands`, `pending`, `groups`),
    and optionally the player's coded counts (`{ wtsd: { made, opp } }`)
    from the rollups.
  - **Per stat** (catalogue order): `opps`, `oppsTaken`, `n`, `taken`,
    `player`, `target`, `half`, `bandLow` / `bandHigh` (clamped 0–100),
    `gap`, `direction` (`high` / `low`), `tone`, `costHigh`, `costLow`,
    `cost` (in the gap's direction), `coverage`, `source` (`charts`
    preflop, `solver` after), and the breakdowns `spots` (costliest first
    in the stat's direction, then by sample, then key), `sizes` and
    `classes` (catalogue order). Each row has the same figures plus
    `shareOfTaken` ("share of your folds") and `worth` (ΣevHigh / taken:
    "a call is worth", bb). A share's class rows are its composition (each
    class's part of your actions against the reference's, `weak` marked).
    Coded stats carry the player's number only (tone `none`).
  - **Tone:** in the band → `ok` (whatever the sample); outside it under
    `sample.min` → `few`; more than twice the half-width outside the band
    (|gap| > 3 × half) → `far`; else `off`; no analysed decision or a
    reference that never takes the action → `none`.
  - **Findings:** stats `off` / `far` merged by family and **lean**
    (`tight` / `loose`), ranked by summed cost, with `stats` (`counted`
    flag), `lead`, `direction`, `tone` and `why` (the lead stat's costliest
    spot, and its hand class with the most extra or missing actions against
    the reference: rate, target, share of the taken, worth).
  - **Words:** `packages/ui/analytics/findings.ts` (`gapText`,
    `percentText`, `pointsText`, `statName`, `breakdownName`,
    `findingHeadline`, `findingWhy`) over the new `checker` and `findings`
    entries of `strings/analytics.{en,hr}.ts`: headlines per family and
    lean (the weak shares have their own), why-templates per family and
    lean.
  - **Tests:** fixture `core/rail-stats/tests/data/analytics/checker/`
    (`cases.json`: Step 2's sums and eight made-up libraries; `expected.json`:
    the results and their EN + HR words), held by
    `tests/test/analyticsChecker.test.ts` (TS + words + properties;
    `ANALYTICS_CHECKER_WRITE=1` rewrites both files) and
    `core/rail-stats/tests/checker.rs` (Rust equals the TS on every number,
    properties). No migration.
- **Deviations:**
  - **Findings merge by family and lean, not by the raw direction.** A
    family mixes folds and raises (BB fold vs steal with 3-bet, fold to
    3-bet with 4-bet), so "too high" means opposite things inside one
    family. The lean turns a fold stat's direction around (folding too much
    and 3-betting too little are both `tight`; a weak share too high is
    `loose`). The headline templates are per family and lean.
  - **No double counting goes past `within`.** A stat is listed but not
    summed when its `within` (or a share's `of`) is in the finding, and
    also when a costlier summed stat of the finding judges the same
    decisions: the same Streets block, or both preflop (an open raise is
    also a PFR and a VPIP; fold to 3-bet and 4-bet share their decisions).
    Otherwise one decision's EV loss would be summed twice.
  - **`ok` wins over `few`.** A player inside the band is `ok` even below
    `sample.min`; `few` is for a gap outside the band on a small sample.
    That is how both properties hold together.
  - **The why's hand class is the one with the most extra actions over
    the reference** (taken − the reference's expected count), not simply the
    most taken: "nothing" is the most folded class and the solver folds it
    too.
  - **The words are rendered in TypeScript only.** Both apps show the
    findings from the shared screen, so the Rust twin returns the numbers
    and keys (template = family + lean, the why's numbers) and the golden
    file holds the EN and HR text the TS renders from them.

### Step 4 — Analytics screen shell

- Rename the navigation label (desktop sidebar, web nav, strings) to
  Analytics.
- Add the tab row: Overview · Streets · All stats · Pool (open question 1:
  today's breakdown tabs).
- The figures row (hands, won, all-in EV, showdown, non-showdown, bb | $)
  is shared by the first three tabs. Overview carries the graph.
- Clean UI applies: no titles, signed and coloured results, rows that look
  clickable.
- **Done when:** both apps render the shell with today's data, the old
  routes still open it, and lint, typecheck and lint:css pass in
  `packages/ui`, `web` and `app`.

Status: done in 17682892 (2026-11-22)

- **As built:** the shared `ReportsScreen` is the Analytics screen; both
  surfaces pass `view` / `onView` (`AnalyticsView`: `overview`, `streets`,
  `stats`, `pool`, `breakdown`), the Breakdown split `tab`, an
  `AnalyticsChecker` and an optional `checkerLock`. Desktop route:
  `#/reports/<view>`, and `#/reports/<split>` (the palette's old links)
  opens Breakdown at that split; `#/reports` opens Overview. Web: `/stats`,
  the tab in page state.
- **Deviations:**
  - Open question 1's default: a fifth tab **Breakdown** holds today's
    statistics matrices, the breakdown tabs and the web's footer
    (sessions, opponents). The old summary tiles are gone; the figures row
    replaces them.
  - The figures are rates per 100 hands from the graph's last point (won,
    all-in EV, showdown, non-showdown), in bb/100 or the currency per 100
    money hands, as the board shows them; the hand count is the figures
    row's on the first three tabs and the header's on Pool and Breakdown.
  - Streets and Pool are one quiet line each until Steps 6 and 10.

### Step 5 — All stats tab

- Build it from `AN-Main` (All stats): grouped rows, the band track, the
  gap word, opportunities and cost.
  - Sort by street or by cost; show all or only off target.
  - A row expands to its spots, with fold / call / raise bars for the
    player against the target.
- A hover on a stat shows two lines: what it counts and where the target
  comes from.
- **Done when:** the fixture hero who over-folds the flop shows flop fold
  red with a cost, and a fixture "perfect" hero shows every row in range.

Status: done in 17682892 (2026-11-22)

- **As built:** `packages/ui/analytics/AllStats.tsx` over the pure view
  model `analytics/view.ts` (`allStatsItems`, `trackOf`, `spotLines`,
  `barOf`, `siblingsOf`, `figuresOf`, `codedOf`, `checkerFiltersOf`) and
  `useChecker` (reads the checker only while All stats is open). Bars: the
  stats with the same opportunity (`count` before `=>`) make one bar per
  spot (flop/river fold + raise -> fold / call / raise; VPIP + PFR -> fold /
  call / raise; a bet stat -> bet / check; a stat alone -> its class and an
  unnamed rest). Tests: `tests/test/analyticsScreen.test.ts`.
- **Deviations:**
  - Costs are always bb/100 (the $ toggle changes the figures and the
    graph only): a stat's cost has no money of its own without a per-hand
    big blind.
  - The target column shows the band ("37–41"), as the board does; the
    exact target and source are in the hover's second line.
  - A spot row shows its numbers whatever its tone ("Fold 57% vs 38%"),
    since most spot rows are `few` on a real sample (Step 3's note); its
    cost shows when it is `off`, `far` or `few`.
  - Where the checker has no number for a stat (nothing analysed, or the
    Free plan), the coded twin from the rollups stands in: the player's
    number only, "No target".
  - Filters: the web sends the Hands list's filter (`hands`) for groups
    the checker keys cannot say; the desktop store's checker reads only
    dates, kind / one format, one position and one pot type, and All stats
    says so in one line when other groups are set (the store does not yet
    filter checker rows by the Hands filter).
  - Free plan: the surfaces' compact Pro lock (feature `analysis`) above
    the rows, the order / show controls hidden, rows not expandable.

### Step 6 — Streets tab

- Four columns of blocks with the fold / call / raise and bet bars. A click
  opens the spots below, using the same component as the All stats row.
- **Done when:** it reads the same rows as Step 5; no new query is needed.

Status: done in 96824995 (2026-11-22)

- **As built:** `packages/ui/analytics/Streets.tsx` over `streetColumns`
  (`analytics/view.ts`). One block per catalogue `group` (showdown left
  out), in the column of its street. A block's bars are the group's rates
  over the first rate's decisions (`count` before `=>`): fold / call /
  raise (flop and river facing a bet, preflop overall from VPIP / PFR) or
  one action filling from the left (open raise, 3-bet, cbet, barrel, river
  bet, fold to a 3-bet). The block's words are its costliest off-target
  stat's (`gapText`), else not sure / in range; its cost that stat's. A
  click opens the block under the columns: each of its stats against its
  target (a pick when there are several, weak shares included), then the
  chosen stat's spots with All stats' component (`StatSpots`, exported from
  `AllStats.tsx` with `ActionBar`). It reads the checker result
  `ReportsScreen` already holds (`useChecker` now on Overview, Streets and
  All stats). The key (fold / call / raise or bet, upper bar you) sits in
  the tab row as on the board.
- **Deviations:**
  - **No double counting in a block or a column.** A block costs its
    costliest stat only (its stats judge the same decisions: the probe is
    inside the turn fold, fold and raise share theirs). A column sums its
    blocks, except that preflop's Overall (VPIP / PFR counts every preflop
    decision, `any`) overlaps the other preflop blocks: the column takes the
    larger of it and their sum.
  - **The bars use the stats with a number.** A rate without a player's
    number leaves its part out (river fold alone when no river raise was
    analysed) instead of blanking the bar; a block with no number at all
    shows its label and "—", and is not clickable.
  - **The costliest off-target block opens first**, as the board shows one
    open; nothing opens when nothing is off.
  - **An open block or finding shows its six costliest spots** with an
    "All N spots" toggle (real samples have 60+ preflop spots); All stats
    keeps the full list.
  - **On a phone** the columns stack and the open block shows under its own
    column; from 721 to 1100 px the columns are two a row.
  - Free plan: the lock above the columns; the player's bars from the
    rollups' coded twins where every part has one (VPIP / PFR, open raise,
    3-bet, cbet, barrel, fold to 3-bet / 4-bet); no target bar, words,
    costs, or opening.

### Step 7 — Overview tab

- The graph, then the three finding cards (Step 3). Each card opens to its
  why-sentence, its spots and "Practise this ▸".
- Below them, the pills for in-range stats, and links to All stats and
  Pool.
- **Done when:** with no finding off target, the cards give way to one line
  ("Nothing clearly off at this sample") and the pills.

Status: done in 96824995 (2026-11-22)

- **As built:** `packages/ui/analytics/Overview.tsx` under the graph, over
  `overviewOf` (the first three of `result.findings`, the stats with tone
  `ok` as pills, and the state: `findings`, `clear` = "Nothing clearly off
  at this sample.", `unanalysed` = no analysed decision at all, "Targets
  show once your hands are analysed."). A card: number, `findingHeadline`,
  each of its stats ("Turn · Fold vs bet 62% target 37–41%", the number in
  its tone), the summed cost in bb/100. The first card is open (the
  board's); open, it shows `findingWhy`, "Practise this ▸" and the lead
  stat's spots (`StatSpots`). Below: "In range" pills, then "All stats →"
  and "How your pool plays →" (switch the tab).
- **"Practise this ▸"** links to the Trainer route Step 9 names, with
  `practiseQuery(finding)` = `from=analytics&stat=<lead>&spot=<why.spot>`
  `&classes=<why.handClass>` (no `size`: the finding has none). Web:
  `/analysis/train?…` (the Trainer ignores the keys until Step 9; checked
  that it opens normally). Desktop: `#/trainer/<query>` (the query is the
  route parameter, since `#/trainer?…` is not a route), left out while the
  Trainer is hidden during play. A new `ReportsScreen` prop
  `practiseHref(query)`; without it the link is not offered.
- **Deviations:** the Free plan shows the graph, the lock and the two
  links (pills are judged against targets, so they are Pro too). A finding
  whose summed cost rounds under 0.05 bb/100 shows "—" for its cost.

### Step 8 — Drill-down

- **Routes:** desktop `#/reports/stat/<id>`, web `/stats/<id>`. The current
  filters are carried.
- **Content:**
  - spots on the left;
  - the bet-size table (player against solver, cost);
  - "What you fold", strongest class first;
  - the folded hands the solver plays, by EV.
- A hand row opens the hand in the replayer, and also offers
  "Play it ▸" (Step 9).
- **Done when:** two clicks from a red stat reach a spot's hand classes,
  and three reach a hand.

Status: done in 58f9bc2d (2026-11-22)

- **As built:** the shared `packages/ui/analytics/Drill.tsx` over the pure
  `drillOf` (`analytics/view.ts`), shown by `ReportsScreen` instead of the
  tabs when the surface passes `drill` (the stat id from its route).
  - **Routes.** Desktop `#/reports/stat/<id>` (`drillOfParam`; "← Analytics"
    returns to the tab or split it was opened from). Web `/stats/<id>`
    (`web/src/app/stats/[stat]/page.tsx`, the same `StatsScreen`; the stat
    is read from the address with `drillOfPath`). The way in is "By bet size
    and hand →" in `StatSpots`' links row, so it is under an All stats row,
    an open Streets block and an open Overview finding alike
    (`DrillNavContext`: the surface's `drillNav.href`, and on the web
    `drillNav.go` = `history.pushState`, so the filter and the tab stay).
  - **Content.** The bar: back, the stat, the player's number in its tone,
    "target 37–41% · Solver", the cost, "Practise <spot> ▸". Spots on the
    left (the checker's order, costliest first, the first open). On the
    right, for the open spot: the bet sizes (fold / call / raise for the
    player over the reference, the stat's own action in its tone, the cost;
    a click narrows the classes and hands to that size), "What you fold ·
    <spot> · strongest first" (share of the folds as a bar, fold rate you /
    solver, "Call is worth", "Practise ▸"), then the hands
    (`AnalyticsChecker.examples` → `analytics_checker_examples` on both
    surfaces), each a link to the hand and "Play it ▸". The figures are the
    checker's (`checkStats`) over the open spot's (and size's) groups.
  - **Hands.** Desktop: `ChosenLink` in a `HandTable` (`wrapHands`), a click
    opens the replayer's window, several can be chosen. Web: the hand's
    analysis page at the decision (`/analysis/h/<id>?t=a<index>&from=stats&stat=<id>`),
    whose Back now reads "Back to the stat".
  - **Trainer.** `drillQuery` = `from=analytics&stat=…&spot=…&size=…&classes=…`
    (Step 9's), `playQuery` adds `hand=<id>&ord=<n>&action=<index>`; both
    through the existing `practiseHref` (web `/analysis/train?…`, desktop
    `#/trainer/<query>`).
  - **Pro:** the drill-down sits behind the same `checkerLock` (feature
    `analysis`): the Free plan sees the way back, the stat's name and the lock.
  - Tests: `tests/test/analyticsDrill.test.ts` (routes, `drillOf` against the
    checker over one spot, sizes, classes, Practise, queries, EN + HR
    renders, the lock, the way in, and the "two clicks / three clicks" walk).
    No SQL, no Rust, no migration.
- **Deviations:**
  - **Every size first.** The board opens the first bet size; the
    drill-down opens with every size of the spot and a click on a size
    narrows the classes and hands to it (a second click widens again):
    real samples per spot and size are small.
  - **The classes show the player's fold rate beside the solver's**
    ("Fold · you / solver"), not the solver's alone: a share of the folds
    next to the solver's fold rate does not say whether a class is folded
    too much. The bar is the share of the folds, amber / red when the class
    is off target.
  - **"Practise ▸" on a class** when it is off target (or not sure yet) the
    stat's way and, for a stat that is too high, at least 5% of its actions
    (the board: solver folds ≤ 10% and share ≥ 5%). "Practise <spot> ▸"
    deals from the three costliest of them.
  - **The hands follow the gap's direction:** too high lists the actions
    taken where the solver did otherwise, too low the missed ones; 8 shown
    (of 16 asked), only those that gave up EV. The heading names it per
    action ("Your folds the solver plays", "Your checks the solver bets", …).
  - **Spots:** analysed ones only (a spot seen but never analysed has no
    number), the first eight and "All N spots" (real preflop samples have
    60+). Preflop has no size table and no classes (the rows carry none):
    the spots and their hands.
  - **No "Open N hands →" and no bar key** under the drill-down: the Hands
    list cannot filter by checker rows yet, and the size table is numbers.
  - **The desktop's replayer opens at the hand**, not at the decision
    (`replayer_open` takes the hand only); the web's opens at the decision.
  - **The web keeps the filter while moving in and out** (history entries of
    one screen); a reload of `/stats/<id>`, or the hand page's Back, opens it
    with the default filter.
  - Shares and coded stats have no drill-down (no link; a typed route says so).

### Step 9 — Into the Trainer

- **Target.** `FocusTarget` gains:
  - `sizes` (the bucket);
  - `classes` (hand classes to deal from);
  - `from: { stat, spot, cost }`.

  `targetSettings` maps them onto the settings sheet. A new "Hands" chip
  reads *Hands you tend to fold*.
- **The bar.** The Trainer shows the *From Analytics* bar and the goal
  panel: your rate here, the target, and this drill's rate, which counts
  as the player answers.
- **Play it.** A fixed spot made from a played decision: seats, line,
  board and the hero's cards, dealt once.
  - Flop, turn and river spots use the solver the analysis used.
  - Preflop uses the chart node.
  - Sessions record these like whole-hand decisions (`sessions.ts`).
- **Links.** Web uses `/analysis/train?from=analytics&stat=…&spot=…&size=…&classes=…`;
  desktop uses the same query on its Trainer route.
- **Done when:** from the drill-down's "Practise", the first hand dealt is
  in the spot, the size and one of the chosen classes, and the goal panel
  updates after each answer.

Status: done in e6156b15 (2026-11-22)

- **As built:** `web/src/components/trainer/analytics.ts` (`analyticsLink`,
  `analyticsTarget`, `drillGoal`), `FromAnalytics.tsx` (bar, goal panel),
  `played.ts` + `PlayedPlayer.tsx` (Play it), `lib/training/focusDeal.ts`
  (size buckets and hand classes in the flop, turn and river dealers);
  settings `size`, `classes`, `from`; host `played(handId)` and
  `analyticsHref(stat)`. Web reads the address in `WebTrainer`, the desktop
  the route parameter in `app/src/screens/Trainer.tsx`. No migration, no RPC,
  no Tauri command (`hand_phf` and `hand_analysis` already exist). Details in
  `docs/TRAINER.md` §7. Tests: `tests/test/trainerAnalytics.test.ts` (links on
  both routes, settings round trip, the deal filter on a synthetic flop tree
  and on real river deals checked against the analysis' own facts, the goal
  math, the bar and panel EN + HR, Play it).
- **Deviations:**
  - **The links carry the goal's figures** (`you`, `ref`, `cost`, `tone`):
    `drillQuery`, `practiseQuery` and `playQuery` take the practised scope's
    figures - the chosen size's row, else the spot's, a class's own for its
    "Practise ▸" - so the Trainer reads no checker of its own.
  - **A link opens its session straight away** (no settings sheet, as the
    board shows); a session training the same spot is continued and takes
    the newer figures (`sameTraining` ignores them).
  - **The goal panel's "This drill"** shows the drill's rate with the
    reference's rate on the same dealt hands under it: the hands are dealt
    from the classes the player gets wrong, so the stat's overall target is
    not the drill's. Judged like the checker with a 5-point floor from 5
    answers. No "N / 12" hands goal (the session's own figures sit below).
    It counts the answers of this visit (and the device's): the account
    does not keep an answer's action and mix (no migration for it).
  - **Play it grades against the stored options** (`gradeDrill`, as the
    drills of your own mistakes): the reference is the analysis' own by
    construction (chart node, flop library, turn or river solve) and nothing
    is solved again. No range panel for it. The desktop analyses the hand
    now when its stored row is older (`handAnalysisOf`, as the hand view).
  - **Turn and river:** hero and villain seat pins only for an Analytics
    session; out of position a bet to answer is the villain's after the
    hero's check (new `facing: "check-bet"`), which the sheet's "out of
    position, facing a bet" now deals too (it used to deal in position).
  - **The Hands chip** reads "Hands you tend to fold" for fold stats and
    "Hands from Analytics" for the others.
  - Spots the dealers cannot hold (bomb and 4-bet pots, several opponents,
    a line the flop library lacks) are dealt as near as they can, and the
    bar says so.
  - Fixed on the way: a spot re-dealt itself when the web host changed after
    an answer was kept (the cards changed under the verdict).

### Step 10 — Pool tab

- **Figures:**
  - hands of regs and of fish (opponent rollups by type) and their ratio;
  - the regs' bb/100 ± SE;
  - the player's bb/100 with a fish in the pot, and with regs only (the
    existing vs-type hand filter).
- **Table:** the catalogue stats for regs and fish from
  `custom_player_rollups`, against the player's target.
  - An exploit sentence per stat and direction appears only when the
    pool's gap is clear on its own opportunities.
- **Composition stats** for the pool come from shown hands only, with a
  note that they lean strong. They are optional and can wait.
- **Done when:** a fixture pool of over-folding regs gives "bluff them more"
  on river fold, and a small pool shows no sentence.

### Step 11 — Stack depth as a filter (kept from the first plan, smaller)

- `effective_first_action_bb` in `core/rail-stats/src/events.rs`:
  - the hero's stack against the largest stack still live at their first
    preflop action, in big blinds of the largest forced blind;
  - a walk falls back to the hero's own stack.
- Store it on desktop `hand_list` and web `hand_stats`, with a backfill.
  Add `effStack` to `facts.rs` / `builderFacts.ts` with golden parity.
- One bucket JSON (`config/stats/stack-buckets.json`) replaces the
  disagreeing bands: report `STACK_BANDS`, `STACK_DEPTHS`, and the filter
  chips 0-40 / 40-80 / 80-120 / 120+.
- An *Effective stack* filter chip in the filter bar. That is all; there is
  no stack tab.
- **Done when:** the chip filters Analytics and Hands the same way on both
  apps.

### Step 12 — States, Free / Pro, guide, rollout

- States from `AN-States`:
  - small sample;
  - no target (4-bet pot turns, multiway);
  - analysis still running ("targets fill in as hands are analysed");
  - Free (numbers only, a one-line Pro lock);
  - empty.
- `docs/GUIDE.md`: what the target is, why most rows stay green or grey,
  and how to read the band.
- Prod migrations are applied before the main promotion, per `CLAUDE.md`.
  Backfills run on prod in batches, out of hours.

## 6. Open questions for the owner

1. **Today's breakdown tabs** (Position, Pot type, Stack, Starting hands,
   …): a fifth tab *Breakdown* (default), or fold them into the filters?
2. **Web `/analysis/reports` and `/analysis/leaks`** overlap with All stats
   and the drill-down. Keep them and link across (default), or retire
   them once Analytics ships?
3. **Weak share target:** the solver's share over your hands (default), or
   the coach's fixed balance numbers?
4. **Pool targets:** show your own target as an approximate reference
   (default), or no target column for the pool?
