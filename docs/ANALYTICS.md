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

### Step 6 — Streets tab

- Four columns of blocks with the fold / call / raise and bet bars. A click
  opens the spots below, using the same component as the All stats row.
- **Done when:** it reads the same rows as Step 5; no new query is needed.

### Step 7 — Overview tab

- The graph, then the three finding cards (Step 3). Each card opens to its
  why-sentence, its spots and "Practise this ▸".
- Below them, the pills for in-range stats, and links to All stats and
  Pool.
- **Done when:** with no finding off target, the cards give way to one line
  ("Nothing clearly off at this sample") and the pills.

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
