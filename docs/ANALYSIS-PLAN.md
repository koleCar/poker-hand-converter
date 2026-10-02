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

**Known weakness of `charts/1`, and what `charts/2` (A2a.1) fixed.**
`charts/1`'s hand-set realisation model under-rated implied-odds hands:
UTG opened A9o/A8o and folded 55–22 and small suited connectors; the BB
defended 48% against a button open; nobody flatted in position.
`charts/2` fits the realisation model to our own postflop solver (turn+river
solves of the charts' own ranges on sampled boards, three rounds to a fixed
point; `docs/CHARTS.md` §4):
- **Fixed:** BB defends 61.7% vs a button open (49.1% call), and calls more
  than it 3-bets against every open; UTG folds A9o–A2o and opens 66+, suited
  aces to A7s, JTs, T9s; lines through a CO–BTN flat are in the set (`ffrc`).
- **Remains:**
  - UTG folds 55–22 and 87s–54s;
  - the BTN flats a CO open only 0.2% (UTG 2%, HJ 1%), flatting and 3-betting
    being nearly indifferent in the model.
  Both trace to the measurement checking the flop: it takes a street of
  betting away from the hands that flop sets and flushes.

The lasting fix is a flop measurement: A5b's flop library (or flop solves of
the realisation spots) fed back into the same fit.

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
  - **Turn:** solved per hand in the browser worker since A5a (§10): river
    cards by suit isomorphism, a coarse river below the turn (75% + all-in,
    no raise), the turn's all-in only up to three pots, and the hand's own
    turn sizes added to the tree. About a second or two for a real spot;
    nothing is cached (no two spots in a library share a key).
  - **Flop:** an offline-precomputed library: canonical flop × preflop line,
    coarse abstraction, flop-level strategies only. Until that exists, flop
    decisions stay heuristic.
- **Bet-size menus:**
  - **River:** 33 / 75 / 150% + all-in; raises 75% + all-in; cap 2–3. Without
    the overbet, real overbets land off-tree (§3.3).
  - **Turn:** 75% + all-in (up to three pots), raises 75% + all-in, cap 1,
    plus the sizes the hand itself used (A5a, §10).
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
| Turn solve for one hand | Web Worker, client, per hand (A5a) | One to a few seconds with A5a's speed-ups; the backfill runs a pool of workers |
| Flop strategies | Precomputed library (offline script) | Too slow per hand in the browser (§3.2, §10 A5a) |
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
- **Plan.** The week's study plan under `/analysis/plan` (A8b): the three
  costliest leaks the sample can vouch for, each with concepts to read, a
  trainer session set to the spot, its due drills and hands to review, a
  checklist that keeps its progress, and last week looked back on.

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
- 2026-10-02 — A2b shipped: preflop grading from the charts, `analysis/2`.
  - **Wiring.** Every hero preflop decision is looked up in the charts
    (`lib/analysis/preflop.ts`, through `lib/charts`' public API only); a node
    gives options, a §2 grade, EV loss in bb and % of the pot, and
    `source: "chart"`. A refusal is a `not-analysed` decision with the
    lookup's reason prefixed `chart-` (a preflop "multiway" must not read as
    the postflop one). Refused preflop decisions **keep their heuristic
    flags** — "you folded when a check was free" holds on any table.
  - **A fold the tree lacks is still graded**: folding is worth exactly minus
    what is already in, so the big blind folding to a limp is graded against a
    zero-frequency fold option at that EV.
  - **Approximations** on chart grades: `model` (every grade from `charts/1`;
    the extra sentence and Learn link only when an implied-odds hand was
    played and graded worse than Good), `short-handed`, `stack-depth-near`,
    `off-tree-size` (any raise in the line, the hero's or an opponent's,
    beyond 25% of the pot: grade capped at Inaccurate), `out-of-range`.
  - **Opponents' ranges come from the charts** where their line has a node:
    `range[class] × freq[action][class]` at their last preflop decision.
    The placeholders parse now (`parseRange` reads `22-JJ`, `A5s-A2s`,
    `KTo-K8o` in either order) and remain the labelled fallback
    (`placeholder-range` vs `preflop-range`). Neither is narrowed postflop (A4).
  - **Owner's local library (5,448 hands):** 5,388 hero preflop decisions,
    **1,274 graded (24%)** — 78% of those on six-handed 100bb ±20% tables
    without a straddle. Refused: not 6-max 3,024, stack depth 674, open limp
    256, rare line 72, straddle 52, off-tree 25, cold call 10, unreadable 1.
    Perfect 90.0%, Good 0%, Inaccurate 4.2%, Mistake 3.7%, Blunder 2.1%;
    score 94.1; **3.5 bb / 100 graded hands**. Most EV lost: folds facing an
    open (20.2 bb, one AA fold on the button is 12.4 of it), folds to 3-bets
    (4.5), opens (4.0), flats of opens (3.8).
  - **"Good" almost never happens with `charts/1`:** its strategies are nearly
    pure, so a move is either the reference's (Perfect) or one it never plays.
    A3's "your frequency vs reference" is where mixed play will show.
  - **UI.** Overview grades (score, EV loss / 100, moves, distribution), a
    grade table in every breakdown (new group: preflop scenario), list columns
    and a Mistake-or-worse filter, the sheet's options table, better-move line
    and 13×13 study chart. **`/analysis/charts` is public and indexable** like
    `/analysis/learn` (robots allow, sitemap): the charts are our own data and
    the page reads no account.
  - Migration `20270104090000_analysis_grades.sql`: reports only (grade
    filters, distribution, EV-loss sort); no table or grant change.
  - **Open:** `lookupPreflop` answers `bad-input` instead of `multiway` when a
    fifth entrant closes the tree (both blinds silent folds); one decision in
    the library.
- 2026-10-02 — A3 shipped: Reports at `/analysis/reports`, your frequencies
  against the reference.
  - **Counts in SQL, the reference in the browser.** `analysis_node_actions`
    counts graded chart decisions per node (`facts.chart.line`) × action and
    per node × hand class × action; `lib/analysis/reports.ts` turns them into
    references with the chart set that graded them. Nothing chart-derived is
    stored, so a regenerated set needs no migration — only the
    `analysis_version` bump that already goes with it. Decisions at lines the
    loaded set lacks are counted and left out, with a note.
  - **Two references per node.** *Range*: the chart's frequencies averaged
    over the range reaching the node, combo-weighted, with a card-removal
    correction (each class weighted by how likely it makes the earlier
    players' chart lines; opponents independent of each other, as in the
    charts' own model). The correction moves RFI and vs-open references by
    under 3 points and deep 4-bet / all-in nodes by up to ~10. *Your hands*:
    the chart's frequency for the classes the player actually held, averaged
    over their decisions — the fair comparison for small samples and for
    nodes reached with the player's own (not the reference's) range.
  - **Verdict**: the range reference against a 95% Wilson interval of the
    player's frequency (the stats screen's interval); "deviates" also needs a
    gap of 2 points or more, and under 10 decisions is "too few".
  - **Familiar stats are sums of nodes**, each node's reference weighted by
    the player's decisions there (with none, by the reference's own reach):
    RFI, steal, 3-bet against an open (no callers — squeezes are their own
    row, unlike `three_bet_opp`), blind defence and fold to a steal (against
    a single open), fold to a 3-bet in and out of position against the
    3-bettor (the opener only), 4-bet (cold included), squeeze; plus a
    fold / call / 3-bet table for each blind against each opener. Each row
    opens its seats, a definition and tip with its Learn page, and
    `analysis_node_hands`: the decisions graded worse than Perfect, most EV
    lost first.
  - **Postflop by role** shows the player's own bet / fold / call / raise
    frequencies (PFR or caller, in or out of position, per street) from the
    stored role scenarios rather than `hand_stats`, which has no IP/OOP split
    and other filters. Heads-up only, limped pots left out, and a "reference
    arrives with the flop library (A5)" note.
  - **Owner's local library** (1,274 graded decisions in 1,232 hands): RFI 29.5%
    vs 25.4% (your hands 24.2%, n=705, deviates) — almost all of it the small
    blind, which raises 49% and never limps where `charts/1` limps 29%; 3-bet
    against an open 6.1% vs 11.5% (your hands 8.9%, n=424, deviates; BTN vs HJ
    0 of 36 against 11.4%, though the hands held there would 3-bet only 2.7%);
    fold to a steal 76% vs 69% (n=145) and fold to a 3-bet out of position 60%
    vs 43% (n=20) lean tight but are inside their intervals; flats the charts
    never make (BTN calls a CO open 5.1%, a UTG open 7.7%) show as deviations.
  - **Open.** The position filter reads the hand's seat while a short-handed
    hand is graded at the 6-max node with UTG folded, so the two can name
    different seats. A6's leak finder can reuse `analysis_node_hands`.
- 2026-10-02 — A4 shipped: river grading with our solver, `analysis/3`.
  - **Range narrowing** (`lib/analysis/narrowing.ts`, `rangeWalk.ts`). Each
    player's preflop range (the charts' for their line, else the labelled
    placeholder) is expanded to 1,326 combos and multiplied, action by
    action, by a likelihood `L(combo | action)`: Bayes with the actor's
    strategy as the likelihood. Before A5 the likelihood is the heuristic
    model `heuristic/1` (`heuristic/2` after the review, below):
    - strength is hand strength against the opponent's current range, with
      card removal, plus draw potential from outs on the flop and turn;
      ranked as a percentile within the actor's own range;
    - **bet or raise:** the top 40 / 33 / 28% (flop / turn / river; raises
      14%) for value, strong draws at 0.75, and the bottom 35% bluffing at a
      rate solved so bluffs plus draws are `x / (1 + 2x)` of the bets
      (×1.5 on the flop, ×1.25 on the turn);
    - **call:** the top `1 / (1 + x)` of the range (the MDF), draws, the very
      top only 60% (the rest raises);
    - **check:** caps the range partially (value 35%, air 70%);
    - every likelihood is at least 0.03, so weights only go down and nothing
      is ruled out.
    `NarrowingModel` is the seam: A5 replaces flop and turn narrowing with
    solved strategies through the same interface. Every grade and equity
    resting on it carries `narrowing-heuristic`.
  - **River solve** (`river.ts`), once per hand, read at every hero river
    decision:
    - inputs: both ranges at the river card (combos under 0.2% of a range's
      heaviest dropped), pot and effective stack at the river, the out of
      position player first, the charts' rake profile (`rake-profile`);
    - menu as §3.2 (33 / 75 / 150% + all-in; raises 75% + all-in) with a
      **raise cap of 2**: 3 cost ~20% more solve time over the library and
      changed no grade distribution;
    - DCFR to 0.5% of the pot or 2,000 iterations; the exploitability reached
      is stored (`facts.river`), over 0.5% is `solver-unconverged`.
  - **The real line onto the tree.** Pseudo-harmonic translation to the
    likelier side; more than 25% of the pot away is `off-tree-size` and caps
    the grade, nearer but not exact is `size-translated`. An opponent's size
    the solve uses under 1% of the time is remapped to the nearest size it
    does use. The hero's own size is graded as the better of its two
    neighbours. EV loss is quoted against the real pot.
  - **Not analysed, by name:** `river-multiway-flop` (three or more saw the
    flop), `river-unreached` (under 2% of either range reaches the node: a
    best response to a sliver), `river-off-tree`, `river-range-unknown`,
    `river-range-empty`, `river-solve-failed`. A skipped river keeps its
    heuristic flags, like a refused preflop decision.
  - **Equity facts** on the flop and turn are now against the narrowed range
    (`source: "narrowed"`); a graded river's are against the solver's range
    at the node (`source: "solver"`). The postflop flags barely moved (one
    in the library either way).
  - **No migration, no `spot_solutions` table.** §3.4: the river's cache is
    the per-decision rows, which the A1 tables already hold
    (`source = 'solver'`, grade, EV loss, options); `facts.river` carries the
    spot hash for a shared cache later. The reports' by-street tables show
    the river row with no SQL change.
  - **UI.** River options with bet sizes in bb and % of the pot; the *why*
    names the hand's role against the range it faces (value, bluff-catcher
    against a polar range, thin value against a merged one, air), blockers
    to its strong and weak combos, translation and the narrowing; Learn
    links for bluff-catching, sizing and polarisation, thin value, blockers,
    ranges. **River study:** the 13×13 grid of the hero's range at the node
    (each class's mix over its combos, reach-weighted), action totals, a
    table by hand (made hands / missed draws / no made hand) and by strength
    against the opponent's range (value / bluff-catchers / air), and the
    opponent's range by the same categories. Re-solved in the analysis
    worker on demand, nothing stored.
  - **Worker.** Progress every 0.25 s within a page; Stop terminates the
    worker at once (resumable as before); the hand view's fresh analysis and
    the study run in their own worker.
  - **Owner's local library (5,448 hands):**
    - 467 hero river decisions: **306 graded (66%)**, multiway 79,
      multiway on the flop 71, unreached 11.
    - Perfect 67.0%, Good 20.9%, Inaccurate 1.6%, Mistake 4.9%,
      Blunder 5.6%; mean score 83.6; 143.5 bb lost, most by checking (41 bb,
      eight Blunders: value and bluffs not bet), calling (20) and folding (18).
    - **"Good" is common on the river** (21%, against 0% preflop): solved
      river strategies mix.
    - 86% of the graded rivers start from a placeholder range (most of the
      library is 8- or 9-max), 22% have the hero out of their own range
      (`charts/1` rarely flats), 38% translate a size and 7% are off-tree.
    - **Backfill: 41 s in the browser** for the whole library (Node: 37 s).
      Per hand with a river solve: median 106 ms, p90 282 ms, slowest 0.7 s;
      median 100 iterations (max 320), every solve under 0.5% of the pot.
    - The stored rows (written by the browser's worker) equal a fresh Node
      analysis for all 467 river decisions, facts included.
  - **Open.**
    - The narrowing is a heuristic and some ranges come out extreme: a
      villain who checks three streets can be 90% air by the river, which
      makes a big bluff with ace-high a "Blunder" to check back. A5's solved
      flop and turn strategies are the fix; until then every river grade says
      it rests on the model.
    - The corpus suite now solves every heads-up river in the fixtures:
      about a minute more in CI.
  - **Revised before merge (review), still `analysis/3`.** Wrong grades
    are worse than none (§9), so the numbers above are the first run's;
    these changes replace them:
    - **Mistake cap (`range-cap`).** A river grade rests on narrowed ranges,
      so it is capped at Mistake. The exceptions keep their Blunder because
      they lose whatever the opponent holds: folding a hand that cannot lose,
      and calling with a hand that beats nothing in the opponent's
      *preflop* range (or against any two cards). `grade()` gained
      `capAtMistake`, and `facts.river.capped` keeps the uncapped grade. The
      *why* says so in EN and HR.
    - **Sensitivity check (`range-sensitive`).** A grade of Inaccurate or
      worse is re-graded on a second solve whose narrowing is at half
      strength (`halved`: every likelihood `L` becomes `√L`). If the two
      grades are more than one class apart, the milder one is kept,
      including its options and its solve (the study view draws the same
      one). The other grade is in `facts.river.sensitivity`. Only about 12%
      of the river grades pay for the second solve.
    - **Checks trim less (`heuristic/2`).** Value checks half the time, up
      from 35% (traps, pot control). Each earlier postflop check by the same
      player scales the next check's trim by 0.5. A player who checks three
      times keeps a realistic middle instead of collapsing into air.
    - **Local library after the revision:** 306 of 467 river decisions
      graded (unchanged). Perfect 73.2%, Good 15.7%, Inaccurate 2.0%,
      Mistake 9.2%, **Blunder 0** (no dominated move in the library). 16
      Blunders were capped to Mistake, and 3 grades were sensitive (two
      Blunders and a Mistake became Good). 118.7 bb lost.
    - **Backfill:** 44 s in the browser (41 s before) and 40 s in Node; the
      second solve runs 37 times.
    - **A3 interplay:** Reports' postflop-by-role river column counts only
      analysed decisions. Rivers the solver skips (three-way flops, lines
      the solve never takes) drop out, which suits its "heads-up" label.
- 2026-10-02 — A2a.1 shipped: `charts/2`, the realisation model fitted to our
  postflop solver.
  - **Method.** 13 heads-up spots covering every role and pot type; 120
    seeded flop+turn deals each, turn and river solved (flop checked, 75% or
    all-in); per class, realised share over check-down equity; a log-linear
    weight of 11 class features per seat, fitted per pot type with the
    position and initiative edges; three rounds of solve → measure → fit,
    pooling the rounds' measurements. The fit's share error is 27–43% below
    `charts/1`'s on the same data.
  - **Rare actions are measured on their candidates.** The button's flat and
    the small blind's limp are measured on every hand that continues there:
    measured on the few classes the charts flat with, the fit swung the flat
    on and off between rounds.
  - **Result.** BB defends 61.7% vs a button open (was 48.3%); UTG opens 66+
    and suited hands instead of A9o/A8o; NashConv 0.075 mbb/hand; 736 KB;
    ~27 min to generate from scratch on 10 threads (turn+river solves on worker
    threads, cached by job hash).
  - **Not reached:** UTG folds 55–22; the BTN flats a CO open 0.2%. Both
    point at the checked flop; a flop measurement (A5b) is the next step for
    the charts.
  - `CHARTS_VERSION` is `charts/2`; the lookup API is unchanged.
- 2026-10-02 — A6 shipped: leaks and progress, at `/analysis/leaks` and
  `/analysis/progress`, and a "what changed" card on the overview. No grade
  changes, so still `analysis/3`.
  - **Sums in SQL, leaks in TypeScript.** Migration
    `20270201090000_analysis_leaks.sql` adds invoker reports only (no table or
    grant change):
    - `analysis_leaks` sums graded decisions per **finest spot**: street,
      scenario, chart line, seat, the action taken and the reference's best
      action (the highest-EV option, `analysis_best_action`). Perfect moves
      are included, because a spot's frequency is every time the player was
      there.
    - `analysis_leak_hands` pages the decisions behind a set of spot keys.
      The key is one string (`analysis_spot_key`) shared by both, so a list
      and its hands cannot disagree.
    - `analysis_trend` sums per ISO week, month or session (the statistics
      screen's 30-minute gap, over every analysed hand), optionally per
      street, seat or pot type.

    Both return score sums and sums of squares, so means and standard errors
    are the client's. `lib/analysis/leaks.ts` does the rest, pure and tested.
  - **What a leak is.** A situation plus one wrong turn in it:
    - the situation is the street, the scenario, the hero's seat and,
      preflop, the villain's. Both seats are read from the chart line, so a
      short-handed hand groups with the 6-max node that graded it;
    - the wrong turn is taken ≠ best, or the right action at the wrong size.

    Mixed play that cost nothing (every decision Perfect) and leaks under
    0.05 bb are left out.
  - **Sparse spots merge up a level**, finest first: (scenario, hero,
    villain) → (scenario, hero) → (scenario) → (family) → (street). A family
    is first in / facing a raise / facing a re-raise preflop, and first /
    vs bet / vs raise postflop.
    - A group under 10 decisions in its situations is lifted whole. It merges
      only with the other lifted groups, never with a sibling big enough to
      stand alone, and such a row says "other opponents / seats / spots".
    - Confidence: high at 50 decisions in the spot and 5 mistakes, medium at
      20 and 2, low below.
  - **Ranking.** Total EV lost by default. Within one filter set, "EV lost
    per 100 hands" divides every row by the same graded-hand count, so it
    gives the same order. The other rankings offered are EV per time in the
    spot (how badly the spot is played) and mistakes.
  - **"What changed"** compares the last 7 or 30 days **of play** against
    the stretch before:
    - the window ends on the last day a graded hand was played, not today,
      and the card says so;
    - leaks are grouped on both periods together, so a leak means the same
      spots in both. A leak compares by mistake rate in its spot
      (two-proportion z); streets and the whole sample by mean move score
      (Welch's z);
    - the words come in tiers: |z| ≥ 1.96 better or worse, ≥ 1 "leaning,
      could be noise", else "no clear change". Under 20 moves (10 spot
      decisions) it says "too few", and under 50 moves in the current period
      the card warns that it is a hint.
  - **"Drill this"** is shown disabled, with "arrives with the trainer (A7)"
    as its visible reason, so the entry point exists before the feature.
  - **Progress** draws per-bucket means, not cumulative lines, on evenly
    spaced buckets (a gap in play is not a stretch):
    - the score has its 95% band, and buckets under 20 graded moves are
      hollow;
    - the graded volume is drawn under each point;
    - every chart has a table view and keyboard navigation.

    `niceStep` and `ticks` moved from `WinrateGraph` to
    `components/stats/chartScale.ts`.
  - **Owner's local library** (rows graded at `analysis/3` with `charts/1`,
    before A2a.1's `charts/2` reaches the grades): 1,580 graded moves in
    1,437 hands, 161.8 bb in 75 leaks, 11.3 bb / 100 hands. Top five by EV
    lost:
    1. River, preflop raiser out of position and first to act, checking
       instead of betting (seats other than the SB, merged from 4 spots):
       18.9 bb, 5 mistakes in 21 decisions, medium confidence.
    2. BTN against a CO open, folding instead of 3-betting: 12.4 bb. It is
       one decision of 39, the AA fold A2b found; low confidence.
    3. The same river spot, betting instead of checking: 11.4 bb, 4 in 22.
    4. The same river spot from the SB, checking instead of betting:
       10.9 bb, 4 in 25.
    5. River facing a bet, calling instead of raising (merged up to the
       family): 9.6 bb, 2 in 15, low confidence.

    The first preflop leak with a real sample is folding to a 3-bet where the
    charts call: 4.5 bb, 8 mistakes in 20 decisions. Rivers dominate the list
    because their mistakes are big and their samples small. Every river leak
    still rests on the narrowing model (A4's open point).
  - **Last 7 days of play (15–21 Feb) against the 7 before:** score 91.4
    against 92.8. That is "no clear change" overall and on both graded
    streets; the work-on list is three river leaks, all "too few to tell".
  - **Open.**
    - The hand view's Back link still returns to the overview list, not to
      the leak it was opened from (browser Back works).
    - The overview card links a leak to the Leaks screen over both compared
      periods, where it was grouped. With the overview's game or pot filter
      set, the Leaks screen (which has neither filter) may group it
      differently and show the list without opening it.
    - Turn and flop leaks appear as soon as A5 grades them; nothing here
      depends on the street.
    - A8b (the study plan) can be built on `groupLeaks` and `comparePeriods`.
- 2026-10-02 — A7 shipped: training, at `/analysis/train` ("Train" in the
  tab's sub-nav). No grade changes, so still `analysis/3`. Started before A5
  (its listed dependency): the trainers use what is graded today — preflop
  charts and river solves — and pick up turn and flop grades when A5 lands.
  - **One grader.** A trainer spot is a real hand: a short script written as
    standard hand-history text and read back by the upload parser
    (`lib/training/handText.ts`). An answer is graded by `analyzeHand` on the
    spot's hand with the answer appended, through a new, additive
    `AnalyzeOptions.only` (analyse one decision: the same walk, chart lookup,
    solve, caps and sensitivity check, without the hand's other decisions — so
    the trainer will not pay for turn solves once A5a grades turns). A
    trainer grade is the analysis grade of the same spot by construction; the
    tests compare the two decision for decision, preflop and river.
  - **Found on the way.** A hand names a seat "dealt in" by its actions, so
    a spot that stops at an early decision (UTG first in) left the players
    behind out of the ring — and the chart lookup refused it as a 2-handed
    table. The trainer completes the orbit after the decision
    (`completePreflop`: a fold facing a bet, else a check). And
    `walkRanges` records the river ranges at the river's first action, so a
    spot where the hero is first to act walks a hand with a placeholder first
    river action (the ranges are taken before narrowing by it).
  - **Preflop trainer.** Families as in the chart browser (RFI, facing an
    open, facing a 3-bet, squeeze, blind vs blind, facing a 4-bet) or any,
    optionally one seat; a node is drawn by √reach among those reached in at
    least 0.2% of deals; a class by `combos × range × card removal` (A3's
    `removalFactors` of the players before), optionally tilted toward close
    decisions (`borderline`: × (0.1 + 1 − max freq + e^(−EV gap / 0.5 bb)));
    suits uniform. `charts/2` is nearly pure: the tilt doubles the share of
    mixed spots (best option under 85%) from 3.5% to 7% of deals. After the
    answer: the grade, EV lost, the options table, the whole 13×13 chart with
    the hand outlined, the *why* and its Learn links. Table size and depth
    offer the one set there is (6-max, 100 bb) until A2c adds more.
  - **River trainer.** Twelve heads-up preflop lines the charts play (single
    raised: UTG/HJ/CO/BTN/SB against the BB and BTN against the SB; 3-bet:
    CO–BTN, CO–BB, BTN–SB, BTN–BB, SB–BB; a limped SB–BB pot), a random
    board, flop and turn lines from five patterns (check-check, a 33% or 75%
    bet called, in or out of position) weighted by who has the initiative,
    no bet over 60% of the stack before the river. Both ranges walk exactly
    as the analysis walks them (`heuristic/2`), the river is solved by
    `solveRiverSpot`, an in-position hero first faces the villain's action
    drawn from the solve's own frequencies (actions taken at least 1% of the
    time), and the hero's combo is drawn from their reach at the node (the
    solve's own hands, so never a board card; `borderline` tilts toward mixed
    combos). Because the walk ignores the hero's cards and the solve adds the
    combo only when it is not already in the range, the spot's solve is the
    one the grade re-runs. Measured on 120 seeds (Node, M2 Pro): generation
    median 153 ms, p90 0.70 s, slowest 1.7 s; grading an answer median
    171 ms, p90 0.82 s (it solves again, twice when the sensitivity check
    runs). Both run in a worker (`workers/training.worker.ts`). Every river
    spot says its ranges rest on the narrowing model.
  - **Drills.** `sync_drill_items` makes a drill of every graded decision of
    yours that is a Mistake or worse (Inaccurate on request), once; a
    re-analysis at a new version re-points the drill and keeps its schedule,
    and a decision no longer graded Mistake simply stops coming up. A drill
    shows your hand up to the decision (`handUpTo`, the forum poll's rule:
    nothing after it, nobody else's cards) and its stored options; the move
    you made keeps its stored grade, any other answer is graded with
    `grade()` and the analysis' caps (an off-tree size at Inaccurate, a
    solver grade at Mistake — the "loses whatever they hold" exceptions are
    not re-judged for another action). Scheduling is SM-2 with the answer's
    grade as quality (Perfect 5, Good 4, Inaccurate 3 passes, Mistake 1 and
    Blunder 0 fail): ease ± by SM-2's formula in [1.30, 3.00], a pass goes
    1 day, 6 days, then interval × ease (half up, at most a year), a fail
    comes back in 10 minutes. The database computes it (`drill_next`); the
    TypeScript copy is tested on the same table of cases.
  - **Where drills show.** The overview has a "Drills" line (due now and
    today, plus Mistakes not drilled yet). On Leaks, "Drill this" is a link
    to the trainer on the leak's spot keys, and every row shows how many of
    its drills are due today (`drill_due_by_spot`). Owner's local library at
    `analysis/3`: 102 drills (Mistakes and Blunders); the top leak (river,
    PFR out of position checking instead of betting) has 4.
  - **Storage** (`20270208090000_analysis_training.sql`): `drill_items`,
    `drill_reviews`, `trainer_results`; RLS select-own, no client write grant;
    writes through three definer RPCs with ownership checks and per-account
    rate limits; invoker reads. The answer's grade is computed in the browser
    and only shape-checked by the database (a false grade only reschedules
    the sender's own drills). pgTAP: 51 assertions.
  - **UI.** EN/HR; keyboard play everywhere outside the replayer and form
    fields (`1`–`9` for the n-th answer, `F` `X` `C` `A` for fold, check,
    call, all-in, `N`/Enter for the next spot, `?` for the key sheet, the
    replayer's pattern); a session score with Perfect…Blunder counts,
    streaks of moves the reference plays, EV lost and mean score, and,
    signed in, the last 30 days per trainer. With seven sections the
    sub-nav keeps three tabs on a phone and puts the rest under "More".
  - **Not built: "what would you do?" graded against the reference (#51).**
    §8.4 makes analysis private and showing it on a shared hand a per-hand
    opt-in, and no such flag exists yet (`shares` and polls carry none). The
    follow-up: a per-post `share_analysis` flag on `forum_polls` (or the
    share), set by the author when posting; `read_poll` returns, after the
    reveal only, the stored `decision_analysis` row of the poll's stop index
    when the flag is set (definer, the flag checked server-side); the poll
    then shows the reference's options next to the votes, with the grade's
    source and approximations. Until then a poll shows votes only.
  - **Open.**
    - A river spot's p90 (0.7 s to deal, 0.8 s to grade) is over the 0.3 s
      the plan hoped for: wide limped and single-raised ranges checked down
      to the river make the biggest solves. A turn-style coarser menu would
      be faster but would no longer be the analysis' grade.
    - §2's move score reads oddly in a trainer: a Perfect answer at a
      0.8%-frequency, zero-EV-loss option scores 1. The grade is what the
      trainer leads with; the session's mean score follows §2 as it is.
    - The drill counts on a leak-filtered drill page are the global ones.
- 2026-10-02 — A7.1 shipped: sharing a hand's analysis, and the reference
  answer in "What would you do?" (#51). No grade changes, so still
  `analysis/3`. This is the follow-up A7 left open, with one change: the flag
  is **per hand**, not per poll (§8.4 says "per-hand opt-in", and one switch
  is easier to reason about than one per surface).
  - **The flag.** `analysis_shares(hand_id, owner_id, shared, …)`
    (`20270222090000_analysis_share.sql`), off by default; RLS select-own, no
    client write grant; `set_analysis_share(surface, id, shared)` is definer,
    checks that the hand *and* the surface are the caller's, says "That hand
    does not exist." for foreign and unknown alike, 120 / 10 min per account.
    Off writes `false`; nothing is deleted.
  - **Surfaces.** A hand is named by where it is seen: `hand` (the owner's
    `/analysis/h/<id>`), `published` (`/p/<id>`), `post` (thread or poll),
    `share` (`/h/<slug>`). The owner's switch accepts any of them; the
    public read only the last three.
  - **Who reads what.** `read_shared_analysis(surface, id, version)` (definer,
    anon-callable) answers only when the surface is public to the caller by
    its own page's rule, restated in the function (published: visible; post:
    the `posts_read` predicate, hand not removed; share: the slug is the
    capability), the hand is the surface author's own, and the flag is on —
    at exactly the version asked for. A hand uuid is never a public surface.
    Output: `analysis_hand`'s named keys without `handId`; options, flags and
    facts projected to their known keys (`analysis_public_facts`: a new
    `SpotFacts` key needs a line there — `turn` and `flop` are pre-listed for
    A5). Facts are hero-centric (no villain cards or names are inputs), so
    nothing needs masking against the scrubbed copy; the page still draws the
    analysis only when every decision lands on a hero action of the copy on
    screen (`analysisFitsHand`; on the corpus it always does, for the
    published document and for the share page's re-parsed standard text).
  - **Vote before reveal, server-side.** For a poll, the read returns nothing
    while `poll_hides_answer` is true for the caller (anon, a reader who has
    not voted), and the sealed hand's `/p/` surface never answers. After the
    reveal the poll shows, under each answer's vote bar, the reference's
    frequency and EV for it and the grade it would get (bet / raise: the
    sizes' frequencies added, graded by the best size; the drill's rule —
    `gradeDrill`, same caps, the hero's own option keeps its stored grade),
    then the full options table with the hero's move, the source and the
    approximations, and grade pips on the replayer.
  - **UI.** Grade pips on the rail and a read-only Analysis sheet (closed by
    default; "the hero" for "you" in the sheet's own labels; a line saying
    whose analysis it is) on `/p/<id>`, threads with a hand, polls after the
    reveal, and `/h/<slug>`. In a thread a decision with comments keeps one
    pip, in the grade's colour, named both ways. The owner's switch, with
    what becomes visible and where spelled out before it is ticked: the
    hand's analysis page, the publish dialog, the share dialog, the submit
    form (with the poll note), and their own `/p/`, thread, poll and share
    page (it renders nothing for anyone else). **Embeds show nothing extra**:
    `/embed/{p,h}` stay the bare replayer, and OG images are unchanged.
  - **Tests.** pgTAP `analysis_share.test.sql`, 53 assertions; Vitest
    `analysisShare.test.ts` (the fit guard over the GG and sample corpus,
    against the hand and its standard-text copy; the poll mapping and
    grades). Verified end to end on the local stack: signed out, a published
    hand shows nothing until the owner ticks the box, then pips and the sheet
    (375 px, light and dark); a poll shows no reference to anon or before
    the vote (no request is even made), and after a second account votes,
    the reference beside the votes (EN and HR); the author's thread gains
    pips when shared, for anonymous readers too.
  - **Open.**
    - The explanations and approximation texts are written to "you"; on a
      shared hand they address the hero. The sheet says so; a third-person
      variant of the templates would be cleaner.
    - The reference is read at the client's `ANALYSIS_VERSION`: after a bump,
      shared hands show nothing until their owner re-runs the analysis.
    - The analysis is read as anon for the server render of `/p/` and
      threads; an author's own hidden (held, shadow-hidden) thread therefore
      shows its analysis to nobody, the author included.

- 2026-10-02 — A8b shipped: the study plan, at `/analysis/plan` ("Plan" /
  "Plan učenja" in the sub-nav, under "More" on a phone) and a plan card on
  the overview. No grade changes, so still `analysis/3`.
  - **A focus area is a situation, not a leak.** The leak finder's leaks
    (`groupLeaks`, unchanged) are gathered by the situation they settled at
    (street, scenario, family, seats): river, preflop raiser out of position
    first to act, "checking instead of betting" and "betting instead of
    checking" are one thing to study, with one sample (every graded decision
    in its situations), the sum of their mistakes, and A6's confidence rule
    on those. Areas rank by EV lost, which within one sample is also the
    order of EV lost per 100 hands.
  - **Confidence.** The plan takes the three costliest areas of medium or
    high confidence; only if there are fewer does it fill with thin ones,
    and only with two mistakes or more, labelled "tentative" with a note to
    review the hands first. The one-hand AA fold of A6 is still not a week's
    work on its own; inside "BTN vs CO open" (39 decisions, 5 mistakes) it is.
  - **Each area's checklist** (`lib/training/plan.ts`, pure, 25 tests in
    `tests/test/studyPlan.test.ts`): up to two concepts (`leakConcepts`), a
    trainer session set to the spot (20 preflop spots or 10 river spots),
    the area's due drills (at most 15; undrilled Mistakes count as due), and
    three of the player's own hands, most EV lost first. A concept or hand
    two areas share appears once. Too little graded play (none, under 50
    moves, or no leak) gives **the fundamentals** instead: position, RFI and
    pot odds, the preflop trainer first in and in the big blind, five river
    spots, and any drills due. A fundamentals plan made for want of hands is
    rebuilt on the next visit, so a first analysis turns it into a leaks plan
    the same day.
  - **The trainer took two filters** so a link can be the spot (additive,
    defaults unchanged): preflop `vs` (the line's last raiser; a filter the
    charts cannot deal is dropped rather than leaving the trainer empty) and
    river `role` (preflop raiser or caller), with the seat and side it
    already had. The river trainer's out-of-position hero always acts first,
    so an area facing a bet is practised in position.
  - **Progress counts itself.** `study_plan` counts, inside the reader's
    week, the trainer answers matching a task's filter (preflop: mode,
    family, seat; river: the `<line>:<seat>` pairs its role and side allow,
    from `riverSeatings`) and the distinct drills of the area's spot keys
    answered. Concepts and hands are ticked by hand; anything can be.
  - **Weeks and the rollover.** A plan is one row per ISO week, named by the
    reader's local Monday (the database accepts the UTC week and one either
    side). The week's first visit builds it; last week's stays as it was.
    The rollover counts an area's weeks in focus, does not ask again for a
    concept read last week, does not offer a hand reviewed last week, and
    carries an unreviewed hand over while its area stays. "Rebuild" builds
    the week again from the latest analysis; tasks it keeps (by kind and
    reference) keep their ticks.
  - **Last week** shows the old checklist's completion and, per focus area,
    A6's comparison: the mistake rate in the spot (two-proportion z, the same
    tiers and "too few" under 10 decisions) and EV lost per 100 hands. It
    compares the plan's own week against the one before when graded hands
    were played in it, and otherwise says so and uses A6's last 7 days of
    play against the 7 before.
  - **Storage** (`20270215090000_analysis_study_plan.sql`): `study_plans`
    and `study_tasks`, RLS select-own, no client write grant; writes through
    `save_study_plan` (validated, refused whole, a review hand must be the
    caller's) and `set_study_task` (id and owner, this or last week), both
    definer, rate-limited; the read `study_plan` and two week helpers
    invoker. The focus snapshot is the browser's, size- and shape-checked:
    only its owner reads it. pgTAP: 54 assertions.
  - **Owner's library** (5,448 hands, analysed at `analysis/3` with
    `charts/2` on a copy in a local account: 1,588 graded moves in 1,442
    hands, 75 leaks, 144.3 bb): 33 areas (5 high, 15 medium, 13 low
    confidence). The plan:
    1. River, preflop raiser out of position first to act (other seats):
       21.0 bb, 1.46 bb / 100 hands, 9 mistakes in 26 decisions, medium —
       betting where the reference checks (11.5 bb) and checking where it
       bets (9.5 bb). Read bet sizing and range advantage; 10 river spots as
       the preflop raiser out of position; 5 drills; three hands (99, QJs,
       KTs).
    2. River facing a bet (other spots): 16.3 bb, 8 mistakes in 33, medium —
       calling instead of raising, calling too wide, folding too much. Read
       MDF and pot odds; 10 river spots in position; 3 drills; three hands.
    3. Preflop, BTN against a CO open: 14.6 bb, 5 mistakes in 39, medium —
       13.3 bb of it the AA fold. Read 3-bets; 20 spots facing an open on
       the button against the cutoff; 5 drills; the AA hand first.
    The fourth costliest area (river, merged to the street: 14.5 bb, 4
    mistakes in 8) is low confidence and stays out. Last 7 days of play
    against the 7 before: score 91.4 against 94.2, "leaning worse"; every
    focus area "too few" or "no clear change".
  - **Open.**
    - A drill task's target is the drills due when the plan is built; a
      rebuild later in the week counts the ones already answered towards a
      smaller target.
    - Flop and turn areas get concepts, drills and hands but no trainer
      session until there is a flop or turn trainer (A5).
    - Plans are per week and kept; there is no history screen beyond last
      week yet.
- 2026-10-02 — A5a shipped: turn grading with our solver, `analysis/4`.
  - **The turn is solved per hand, in the browser worker.** Precomputing or
    caching it, as §3.2 expected, buys nothing: among the library's 407
    solved turn spots no two share a spot key, nor even a canonical turn
    board. So there is no `spot_solutions` table; the per-decision rows are
    the cache, as on the river.
  - **Speed-ups** (`lib/solver`, additive; the river's API is unchanged):
    - **River-card isomorphism** (`TurnSpot.isomorphism`): where the board
      and both ranges are symmetric under swapping suits the board does not
      use, one card per class is dealt and the others are read back through
      the relabelling of the hands. Exact: the isomorphic solve's strategy,
      spread over all 44 cards, has the full tree's exploitability and
      values to 1e-6 bb (test). It saves a quarter of the rivers on a
      two-suit turn and half on a monotone one, nothing on the 61% of turns
      with three suits: 41.0 river classes on average in the library.
    - **Chance sampling** (`SolveOptions.sampling`): stratified public
      chance sampling, seeded, exact exploitability (best response walks
      every card). **It does not pay here and is off.** Each river subgame
      needs its own few dozen updates whatever order they come in, so four
      strata took 3.4× the iterations at a quarter of the cost each.
    - **A coarse tree, chosen by measurement**: turn 75% + all-in, raises
      75% + all-in, one raise, the turn's all-in only up to three pots; a
      river below it of 75% + all-in and no raise. Two findings shaped it:
      the deep turn shove (9 pots at 100bb) cost twice the time for no use,
      but capping the river's all-in the same way made a turn flat of the
      nuts a Blunder that the full river calls Good (the nuts lose their
      river shove) — so the river keeps it; and a river raise doubled the
      time again for no change in the grades.
    - **The hand's own sizes** (`lineMenu`): 44% of the library's turn bets
      are more than 25% of the pot from 75%, which a fixed menu would cap as
      off-tree. A real bet or raise more than 0.1 pot from every menu size is
      added to the tree (`turn-m1+b0.4`), and a shove past the cap puts the
      all-in back. 243 of 465 graded turns used it; off-tree turn grades fell
      from 111 of 468 (fixed menu, first run) to 1.
    - **Engine**: the showdown sweeps read cards in strength order and skip
      zero reach (−7%); a player's own node reuses the strategy its
      opponent's traversal just regret-matched there (−8–10%, an A/B in one
      run); `evaluate` and the result keep turn-level nodes only (`nodes:
      "turn"`); DCFR `γ = 3` (5–15% fewer iterations); exploitability is
      measured from iteration 30, every 10.
  - **Measured** (`npm run bench:turn`, M2 Pro, Node 24, 313 v 239 combos on
    twelve boards of every suit structure, 10 bb pot, 90 behind, to 1% of the
    pot measured exactly over the whole tree). The machine was shared with
    other agents' solves (load average 25–70); the same configurations ran
    about twice as fast on a quieter machine earlier (1.0–1.6 s).

    | Tree | median | p90 | iterations | solver MB |
    |---|---|---|---|---|
    | Phase S (75% + all-in, raises, 44 rivers) | 4.2 s | 4.7 s | 80 | 19.7 |
    | A5a menu | 2.2 s | 2.4 s | 70 | 11.7 |
    | + isomorphism | 2.0 s | 2.9 s | 70 | 8.7 |
    | + sampling, 4 strata | 2.2 s | 2.9 s | 240 | 8.7 |

    The A5a target (median ≤ 1.5 s, p90 ≤ 4 s for ~300 v 240) is met on a
    quiet machine and missed by a third under that load. Real library spots
    are wider (median 611 combos in total; up to 1,128 a side in limped and
    9-max pots): the solve alone took median 2.0 s, p90 4.2 s.
  - **Gaps**, all exploitabilities exact in their own tree:
    - against a fuller tree (turn 75% + all-in always, river 33/75/150% +
      all-in, raises 75% + all-in, two raises; bench, four boards): the
      game's value within 1.3–2.0% of the pot; checking at the root graded
      alike for 94–100% of hands, calling a 75% bet for 78–89%;
    - against a fuller tree on 19 library spots (turn 33/75%, that river):
      the hero's actual turn decision got the same grade 68–79% of the time
      depending on the coarse variant, within one class 95%, EV loss 0.35–
      0.43% of the pot apart on average. Grades near a threshold (2% of the
      pot is Inaccurate against Mistake) move with any change of tree.
  - **Grading** (`lib/analysis/turn.ts`) mirrors the river's: ranges as the
    turn came (the flop narrowed by the heuristic), the real line onto the
    tree, the hero's size graded as the better of its neighbours, `range-cap`
    (Mistake unless dominated: folding a hand no river can beat, calling with
    no equity at all against the preflop range) and `range-sensitive` (a
    second turn solve on the half-strength narrowing for grades of
    Inaccurate or worse). New approximation `coarse-river`; reasons
    `turn-*`. Facts (`TurnFacts`): equity over every river, the share of
    rivers that make the hand strong or a loser, a role (value, a hand that
    wants protection, a draw, a bluff-catcher, a middling hand, air), the
    range shape. The *why* says which, plus equity realisation out of
    position and the river cards that change the board (barrel cards), with
    Learn links. The turn study is the river's view with draw categories.
  - **The river narrows through the solved turn**: where the turn was solved
    and the line reaches the river within the off-tree distance, the river
    starts from the solved turn strategy (`RiverFacts.narrowing:
    "turn-solver"`), else from the heuristic. 282 of 310 graded rivers did.
    The river's sensitivity check stays the half-strength heuristic all the
    way: a second, different narrowing.
  - **Owner's local library** (5,448 hands, `charts/2`):
    - **Turn: 745 decisions, 465 graded (62%)**; multiway 198, multiway on
      the flop 73, unreached 9. Perfect 75.1%, Good 11.0%, Inaccurate 2.2%,
      Mistake 11.8%, Blunder 0 (28 capped from Blunder); score 84.8; 105.5 bb
      lost, most by checking (38.1 bb) and betting (22.5). All 465 solves
      under 1% of the pot, 70 iterations on average.
    - **River: 310 graded**: Perfect 71.6%, Good 20.0%, Inaccurate 2.3%,
      Mistake 6.1%, Blunder 0; 94.3 bb lost (118.7 in A4). Out of the hero's
      own range 20% (22% in A4) and from a placeholder range 84% (86%): most
      of the library is 9-max, which `charts/2` does not cover either.
    - **Preflop** (`charts/2`): 1,281 graded; Perfect 90.8%, Good 0.1%,
      Inaccurate 3.2%, Mistake 3.9%, Blunder 2.0%.
  - **Backfill: 9 min 12 s in the browser** for the whole library (41 s in
    A4), on four workers side by side (`runAnalysis` now runs a pool of
    one per spare core, at most four, on chunks of 20 hands) under that same
    load; a single-threaded Node run of an earlier tree took 22 minutes. The
    tab stays responsive (the work is all in workers), shows the time left,
    stays resumable, and can start with the most recent 200 / 500 / 1,000
    hands (`hands_needing_analysis_recent`, `20270125090000_analysis_turn.sql`,
    invoker; such a run never prunes).
  - **Corpus suite**: thousands of hands with turn solving off
    (`AnalyzeOptions.turn: false`, A4's handling) plus ten heads-up turn
    hands analysed in full. A trainer river (A7) is built and graded on the
    heuristic narrowing (`turn: false`) so that the solve the trainer shows
    is the one that grades it; drills of real hands read the stored rows.
  - **`charts/2`'s known weakness** replaces `charts/1`'s in the `model`
    note: the small pairs, small suited connectors and A5s UTG folds, and
    the button's flat of a cutoff open (`docs/CHARTS.md` §9).
  - **Open.**
    - The flop is still heuristic, and every turn grade rests on it (A5b).
    - A turn solve on a wide limped or 9-max range takes 4–8 s.
    - Mistake is the most common bad turn grade (11.8%), 28 of them capped
      Blunders; the turn's coarse river likely leans towards betting now.
  - **A5b, the flop library: feasible offline, not in the browser.**
    - A flop + turn + river game built from the same pieces (flop 33% +
      all-in up to three pots, raise 75%; turn and river as above; no
      isomorphism; 335 v 255 combos on Qs7h2d) has 839,000 nodes, holds
      2.7 GB of solver arrays, and takes 8.7 s per iteration under that load
      (about 5 s quiet). At the turn's ~70–100 iterations that is 10–15
      minutes per flop and preflop line on one core.
    - Needed: the flops × the heads-up preflop lines. All 1,755 canonical
      flops × ~12 lines (SRP of each opener against each blind, the common
      3-bet pots) is ~21,000 solves, ~4,000 core-hours. A representative
      subset of ~100 flops (weighted by texture) × 12 lines is 1,200 solves,
      ~250 core-hours: a few days on a 10-core machine.
    - Recommended: an offline Node script (`worker_threads`, one solve per
      core) on a 100-flop subset first; isomorphism on the turn and river
      deals; the A5a turn/river tree with one or two flop sizes; 16-bit
      regrets and strategy sums to halve the memory (or drop the strategy
      reuse cache: −1/3); store flop-level nodes only (~0.3 MB a solve,
      ~0.4 GB in all) in Storage, keyed by (canonical flop, line, tree).
      Then the flop's ranges at the turn come from the library, which
      replaces the last heuristic narrowing and feeds the realisation back
      into the charts (`docs/CHARTS.md` §9). Chance sampling will not save
      the flop either (same reason as the river); a WASM core would.
