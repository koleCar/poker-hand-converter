# Hand analysis — plan

How Rail grades a hand: for every decision the hero made, how far was it from a
reference strategy, what did it cost, and why. This is the plan, not the spec;
each phase gets its own issue and its spec section once it is picked up.

Status: **accepted**, 2026-10-02. Being implemented phase by phase; each phase
updates this file when it learns something that changes the plan (§10 is the log).

---

## 0. What the two reference products do

Studied on 2026-10-02: GTO Wizard's Analyze section, logged in with ~68.5K
analysed hands of the owner's own; Upswing's Lab from its public descriptions
(the members area is blocked to the browser tooling used here). Notes describe
structure only — nothing is copied, and nothing from either product (charts,
solutions, numbers) may be imported into Rail. Both products' terms forbid it,
and an engine we cannot explain is an engine we cannot test.

### 0.1 GTO Wizard — quantitative, per decision

**Hands table.** One row per hand. Each action letter (`F R C X B`) is
coloured by how good that move was, so a bad hand is visible without opening it.
Columns: pot type (SRP / 3Bet / …), pot (bb), win/loss (bb), **EV loss (bb)**,
**EV loss %** (of pot), **GTO result** (icon of the worst move), **GTO score %**,
**frequency difference %**, effective stack, and the source file.

**Hand panel.** Opening a row slides in:

1. A table diagram at the current decision, with pot and pot share of the bet.
2. A banner when the solution is approximate (e.g. "non-ante solve").
3. **Hand evaluation**: one word for the whole hand (the worst move:
   *Perfect / Good / Inaccurate / Mistake / Blunder*), win/loss, EV loss, and a
   per-street badge row.
4. The action list, street by street. Every hero move carries a quality icon,
   and a wrong one shows the best alternative underneath it ("Fold ⓘ → Call 1.8 ✓").
5. Selecting a move shows **every option at that node**: GTO frequency and EV
   (bb) per option. EV loss is `max EV − EV(chosen)`.
6. *Study* opens the full solution for the node: the 13×13 grid with a strategy
   mix and EV per hand class, action totals in % and combos, a breakdown by
   made hand and draw (set, top pair, flush draw, OESD, …), and equity buckets.
   *Practice* replays the spot against the solver.

**Stats.** GTOW score, hands and moves, average EV loss (bb/100 hands, % of pot
per 100 mistakes, bb per 100 mistakes) and frequency difference. Then a
**Perfect / Good / Inaccurate / Mistake / Blunder %** table by street, preflop
action, position and preflop aggression.

**Reports ("compare stats to GTO").** Each of your frequencies next to the
equilibrium's, with the signed difference. Preflop: VPIP, PFR, RFI, limp,
squeeze, 3/4/5-bet. Flop, grouped by role: PFR in or out of position and caller
in or out of position, each with cbet, check, donk, and raise/call/fold against
a cbet or a stab. Each stat also shows:
- a by-position split;
- the list of hands where you deviated, sorted by EV loss;
- a definition and a tip.

**Their move classes** (help centre, Trainer):
- *best*: the highest-frequency action;
- *correct*: played at some frequency;
- *inaccuracy*: played under 3.5% of the time, but not costing much EV;
- *wrong*: never played;
- *blunder*: never played and costing significant EV.

Each move scores −100…+100. Frequency difference is
`freq(most frequent) − freq(chosen)`, averaged over moves.

**Owner's own numbers.** These justify the build order:
- 65K graded moves in total: 53K preflop, 6.4K flop, 4.0K turn, 2.2K river. **Preflop is 81% of all decisions.**
- Accuracy falls street by street: 86.9% perfect overall, 91.1% preflop, 62.3% river.
- The blunder rate is 4× higher on the river than preflop.

### 0.2 Upswing Lab — qualitative, per street

Upswing does not grade hands automatically. Its "analysis" is coaching:
- preflop charts by position and scenario;
- videos, plus written hand reviews organised **street by street**.

Each street gives the action, a verdict, and the reasoning behind it. The
reasoning uses the same small set of concepts every time:
- ranges (what each side has here);
- board texture (paired, monotone, connected);
- range and nut advantage;
- bet sizing and its purpose;
- position;
- equity and pot odds;
- blockers;
- where real opponents differ from the solver.

### 0.3 What Rail takes from each

| From GTO Wizard | From Upswing |
|---|---|
| Per-decision grade with frequency, EV and EV loss | A *why* for every graded decision |
| One word per hand, coloured action letters in lists | Street-by-street narrative |
| Stats by street, position and pot type | Concepts as a fixed vocabulary (texture, range/nut advantage, SPR, MDF, blockers) |
| Reports: your frequency vs reference, with a list of offending hands | Practical notes where population play deviates (later, from villain stats) |
| An honest *approximate* banner | — |

---

## 1. The core model

Everything below hangs off one record per hero decision. The stats engine
already enumerates decisions (`lib/stats/context.ts` → `Decision`); analysis
adds a reference strategy to each.

```ts
interface DecisionAnalysis {
  order: number;               // Decision.order — same index as the stats engine
  street: Street;
  node: SpotKey;               // canonical description of the spot (§3.4)
  options: Array<{
    action: "fold" | "check" | "call" | "bet" | "raise";
    size?: number;             // bb, as solved (bucketed, §3.3)
    sizeBb?: number;           // preflop: "raise to X" in bb (charts are not pot-relative)
    sizePot?: number;          // fraction of pot
    freq: number;              // 0–1, reference frequency for the hero's exact hand
    ev: number;                // bb, for the hero's exact hand
  }>;
  chosen: number;              // index into options (after size mapping)
  evLoss: number;              // bb: max(ev) − ev[chosen]
  evLossPot: number;           // evLoss / pot before the decision
  freqDiff: number;            // max(freq) − freq[chosen]
  grade: Grade;                // §2
  source: "chart" | "solver" | "heuristic";
  approximations: Approximation[];   // §3.5 — always shown
  facts: SpotFacts;            // §4 — texture, SPR, pot odds, MDF, hand class, blockers
}

interface HandAnalysis {
  version: "analysis/1";
  status: "full" | "partial" | "not-analysed";
  reason?: string;             // why not, e.g. multiway postflop, PLO, ICM
  grade: Grade;                // worst decision
  score: number;               // §2
  evLoss: number;              // Σ bb
  evLossPot: number;           // Σ evLoss / final pot
  decisions: DecisionAnalysis[];
}
```

Analysis is **versioned exactly like stats** (`STATS_VERSION`/`withVersion`):
`ANALYSIS_VERSION = "analysis/1"`, a rebuild on version bump, and reports that
refuse to mix versions. A new chart set, solver build or threshold change is a
new version.

---

## 2. Grading

Five grades, named after the analyser's: **Perfect, Good, Inaccurate,
Mistake, Blunder**. The thresholds are ours, are constants in one file, and are
part of the version:

| Grade | Rule (first that matches) |
|---|---|
| Perfect | `freq[chosen] ≥ max(freq) − 0.05`, or `evLoss ≤ 0.1% pot` |
| Good | `freq[chosen] ≥ 3.5%` |
| Inaccurate | `freq[chosen] < 3.5%` and `evLossPot ≤ 2%` |
| Mistake | `evLossPot ≤ 8%` |
| Blunder | everything else |

Why EV loss in **% of pot** and not bb: the same 2bb is a disaster in a limped pot
and noise in a 4-bet pot (GTOW added % of pot for this reason). bb is still
stored and shown.

**Move score** (0–100, for averages): `100 · freq[chosen] / max(freq)` when
`evLoss` is negligible, otherwise `max(0, 100 − 1000 · evLossPot)`. **Hand
score** is the mean over the hand's decisions; **player score** the mean over
moves (not hands — a 9-decision hand counts 9 times, same as GTOW's "moves").

Mixed strategies are why "Perfect" is a band, not an equality: if the reference
calls 52% and raises 48%, both are perfect. A player who always picks the
48% action is not wrong in any single hand — that shows up in *Reports* (§6.3),
never as a per-hand grade.

---

## 3. Where the reference strategy comes from

This is the hard part and the reason for the phasing. Three sources, each
labelled on screen so a grade never pretends to be more than it is.

### 3.1 Preflop — charts (`source: "chart"`)

A preflop chart is a table: *(format, players, stack depth, position, scenario)
→ for each of 169 hand classes, a frequency and EV per action*. Scenarios:
RFI, vs RFI (call / 3-bet / fold), vs 3-bet, vs 4-bet, squeeze, BvB (SB limp/raise),
vs limp. 6-max 100bb cash is ~60 charts; 9-max and other depths multiply that.

**Charts are authored by us** — computed with our own preflop solver (§3.2 run
with a preflop tree and an equity-realisation model) or licensed explicitly.
Not copied from GTO Wizard, Upswing or anyone else.

Preflop decisions are 81% of all moves (§0.1), so charts alone grade most of a
player's decisions. This is why they come first.

**Shipped in A2a (#95), details in `docs/CHARTS.md`.**
- **Source:** our own multi-player DCFR over the 169 classes, plus a
  realisation model for pots that see a flop.
- **Set:** 280 tree nodes for 6-max 100bb, `charts/1`, 631 KB.
- **Convergence:** NashConv 0.06 mbb/hand.
- **Lookup refuses, with a reason:** `limp`, `cold-call`, `multiway` (more than
  4 entrants), `rare-line`, `action-not-modelled`, and depth beyond ±20%.
- **Lookup approximates:** `short-handed` (5-max is read as 6-max with UTG
  folded), and off-tree sizes, by action translation.
- **Hands outside the range:** a hand class that never reaches a node gets the
  best response, and the lookup reports `inRange: false` so the UI can say so.

**Known weakness of `charts/1`.** The realisation model under-rates
implied-odds hands:
- early-position opens lean to high cards over small pairs and suited
  connectors;
- flatting is rare: BB defends 48% vs a button open, and BTN never flats vs CO.

Two consequences:
- Lines through a flat come back as `rare-line`.
- Grades in those spots carry a `model` approximation note.

A2a.1 reworks the model (`charts/2`). The lasting fix is feeding the A5 flop
library's realisation back into the preflop solve.

### 3.2 Postflop — our own solver (`source: "solver"`)

A counterfactual-regret solver (Discounted CFR, Brown & Sandholm 2019) over a
fixed betting abstraction, heads-up only.

- **Language.** TypeScript over typed arrays in `lib/solver` (shipped in #90).
  Same import rule as `lib/equity`, enforced by ESLint. It runs in a Web Worker
  in the browser and under Node in tests.
- **Measured (#90, M2 Pro, Node 24), solved to under 0.5% of the pot:**
  - **River:** 40 ms for ~300 v ~240 combos with two sizes + all-in; 273 ms for
    ~600 combos with three sizes and rake.
  - **Turn+river:** 6 s with one size, 36 s with two sizes; 20–80 MB of memory.
  - **Flop:** about 50× the turn. Not feasible on demand in the browser.
- **Licensing.** The well-known open-source postflop solvers are AGPL. Rail has
  no licence file and is not open source, so we do not embed them. We write our
  own: the algorithm is published, and the river-only version is small.
- **Order and strategy per street:**
  - **River:** solved on demand for the hand on screen. A full strategy blob is
    100–500 KB, so re-solving is cheaper than storing and downloading the blob.
  - **Turn:** too slow per hand. It needs river-card isomorphism, chance
    sampling, and a coarse river menu below the turn (one size + all-in). It is
    then precomputed or cached, storing turn-level nodes only (a full blob is
    10–44 MB).
  - **Flop:** an offline-precomputed library: canonical flop × preflop line,
    coarse abstraction, flop-level strategies only. Until that exists, flop
    decisions stay heuristic.
- **Bet-size menus:**
  - **River:** 33 / 75 / 150% + all-in; raises 75% + all-in; cap 2–3. Without
    the overbet, real overbets land off-tree (§3.3).
  - **Turn:** 75% (or 33 / 75%) + all-in; cap 1–2.
- **EV units:** net chips from the start of the street, counting the pot as
  winnable. Grading reads `ev[action][combo]` and `strategy[action][combo]` at
  the hero's combo straight from the result.
- **Inputs.** Two ranges, the board, pot, effective stack, the bet-size menu
  and rake. Ranges come from walking the hand: the preflop chart gives each
  player's range for their line, and every postflop action narrows it by the
  solved strategy at that node. This is the same thing a solver does inside
  its own tree.
- **Validation.**
  - Known games: Kuhn and Leduc poker, plus the river "clairvoyance" game,
    which has a closed-form answer.
  - Exploitability below 0.5% of the pot on every regression spot.
  - Results do not depend on suit permutation: an isomorphic board gives the
    same answer.

### 3.3 Real sizes vs solved sizes

Players bet 2.08bb into 6.3bb; the tree has 33% and 75%. Real sizes map to the
nearest abstraction sizes with **pseudo-harmonic action translation** (the
standard method). When the real size is far from every solved size (more than
±25% of pot away), that is an `Approximation` and the grade is capped at
"Inaccurate" in the bad direction: a size we did not solve cannot be called a
blunder.

### 3.4 Spot key and cache

`SpotKey` (`lib/solver/spotKey.ts`) = format, players, stack bucket, preflop
line, position pair, board reduced to its suit-isomorphic canonical form, the
street action so far, pot/stack ratio bucket, rake profile, **the bet-menu
profile**, and **a hash of the canonical ranges**. The last two are needed
because the ranges depend on the analysis version.

What is cached depends on the street:
- **River:** the per-decision results (frequencies and EVs at the hero's
  decisions), not the strategy. A re-solve takes well under a second.
- **Turn and flop:** street-level strategies, keyed by
  `(SpotKey, SOLVER_VERSION)`, with the blob in Storage and an index row in
  Postgres.

The cache is shared across users. Spot keys contain no hole cards and no player
names, so sharing reveals nothing about anyone's hands.

### 3.5 Approximations and "not analysed"

Every graded decision carries the approximations used, and the hand panel
shows them like GTOW's banner:

- **Not modelled:** antes or straddle; rake differing from the solve; stack
  depth differing from the nearest bucket by more than 20%.
- **Sizing:** off-tree bet size (§3.3).
- **Source quality:** a heuristic source (§3.6).

A decision is **not analysed** (`status: partial`) when:
- the postflop pot is multiway;
- the game is PLO, Short Deck or a Hi/Lo variant;
- the game is MTT with ICM;
- it is a bomb pot;
- there is a straddle that no chart covers;
- the hero's cards are unknown.

Saying nothing is better than saying something wrong.

### 3.6 Heuristic fallback (`source: "heuristic"`)

Used before the solver exists, and afterwards wherever it cannot reach. No
frequencies; only checks that are true regardless of strategy:

- **Pot odds:** call needed vs equity against the narrowed range. Uses
  `lib/equity`, which needs a range-vs-hand mode added.
- **MDF:** how often you defend vs `pot / (pot + bet)`, across many hands.
- **SPR:** commitment, and bets that leave less than a pot behind.
- **Dominated actions:**
  - folding the nuts or a hand that cannot lose;
  - calling the river with a hand that beats nothing the opponent can have;
  - checking back the nuts with no blocker or merge reason. This one is flagged
    only on the river, and never graded worse than Inaccurate.

Heuristic grades never go above "Inaccurate" in the bad direction and never
produce "Perfect". They produce **flags**, which the UI renders as notes, not
grades.

---

## 4. The explanation layer

Definitions fixed in A1 (#92):
- **SPR** is measured at the start of the street.
- **MDF**, and "defended vs MDF", are postflop only. Preflop they read as a
  leak that is not one.
- **Dynamic vs static:** the share of next cards that bring a third flush
  card, two or more new straight combos, or an overcard (counted at half
  weight). Below 25% is static; from 45% up is dynamic.
- **Pot-odds flags need narrowed ranges.** Against the placeholder ranges they
  cried wolf. Until A4 narrows ranges, a river fold is judged against the
  strongest quarter of the range, and river raises are not flagged.

Every graded decision gets a short *why*, built from facts we can compute. This
is the Upswing half.

`SpotFacts`, derived deterministically:

- **Board texture.** Paired, monotone, two-tone, rainbow; connectedness
  (straights possible); high card; dynamic vs static (how much equities shift
  on the next card).
- **Range advantage.** Equity of range A vs range B.
- **Nut advantage.** Share of each range in the top 10% of hands on this board.
- **Hand class.** Set, two pair, top pair with kicker class, overpair, draws
  (flush draw, OESD, gutshot, backdoors). Uses the same categories as the
  study grid.
- **Pot geometry.** SPR, pot odds, MDF, bet as % of pot.
- **Blockers.** Which nut or bluff-catcher combos the hero's cards remove.

Text comes from **i18n templates** (`ns/analysis.{en,hr}.ts`), keyed by
`(grade, street, reason)`.

Example: *"Mistake: the reference calls 99.5% here. 2.08 into 6.3 needs 25%
equity; KQ has 41% against a button cbet range on T63."*

Templates, not free text, because:
- they are testable;
- they translate;
- they cannot invent a reason the numbers do not support.

**Optional later:** a Claude-written paragraph, grounded strictly on
`SpotFacts` and `options`, behind a button and labelled as AI-written.

---

## 5. Where it runs

| Work | Where | Why |
|---|---|---|
| Decision walk, facts, chart lookup, heuristic | Browser Web Worker, resumable (shipped in A1: 5,448 hands in ~10 s) | Cheap; same code as stats |
| River solve for one hand being viewed | Web Worker, client | Under 0.3 s; free; no server timeouts |
| Turn / flop strategies | Precomputed library (offline script) + cache | Too slow per hand in the browser (§3.2) |
| Backfill of a user's whole database | The user's browser (Web Worker), resumable, like the stats rebuild; progress persisted per hand | No host to run; Vercel's function limit is far below a flop solve. A server worker is optional later |
| Solved-spot cache | Postgres index + Storage blobs | Shared across users, deduped by `SpotKey` |

**Security model unchanged.**
- Analysis rows are written through SECURITY DEFINER RPCs as the user, as with
  `save_hand_stats`.
- Reads go through invoker functions under RLS.
- The cache tables are readable by any authenticated user. Writes go only
  through an RPC that checks the blob hash against the spot key.
- **No service-role key in the app.** If the backfill worker needs one, it
  lives only in that worker's environment.

**Tables** (sketch; `docs/DATABASE.md` gets the real definitions in each phase):

- `hand_analysis` (`hand_id`, `user_id`, `analysis_version`, `status`, `grade`,
  `score`, `ev_loss_bb`, `ev_loss_pot`, `approximations`). Unique on
  `(hand_id, analysis_version)`.
- `decision_analysis` (`hand_id`, `analysis_version`, `order`, `street`,
  `grade`, `ev_loss_bb`, `ev_loss_pot`, `freq_diff`, `source`, `options` jsonb).
  Kept narrow so stats can `GROUP BY street, grade`.
- `spot_solutions` (`spot_key`, `solver_version`, `storage_path`, `bytes`,
  `exploitability`, `created_at`).

---

## 6. What the user sees

### 6.0 The Analysis tab (`/analysis`)

A top-level tab next to Stats, and the home of everything below.

- **Overview.** Score; EV loss per 100 hands; moves graded; a Perfect…Blunder
  distribution; coverage, meaning how many hands are full, partial or not
  analysed, and why; and the score trend.
- **Breakdowns.** By street, position, pot type and preflop scenario, with the
  same filter bar as Stats: date, stakes, room, game.
- **Leaks.** The spots that cost the most EV in total: grouped by
  (street, scenario, action), sorted by bb lost, each opening its hands.
- **Hands.** A sortable list showing grade, score, EV loss, and action letters
  coloured by grade. **Clicking a hand opens its analysis**: the replayer with
  the Analysis sheet open on the worst decision (§6.1), at
  `/analysis/h/<handId>`. Back returns to the list with its filters kept.
- **Run analysis.** Analysis runs in the browser. A rebuild or backfill button
  shows progress and is resumable, and the page tells you when the analysis
  version has changed since your hands were analysed.

- **Learn.** A concept library under `/analysis/learn`, linked from every
  explanation that uses a concept. It is not a new top-level tab: five tabs
  already scroll sideways at 375px (A1).

`analysis` is a new top-level path, so it goes into `username_reservations` in
the same migration (see `lib/routes.ts`).

### 6.1 Replayer — "Analysis" sheet

The replayer already has the pieces: a sheet slot (`ActionLogSheet`), rail pips
(`rp__mark`, #34) and the 13×13 grid (`HandMatrix`).

- **Rail pips coloured by grade.** Jump straight to the mistake, the same way
  comment pips jump to a comment.
- **Header.** The hand's grade word, EV loss in bb and % of pot, score, and the
  approximation banner if any.
- **Street-by-street list.** One chip per hero decision with its grade icon. A
  bad move shows the best alternative under it, as GTOW does.
- **Selected decision.** An options table (action · frequency bar · EV),
  the hero's choice highlighted, and below it the *why* (§4).
- **Study.** The 13×13 strategy grid for the node, the action totals, and a
  table by hand class and draw. Phase A5+; charts give the preflop version
  for free in A2.
- **Spoiler-safe.** In "What would you do?" mode (#51), grades stay hidden
  until the reveal. In shared or embedded hands, analysis is shown only if
  the owner chose to share it.

### 6.2 Hands list

New columns:
- grade icon;
- score;
- EV loss (bb and % of pot);
- action letters coloured by grade, as in GTOW's preflop/flop/turn/river
  columns.

New sorting and filters: sort by EV loss, and filter by grade, street or
"has blunder".

### 6.3 Stats — "Analysis" panel

- Score trend over time, using the same graph component as winrate.
- A Perfect…Blunder % table by street, position and pot type. It reuses
  `BreakdownPanel`'s groups — `pot_type` already exists, from stats/2.
- EV loss per 100 hands, and per mistake.
- **Reports: your frequency vs reference.** The counters this needs already
  exist in `SeatCounters`:
  - preflop: `vpip`, `pfr`, `rfi`, `three_bet`, `squeeze`, `limp`, …;
  - flop: `cbet_flop`, `fold_to_cbet_flop`, donk, check-raise, …

  What is new is a **reference frequency** per stat, position and role,
  computed from the charts and solver. Each row shows yours, the reference, the
  signed difference, and the list of hands where you deviated, sorted by EV
  loss.

### 6.4 Forum

"Post for review" attaches the analysis as an optional layer. Commenters see the
grade only after voting (#51). A thread can anchor a comment to a graded
decision.

---

## 7. Phases

Each phase ships something usable on its own, has its own PR, migration and
`analysis/N` bump if grades change, and appends to §10 what it learned.

| Phase | Delivers | Depends on |
|---|---|---|
| **A1 — decision model, heuristics, Analysis tab** | Everything the tab needs to show heuristic data now:<ul><li>`lib/analysis`: decision walk (on `StatsContext`), `SpotFacts` (texture, hand class and draws, SPR, pot odds, MDF, blockers), heuristic flags, and grading constants with `ANALYSIS_VERSION`</li><li>range-vs-hand equity in `lib/equity`</li><li>`hand_analysis` / `decision_analysis` tables, RPCs, pgTAP, and the rebuild path</li><li>i18n `ns/analysis`</li><li>the **`/analysis` tab**: overview, hands list, and `/analysis/h/<id>` with the replayer and Analysis sheet</li></ul> | — |
| **S — solver core** (parallel to A1) | `lib/solver`, pure TypeScript:<ul><li>DCFR over an explicit tree; best response and exploitability</li><li>Kuhn, Leduc and clairvoyance tests</li><li>a heads-up river subgame builder (ranges, board, pot, stack, sizes, rake)</li><li>suit isomorphism</li><li>a benchmark</li></ul> | — |
| **A2 — preflop charts and grading** | <ul><li>Chart format</li><li>a reproducible generator script (our solver, an equity-realisation model) and a committed 6-max 100bb cash set</li><li>preflop grading wired into A1's pipeline</li><li>a 13×13 chart viewer, which is also the preflop "Study" view</li><li>grades shown in the tab</li></ul> | A1, S |
| **A2a.1 — chart realism** | Reworks the realisation model so implied-odds hands, flats and small pairs come out right (§3.1), as `charts/2`. | A2a |
| **A2c — chart coverage** | <ul><li>The same generator, run for more tables: 9-max/full ring, plus 40 / 60 / 150 / 200bb for 6-max and 9-max</li><li>Straddle charts, or an explicit not-analysed</li><li>Lookup picks the nearest set and records the distance as an approximation</li></ul> | A2a |
| **A3 — reports vs reference** | Reference frequencies per stat, position and role, from the charts. Reports panel in the Analysis tab: yours, reference, the difference, and the deviating hands. | A2 |
| **A4 — river grading** | <ul><li>Range narrowing along the hand: preflop chart, then postflop heuristics until A5</li><li>river solve in a Web Worker</li><li>`spot_solutions` cache (index row + Storage blob, RPC-written)</li><li>river grades and the study grid for river nodes</li></ul> | A2, S |
| **A5 — turn and flop** (A5a turn: isomorphism, sampling, cache; A5b flop: offline precomputed library) | Sizing abstraction, action translation (§3.3), turn and flop solves with caching, full heads-up postflop grading, flop reports by role. | A4 |
| **A6 — leaks and progress** | <ul><li>Leak finder: EV lost grouped by spot, ranked</li><li>score trend</li><li>per-street, position and pot-type breakdowns</li><li>a weekly "what improved / what to work on" summary</li></ul> | A3, A5 |
| **A7 — training** | <ul><li>**Spot trainer**: play the hero's side of a stored strategy and be graded per move</li><li>**mistake drills**: your own worst spots, replayed until right (spaced repetition)</li><li>"what would you do?" (#51) graded against the reference</li></ul> | A5 |
| **A8 — learning layer** (A8a: the concept library) | <ul><li>**A8a** — a concept library, which can start any time (§6.0 *Learn*) (texture, range/nut advantage, MDF, SPR, blockers, polarisation…), each concept with a definition, an interactive example and links from every explanation that uses it</li><li>**A8b** — a study plan built from the leak finder</li><li>**A8c** — the optional AI-written review, grounded on facts</li></ul> | A8a: A1. A8b: A6, A7 |
| **A9 — multiway** | Approximate grading for 3-way postflop pots, about 9% of decisions in a real library: heuristics + MDF split, and solver-based later if feasible. | A4 |
| **Later** | MTT/ICM preflop, PLO, exploitative notes from villain stats. | — |

## 8. Decisions taken (2026-10-02)

1. **Chart source:** computed by us with our solver; never copied or scraped.
2. **v1 scope:**
   - covered: NLHE cash, 6-max, 100bb (±20%), heads-up postflop;
   - everything else: `not-analysed`, with the reason shown.
3. **Compute:** in the user's browser; no external worker host for now.
4. **Visibility:** analysis is private to the owner. Showing it on a shared hand
   is a per-hand opt-in, off by default.

## 9. Risks

- **Wrong grades are worse than none.** Mitigations:
  - every grade carries its source and approximations;
  - "not analysed" is a first-class outcome;
  - heuristic flags are never shown as grades.
- **Compute.** A flop solve takes seconds to minutes. Mitigations: per-node
  caching, a precomputed flop library, coarse sizings, and on-demand solving
  for the river only.
- **Chart and solver correctness.** Mitigations: exploitability bounds,
  known-game tests, and isomorphism tests, all in CI like the pgTAP suite.
  GTO Wizard's numbers may be used by the owner for a manual sanity check on
  their own hands, never as data.

## 10. Change log

Each phase appends what it learned that changed the plan.

- 2026-10-02 — Rust/WASM replaced by TypeScript (no toolchain in repo/CI/Vercel);
  backfill moved to the browser; Analysis tab (§6.0) and phases S, A7, A8 added.
- 2026-10-02 — Phase S shipped (#90).
  - The river is solved on demand in the browser.
  - The turn needs isomorphism and sampling, then caching.
  - The flop needs an offline precomputed library; until then it stays
    heuristic.
  - The spot key gained the bet-menu profile and a hash of the ranges.
  - River caching stores per-decision results only.
  - A5 is split into **A5a**, turn (caching, sampling), and **A5b**, the flop
    library.
- 2026-10-02 — A1 shipped (#92).
  - **Coverage in the owner's 5,448-hand library:**
    - 3,207 of 5,168 hands are not 6-max, and 1,682 are outside 100bb ±20%.
      **A2c** (9-max and other stack depths) is added for this.
    - 9% of decisions are multiway postflop, so **A9** is added.
  - MDF is postflop only, and pot-odds flags wait for range narrowing (A4).
  - Learning content lives under `/analysis/learn`, not a new tab.
- 2026-10-02 — A8a shipped: the concept library.
  - **24 concepts** under `/analysis/learn/<id>`, in English and Croatian:
    foundations (pot odds, equity realisation, EV and grading, GTO vs
    exploitative, position), ranges and boards (ranges, range and nut
    advantage, texture, dynamic boards, blockers), betting (SPR, MDF/alpha,
    sizing and polarisation, c-bet, check-raise, donk bet, bluff-catching,
    thin value) and preflop (RFI, 3/4-bets, squeeze, blind defence, steal).
  - **Public and indexable.** The pages read no account data, so they are in
    the sitemap and `robots.txt` allows `/analysis/learn` inside the
    disallowed `/analysis`. The "your hands" link is a plain link to the
    flag filter of §6.0's list.
  - **Words and numbers are split.** `lib/learn/concepts.ts` is the
    language-free catalogue; the page bodies (`lib/learn/content/`) are
    server-only; the dictionary carries only titles and widget labels.
    Every number an example quotes is recomputed in `tests/test/learn.test.ts`.
  - **Linking.** `lib/learn/links.ts` maps flags and facts to concepts,
    mirroring `explain()` sentence by sentence; the sheet's *why* and the
    overview's flag rows link through it. New flags or explanation sentences
    must add their concept there (a test fails on an unmapped flag).
  - **Teaching ranges are not the grader's.** The widgets use hand-written
    illustrative ranges (`lib/learn/presets.ts`), not `ranges.ts`'s
    placeholders, so a version bump never changes what a page teaches.
  - **Found on the way (A1 bug, not fixed here):** `parseRange` reads only
    same-gap spans written high-to-low, so `ranges.ts`'s `A5s-A4s`,
    `A5s-A2s`, `22-JJ`, `22-99` and `99-QQ` throw. `defaultRange` therefore fails for
    early and middle opens, isolation raises, limps, non-big-blind calls,
    3-bets and calls of 3-bets (late opens, the big-blind call and 4-bets parse), and
    `analyze.ts` swallows the error: the equity fact (and the pot-odds
    flags that need it) silently drops for most decisions — 171 hands of
    5,448 carry a placeholder-range equity. The fix (kicker spans and
    either order in `parseRange`, or rewriting the strings) changes stored
    facts, so it is an `analysis/2` bump, best done with A4's narrowing.
  - A8 is split: **A8a** (this), **A8b** the study plan (needs A6), **A8c**
    the AI-written review.
- 2026-10-02 — A2a shipped (#95).
  - Multi-player CFR converged (NashConv 0.06 mbb/hand) once the tree's caps
    limited who may *enter* a pot rather than who may *continue*.
  - The realisation model under-rates implied-odds hands, so **A2a.1** is
    added.
  - Lookup covers 58% of the GG corpus's hero preflop decisions. Most of the
    misses are deeper than 120bb (A2c) or behind open limps.
- 2026-10-02 — A8a shipped (#94): the concept library at `/analysis/learn`,
  the one public part of `/analysis`. It found that A1's `parseRange` rejects
  spans like `22-JJ` and `A5s-A4s`, so equity facts silently dropped. The fix
  goes in A2b with the `analysis/2` bump.
