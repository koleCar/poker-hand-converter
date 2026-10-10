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
  source: "chart" | "solver" | "heuristic" | "approx";   // approx: A9, multiway
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

**Shipped in A2a (#95), widened in A2c and A2d; details in `docs/CHARTS.md`.**
- **Source:** our own multi-player DCFR over the 169 classes, plus a
  realisation model for pots that see a flop, fitted per set to our own
  turn+river solves (A2a.1).
- **Sets (`charts/4`, A2c + A2d):** a library of eight, one JSON per table
  and depth, loaded lazily one set at a time:
  - 6-max at 40 / 60 / 100 / 150 / 200bb (the 100bb set on `charts/2`'s
    fit);
  - 9-max (UTG, UTG+1, UTG+2, LJ, HJ, CO, BTN, SB, BB) at 100 / 150 / 200bb;
  - every set with **limped pots** (A2d): open limps and over-limps from
    every seat, isolation raises sized by the limpers, the limper's answers,
    at most three limpers; solved with a 0.5% limp tremble so the spots
    behind a limp are trained although the equilibrium barely limps.
- **Convergence:** NashConv 0.06–0.33 mbb/hand (6-max), 0.27–0.44 (9-max) with the limp trees (`charts/3`: 0.04–0.13, 0.26–0.49).
- **Lookup picks the set:** the smallest table with enough seats, then the
  nearest depth within 20%, never interpolated; the distance is a
  `stack-depth` approximation.
- **Lookup refuses, with a reason:** `cold-call`, `multiway` (more than
  4 entrants, or a fourth limper), `rare-line`, `action-not-modelled`,
  `straddle`, heads-up and 10+ players (`players`), and depths no set covers
  (`limp` only for a set without limp trees).
- **Lookup approximates:** `short-handed` (3–5 handed read as 6-max, 7–8
  handed as 9-max, the earliest seats folded: exact in the model up to
  convergence), and off-tree sizes, by action translation.
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
    coarse abstraction, flop-level strategies only. A5b built the pipeline
    and solved a pilot (§10); the analysis reads it only behind
    `FLOP_LIBRARY_ENABLED`, off until the full library exists. Until then
    flop decisions stay heuristic.
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
- the postflop pot is multiway, except a river call or fold facing a bet
  (an approximate grade, `source: "approx"`) and a turn or river that
  began heads-up after a multiway flop (solved, `multiway-history`) — A9;
  the rest keeps its multiway facts and flags;
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
| Flop strategies | Precomputed library (offline script, `tests/scripts/flop-library`); chunks fetched by the worker per hand (A5b) | Too slow per hand in the browser (§3.2, §10 A5a) |
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
  explanation that uses a concept ("Concepts" in this sub-nav since L1). It is
  not a new top-level tab: five tabs already scroll sideways at 375px (A1).
  The course built on it is the top-level Learn tab (`/learn`,
  `docs/LEARN-PLAN.md`), which links back here.
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
| **L1–L4 — the Learn tab** (`docs/LEARN-PLAN.md`) | A top-level course at `/learn`: 62 lessons in tracks and modules, practice generated and graded by the charts, the solver and the concept library's maths, the learner's own hands as the last exercise, lessons recommended from leaks (a `lesson` task in the plan), missed items as SM-2 review cards. L1: catalogue, M0–M3 and M6-L4 written, turn spots; L2–L4: the other modules, `range-split`, `range-paint`, placement, curated hands, flop drills. | A7, A8a, A8b |
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
  - **Shared analyses survive the bump** (A7.1's open point): a version bump
    used to blank every shared hand until its owner re-ran the analysis, and
    `analysis/4` is one. `read_shared_analysis` now falls back to the hand's
    newest *older* stored version, flagged `staleVersion`
    (`20270224090000_analysis_share_fallback.sql`, pgTAP), and the
    read-only sheet says "analysed with an earlier version". Checked locally:
    a shared turn decision, its turn study, and a poll's reference on a turn
    decision render from `analysis/4` rows. The poll reference itself does not
    yet say when it is from an earlier version.
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
- 2026-10-03 — A2c shipped: chart coverage, `charts/3`, `analysis/5`.
  - **Eight sets, one model.** 6-max at 40 / 60 / 100 / 150 / 200bb and 9-max
    (UTG, UTG+1, UTG+2, LJ, HJ, CO, BTN, SB, BB — the stats engine's names)
    at 100 / 150 / 200bb, each generated by `charts/2`'s pipeline at its own
    table and depth: the realisation re-measured on its own ranges and stack-
    to-pot ratios (two rounds from `charts/2`'s fit). The 6-max 100bb set is
    unchanged (`charts/2`, regenerated byte for byte by the new code). Sizes:
    2.2bb opens at 40bb, and every raise past 40% of the stack is all-in
    (most 40bb 4-bets, 60bb 4-bets over a squeeze). NashConv 0.04–0.13
    mbb/hand (6-max), 0.26–0.49 (9-max). 11.8 MB in all; each set is its own
    chunk (171–224 KB gzip for 6-max, 570–645 KB for 9-max), loaded only
    when a hand, the chart browser or the trainer needs it. ~2 h 15 min to
    generate everything, four sets at a time on 10 cores.
  - **8- and 7-max are read on 9-max, 3–5 handed on 6-max**, the earliest
    seats folded (`short-handed`), instead of separate sets: in the model
    the game after a fold *is* the smaller table's (card removal between
    opponents is ignored), and measured against native 3-, 4-, 5-, 7- and
    8-handed solves the reading differs by 0.07–0.18% of a class's
    frequency, against 0.05–0.07% between two iteration counts of the same
    native solve (`npm run charts:compare`, `docs/CHARTS.md` §6.3).
  - **Lookup picks the set:** the smallest table with enough seats, then
    the nearest depth within 20% (never interpolated); `stack-depth`
    records the distance. Covered: 32–240bb on 6-max except 72–80bb, 80–240bb
    on 9-max. **Straddles stay refused** (52 of 5,388 preflop decisions in
    the library); so does heads-up (the button is the small blind). A fifth
    entrant is now `multiway`, not `bad-input` (A2b's open item).
  - **The library is a `ChartSet`** (its own fields the default set's), so
    Reports and every existing reader work unchanged; `lookupPreflop`
    answers from the set a spot needs and names it (`facts.chart.set`). The
    analysis worker and the trainer worker load the sets a page of hands
    or a spot needs (`requiredChartSets`, `ensureChartSets`).
  - **Trainer:** a table-and-depth selector (`?set=`), 9-handed spots at
    9-max seats, graded from the same set; drills draw the set their grade
    names. **Leaks** walk a stored line on the table it was written for.
  - **Owner's local library:** preflop decisions graded **1,281 → 3,817 of
    5,388 (24% → 71%)**; table-size refusals 3,024 → 210, depth 674 → 106,
    open limps 256 → 933 (8-handed pots behind a limper now reach the
    lookup). Solver-graded turns and rivers resting on a placeholder range
    85% → 42% (turns 395 → 194 of ~460, rivers 261 → 129 of 310). Preflop
    grades: Perfect 90.4%, Inaccurate 3.7%, Mistake 4.0%, Blunder 1.8%.
  - `ANALYSIS_VERSION` is `analysis/5`: the sets change preflop grades and
    the ranges every postflop grade starts from. No migration.
  - **Open.**
    - At 40bb the big blind defends 78% against a button open and 51%
      against UTG (2.2bb opens, OOP realisation 0.85): wider than usual;
      the flop measurement (A5b) is where to check it.
    - Reports read the 6-max 100bb set only (decisions graded on other sets
      are left out with A3's note), and the study plan's trainer links name
      6-max seats.
    - The rebuild to `analysis/5` was verified in Node on the library's
      stored hands (the same `analyzeHand` the worker runs) and the chart
      browser and trainer in the browser; the in-browser rebuild of the
      owner's library is still to run.
    - Remaining refusals: open limps (933) are the biggest; a limp tree
      for full ring would be next.

- 2026-10-03 — A5b, pilot: the flop library's pipeline, a pilot solve and
  the full run's estimate. The analysis reads the library only behind
  `FLOP_LIBRARY_ENABLED`, which is off, so no grade changes: still
  `analysis/5`. **The full run (~235 core-hours) waits for the owner.**
  - **Flop solver** (`lib/solver/flop.ts`, additive): flop betting, the
    turn dealt, A5a's turn tree, the river dealt, A5a's river.
    - **Suit isomorphism on both deals**: turn cards by the orbits of the
      flop's symmetry group, river cards by the orbits of the turn card's
      stabiliser (below `7h` on `Ks 8s 2d` hearts and clubs are no longer
      interchangeable), read back through per-edge mirrors
      (`Game.edgeMirrors`). Exact: the isomorphic solve, spread over every
      card, has the full game's best responses and values to 1e-6 on a
      two-tone and a monotone flop, and the full game matches the naive
      pairwise evaluator through both deals (tests). It saves nothing on a
      rainbow flop, a quarter of the turn cards on a two-tone one and half
      on a monotone one, plus rivers below: the BTN–BB monotone pilot flop
      held 0.5 GB against 1.8 GB rainbow.
    - **16-bit storage** (`SolverConfig.storage: "i16"`): regrets as int16
      and strategy sums as uint16, each node's block scaled by its largest
      magnitude, and no strategy-reuse cache: 4 bytes per entry instead of
      12. Regret matching and averaging read ratios within a hand's row, so
      the scale cancels; the cost is resolution relative to the node's
      largest entry. On a test tree the root strategy stays within 2%
      (mean |Δfreq|) of float32's and the exploitability within the same
      band. The float32 path (turn, river) is unchanged.
    - **Exploitability is exact**: a full best response over the whole
      flop+turn+river tree (no sampling), measured at iteration 40 and
      every 20 after, ~1.5 iterations' time each. It is the exploitability
      of exactly the strategy the solver holds (16-bit sums included).
    - Progress and cancel per iteration (`RunOptions.onIteration`);
      deterministic (same job, same bytes).
  - **The tree, `flop-m1`, chosen by measurement** on the widest
    single-raised line (BTN–BB, 601 v 473 combos on `Qs7h2d`; solver
    entries, 16-bit):

    | Tree | entries | memory | s / iteration |
    |---|---|---|---|
    | flop 33/75% + raise 50% + all-in ≤ 3 pots, A5a turn (one raise) and river | 638 M | 2.55 GB | 14–21 |
    | the same with one flop size (33%) | 414 M | 1.66 GB | |
    | **two flop sizes, no turn raise** (chosen) | 449 M | 1.80 GB | 11 alone, 18–22 four at a time |
    | no turn raise, river all-in ≤ 3 pots | 335 M | 1.34 GB | |

    The river is 99% of the entries. Two flop sizes because real flop bets
    cluster at both (one would put most 66–75% bets off the tree); the turn
    raise is what gave way. The river keeps its all-in (A5a: the nuts need
    their shove).
  - **Representative flops** (`lib/solver/flopSet.ts`): the 1,755 canonical
    flops fall into eight texture classes (unpaired rainbow, monotone,
    two-tone by which two ranks share the suit; paired rainbow and two-tone;
    trips); a flop maps only within its class, to the nearest
    representative by `1.5·|Δhigh| + |Δmiddle| + 0.7·|Δlow| + 0.4·|Δstraights|`
    (straights: hole-rank pairs that make a straight with the flop). 100
    representatives by weighted k-medoids per class, split by the classes'
    share of the 22,100 flops (at least two each). Committed as data
    (`FLOP_REPRESENTATIVES`); a test recomputes them. Mean distance of a
    flop to its representative 1.9 ranks, the worst 9.6.
  - **Lines** (`FLOP_LINES`): the river trainer's twelve heads-up pots (SRP
    of every opener against the BB and BTN against the SB, five 3-bet pots,
    the SB limp). Ranges are the charts' for the line, read by the
    analysis' own walk on a scripted hand, so a library spot starts from
    exactly the ranges a real hand on that line gets. Keyed by chart set
    id (pilot: `nlhe-cash-6max-100bb`); chunks of another set (A2c's 9-max
    and other depths) can be added the same way.
  - **Format** (`lib/solver/flopLibrary.ts`, `FLOPLIB_VERSION = floplib/1`):
    one chunk per (set, tree, line, canonical flop): a header naming what
    was solved (chart set id, version and model hash, line, players, pot,
    stack, rake, target) and the flop-level solve in the existing solution
    blob (`format.ts`: strategies 16-bit, EVs float32) - every flop
    decision node with strategy and EV per combo, the turn deals with no
    subtree. 57–63 KB for a 3-bet pot, 98–104 KB for BTN–BB; ~50% gzipped.
    Under `<base>/<set>/<tree>/<line>/<flop>.bin` with a `manifest.json`;
    the worker's `FlopLibraryLoader` fetches a set's manifest and then
    single chunks a hand needs. Never bundled into a page.
  - **Batch runner** (`tests/scripts/flop-library`, `npm run floplib`): a
    queue on disk, one solve per process (memory returned on exit, its own
    peak RSS, cancel is a kill), chunks and stats written atomically, so it
    resumes where it stopped; a memory budget (`--mem`) with each job's
    peak predicted from its ranges and turn classes; `--only N`, `--lines`,
    `--flops`, `--estimate`, `--validate`; `manifest.json` with times,
    memory and exploitability per spot.
  - **Integration, behind the flag** (`lib/analysis/flopLibrary.ts`):
    - a hand reads the library when it is heads-up to the flop on one of
      the lines, its line was answered by the chunk's chart set (id and
      model hash), and its SPR at the flop is within 30% of the solve's;
    - the hand's own flop reads its chunk combo for combo (through the suit
      relabelling); any other flop reads its representative's **by hand
      category** (made hand × draw, coarser when thin): `flop-mapped` and
      `library-bucketed`. Amounts and EVs are scaled by the real pot over
      the solved one;
    - **narrowing**: `libraryModel` is a `NarrowingModel` reading
      `L(c | action)` from the solved node (found from the street's actions
      through `NarrowInput.actionIndex`, followed as grading follows a
      line); off the tree it falls back to the heuristic for the rest of
      the street. The turn then starts from the library's ranges, and turn
      and river grades drop `narrowing-heuristic` (tested on the pilot: a
      3-bet pot's turn solve);
    - **flop grading** (`gradeFlop`): options, frequency and EV for the
      hero's combo (or category) at the node, `grade()`, `source: "solver"`,
      `rake-profile`, `coarse-river`, translation codes, `range-cap` (Mistake
      unless dominated), `facts.flop` (`FlopFacts`). A decision the
      library cannot follow keeps the heuristic.
    - Shared edits are small: `NarrowInput.actionIndex`,
      `AnalyzeOptions.flopLibrary`, `SolvedStreet` gains `flop`, two
      approximation codes (EN/HR texts), `SpotFacts.flop`.
  - **Pilot** (6-max 100bb, `flop-m1`, target 1% of the flop pot; committed
    in `tests/scripts/flop-library/pilot/` with the five validation solves, 1.1 MB), on the M2 Pro (10
    cores) shared with another agent's chart generation (load 5–20), four
    solves at a time:

    | Line | Flop | iterations | exploitability | time | solver / peak RSS | chunk |
    |---|---|---|---|---|---|---|
    | BTN–BB SRP | `Ts7h4d` | 100 | 0.80% | 36.0 min | 1.80 / 1.89 GB | 104 KB |
    | | `AsKh7d` | 100 | 0.73% | 30.7 min | 1.70 / 1.80 GB | 99 KB |
    | | `Qs8s4h` | 100 | 0.75% | 21.2 min | 1.09 / 1.19 GB | 103 KB |
    | | `KhKs9d` | 100 | 0.72% | 17.6 min | 1.07 / 1.31 GB | 98 KB |
    | | `Ks6s3s` | 100 | 0.93% | 10.0 min | 0.52 / 0.60 GB | 102 KB |
    | BB 3-bet, BTN calls | `Ts7h4d` | 60 | 0.71% | 4.9 min | 0.37 / 0.62 GB | 63 KB |
    | | `AsKh7d` | 80 | 0.71% | 5.7 min | 0.33 / 0.59 GB | 58 KB |
    | | `Qs8s4h` | 60 | 0.75% | 2.9 min | 0.22 / 0.50 GB | 60 KB |
    | | `KhKs9d` | 80 | 0.64% | 3.4 min | 0.21 / 0.45 GB | 57 KB |
    | | `Ks6s3s` | 100 | 0.73% | 2.5 min | 0.11 / 0.28 GB | 59 KB |

    Every solve reached the target; single-raised pots take ~100
    iterations (5% of the pot at 40), 3-bet pots 60–100. A BTN–BB rainbow
    flop alone on a quiet machine runs ~11 s an iteration (~20 min a
    solve); four at a time under that load, 18–22 s.
  - **Validation of the mapping** (`--validate`): five more flops solved
    and read the way the analysis reads a mapped flop, each combo of the
    real flop's own solve against its category on the representative,
    reach-weighted over the 14 flop nodes; "own categories" reads the
    flop's own solve by category - the cost of categories alone:

    | Line | Flop → representative | strategy TV (own categories) | mean \|ΔEV\| % pot (own) | same top action | same check/call grade |
    |---|---|---|---|---|---|
    | 3-bet | `AsKh9d` → `AsKh7d` (1.4) | 12.6% (9.6%) | 4.3% (3.0%) | 86% | 71% |
    | 3-bet | `Ts8h4d` → `Ts7h4d` (1.0) | 19.1% (16.8%) | 5.9% (5.2%) | 83% | 62% |
    | 3-bet | `Js8s4h` → `Qs8s4h` (1.5) | 27.5% (18.7%) | 9.3% (4.6%) | 70% | 55% |
    | BTN–BB SRP | `AsKh9d` → `AsKh7d` (1.4) | 10.1% (8.0%) | 5.4% (3.9%) | 87% | 81% |
    | BTN–BB SRP | `Ts8h4d` → `Ts7h4d` (1.0) | 18.9% (15.0%) | 6.1% (4.4%) | 80% | 61% |

    Mapping to a near representative costs little beyond reading by
    category at all; **reading by category is the larger loss**: a
    category's mean strategy is not a combo's (kickers, blockers, which
    draw), and the grade of a check or call agrees only 55–81% of the time.
    A mapped (or out-of-range) flop grade is therefore approximate in a way
    an exact one is not; `range-cap` keeps it from Blunder, and it is
    labelled. Finer categories or more representatives are the levers.
  - **Full-run estimate on this machine** (`--estimate`, fitted on the 15
    pilot solves by each line's live combos × turn classes): **~235
    core-hours** for 12 lines × 100 flops (BTN–BB 34, SB–BB 30, CO–BB 23,
    HJ–BB 18, BTN–SB 17, UTG–BB 14, 3-bet pots 9–14 each, the SB limp 43 -
    the widest ranges); **~85 MB** of chunks (~45 MB gzipped); the widest
    solve (the SB limp) ~1.9 GB of arrays, ~2.3 GB resident. Four solves at
    a time (the 16 GB of memory and a usable machine) is **~60 hours**;
    eight on an otherwise idle machine about 30. The pilot's times are
    under load: a quiet machine is perhaps a third faster.
  - **Options** for the owner:
    - the full run as is, overnight runs resumed (`npm run floplib`
      resumes);
    - **the six SRP lines and two 3-bet pots first** (~150 core-hours), or
      **the 50 most-covering flops** (half: ~110 core-hours, mapping
      distances grow);
    - **a coarser tree** (`no turn raise, river all-in ≤ 3 pots`: −25%
      memory and time), or one flop size (about a third less, but most
      66–75% bets would be off the tree: not recommended);
    - a **cloud machine**: a 32–64-core, 128 GB instance runs ~16–30 solves
      at once, so the full run is roughly 8–15 hours of one machine; the
      runner needs only Node and the repo (worth checking that its first
      chunk there is byte-identical to the pilot's: another CPU and V8 build
      should, but need not, round alike).
  - **Open.**
    - The library is a pilot: `FLOP_LIBRARY_ENABLED` stays off until the
      full run, then its first grades are a version bump.
    - Category reading is coarse (above); the SB limp's convergence is
      untested (only BTN–BB and its 3-bet pot were solved).
    - Hosting: chunks go to Storage (or any static host) under the layout
      above; `FLOP_LIBRARY_BASE` is a placeholder until then.
    - Charts' realisation from flop solves (`docs/CHARTS.md` §9) can read
      the library once it exists.
- 2026-10-03 — A2d shipped: limped pots in the charts (`charts/4`), every
  chart consumer on every set, `analysis/6`.
  - **Why.** After A2c the biggest refusal in the owner's library was the
    open limp: 933 hero decisions (17% of preflop), 399 of them on the
    9-max 100bb set, 284 on 6-max 100bb, 90 on 6-max 150bb, 77 on 9-max
    150bb, 60 on 9-max 200bb; 694 behind one limper, 191 behind two, 37
    behind three, 11 behind four. And Reports and the study plan still read
    only the 6-max 100bb set.
  - **The limp tree** (`preflopTree.ts`, `maxLimpers: 3`; `docs/CHARTS.md`
    §1.3). Every seat but the big blind may limp first in or behind until
    three have (the small blind's completion counts); the next may only
    fold or isolate (`limpers-cap`, the lookup's `multiway`). The big blind
    behind limpers checks or isolates. Isolation: 4bb over one limper in
    position, +1bb per extra limper, +1bb out of position of a limper (a
    blind); the big blind over the small blind's completion stays 4bb, so
    blind-versus-blind is `charts/3`'s. Facing an isolation: fold, call,
    re-raise 3x (+1x per caller). Limpers are entrants (at most four). Behind
    an open limp the pot's 4-bet is all-in: that raise level is a third of
    the tree and no library decision reaches it. Sizes, 100bb: 6-max 3,825
    -> 10,361 action nodes, 9-max 28,591 -> 79,131 (three limpers without
    the shove cut would have been 14,837 and 118,947).
  - **The tremble.** The equilibrium hardly limps outside the small blind,
    and CFR does not train anyone's strategy facing a limp nobody makes (an
    opponent's regrets are weighted by the limper's reach). So the solve is
    an **ε-perturbed game** (Selten's trembling hand): every class limps at
    least 0.5% at every unopened non-blind node (`limpFloor`); regret
    matching on the free part, play with the perturbed one, best responses
    and NashConv in the perturbed game (`preflopCfr.ts`). The reference's
    limper therefore holds any hand; that is labelled on every grade behind
    a limp (new approximation `limp-tremble`), and an opponent who
    open-limped keeps the placeholder limp range for the postflop walk
    (`chartRange`). Nodes behind an open limp are kept down to a reach of
    1e-6 (`minLimpReach`).
  - **Generation.** Every set re-solved once (3,000 iterations) on its own
    committed realisation fit (`reuseFit`, `sets.ts`): the tremble moves the
    fit's heads-up ranges by about the fit's own round-to-round noise
    (raise-first-in widths by at most 0.6 points, the big blind's defence
    against a button open by 0.1), and re-measuring would have cost ~3
    hours more. A solver speed-up made the 9-max trees affordable: a
    multiway terminal's pair products `S_ab π_b` are kept between
    traversals until `b`'s own traversal changes its reach (same numbers,
    identical checksums; ~1/3 off the limp trees' iteration time).
    | Set | Nodes (charts/3) | Bytes | gzip | NashConv (charts/3) | Solve |
    |---|---|---|---|---|---|
    | 6-max 40bb | 834 (335) | 1.95 MB | 486 KB | 0.058 (0.038) | 7 min |
    | 6-max 60bb | 883 (368) | 2.12 MB | 545 KB | 0.065 (0.058) | 10 min |
    | 6-max 100bb | 752 (281) | 1.87 MB | 486 KB | 0.094 (0.075) | 14 min |
    | 6-max 150bb | 814 (343) | 1.99 MB | 530 KB | 0.139 (0.121) | 14 min |
    | 6-max 200bb | 815 (355) | 2.00 MB | 537 KB | 0.332 (0.130) | 15 min |
    | 9-max 100bb | 2,705 (1,033) | 6.40 MB | 1.64 MB | 0.313 (0.256) | 110 min |
    | 9-max 150bb | 2,888 (1,139) | 6.87 MB | 1.78 MB | 0.270 (0.313) | 112 min |
    | 9-max 200bb | 2,795 (1,129) | 6.65 MB | 1.73 MB | 0.439 (0.485) | 114 min |

    29.8 MB in all (11.8 MB), still one lazy chunk per set; ~1 h 55 min
    wall, five sets at a time on a shared 10-core Mac (9-max: 1.5-2.5 GB
    each). Deterministic: a rerun of the 6-max 40bb set writes the same
    bytes.
  - **What they say** (`docs/CHARTS.md` §8.3, all tested per set): isolation
    widens with position and against a later limper (6-max 100bb: HJ, CO,
    button 13.3 / 15.4 / 18.8% against an UTG limp, the button 28.9%
    against a cutoff limp; 9-max 7.4% from UTG+1 to 11.3% on the button);
    AA and KK isolate at every node facing limpers, 72o folds; the button
    over-limps an early limp 10-16%, the small blind completes behind
    58-72%; the big blind checks behind 89-97%; the limper facing an
    isolation folds about half, calls and re-raises a quarter each. The
    equilibrium limps 0.4-0.7% from every non-blind seat (the tremble plus
    traps: AA 3.9% UTG, at the same EV as opening).
  - **Straddles stay refused**, by cost: 52 decisions (1.0%), 4-6 handed at
    100-120bb; one 6-max 100bb UTG-straddle set would grade ~45 for a third
    tree shape (a third blind, the straddler's option, the lookup's straddle
    seat) to build and keep.
  - **Coverage, owner's library** (5,388 hero preflop decisions, a Node run
    of `analyzeHand` over the exported stored hands, `npm run
    charts:library`): **3,817 -> 4,687 graded (70.8% -> 87.0%)**. Refused
    now: table size 210, rare line 165, off-tree 118, stack depth 106,
    straddle 52, cold call 27, multiway 20, action not modelled 3; open limp
    **0** (933). Of the 1,000 decisions behind an open limp 871 are graded
    (Perfect 763, Good 15, Inaccurate 49, Mistake 33, Blunder 11); off-tree
    47 are mostly WePlay players posting a dead big blind (their check in
    turn has no seat in any tree). Preflop grades: Perfect 89.9%, Good
    0.4%, Inaccurate 4.1%, Mistake 3.9%, Blunder 1.7%; 224.4 bb lost
    (182.8). Rivers on a placeholder range: 42%, unchanged (the limper keeps
    the placeholder).
  - **Every consumer on every set.**
    - *Reports (A3)*: `buildReports` reads every set the player has
      decisions on, each node against its own set; the familiar stats pool
      the sets' nodes, each node's reference weighted by the player's
      decisions there (`statReport` takes a list of sets), and split by
      seat **and table** (a 9-max UTG is not a 6-max one). A set filter
      ("All N tables and depths" by default, or one) and the set on each
      node's row and its chart link. New stat **isolation raise** (`iso`);
      limped pots stay out of the raised-pot stats (an isolation is not an
      open), as in the stats engine. Tests: pooled references are the
      decision-weighted sums, 6- and 9-max UTG stay apart, unloaded sets
      count as unmatched.
    - *Leaks (A6)*: migration `20270303090000_analysis_leaks_sets.sql`
      replaces `analysis_leaks` (same signature and grants, invoker) so a
      row is one finest spot **on one chart set**, with `set`; a full-ring
      spot's ids end in `~9max` (6-max and postflop ids unchanged), and
      its name says "(9-max)"; facing limpers the villain is the first
      limper ("BTN vs UTG limp"). pgTAP: 53 assertions (3 new).
    - *Study plan (A8b)*: a focus area's trainer target carries the set its
      leaks were graded on most (`areaSet`; the reference
      `preflop/rfi/UTG+1/nlhe-cash-9max-150bb`), 9-max seats are valid,
      and facing limpers maps to the new trainer family.
    - *Trainer (A7)*: family **facing limpers** (`vs-limp`), dealt from
      nodes reached at least 1e-4 (limped pots live on the tremble); the
      table selector already took every set.
    - Chart browser: a "Limped pots" category (nodes reached 1e-4 and more);
      options read "Limp" and the explanations "limp" for a call of one big
      blind; the best alternative among equal-EV options is the most
      played one (AA's limp-trap is worth exactly its open).
  - **Checked** in the browser on the worktree's dev server, offline: the
    chart browser's limped pots and the trainer's "Facing limpers" spot,
    graded with the `limp-tremble` note. Reports, Leaks and the plan
    against stored rows need a signed-in account and were checked by the
    tests and the build only.
  - **Open.**
    - At 200bb (6- and 9-max) the big blind facing a single limp is left
      out as unconverged (its mix gives up 2.2-2.8% of the pot for one
      class after 3,000 iterations): `rare-line` there. More iterations for
      the 200bb sets would likely bring it in.
    - The reference's limper holds any hand: isolating is graded against a
      limper who folds to it about half the time. A population limp range
      is an exploitative input the charts do not take; the flop library
      (A5b) will not change this.
    - The 9-max chunks are 1.6-1.8 MB gzip (0.6 before); a 9-handed hand
      costs one such download. Most of a set's bytes are deep limped-pot
      nodes; a coarser `minLimpReach` or 8-bit EVs would halve it.
    - Players posting a dead big blind (WePlay) are off every tree (~35
      decisions).
    - **A5b's pilot chunks** were solved from `charts/3`'s 6-max 100bb
      ranges; their hash guard now answers `charts-differ` for them (the
      library is behind its flag, so no grade changes), and the two pilot
      tests that grade from them skip until the pilot is re-solved on
      `charts/4` (`npm run floplib`). The flop library's lines are raised
      pots, so the re-solve changes their ranges by the tremble only.
    - The in-browser rebuild to `analysis/6` of the owner's library is
      still to run; the numbers above are from the Node run.
- 2026-10-03 — A9 shipped: multiway postflop analysis, `analysis/7` (after
  A2d's `analysis/6`).
  - **No multiway solver, so three honest tiers** (`lib/analysis/multiway.ts`):
    1. **Facts and flags, always.** Every player who saw the flop is walked
       through the hand: each range narrowed by its own actions with the
       same `NarrowingModel`. With three or more live the heuristic reads
       the field — a combo's strength is the product of its heads-up
       strengths against each other range (opponents independent; card
       removal between two opponents' ranges ignored in the narrowing,
       exact in the equities), value bets scale by 0.8 and bluffs-and-draws
       by 0.5 per player beyond two, and a caller defends the **MDF split**
       `1 − α^(1/k)` of its range (`k` defenders, `α = x / (1 + x)`). With
       two left it is the heads-up input exactly, so every heads-up grade is
       unchanged. `facts.multiway`: equity against each opponent's narrowed
       range and against the field (`equityVsRanges`, new in `lib/equity`:
       exact over compatible tuples, else seeded sampling that rejects
       whole tuples), players still to act after the hero, the MDF split,
       the fold equity of a bet (each opponent's heads-up fold rate by the
       model, and their product against the α the bet needs), the next
       card's nut and non-nut outs, reverse implied odds. Flags, notes
       unless said: `multiway-bluff` (Inaccurate only on the river with
       under 5% against the field and under half the folds needed),
       `multiway-slowplay` (a strong hand checked or two pair+ flatted on
       a board with volatility ≥ 25%, not when checking to the preflop
       raiser), `multiway-dominated-draw` (calling off a non-nut draw with
       less equity than the price). The §3.6 flags now run multiway too,
       their equity against the field.
    2. **An approximate river grade** (`source: "approx"`,
       `multiway-approx`): a river call or fold facing a bet in a pot that
       was multiway. On the river the showdown is exact given the ranges:
       call EV = Σ over the ways the players still to answer can respond
       (each calls with the model's call likelihood, independently; nobody
       re-raises; at most three of them) of P × (share × raked pot − call).
       Fold = 0. The better one at 100% (a best response, not a mix), §2's
       thresholds, capped at Mistake (`range-cap`) unless the move loses to
       anything, the half-strength sensitivity check (`range-sensitive`).
       Raising is not compared, and the sheet says so. Side pots, crowds
       (4+ to answer) and unwalkable ranges are refused by name
       (`multiway-side-pot`, `-crowded`, `-range-unknown`).
    3. **Heads-up reducible** (`multiway-history`): a turn or river that
       *began* heads-up after a multiway flop is solved by the existing
       turn and river solvers from the multiway walk's ranges
       (`headsUpWalk`); the river still narrows through the solved turn.
       A street that became heads-up mid-street keeps `turn-` /
       `river-multiway-flop` ("began multiway").
    Everything else multiway (flop and turn decisions, river bets and
    checks) is `not-analysed / multiway` with its facts and flags.
  - **Scenarios** of multiway decisions read `caller-mw-oop-vs-bet` ("ip"
    = last to act among the players in): Reports' heads-up role table
    leaves them out by its regex, Leaks label them "multiway", and the
    study plan gives a multiway river area no (heads-up) trainer session.
    Heads-up-reducible decisions keep heads-up scenarios and count in the
    role table: they are heads-up at the node.
  - **Learn**: "Multiway pots" (betting group), with a calculator for the
    MDF split and fold-equity multiplication (`learn/math.ts`: `allFold`,
    `mdfSplit`, `multiwayBluffEv`; the example's numbers tested).
  - **Migration** `20270310090000_analysis_multiway.sql`: the
    `decision_analysis.source` check names `approx`, and
    `analysis_public_facts` keeps `multiway` (pgTAP, 9 assertions).
  - **Owner's library** (5,448 hands, Node, the same `analyzeHand` the
    worker runs, all eight chart sets):
    - multiway facts on 677 decisions (670 with three or more players at
      the decision: flop 393, turn 198, river 79);
    - **river graded 308 → 394 of 467** (66% → 84%): 63 heads-up-reducible
      solver grades (`river-multiway-flop` 71 → 1) and 23 approximate
      grades (23 of the 24 river calls and folds facing a bet multiway;
      one side pot). Still not analysed on the river: 58 multiway bets and
      checks, 3 raises;
    - **turn: 47 of the 73 heads-up turns after a multiway flop are now
      solved**; 25 began multiway and became heads-up mid-street, 1 is
      unreached;
    - approximate grades: Perfect 21, Mistake 2 (one capped from Blunder),
      2 range-sensitive; 6.0 bb EV loss. `multiway-history` grades: river
      Perfect 41, Good 15, Inaccurate 1, Mistake 6; turn Perfect 35, Good
      5, Inaccurate 2, Mistake 5;
    - flags: slowplay 27 (flop 16, turn 11), bluff into a crowd 10 (one
      Inaccurate), dominated draw 0;
    - hands not analysed 1,542 → 1,522 (they now have a graded decision);
    - cost: the whole library without turn solves 37.6 s → 56.2 s; the
      1,282 hands three or more saw the flop of, turns solved, 89 s.
  - **Verified** in the browser on a fresh local account (378 copied hands,
    the multiway ones and 60 more): the in-browser rebuild stores
    `analysis/7` rows with `source = 'approx'`; the sheet shows the
    "(approximate)" grade, the ≈ chip, the options note, the multiway fact
    rows and *why* in EN and HR, light and dark, at 375 px; the overview's
    coverage and flag rows link "Multiway pots"; the Learn page's
    calculator works.
  - **Open.**
    - Rests on the heuristic narrowing: a river raise range is polar by the
      model (14% value), so folding two pair to a raise can read as a
      Mistake; the cap and sensitivity check limit the damage, as on the
      heads-up river.
    - Multiway river bets and checks have no grade: a bet's EV needs every
      opponent's response tree, which the call/fold model does not give.
    - The chart ranges of multiway preflop callers are thin (`charts/2`'s
      flats), so some opponents' ranges are a few combos.
    - With A5b's flop library (rebased onto it), the multiway walk still
      narrows a multiway flop by the heuristic: the library is heads-up. The
      walk passes `actionIndex` like the heads-up one.
- 2026-10-06 — L1 shipped: the Learn tab (`docs/LEARN-PLAN.md`). No grade
  changes, so still `analysis/7`.
  - **A top-level course at `/learn`**, for everyone: tracks → modules → 62
    lessons with the learner's status, "coming soon" for the unwritten ones,
    and badges from the leak finder ("you lose X bb / 100 here"). "Learn" is
    the last main tab (three tabs signed out, six with a library; the strip
    already scrolled at 375px). The concept library stays at `/analysis/learn`
    and is "Concepts" in this tab's sub-nav.
  - **The catalogue** (`lib/learn/course.ts`): a closed `LessonId` union like
    `ConceptId`, with prerequisites, concepts, exercises and the spots and
    flags each lesson teaches. 25 lessons written in English and Croatian (M0–M3
    and M6-L4, the owner's request); every computed number recomputed by
    `tests/test/course.test.ts`, the two languages held to one structure.
  - **Practice graded by this plan's engine**: chart quizzes and river spots
    through `analyzeHand` (the A7 trainer), new **turn spots**
    (`lib/training/turn.ts`, graded with the turn solve on: a trainer turn
    grade is the analysis' turn grade, tested), a `facing` filter (the
    in-position hero facing a check or a bet), calc items answered before the
    concept library's calculator reveals them, classify items read by
    `texture.ts` and the hand classes, and the learner's own decisions,
    spoiler-safe through `gradeDrill`.
  - **Smart features**: a lesson per focus area in the study plan (task kind
    `lesson`, counted done when the lesson is passed); missed items as review
    cards on the drills' SM-2 (`drill_next`); lessons passed automatically.
  - **Migration** `20270317090000_learn_progress.sql`: `lesson_progress`,
    `lesson_cards`, three definer writers, the `lesson` task in
    `save_study_plan` / `study_plan`, `learn` reserved; pgTAP 50 assertions.
    Signed out, the same model lives in the browser's storage.
  - **Open**: the flop parts wait for the flop library (on since `analysis/8`); `range-split` and
    `range-paint` are typed placeholders (L2, L3); the turn tree has one bet
    size, so M6-L4's turn drill is check / 75% / all-in.
- 2026-10-08 — A5b on: the full flop library graded in the analysis,
  `analysis/8`.
  - **The run.** All 12 lines × 100 representative flops of the 6-max 100bb
    set (`charts/4`, hash `ecad38d0`) solved on the owner's M2 Pro in the
    evening and weekend windows (2026-10-03 → 10-07, ~281 core-hours):
    1,200 chunks, 86 MB, every solve below 1% of the pot (worst 0.9996%,
    utg-bb Qs6h3d; most stop at the 1% target after 60–120 iterations,
    the SB limp at 120–200). `--validate` had nothing to compare (only
    representatives solved); 24 mapped flops on four lines (btn-bb, co-bb,
    sb-bb, btn-bb-3bet) are being solved outside the library for it, and
    their numbers follow in this entry.
  - **Hosting.** Migration `20270331090000_flop_library_bucket.sql`: a
    public Storage bucket `flop-library` (1 MB, octet-stream/json only) with
    **no** storage.objects policy, so clients can neither list nor write
    (pgTAP; on prod anon writes are refused by RLS, a list returns nothing).
    `tests/scripts/flop-library/upload.sh` uploads a run from the owner's
    machine with the service-role key fetched from the Management API into
    the script's process only. The worker reads
    `<NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/public/flop-library`
    (`flopLibraryBase`, outside the pure lib layer's config rule);
    without a Supabase URL the flop stays heuristic.
  - **Pilot** regenerated on `charts/4` from ten of the run's chunks; its
    two grading tests run again.
  - **Measured on the owner's library** (`npm run floplib:measure`, 5,448
    stored hands, the worker's `analyzeHand` and loader in Node):
    - Flop: 118 of 1,095 hero flop decisions (10.8%) now graded from the
      library — 108 mapped, 10 exact; Perfect 96, Good 16, Inaccurate 3,
      Mistake 3; 5.7 bb of EV loss found where the heuristic graded nothing.
    - Why so few: of the hands with a hero flop decision, 6-max heads-up at
      80–120bb are ~131; 9-max heads-up at 100bb are 183 more (backlog: the
      9-max lines), multiway flops ~450 (the library is heads-up) and
      other depths ~230.
    - Turn and river (first 600 hands, turn solving on): the flop narrowing
      moves 3 of 81 turn grades (EV loss 9.4 → 7.7 bb) and 1 of 55 river
      grades.
  - `ANALYSIS_VERSION` `analysis/8`: flop grades and the ranges the turn
    and river start from change. No table migration.
  - **Open.** 9-max 100bb lines (most of the owner's hands); mapped flops
    read by coarse categories (the A5b pilot's 55–81% check/call grade
    agreement); multiway flops stay heuristic; the Learn flop drills (L2)
    can now be graded.
- 2026-10-08 — A5b, full-ring lines: the flop library's 9-max lines (the
  runner and the reader); no chunks yet, so no grade changes: still
  `analysis/8`.
  - **Why.** Measured on the owner's library (heads-up flops with a hero
    flop decision, by the set and line `chartLineOf` places them on): the
    9-max sets answer 7–9-handed hands; their placed heads-up lines are few
    (btn-bb, co-bb, hj-bb, lj-bb, sb-bb, sb-limp a handful each, ~25 hands)
    next to the 6-max sets (which also answer 8-max tables with six or fewer
    dealt in). The bigger losses are elsewhere and listed below.
  - **Lines.** `FLOP_LINES_9MAX`: the twelve 6-max pots spelled over nine
    seats plus lojack vs big blind (13 lines × 100 flops = 1,300 solves);
    `flopLinesFor(players)` picks a set's lines, `lineSeats` / `flopPlayersOf
    (key, seats)` read a full-ring key, and `chunkFor` matches a hand's line
    against its own set's table. A button open-limp has no chart range (the
    charts' open limper is the tremble), so it is not solved. The runner
    takes `--set nlhe-cash-9max-100bb` and defaults to that set's lines.
  - **Compute.** The nightly runner (`~/Projects/rail-floplib-out/bin/start.sh`)
    now runs the 9-max set; when its 1,300 chunks are done they go to the
    same bucket with `upload.sh … nlhe-cash-9max-100bb` and the version
    bumps then.
  - **Open (what keeps heads-up flops off the library).** Of ~620 heads-up
    flops with a hero decision, 237 have no chart line: heads-up tables
    (`players`, 52), stacks outside every set (`stack-depth`, ~60), straddles,
    and **~45 where the two flop players' own lookups pick different depth
    sets** (each by its own effective stack, e.g. 6-max 100bb vs 150bb):
    picking the set by the pair's effective stack would place them. The 6-max
    150bb / 60bb / 200bb sets reach ~45 more heads-up flops on library lines
    with no chunks.
- 2026-10-08 — Learn L2: the flop track, graded from the flop library
  (`docs/LEARN-PLAN.md` §8). No grade changes: still `analysis/8`.
  - **Flop drills on the library**: `lib/training/flop.ts` deals a spot on a
    library line and flop (exact, suits relabelled), graded by `analyzeHand`
    with the same chunk; `lib/training/split.ts` reads a solved node by
    `flopBucket` (or a turn solve by `turnCategory`) for the Learn range
    split. The trainer worker fetches the one chunk a job needs.
  - **Loader**: `FlopLibraryLoader.ready` shares an in-flight manifest fetch
    (concurrent callers used to read a half-loaded manifest as empty).
    Additive, `load(set, line, flop)` fetches a chunk by name.
  - **Found, not fixed**: `chartLineOf` places a button–small-blind pot as
    `fffrc`, but `FLOP_LINES` keys it `fffrcf`, so real `btn-sb` hands never
    read their chunks (heuristic flop). Fixing it changes grades (a version
    bump); the Learn drills skip that line meanwhile.
- 2026-10-08 — A5b, reading fixes and the full library's validation,
  `analysis/9`.
  - **Button–small-blind pots read their chunks.** A hand's placed line ends
    at the later flop player's decision (`fffrc`); the library spells the
    big blind's fold too (`fffrcf`). `sameLine` compares them without
    trailing folds; the Learn drills deal `btn-sb` again.
  - **Mixed-depth placements.** When the two flop players' own lookups land
    on sets of different depths (each judged against its deepest opponent
    at the time), `chartLineOf` now places both on the set nearest the
    pair's effective stack instead of giving up. On the owner's library this
    places most of the ~45 such hands, mostly on the 6-max 150bb set (no
    chunks yet), so it barely moves grades today.
  - **Measured** (same run as above): 121 of 1,095 hero flop decisions now
    graded from the library (was 118); Perfect 97, Good 18, Inaccurate 3,
    Mistake 3.
  - **`--validate` on the full library.** 24 mapped flops solved on their
    own (btn-bb, co-bb, sb-bb, btn-bb-3bet × Jd9c4h, Ah7c2d, Kc8d8h, 6c5d4h,
    QhJd3c, Tc9c2d), compared with reading them from their representative
    by hand category. Medians (range):
    - strategy distance (TV) 16.4% (10–27%); the floor of reading by
      category on the flop's own solve is 12.9%;
    - |ΔEV| per action 6.5% of the pot (3–14%); floor 3.9%;
    - same top action 84% (70–93%);
    - same check/call grade 69% (48–76%), as the pilot's 55–81%.

    The worst pairs are the farthest mappings: a low connected flop read
    from another (6-5-4 → 7-5-3: TV 25–26%, ΔEV 11–14% of the pot) and a
    paired board from a lower pair (K-8-8 → K-6-6 on sb-bb). Category
    reading itself costs about two thirds of the error; finer buckets
    (backlog) and more representatives where the mapping distance is 3+
    are the two levers.
- 2026-10-08 — Learn L3: the turn and river tracks (`docs/LEARN-PLAN.md`
  §10). No grade changes: still `analysis/9`; no migration.
  - **Training, additive**: `riverSetup` (the river spot's first half, the
    same draws from the seed, so a river spot is unchanged), the river range
    split (`riverCategory`, an overbet group above the pot), a turn flop-line
    filter (`TurnSpotOptions.flop`), and `lib/training/paint.ts` (a chart's
    first-in range or a river node per hand class, graded cell by cell), a
    `paint` job in the trainer worker.
  - **Mastery** reads `analysis_leaks` twice (`to` / `from` the day a lesson
    was passed) and compares the mean move score with the leak finder's own
    `meanZ`; nothing stored.
  - **Direction check** (`npm run learn:directions`): the lessons' claims
    read from the trainer's turn and river solves by hand category before
    they were written.
- 2026-10-08 — Learn L4: the exploits track and the exploit lab
  (`docs/LEARN-PLAN.md` §12). No grade changes: still `analysis/9`; no
  migration.
  - **Solver, additive**: `Solver.value(p)`, `Solver.bestResponse(p, keep)`
    (the best-response walk that exploitability already ran, now able to
    record the response per node with each action's EV; `keep` leaves a
    hand within that many chips of its best action on its average mix),
    `averageSnapshot` / `restoreAverage`; `lib/solver/lock.ts`:
    `lockedStrategy` (a group of actions' share at a node set to a number,
    hands moving in a stated order), `loadResult` (a full result's
    strategies into a fresh solver of the same game), `ownReach`, and
    `exploitLab` (lock one player, best-respond, and measure the gain over
    the equilibrium against the lock, the cost against the equilibrium
    opponent, the cost against the opponent's own best response, and the
    equilibrium's cost against its counter). Verified on the clairvoyance
    game at its closed-form equilibrium, by hand (`learnLab.test.ts`).
  - **River, refactor only**: `riverSpotOf(input)` is the exact game
    `solveRiverSpot` solves (pruned ranges, menu, rake), so the lab rebuilds
    it from a solve's input; `RIVER_SOLVE_OPTIONS`. The river solve and its
    grades are unchanged.
  - **Training**: `lib/training/lab.ts` (a river spot with the hero in
    position, one of three locks — folds to a river bet shifted from the
    solve at every size, never raises, bets a share of its air first to act
    — the best response, the decisions it changes by `riverCategory`, and a
    question graded by the response's own EVs), a `lab` job in the trainer
    worker, about 0.2 s per item. `npm run learn:lab` from `tests/` is the
    direction check the exploit lessons were written from.
- 2026-10-08 — Learn L5: the extras (`docs/LEARN-PLAN.md` §14). No grade
  changes: still `analysis/9`; no migration.
  - **Reads only**: example hands pick from `analysis_leak_hands` (the
    costliest mistake, and a clean Perfect from the recent decisions with
    `deviations` off) and re-check nudges read `analysis_leaks` before and
    after the day a lesson was settled (at most six day/pot-type groups),
    both invoker under RLS.
  - **Training, additive**: none. The placement test, capstones and the
    daily dose deal the lessons' existing card specs; `pot-tracking` counts
    its answer with `scriptMoney`, and `profile-read` uses the pool
    section's `foldRead`.
- 2026-10-08 — A2e, the straddle chart set (`charts/5`), `analysis/10`
  (`docs/CHARTS.md` §1.4, §6.8). Reopens A2d's "straddles stay refused, by
  cost" for the one shape that holds most of them. No migration.
  - **A third blind in the tree** (`PreflopTreeConfig.straddle`): a 2bb
    straddle from the first seat left of the big blind, not a raise; the
    action starts at the HJ and the straddler has the option last; both
    blinds may complete or raise first in. The tree's players, and the set's
    `game.positions`, are in action order (`HJ, CO, BTN, SB, BB, UTG`), so
    every line walker reads the set with its own seats. Trees without a
    straddle are byte-identical (node arrays hashed against `main`).
  - **`nlhe-cash-6max-100bb-straddle`**: sizes against 2bb (open 5bb, a
    blind's raise first in 6bb, isolation 8bb), the limp tree and its
    tremble, the realisation measured on its own fifteen spots in two rounds
    from `charts/2`'s fit (fit error 0.032-0.034 per pot type, against
    0.050-0.053 for `charts/1`'s model). 854 nodes of a 4,906-node tree,
    2.0 MB (539 KB gzip). NashConv **0.166 mbb/hand** at 3,000 iterations;
    43 min on four threads next to the flop-library batch. HJ / CO / BTN
    open 18.7 / 23.2 / 31.2%; the straddler defends 45 / 55 / 67% against
    HJ / CO / BTN opens, the big blind in front of it 13-17%.
  - **Lookup**: `pickChartSet` reads a straddled spot only on a straddle
    set and an unstraddled one never on it; the straddle set answers one
    straddle, its size, from the seat left of the big blind, 4-6 handed,
    within 100bb ±20% (`straddleMismatch`). Everything else stays
    `chart-straddle`, with a detail naming what it was.
  - **Consumers**: preflop grades and chart ranges (`chartRange`, so the
    range walk, the turn and river solves and the multiway narrowing) come
    from the straddle set; the money was already the hand's own (the walk
    counts the straddle post as live money: pot 3.5bb before the first
    decision). A straddle the charts model no longer carries the hand-level
    `straddle` approximation. The trainer deals the set (`HandScript.straddle`
    posts it), the chart browser and Reports list it, and the Learn
    `straddle-preflop` paint is real (no longer planned).
  - **Measured on the owner's library** (`npm run charts:library`, the same
    export at `analysis/9` and `analysis/10`): of 52 straddled decisions,
    **41 graded** (Perfect 36, Inaccurate 2, Mistake 3) and 11 still
    `chart-straddle` (10 outside 80-120bb, one straddle from another seat);
    preflop graded 4,687 -> 4,728 (87.0% -> 87.8%), every other count the
    same; solver-graded rivers on a placeholder range 172 -> 166 of 370.
  - **Open**: other straddle shapes (button, re-straddle, other depths or
    tables) need their own sets; straddled leaks group with unstraddled
    6-max ones in the leak finder (no `table` tag yet), and the study plan
    sends them to the 6-max 100bb trainer; the flop library has no straddled
    lines.
- 2026-10-09 — The 200bb limp nodes converge: `charts/6`, `analysis/11`
  (`docs/CHARTS.md` §5.1). Closes A2d's open item "at 200bb the big blind
  facing a single limp is left out as unconverged". No migration.
  - **Diagnosis.** Measured on the 6-max 200bb solve, checkpoint by
    checkpoint (the 3,000-iteration state reproduces the committed set
    exactly), and on the 9-max 200bb solve to 1,000 iterations. The node is
    reached only through the 0.5% limp tremble; the big blind's regrets
    there are weighted by the limper's reach, which is about a third in the
    first iterations and the tremble's 0.5% later - each iteration's regret
    shrinks ~60x, and DCFR's positive-regret discount (`t^1.5/(t^1.5+1)`)
    never forgets the early ones. At 3,000 iterations the big blind with
    AQo behind a cutoff limp still carried regret +0.24 (check) and +0.20
    (isolate) while isolating was worth 0.105bb more and each iteration
    moved the check's regret by -3e-5: a 55/45 mix, 2.55% of the pot lost.
    Not the DCFR parameters, the tremble's size, a degenerate class or the
    tree: the worst class falls steadily with iterations (6-max: BB vs CO
    limp 2.55% at 3,000, 1.89% at 4,000, 1.18% at 6,000, 0.76% at 9,000).
  - **Fix.** The two 200bb sets are solved for 9,000 iterations
    (`SetConfig.iterations`, `sets.ts`; the generator reads it, and
    `CHARTS_ITERATIONS` still overrides). Same fit, tree, tremble and
    engine. Every other set's configuration is identical to `main`'s and
    its bytes too (regenerated and compared: 6-max 40, 60, 100 and 150bb;
    `model.hash` of 6-max 100bb `ecad38d0` and 9-max 100bb `204ec7be`
    unchanged, so the flop library's chunks still match). A change to the
    engine (forgetting stale regrets, or starting the trembling nodes at
    the tremble) would have moved every set, the flop library's two among
    them.
  - **Results.** Measured on the 6-max 200bb solve, checkpoint by checkpoint, the
    three big-blind nodes cross the 2% bar at ~4,000-4,500 iterations and
    sit at 0.8-1.0% at 9,000; 9,000 is that with a 2x margin (9-max
    converges more slowly).

    | Set | Nodes (charts/4) | Left out as unconverged | NashConv mbb/hand | Bytes | Solve |
    |---|---|---|---|---|---|
    | 6-max 200bb | 829 (815) | 2 (19) | 0.182 (0.332) | 2.03 MB, 538 KB gzip | 45 min |
    | 9-max 200bb | 2,841 (2,795) | 7 (61) | 0.247 (0.439) | 6.77 MB, 1.73 MB gzip | 6 h 04 min |

    The big blind facing a single limp is in both sets from every seat
    (6-max: check 92.3% behind a cutoff limp; 9-max 91.9%), and the 9-max
    `rc` and `rrr` nodes (3e-4 and 1e-4 of hands) are back. Every other
    node left out is reached under 1e-5, except the 6-max small blind
    behind two limps (`fcfc`, reached 3e-4: KK re-raises where calling
    is worth 0.1bb more at the final averages - not the stale-regret
    pattern; 2.6% of the pot, 3.5% at `charts/4`). Widths move by at most 0.3 points
    outside limped pots, up to 2.6 inside them. Each solve ran alone in its
    own process beside the flop-library batch's four solves (9-max at times
    thermally throttled).
  - **Measured on the owner's library** (`npm run charts:library`, the same
    export as A2e, now with a per-decision dump to compare two runs and the
    rare-line refusals by set, seat and shape): the
    library has **no** hero decision as the big blind facing a single limp
    at 200bb, so **no `rare-line` refusal becomes graded** (165 -> 166:
    none of the 165 was such a node; 7 were on the 9-max 200bb set, the
    rest at 100-150bb). Five of the 295 decisions graded on the 200bb sets
    change: grades Good -> Perfect (6-max), Good -> Perfect, Good ->
    Inaccurate, Mistake -> Inaccurate (9-max), and one 9-max decision
    becomes `rare-line` (`ffffcffrcr`, reached exactly 1e-6 at `charts/4`,
    just under the cut now). Graded 4,728 -> 4,727 (87.7%); Perfect 4,250,
    Good 17, Inaccurate 194, Mistake 185, Blunder 81; 225.1 bb lost
    (225.2). Rivers on a placeholder range 166 of 370, unchanged.
  - `CHARTS_VERSION` `charts/6` (the two sets carry it; the other seven keep
    theirs), `ANALYSIS_VERSION` `analysis/11`: grades read from the 200bb
    sets change.
  - **Open.** The fix is bought with iterations: the 9-max 200bb set now
    takes ~6 hours to regenerate. A solver change that rescales or forgets
    the early regrets of trembling lines would converge every set's limp
    nodes in far fewer iterations, but regenerates every set (and the flop
    library keyed to the 100bb hashes). The 9-max 150bb set still leaves
    the big blind behind an HJ limp out (and 46 other rare nodes); the same
    9,000 iterations would likely bring it in, ~6 hours. The 6-max 200bb small
    blind behind two limps (`fcfc`) stays out. The rare-line refusals that
    matter in the owner's library are 100bb lines below the 1e-5 reach cut,
    not unconverged nodes.
- 2026-10-09 — A5b, finer categories for mapped flops, `analysis/12`. No
  migration. Closes the backlog item of the 2026-10-08 validation ("finer
  buckets").
  - **What changed.** A mapped flop (and a hero combo an exact chunk does
    not hold) reads its representative by a finer category,
    `flopReadingBucket` = made × draw. Every split is rank-relative to the
    board and suit-blind:
    - made: the nut straight apart from a lower one; a set by the board
      card it pairs (top, middle, bottom); trips by kicker; two pair by
      which two (top two, top and bottom, bottom two); a pocket pair
      between the top two board ranks apart from a second pair, which
      splits by kicker; third pair apart from an underpair; unpaired hands
      by their overcards to the board (0-2) and whether a hole card is
      under the bottom board rank;
    - draw: the flush part (nut or other flush draw, else a backdoor flush,
      nut or not) and the straight part (open-ended, gutshot, backdoor)
      apart, so a combo draw keeps both and a backdoor no longer pools with
      no draw.

    A combo reads the finest category with enough reach at the node
    (`MIN_BUCKET_COMBOS`, unchanged at 0.5 combos), falling back through
    `readingChain`: fine made × fine draw, fine made × coarse draw, the
    coarse `flopBucket`, fine made alone, coarse made alone, everything.
    `flopBucket` itself is unchanged, so the Learn range split
    (`training/split.ts`) and its tests still teach the coarse categories.
    The stored `facts.flop.bucket` is now the fine category.
  - **Validation** (`npm run floplib -- --validate`, which now prints both
    readings, the own-category floor for every metric, and the medians).
    The 24 mapped pairs of 2026-10-08, medians, coarse → fine:
    - strategy distance (TV) 16.5% → 12.8% (floor 12.9% → 8.1%);
    - |ΔEV| per action 6.50% → 5.37% of the pot (floor 3.89% → 1.70%);
    - same top action 84.2% → 87.9% (floor 87.4% → 93.0%);
    - **same check/call grade 69.0% → 75.5%** (range 47.5–75.7% →
      49.5–86.6%; floor 75.8% → 84.2%).

    | Line | Flop → rep | TV | \|ΔEV\| % pot | Same top action | Same check/call grade |
    |---|---|---|---|---|---|
    | btn-bb-3bet | 6s5h4d → 7s5h3d | 23.0 → 23.0 | 12.6 → 12.4 | 73.8 → 72.4 | 55.4 → 57.4 |
    | btn-bb-3bet | As7h2d → As6h3d | 13.3 → 10.9 | 5.2 → 4.3 | 92.2 → 93.9 | 72.0 → 79.2 |
    | btn-bb-3bet | Js9h4d → Js9h3d | 17.0 → 9.9 | 6.0 → 3.9 | 79.8 → 88.0 | 70.3 → 75.8 |
    | btn-bb-3bet | Ks8d8h → Ks6d6h | 11.7 → 11.4 | 6.2 → 6.1 | 93.4 → 93.2 | 69.8 → 71.5 |
    | btn-bb-3bet | QsJh3d → QsTh4d | 15.1 → 12.1 | 9.8 → 8.1 | 86.3 → 87.7 | 74.2 → 78.4 |
    | btn-bb-3bet | Ts9s2h → Ts7s4h | 26.8 → 23.3 | 9.0 → 7.8 | 71.6 → 76.8 | 53.1 → 60.8 |
    | btn-bb | 6s5h4d → 7s5h3d | 25.4 → 24.7 | 10.8 → 11.3 | 74.1 → 74.4 | 68.1 → 70.4 |
    | btn-bb | As7h2d → As6h3d | 13.7 → 9.8 | 3.8 → 2.6 | 84.6 → 88.8 | 75.7 → 80.3 |
    | btn-bb | Js9h4d → Js9h3d | 12.6 → 5.9 | 4.1 → 2.2 | 84.9 → 91.7 | 72.7 → 86.6 |
    | btn-bb | Ks8d8h → Ks6d6h | 16.0 → 13.3 | 3.1 → 2.9 | 84.4 → 87.0 | 65.6 → 71.0 |
    | btn-bb | QsJh3d → QsTh4d | 10.2 → 5.5 | 4.6 → 3.0 | 90.9 → 94.3 | 72.3 → 84.3 |
    | btn-bb | Ts9s2h → Ts7s4h | 17.7 → 13.7 | 7.6 → 6.5 | 84.1 → 85.4 | 63.9 → 76.9 |
    | co-bb | 6s5h4d → 7s5h3d | 25.8 → 24.9 | 10.6 → 10.7 | 72.9 → 73.7 | 69.2 → 71.9 |
    | co-bb | As7h2d → As6h3d | 15.6 → 11.0 | 4.6 → 3.3 | 85.9 → 91.4 | 68.8 → 75.3 |
    | co-bb | Js9h4d → Js9h3d | 14.4 → 7.1 | 6.5 → 4.8 | 83.0 → 90.8 | 65.4 → 78.5 |
    | co-bb | Ks8d8h → Ks6d6h | 16.2 → 13.0 | 4.1 → 3.9 | 87.5 → 90.3 | 71.4 → 75.3 |
    | co-bb | QsJh3d → QsTh4d | 13.8 → 10.2 | 6.5 → 5.4 | 80.3 → 85.2 | 70.6 → 79.3 |
    | co-bb | Ts9s2h → Ts7s4h | 18.8 → 16.1 | 7.4 → 6.3 | 83.8 → 84.6 | 65.5 → 76.4 |
    | sb-bb | 6s5h4d → 7s5h3d | 26.2 → 25.1 | 13.9 → 14.4 | 71.3 → 74.1 | 47.5 → 49.5 |
    | sb-bb | As7h2d → As6h3d | 15.9 → 12.9 | 7.1 → 6.2 | 87.3 → 90.1 | 64.5 → 69.0 |
    | sb-bb | Js9h4d → Js9h3d | 18.2 → 10.7 | 5.4 → 2.7 | 85.5 → 90.6 | 75.7 → 85.4 |
    | sb-bb | Ks8d8h → Ks6d6h | 24.7 → 24.1 | 5.1 → 5.2 | 69.5 → 70.2 | 54.6 → 52.2 |
    | sb-bb | QsJh3d → QsTh4d | 16.7 → 12.8 | 6.5 → 5.3 | 88.9 → 90.7 | 72.6 → 80.1 |
    | sb-bb | Ts9s2h → Ts7s4h | 25.8 → 20.7 | 8.2 → 6.8 | 74.5 → 73.5 | 60.2 → 74.8 |

    It hurts in a few places, all on the farthest mappings. sb-bb K-8-8 →
    K-6-6 loses 2.4 points of check/call grade (54.6% → 52.2%). |ΔEV| gets
    slightly worse on the three 6-5-4 → 7-5-3 pairs outside the 3-bet pot
    (+0.1 to +0.5% of the pot) and on sb-bb K-8-8 (+0.04). Top action drops
    by 0.2–1.4 points on three pairs. The low connected flops stay the
    worst (TV 23–25%): there the whole range plays differently, which no
    hand category fixes.
  - **Held out.** The 24 pairs informed the choice, so the reading was
    also checked on pairs it was not tuned on (`--validate --loo`): every
    representative of the full 6-max library is read from its nearest
    *other* representative on the line (texture distance ≤ 3.5; 552 pairs,
    46 per line). Medians, coarse → fine: TV 20.7% → 17.5% (floor 13.4% →
    7.1%), |ΔEV| 8.15% → 7.42% of the pot (floor 3.99% → 1.83%), same top
    action 78.3% → 81.7% (floor 86.3% → 92.5%), **same check/call grade
    62.9% → 69.8%** (floor 73.4% → 86.2%). Check/call grade improves by
    more than a point on 452 pairs and worsens by more than a point on 23
    (worst −6.8). By line, the median check/call grade rises 4–15 points
    everywhere except btn-sb, which slips at the median (49.6% → 48.5%;
    8 of its 46 pairs are worse, its median pair gains 2.5 points).
  - **Tried and not shipped** (on the 24, check/call grade against 69.0%).
    Draw splits alone reach 71.8%, made-hand splits alone 70.4%, and both
    together 74.6%. The nut backdoor and undercard splits add the last
    0.9 points. Thresholds: `MIN_BUCKET_COMBOS` at 0-0.25 gains at most
    0.2 points, and at 1-2 it loses at every setting, so it stays at 0.5.
    Bucketing by hand-strength percentile within the preflop range is
    worse than the made-hand categories on its own (71.9%). Inside them it
    adds 0.8-1.3 points on the 24 and 0.7 held out, not worth reading the
    real range's percentiles into the entry.
  - **Measured** on the owner's stored library (`npm run floplib:measure`,
    5,448 hands, 1,095 hero flop decisions; the measure now takes
    `FLOPLIB_DUMP` to compare two runs decision by decision): 127 graded
    from the library either way (117 mapped, 10 exact). 11 grades move,
    all mapped, all weak hands with backdoor or gutshot draws that the
    coarse category had pooled: Perfect → Good 5, Good → Perfect 2,
    Good → Mistake 2, Good → Inaccurate 2. Perfect 100 → 97, Good 20 → 19,
    Inaccurate 3 → 5, Mistake 4 → 6; EV loss 7.9 → 8.8 bb.
  - `ANALYSIS_VERSION` `analysis/12`: grades of mapped flops change.
  - **Open.** What is left is mostly the mapping, not the category: the
    6-5-4 → 7-5-3 pairs and the paired board read from a lower pair keep
    a TV of 23–25%, against a floor of 6–12%. More representatives where
    the mapping distance is 3+ is still the lever. btn-sb does not gain
    from the finer reading (held out), which is worth a look.
- 2026-10-09 — Rare lines read on a neighbouring depth, `analysis/13`
  (`docs/CHARTS.md` §7.1). No migration, no chart regenerated.
  - **Why this issue.** After `charts/6` the largest preflop refusal left
    in the owner's library is `rare-line`: 166 of 5,388 hero preflop
    decisions (`analysis/12`). The other candidates cost more for less:
    more flop-library representatives where the mapping is far (new flop
    solves), multiway flops (a large project), and the 9-max 150bb set at
    9,000 iterations (~6 hours of compute, for a set that holds only 8 of
    the 166).
  - **What the 166 are** (`npm run charts:library`, its rare-line breakdown,
    and a per-decision pass over the same export). Every one is in the tree
    (the replay reaches the node, so none is a missing line): 163 are left
    out by the reach cut (1e-5), 3 as unconverged (6-max 150bb `frcf` twice,
    9-max 100bb `fffffcc`). By set: 9-max 100bb 79, 6-max 100bb 67, 9-max
    150bb 8, 9-max 200bb 8, 6-max 150bb 4. By shape: **126 are an open with
    one or more flat calls from seats other than the blinds before the
    hero** (UTG opens, the cutoff flats, the hero is in the small blind),
    33 a flatted or limped pot re-raised, 6 three or more limpers, 1 other.
    The hero folds 137 of them, raises 15, calls 13, checks 1. At 100bb the
    charts almost never flat an open (3-bet or fold), so what follows a
    flat is reached under 1e-5; 126 of the 166 lines are charted at some
    other depth of the same table, where the flat is common enough.
  - **Options.** (a) Grading the low-reach node with a caveat is not
    possible without a regeneration: the sets store nothing below
    `minReach` (the strategies live in the solver, not the JSON) and carry
    no per-node convergence data beyond `model.excluded.unconverged`, so
    there is nothing converged to grade from. (b) The nearest modelled node
    by **depth** is: a neighbouring set's node passed that set's own rules
    (reach, self-loss under 2% of the pot), and it plays against a real
    flatting range, which is what the hero faces. Mapping by position or by
    dropping the flatter would change the pot and the number of players,
    not just a parameter. (c) Explaining the refusal better stays for what
    is left.
  - **What changed.** `lookupPreflop(..., { rareLineDepth: true })` (the
    grade only): a `rare-line` spot is replayed on the nearest charted
    depth below and above in the same table (`rareLineDepthSets`, nearest
    first by depth ratio, never two steps away); the first that reaches a
    stored node answers, with the new `rare-line-depth` approximation, and
    the grade is capped at Inaccurate. The opponents' chart ranges and the
    flop library's placement do not read across depths. The app loads the
    neighbours a hand needs in a second step (`rareLineChartSets`). The
    `rare-line` detail now says when a node was left out as unconverged
    rather than rare, and the user-facing reason says the line is too rare
    at this depth or the nearest ones.
  - **Measured** (`npm run charts:library`, compared decision by decision
    with `CHARTS_LIBRARY_DUMP`): `rare-line` **166 -> 46**; **119 graded** -
    Perfect 109, Good 1, Inaccurate 9 (7 of them capped: they lose 3-28% of
    the pot at the neighbour) - and one becomes `action-not-modelled`. Read
    at: 6-max 100 -> 150bb 47, 100 -> 60bb 18; 9-max 100 -> 150bb 48, 200
    -> 150bb 4; 6-max 150 -> 200bb 2. Nothing else moves. Graded 4,727 ->
    4,846 (87.7% -> 89.9%): Perfect 4,250 -> 4,359, Good 17 -> 18,
    Inaccurate 194 -> 203, Mistake 185, Blunder 81; 225.1 -> 230.3 bb lost.
    By scenario, squeeze 260 -> 357 and facing a 3-bet 282 -> 301.
  - `ANALYSIS_VERSION` `analysis/13`: stored `chart-rare-line` decisions
    become graded.
  - **Open.** The 46 left are 43 on 9-max sets: lines the 150bb set leaves
    out too, with no shallower 9-max set to read. A 9-max 60bb set, or
    regenerating with a lower reach cut for nodes behind a flat (the
    strategies there would need their own convergence check), are the
    levers; neither is worth it for 46 decisions now.
- 2026-10-10 — The 9-max 150bb limp nodes converge: `charts/7`,
  `analysis/14` (`docs/CHARTS.md` §5.1). Closes `charts/6`'s open item "the
  9-max 150bb set still leaves the big blind behind an HJ limp out". No
  migration.
  - **Diagnosis.** Measured on the 9-max 150bb solve, checkpoint by
    checkpoint, with a diagnostic copy of the generator's loop (its
    3,000-iteration state reproduces the committed `charts/4` set exactly:
    2,888 nodes, the same 47 left out, NashConv 0.270). The same stale
    early regrets as at 200bb: the node is reached only through the 0.5%
    tremble (the HJ limp, 4.8e-4 of hands), its worst class is AQo at every
    checkpoint, and the loss falls steadily with iterations - 3.75% of the
    pot at 1,000, 3.34% at 2,000, **2.42%** at 3,000, 1.81% at 4,000, 1.19%
    at 5,000, 0.79% at 6,000, 0.32% at 8,000, **0.21%** at 9,000. Behind
    the CO and button limps it starts under the bar at 3,000 (1.53%, 1.84%)
    and ends at 0.59% and 0.75%; behind the earlier seats under 1%
    throughout. Not a degenerate class, the tremble's size or the tree.
  - **Iterations.** The HJ node crosses 2% at ~3,700; 9,000 (the 200bb
    sets' count, `DEEP_ITERATIONS`) is more than twice that, and leaves the
    worst big-blind-vs-limp node at 0.75%, under half the bar. More would
    cost ~1.5-2 h per 1,000 on the shared machine for nodes already well
    inside it.
  - **Fix.** `nlhe-cash-9max-150bb` is solved for 9,000 iterations (`deep`
    in `sets.ts`, version `charts/7`). Same fit, tree, tremble and engine.
    Only that file changes; every other set's configuration is `main`'s and
    its bytes too (6-max 40 and 100bb regenerated and compared byte for
    byte; `model.hash` of 6-max 100bb `ecad38d0` and 9-max 100bb `204ec7be`
    untouched, so the flop library's chunks still match).
  - **Results.** 2,924 nodes (2,888), **13 left out as unconverged (47)**,
    all reached under 1e-4; NashConv **0.087** mbb/hand (0.270), every
    seat's best-response gain under 0.015; 6.96 MB, 1.80 MB gzip. The big
    blind facing a single limp is in the set from every seat (checks 94.3%
    behind an HJ limp). 56 nodes come in, 20 rare ones (1e-6 to 1e-5) drop
    under the reach cut. Widths move by at most 0.4 points outside limped
    pots (SB raise first in 15.7% -> 15.3%, limp 45.8% -> 46.4%), up to 1.0
    inside them. **Generation: 13 h 38 min** (49,051 s) single-threaded,
    beside the flop-library batch's four solves and the diagnostic solve,
    at 30-50% of a core per process; peak 1.9 GB. The generator's 12-hour
    vitest timeout fired before the file was reported (the solve is
    synchronous, so the file was written whole); it is now 24 hours.
  - **Measured on the owner's library** (`npm run charts:library`, the same
    export, decision by decision with `CHARTS_LIBRARY_DUMP`, which now also
    records each decision's line, `rare-line-depth` and EV loss): there is
    no hero decision as the big blind behind an HJ limp at 150bb. Of the
    342 decisions graded on the set (52 of them 9-max 100 and 200bb rare
    lines read on it), two change grade (Inaccurate -> Perfect, Good ->
    Perfect) and 12 keep it with an EV loss moved by 0.01-0.09bb (4 of them
    rare lines read across depths). **Three 9-max 100bb `rare-line`
    refusals are now graded on the 150bb set** (`rare-line-depth`), all
    Perfect: the small blind behind a cutoff and a button limp (`fffffcc`,
    unconverged at `charts/4`) and the big blind and the HJ opener facing a
    squeeze after a cutoff flat (`ffffrcrf`, `ffffrcrff`, now reached
    1.2e-5). `rare-line` 46 -> 43; graded 4,846 -> 4,849 (90.0%); Perfect
    4,364, Good 17, Inaccurate 202, Mistake 185, Blunder 81; 230.3 bb lost
    (unchanged to 0.1bb). Rivers on a placeholder range 166 of 370,
    unchanged.
  - `CHARTS_VERSION` `charts/7` (the set carries it; the other eight keep
    theirs), `ANALYSIS_VERSION` `analysis/14`: grades read from the 9-max
    150bb set change. `sets.test`: the big blind facing a single limp is
    now required from every seat in every set; the EV-consistency check
    skips classes within half a 1/255 step of the in-range bar (a stored
    range of 0.051 can be a generator reach under 0.05).
  - **Open.** Every chart set now keeps the big blind facing a single limp.
    The 6-max 200bb small blind behind two limps (`fcfc`) stays out. The
    three 9,000-iteration sets cost 45 min to 14 hours each to regenerate;
    a solver change that forgets the trembling lines' early regrets would
    converge them in far fewer, at the price of regenerating every set
    (and the flop library keyed to the 100bb hashes). The 43 `rare-line`
    refusals left are 40 on 9-max sets, lines no 9-max depth charts.
