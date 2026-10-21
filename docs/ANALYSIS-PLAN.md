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

**The big-blind floor** (`analysis/33`, `FLOOR_POT_BB`): a *postflop* grade
takes the shares above of a pot of at least **12.5bb**, so in a smaller pot a
loss of at most 0.25bb is never worse than Inaccurate and at most 1bb never a
Blunder; the move score reads the same pot, and `evLossPot` shown is still
the share of the real pot. Below about 10bb the range model's own error stops
shrinking in big blinds (§10, 2026-10-20, the big-blind floor). Preflop
grades keep the plain shares.

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
    behind a limp are trained although the equilibrium barely limps;
  - plus a 6-max 100bb set with a 2bb UTG straddle (`charts/5`) and
    **heads-up** 100bb and 150bb sets (`charts/8`, `charts/9`: the small
    blind is the button and in position after the flop).
- **Convergence:** NashConv 0.06–0.33 mbb/hand (6-max), 0.27–0.44 (9-max) with the limp trees (`charts/3`: 0.04–0.13, 0.26–0.49).
- **Lookup picks the set:** the smallest table with enough seats, then the
  nearest depth within 20%, never interpolated; the distance is a
  `stack-depth` approximation.
- **Lookup refuses, with a reason:** `cold-call`, `multiway` (more than
  4 entrants, or a fourth limper), `rare-line`, `action-not-modelled`,
  `straddle`, 10+ players (`players`), and depths no set covers (heads-up:
  80-180bb only)
  (`limp` only for a set without limp trees).
- **Lookup approximates:** `short-handed` (3–5 handed read as 6-max, 7–8
  handed as 9-max, the earliest seats folded: exact in the model up to
  convergence), and off-tree sizes, by action translation. Since
  `analysis/24` a dead button is read as the live table of the same size
  (`dead-button`, exact), and a live big blind posted from another seat and
  checked as a limp (`posted-blind`, capped at Inaccurate; §10 2026-10-16).
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
- **Ranges:** a placeholder preflop range; since `analysis/18` a chart range
  read on a neighbouring depth (`range-neighbour-depth`) or a limp-caller's
  limp placeholder (`range-limp-call`); since `analysis/19` an opponent's
  flat call of a single raise or limp from outside the blinds started from
  the population range fitted on shown hands (`range-population`, with
  `placeholder-range`: not the charts'); since `analysis/20` an opponent's
  big blind defence moved by their own VPIP − PFR in the learner's library,
  with the sample shown (`range-villain`); since `analysis/31` an
  opponent's chart or placeholder range at its own width, three quarters of
  it in the population's order of hands (`range-population-order`; not on
  a heads-up flop the flop library answers).
- **Source quality:** a heuristic source (§3.6).

A decision is **not analysed** (`status: partial`) when:
- the postflop pot is multiway, except a river call or fold facing a bet
  (an approximate grade, `source: "approx"`) and a turn or river that
  began heads-up after a multiway flop (solved, `multiway-history`) — A9 —
  and, since `analysis/15`, a flop call or fold facing a bet in a pot three
  or more saw the flop of (approximate, `flop-realisation`: the showdown
  share times a realisation factor measured on the flop library; only the
  EV loss beyond 5% of the pot counts; capped at Mistake; §10
  2026-10-10), and, since `analysis/16`, a turn call or fold facing a bet
  in a pot three or more saw the turn of (approximate, `turn-realisation`:
  the same with a factor measured on Rail's own heads-up turn solves; §10
  2026-10-10, multiway turns). On both streets, since `analysis/17`, a call
  that ends the betting (an all-in) takes no factor, and a call or fold
  facing a re-raise is refused (`multiway-reraise`: the factors were
  measured on trees with one raise) unless the call ends the betting; the
  flop table is fitted without the all-in calls (`floplib-r/2`; §10
  2026-10-10, multiway rules and placeholder ranges). Since `analysis/29`
  the players still to answer behind the hero's call (all three streets)
  continue as often as players behind a call do on stored hands (the MDF
  split recalibrated, `mw-behind/1`; the model's calling range kept; behind
  a call of a raise the model's own share; §10 2026-10-20). Opponents whose line
  no chart covers - most often an open limper - start from the labelled
  placeholder range (`placeholder-range`); since `analysis/18` a line at a
  depth no set covers, or too rare for its set, is read on the nearest
  charted depth instead (`range-neighbour-depth`; not a flat call of a
  single raise, which keeps the placeholder), and a limper who called an
  isolation raise starts from the placeholder limp range
  (`range-limp-call`; §10 2026-10-10, neighbouring ranges). Since
  `analysis/19` an opponent who flat-called a single raise (a cold call, the
  big blind's defence), limped from outside the blinds (first in or behind a
  limper) or limped and called the raise behind starts from Rail's
  population range for that line instead, ahead of the charts and the
  placeholder (`range-population`; not the hero's own range, not after a
  preflop all-in; §10 2026-10-10, population callers); since `analysis/20`
  a big blind's defence is moved by the player's own statistics where the
  learner keeps them, at least 30 hands (`range-villain`; §10 2026-10-10,
  villain statistics); since `analysis/31` every other opponent's chart or
  placeholder range keeps its width but takes three quarters of it in the
  population's order (`range-population-order`; §10 2026-10-20,
  opponents' chart ranges). The rest (flop
  and turn checks and bets, river bets and checks) keeps its multiway facts
  and flags;
- the game is PLO, Short Deck or a Hi/Lo variant;
- the game is MTT with ICM;
- it is a bomb pot on two boards (since `analysis/28` a bomb pot on one
  board is analysed: every range starts from any two cards, the rules of
  the game, and the multiway rules above apply - approximate calls and
  folds, heads-up solves after it, checks and bets three or more ways
  `multiway` - flagged `bomb-pot`; §10 2026-10-19, bomb pots);
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
- 2026-10-10 — Multiway flops: an approximate flop call, `analysis/15`. No
  migration (`decision_analysis.source` already allows `approx`).
  - **What the ~450 are.** The owner's library (5,448 hands, `analysis/14`
    with the flop library) has 434 hero flop decisions in pots three or
    more saw the flop of, all ungraded:
    - players at the decision: 3: 282, 4: 85, 5: 24, 6: 2, and 41
      heads-up at the decision (a player folded on the flop before the
      hero acted; no library line fits);
    - pot type: single-raised 237, limped 173, 3-bet 20, 4-bet 4;
    - action: **not facing a bet 285** (check 267, of which 54 check behind
      as the last to act; bet 18); **facing a bet 149** (fold 94, call 52,
      raise 3; 137 against a bet, 12 against a raise). Facing a bet, the
      players still to answer behind the hero: none 70, one 63, two 12,
      three 4; sizes about a quarter pot 43, half 58, three quarters 28,
      a pot or more 18;
    - effective stack: 80-120bb 285, 120-170bb 73, 50-80bb 27, 170bb+ 27,
      under 50bb 22; 292 on full-ring tables, 142 on 6-max;
    - ranges: in 331 of the 393 with three or more at the decision at least
      one opponent's range is a placeholder (a flat or a limp no chart
      covers).
  - **Method** (`flopCallEv`, `gradeFlopCall` in `multiway.ts`). A flop call
    or fold facing a bet in a pot three or more saw the flop of is graded
    like A9's river call: everyone's range from the multiway walk, every
    way the players still to answer can respond (each calls with the
    narrowing model's likelihood, nobody raises, at most three), the
    hero's share against the field exactly or sampled (`equityVsRanges`).
    What the river does not need: two cards are to come, so a call wins
    the share **times a realisation factor** `R` - the hand's later
    winnings (implied odds included) as a multiple of its equity of the
    pot after the call. `R` is a table (`FLOP_REALISATION`, `floplib-r/1`,
    46 numbers) **measured on Rail's own flop library**: at every node
    facing a bet or raise of the 6-max and 9-max 100bb chunks (1,602
    chunks, 15,174 nodes; every third combo, 1.4 million), the solve's
    `EV(call) − EV(fold) + toCall` against `equity × raked pot` (exact
    equity against the bettor's range at the node), least squares per
    position after the call (last to act or not) × made hand (`flopBucket`'s
    made part) × draw or not. In position: sets 1.41, two pair 1.20,
    overpairs 1.01, top pair top kicker 0.97, weak kicker 0.81, middle pair
    0.71, ace high 0.68 (with a draw 1.01), no pair 0.73 (with a draw 1.13);
    out of position mostly lower (by up to 0.15 for no pair; overpairs
    slightly higher). In a multiway way the hero is
    "in position" when acting after everyone left in it. Applying a
    heads-up factor to the share against two or more ranges is **the
    assumption**, and the reason for the margin below.
    - **The grade.** Fold (0) against call, the better at 100%, §2's
      thresholds on **only the EV loss beyond 5% of the pot**
      (`FLOP_MARGIN_POT`, the factor's measured error: inside it the two
      are too close to call), always capped at Mistake (`range-cap`), with
      the half-strength sensitivity check. The options carry the EV beyond
      the margin, so the grade is §2 of its options as everywhere; the
      model's own call EV and the factor are stored in
      `facts.multiway.ev` (`realisation`: table, category, factor, share in
      position, margin). Approximations `multiway-approx`,
      `flop-realisation`, `narrowing-heuristic`, `rake-profile`.
  - **Validation** where an exact answer exists.
    - *Against the library, held out* (`npm run floplib:realisation`:
      fitted on the flops whose name hashes even, judged on the other
      644,850 samples; each node's range by reach; the library's grade of
      the same action from all its options):

      | | call/fold verdict | \|ΔEV\| % pot | same side of Good/Inaccurate | approx Mistake that is one | approx Perfect that is Perfect/Good | false alarms | misses |
      |---|---|---|---|---|---|---|---|
      | raw equity (R = 1) | 80.8% | 16.4 | 75.2% | 64.8% | 85.8% | 15.9% | 6.2% |
      | R by position | 81.4% | 15.9 | 76.4% | 66.0% | 87.0% | 15.2% | 5.6% |
      | R by category, no margin | 87.1% | 12.0 | 83.5% | 73.4% | 94.0% | 11.5% | 2.3% |
      | margin 3% | 87.1% | 12.0 | 85.2% | 77.7% | 91.9% | 8.7% | 3.5% |
      | **margin 5% (shipped)** | **87.1%** | **12.0** | **85.8%** | **80.6%** | **90.2%** | **7.0%** | **4.6%** |
      | margin 8% | 87.1% | 12.0 | 86.0% | 84.5% | 87.3% | 4.9% | 6.7% |
      | margin 10% | 87.1% | 12.0 | 85.5% | 86.7% | 85.2% | 3.9% | 8.3% |
      | margin 15% | 87.1% | 12.0 | 83.1% | 91.0% | 80.3% | 2.1% | 12.7% |

      (A false alarm: the approximation says Mistake, the library Perfect
      or Good; a miss the other way round; call and fold each half of a
      combo.) By pot, at 5%: single-raised 84.3% same side, 6.9% false
      alarms; 3-bet 86.6%, 7.3%; limped 88.9%, 4.6%. For comparison, the
      library's own mapped flops agree on the exact check/call grade 75.5%
      (2026-10-09). 5% is the smallest margin at which four in five of the
      approximation's Mistakes are Mistakes by the library while it misses
      under 5%; from 8% on the misses outnumber the false alarms.
      Refitted on every chunk the table moves by at most 0.003.
    - *The whole pipeline, heads-up* (`npm run floplib:measure`, new
      section): every heads-up flop call or fold of the owner's library
      that the library grades (26) graded again by the approximation on
      the heuristic walk: same grade 20, same side 25, **no false alarm**;
      the one miss is a call the library marks Mistake because it only
      raises there (raising is not compared).
    - *Three-way with one player (nearly) sure to fold.* With the player
      behind folding (a model whose call likelihood is 1e-9), the three-way
      answer is exactly the heads-up one against the bettor's range (unit
      test, against enumeration); with nobody left to answer it is the
      realised share of the enumerated showdown. So a three-way spot
      where one player nearly always folds inherits the heads-up agreement
      above; the part no exact answer checks is the factor applied against
      two or more live ranges.
  - **Measured on the owner's library** (`npm run floplib:measure`, the
    same export, with the flop library; `analysis/14` → `analysis/15`):
    - **144 multiway flop decisions graded** (approximate) of the 146
      calls and folds facing a bet (2 refused as side pots): Perfect 132,
      Inaccurate 1, Mistake 11 (5 of them capped from Blunder); 19.9bb of
      EV loss. Folds 93 (Perfect 88, Mistake 4, Inaccurate 1), calls 51
      (Perfect 44, Mistake 7). 106 with three or more at the decision, 38
      heads-up at it after a flop fold. Placeholder ranges in 118 of them.
    - Hero flop decisions graded 129 → 273 of 1,095 (11.8% → 24.9%);
      `multiway` refusals on the flop 393 → 285 (the checks and bets).
      Flop grades Perfect 99 → 231, Good 19, Inaccurate 5 → 6, Mistake
      6 → 17; flop EV loss 8.8 → 28.8bb. Turn and river grades do not move
      (the walks are unchanged).
  - `ANALYSIS_VERSION` `analysis/15`: flop multiway decisions get grades.
    Tests: the table and its categories, the exact no-responder EV, the
    heads-up reduction, the margin and cap from the options, the analysis
    and both languages (`analysisMultiway`), the measurement's exact node
    equities on the pilot and the fit (`flopRealisation`), the corpus
    invariants for flop `approx`.
  - **Open.**
    - **Checks and bets (285) stay ungraded.** A bet's EV needs every
      opponent's answer and the streets after; a check's is the same tree
      seen from the other side. Nothing in the engine grounds either
      multiway, so they keep facts and flags.
    - The factor is heads-up. Multiway the hero's realisation is likely
      lower for one-pair hands and higher for nut draws; no multiway
      reference exists to measure it. The margin covers the heads-up
      error, not this.
    - The narrowing is the larger risk: e.g. 4-4 on 2-2-2 called against a
      bet and a call reads 9% equity because the heuristic narrows the
      bettor to overpairs, a Mistake the library would not give. The cap
      and the margin bound it; a flop narrowing from the library for
      multiway pots would fix it.
    - Raises are not compared (3 decisions), and nobody re-raises behind
      the hero; the turn's multiway decisions (a turn realisation from the
      turn solver) are the next candidate.
- 2026-10-10 — Multiway turns: an approximate turn call, `analysis/16`. No
  migration (`approx` is allowed; skip reasons and approximations are not
  constrained in the database).
  - **What they are.** The owner's library (5,448 hands, `analysis/15`)
    has 223 hero turn decisions in pots three or more saw the turn of, all
    ungraded: 198 with three or more at the decision (`multiway`) and 25
    heads-up at it after a turn fold before the hero (`turn-multiway-flop`:
    the turn solver starts heads-up from the street's start).
    - players at the decision: 3: 159, 4: 33, 5: 5, 6: 1, and 2: 25;
    - **not facing a bet 133** (check 108, bet 25); **facing a bet 90**
      (fold 58, call 21, raise 11): **79 calls and folds**, 72 against a
      bet and 7 against a raise; players still to answer behind the hero
      none 33 (22 of them heads-up at the decision), one 40, two 6; sizes
      about a quarter to a third of the pot 23, half 21, three quarters 23,
      a pot or more 12;
    - pot type: single-raised 124, limped 90, 3-bet 8, 4-bet 1;
    - effective stack: 80-120bb 155, 120-170bb 29, 170bb+ 16, 50-80bb 15,
      under 50bb 8; 146 on full-ring tables, 77 on 6-max.
  - **Method** (`turnCallEv`, `gradeTurnCall` in `multiway.ts`): the
    flop's (`analysis/15`) with one card to come. Everyone's range from the
    multiway walk, every way the players still to answer respond, the
    hero's share against the field times a **turn realisation factor**
    `TURN_REALISATION` (`turnsolve-r/1`, 42 numbers), the EV loss beyond
    `TURN_MARGIN_POT` (5%) of the pot graded, capped at Mistake, with the
    half-strength sensitivity check. Approximations `multiway-approx`,
    `turn-realisation`, `narrowing-heuristic`, `rake-profile`. Two rules
    the flop does not have:
    - a call that leaves the hero, or every other player in a way, all-in
      takes no factor in that way (nothing is left to bet: the share is
      what the call wins; `realisation.allIn` says how often). Measured: at
      the solves' all-in calls `EV(call) − EV(fold) + toCall` equals
      `equity × raked pot` to float precision;
    - a call or fold facing a **re-raise** is refused (`multiway-reraise`):
      the factor was measured on A5a's tree, which has one raise.
  - **Measuring R on the turn, not assuming it.** No heads-up turn library
    exists, so the corpus is made from the flop library
    (`npm run floplib:turn-realisation`, `turnRealisation.ts`): every flop
    ending of every 6-max 100bb chunk with chips behind that at least 3% of
    both ranges reach (checked through, a bet called, a raise called) is
    dealt one turn card, fixed by a hash of the flop, line and path, with
    both ranges as the library's strategy plays them there, and solved
    exactly as A5a solves a hand's turn (`TURN_PROFILE`: 75% and all-in,
    one raise, the coarse river, 1% of the pot, isomorphism), plus a third
    of a pot to the bet menu - the owner's multiway turn bets run from a
    quarter pot to a pot, and a single size would measure only the call of
    75%. **1,200 chunks, 6,505 turns, 3.35 million samples** (every third
    combo at every turn node facing a bet or a raise, short of an all-in
    call), about 1 h 40 min on three processes beside the batch. The same
    least squares per position after the call × `flopRealisationCategory`
    on the turn board; categories under 50 nodes of weight (a set, trips,
    two pair or straight with a draw, two out-of-position draws) read their
    no-draw row. In position: full house+ 1.30, set 1.27, straight 1.21,
    flush 1.20, trips 1.03, two pair 1.01, overpair 0.88, top pair top
    kicker 0.86, good 0.80, weak 0.76, middle pair 0.71, weak pair 0.73, ace
    high 0.67 (with a draw 0.91), no pair 0.84 (with a draw 1.19); out of
    position lower by up to 0.38 (no pair without a draw 0.46; overpairs
    about the same). **Not close to
    1**: the position means are 1.00 and 0.88, but the spread between
    categories is the flop's, so a margin alone does not do (below).
  - **Validation** where an exact answer exists.
    - *Held out against the turn solves* (fitted on the flops whose name
      hashes even, judged on the other 1.5 million samples; the solve's
      grade of the same action from all its options):

      | | call/fold verdict | \|ΔEV\| % pot | same side of Good/Inaccurate | approx Mistake that is one | approx Perfect that is Perfect/Good | false alarms | misses |
      |---|---|---|---|---|---|---|---|
      | raw equity (R = 1) | 79.8% | 16.0 | 74.2% | 60.2% | 87.6% | 18.2% | 5.2% |
      | R = 1, margin 5% | 79.8% | 16.0 | 75.7% | 63.3% | 85.1% | 14.8% | 7.2% |
      | R by position | 81.4% | 14.5 | 75.7% | 61.8% | 89.0% | 17.4% | 4.6% |
      | the flop's table, margin 5% | 86.5% | 12.3 | 84.3% | 76.1% | 90.6% | 8.5% | 4.5% |
      | R by category, no margin | 86.9% | 10.3 | 81.0% | 69.0% | 94.3% | 13.2% | 2.2% |
      | margin 3% | 86.9% | 10.3 | 84.0% | 74.9% | 92.4% | 9.3% | 3.4% |
      | **margin 5% (shipped)** | **87.0%** | **10.3** | **85.2%** | **78.6%** | **90.7%** | **7.3%** | **4.5%** |
      | margin 8% | 86.9% | 10.3 | 85.8% | 82.9% | 88.0% | 5.0% | 6.5% |
      | margin 10% | 86.9% | 10.3 | 85.5% | 85.4% | 86.0% | 3.9% | 8.1% |

      By pot at 5%: single-raised 84.9% same side, 8.0% false alarms;
      3-bet 86.2%, 5.3%; limped 84.6%, 8.0%. Facing a third of a pot
      86.2%, 5.1%; three quarters 84.8%, 8.2%. 5% for the flop's reason:
      four in five of the approximation's Mistakes are Mistakes by the
      solver while it misses under 5%; from 8% on the misses outnumber the
      false alarms. The 42-row table loses nothing to every category
      (85.2%, 7.3% either way); refitted on every sample it moves by at most
      0.0005.
    - *On another corpus*: 152 chunks of the full-ring 100bb set (a twelfth
      each of four shards, 398,729 samples: other preflop ranges and seats),
      judged with the 6-max fit: verdict 87.1%, same side 85.1%, false
      alarms 7.2%, misses 4.7% (R = 1: 75.4%, 14.8%).
    - *The owner's heads-up turn decisions* (`npm run floplib:measure` with
      `FLOPLIB_TURN_SAMPLE`, new section): every heads-up turn call or fold
      facing a bet that the turn solver grades (114) graded again by the
      approximation on the heuristic walk. With the factor: same grade 84,
      same side 97 (85.1%), **false alarms 7 (6.1%)**, misses 6; with
      R = 1: same grade 84, same side 94, false alarms 15 (13.2%), misses 4.
    - *Three-way with one player certain to fold* (unit test): the turn
      call with the player behind folding (call likelihood 1e-9) equals
      the heads-up call in the same pot, the big blind having folded before
      the hero, to 1e-4 bb, and both equal `R × share × raked pot − call`
      against enumeration. With nobody left to answer it is the realised
      share of the enumerated showdown; with the hero all-in it is the
      share itself.
  - **Measured on the owner's library** (with the flop library and turn
    solving, every hero decision of `analysis/15` and `analysis/16`
    compared one by one, 7,695): only multiway turn calls and folds move.
    - **76 multiway turn decisions graded** (approximate) of the 79 calls
      and folds facing a bet (2 refused as re-raises, 1 as a side pot):
      Perfect 72, Inaccurate 1, Mistake 3 (1 capped from Blunder); 3.1bb of
      EV loss. Folds 56 (Perfect 54, Inaccurate 1, Mistake 1), calls 20
      (Perfect 18, Mistake 2). 55 with three or more at the decision, 21
      heads-up at it; placeholder ranges in 54; 2 kept milder by the
      sensitivity check; one all-in call realised at 1.
    - Hero turn decisions graded 508 → 584 of 745 (68.2% → 78.4%);
      Perfect 369 → 441, Inaccurate 12 → 13, Mistake 50 → 53; turn EV loss
      136.7 → 139.8bb. `multiway` refusals on the turn 198 → 141 (the
      checks, bets and raises), `turn-multiway-flop` 25 → 3. Flop and river
      grades do not move; all decisions graded 6,030 → 6,106.
    - The re-raise rule was added after the first pass: without it a fold
      of K♠5♠ (flush draw) to a big-blind 3-bet on T♠7♠2♥T♥ read 45% equity
      against a narrowed calling range and came out a capped Mistake of
      22bb - a 3-bet range the heuristic does not narrow and a spot the
      measured tree does not hold.
  - `ANALYSIS_VERSION` `analysis/16`. Tests: the turn table and its
    categories, the exact no-responder EV, the three-way certain-folder
    equivalence with the heads-up call, the all-in rule, the margin, cap
    and label, the re-raise refusal, the analysis and both languages
    (`analysisMultiway`); the corpus's turns and ranges, exact equities
    over the river, the all-in calls realising exactly, the shard files
    (`turnRealisation`); the corpus invariants for turn `approx`.
  - **Open.**
    - Turn checks and bets (133) stay ungraded, for the flop's reason.
    - The factor is heads-up and applied to the share against two or more
      ranges, and the narrowing is the larger risk (54 of the 76 rest on a
      placeholder range), as on the flop; the margin covers the factor's
      heads-up error only.
    - The flop's call has no all-in rule and no re-raise refusal yet;
      adding them would move flop grades (a version bump of its own).
    - The corpus is 100bb 6-max; deeper and shorter stacks read the same
      table (the full-ring check above is 100bb too).
- 2026-10-10 — Multiway rules and placeholder ranges, `analysis/17`. No
  migration.
  - **The flop takes the turn's two rules** (`callEv` in `multiway.ts`):
    - a call that ends the betting - the hero all-in, or every other player
      in a way all-in - takes no factor in that way (`realisation.allIn`).
      Measured on the flop library (1,691 chunks): at the 146,236 sampled
      all-in calls `EV(call) − EV(fold) + toCall` against
      `equity × raked pot` gives R = 1.0002 (the largest single gap 2.2% of
      the pot, the chunks' stored precision);
    - a call or fold facing a **re-raise** is refused (`multiway-reraise`):
      the flop library's tree has one raise (`FLOP_PROFILE.flopRaiseCap`) -
      **unless the call ends the betting** (a re-raise all-in the call
      closes), where no factor is used and nothing is left to measure. The
      exception holds on the turn too; on the owner's library it moves no
      turn decision (both turn refusals have chips behind).
  - **The flop table refitted without the all-in calls** (`floplib-r/2`,
    `npm run floplib:realisation`, which now measures all-in calls apart).
    `floplib-r/1` was fitted with them in: they were 10% of the samples,
    all at R = 1, and pulled every category towards 1. Kept in, today's
    library reproduces `floplib-r/1` to within 0.017 (the batch's new
    chunks change nothing); left out, strong hands go up and weak ones down:
    sets 1.41 → 1.64 in position (1.32 → 1.46 out), straights and full
    houses by 0.15-0.24, ace-high out of position 0.60 → 0.51, position means
    0.993 / 0.868 (were 0.995 / 0.899). Held out (fitted on the flops whose
    name hashes even, judged on the other 600,899 samples short of an all-in
    call; margin 5%):

    | | verdict | \|ΔEV\| % pot | same side | false alarms | misses |
    |---|---|---|---|---|---|
    | `floplib-r/1` | 86.8% | 11.3 | 85.3% | 6.6% | 5.2% |
    | **`floplib-r/2`** | 86.2% | 11.2 | **85.9%** | **6.6%** | **4.8%** |

    and on the held-out all-in calls R = 1 against the old factor: same side 90.7% / 87.5%, false alarms 6.0% / 9.5%, |ΔEV| 0.04 /
    15.1% of the pot.
  - **Measured on the owner's library** (5,448 hands, flop library and turn
    solving on, every hero decision of `analysis/16` and `analysis/17`
    compared one by one with dumps, 7,695): only flop approximate grades
    move.
    - **143 multiway flop decisions graded** (was 144): Perfect 133 (132),
      Inaccurate 0 (1), Mistake 10 (11); EV loss 14.2bb (19.9). One fold
      facing a re-raise is refused (a Mistake of 5.0bb: in a limped pot the
      hero bet, was raised and re-raised, and folded); one
      call of an all-in re-raise stays graded under the exception (Perfect,
      its factor 1.32 → 1); four all-in calls in all now take no factor (all
      Perfect before and after); the refit moves the factor by 0.05 on
      average (at most 0.32), turns one Inaccurate fold into Perfect and
      changes the EV loss of ten Mistakes (none changes class).
    - Flop decisions graded 275 → 274, flop EV loss 28.9 → 23.2bb;
      `multiway-reraise` on the flop 0 → 1. Turn, river and preflop grades
      do not move; all decisions graded 6,106 → 6,105.
  - **Where the placeholder ranges come from** (the same library at
    `analysis/16`; `npm run floplib:measure` now lists them by line). 452
    hands saw a flop three or more ways with the hero in; 129 are bomb pots
    (no preflop line, never graded). In the other 323, 481 of the 769
    opponents who saw the flop start from a placeholder (63%; the hero's own
    range in 81 hands):
    - **open limpers 194** - 118 first in, 76 over-limping behind a limper
      (`chartRange` refuses every non-blind limp, `openLimped`);
    - callers 173: no chart set at the stack depth 63, a limper calling an
      isolation 46 (it then reads the `call` placeholder), a line too rare
      for its set 26, a chart range under one combo 26 (a call the charts
      all but never make), off the tree 12; limpers at a depth no set covers
      19, a big blind's check the tree does not hold 10 and smaller groups.
    - At the graded decisions (opponents still in): flop 118 of 144 rest on
      a placeholder - first limpers in 58, over-limpers 25, callers at an
      uncharted depth 16, limpers calling an isolation 18, thin calls 13 -
      turn 54 of 76 (23, 11, 10, 8, 5). **The first limper is the most
      common placeholder**, then the over-limper.
  - **Can a Rail-own range replace it? Not soundly, so it stays.**
    - *The suggested recipe* - the hands the charts would not raise first in
      at the limper's seat, weighted by a calling tendency (the big blind's
      continue frequency against that seat's open, or the placeholder) - is
      about 200 combos (the placeholder 408) and holds no hand the charts
      always open: no TT+ or AQ+.
    - *Checked where hands were shown.* Over the same export, the
      opponents (the hero left out; no ante, straddle or bomb pot) open-limp
      12.0% of 10,457 first-in chances and raise 23.0% (9-max UTG: limp
      14.5%, raise 14.6%), and over-limp 17.4% of 2,265. Their shown hands
      (239 first limpers, 55 over-limpers, 389 open-raisers as a control)
      against each candidate on the 6-max or 9-max 100bb set, per combo:

      | shown | candidate | holds the hand | mean log-likelihood |
      |---|---|---|---|
      | open-raisers (control) | the charts' open range | 74.8% | **−6.81** |
      | | the placeholder open range | 74.0% | −6.85 |
      | | any two cards | 100% | −7.19 |
      | first limpers | any two cards | 100% | **−7.19** |
      | | the placeholder limp range | 56.1% | −7.89 |
      | | not raised × big blind's continue (the recipe) | 26.8% | −8.97 |
      | | not raised × placeholder | 31.8% | −8.70 |
      | | not raised | 68.2% | −8.23 |

      (A hand the range does not hold is scored at a twentieth of a uniform
      combo.) The control behaves: where the range is known the charts' range
      beats any two cards. For limpers the recipe explains the shown hands
      clearly worse than the placeholder (it holds a quarter of them), and
      nothing narrower beats any two cards: 12.6% of the shown first limps
      are TT+ or AQ+ (AA 6, AKo 9, QQ 3) - about 10% after the showdown's
      lean towards premiums (28.5% shown among open-raisers against about
      22% of the charts' opening combos). Real limpers limp traps; the
      placeholder holds none of them, and the recipe removes them by
      construction.
    - *The over-limper's chart range* (the over-limp node minus the 0.5%
      tremble) is 45 combos on average, 3.4% of hands, against the 17.4%
      the population over-limps: the equilibrium's best response to a
      limper who may hold anything, not what over-limpers hold. A2d's rule
      (no non-blind limp starts a walk from the charts) stands for both.
    - *How much the grades depend on it.* The 452 multiway hands analysed
      again with only the first limper's range swapped (1,190 decisions;
      81 flop and turn approximate grades have a first limper): any two
      cards moves 3 approximate grades (and 4 solver grades after a flop
      that began heads-up), the recipe 4 (+3), a tight range (22+, A2s+,
      KTs+, QTs+, JTs, T9s, 98s, ATo+, KJo+) 3 (+7). The approximate ones
      are calls and folds of 1-3bb whose EV moves by under 1bb, across the
      margin (and one the recipe leaves without a range). The
      limper's own postflop actions narrow it far more than where it
      starts, so the first limper's preflop range is not what moves these
      grades.
    - So the placeholder stays, labelled as before (`placeholder-range`).
      The learner's own villain statistics (VPIP − PFR) would be the honest
      input, but they are not in the analysis context and `analyzeHand`
      reads no database.
  - `ANALYSIS_VERSION` `analysis/17` (flop grades move). Tests: the flop's
    all-in rule against enumeration, the re-raise refusal and its all-in
    exception, both languages (`analysisMultiway`); all-in calls marked and
    realising exactly on the pilot (`flopRealisation`); the corpus
    invariants (the flop table's id, no factor on an all-in call).
  - **Open.**
    - A limp range with traps (premiums at a small weight) fits the shown
      limps better than the placeholder, but its weights would come from
      one player's opponents and a biased sample; the per-villain statistics
      (VPIP − PFR, limp frequency) are the better input, once the analysis
      can be handed them.
    - Callers at depths no set covers (63) and rare lines (26) could read a
      neighbouring depth for the range as grading does since `analysis/13`
      (`rare-line-depth`); a limper calling an isolation could start from
      the limp range times the charts' call frequency facing the isolation.
      Neither moves many grades on this library (the swaps above bound it).
- 2026-10-10 — Neighbouring ranges, `analysis/18` (`docs/CHARTS.md` §7.2).
  No migration, no chart regenerated.
  - **Why.** `analysis/17` traced 481 of 769 opponents in the owner's
    multiway hands to a placeholder and proposed two cheap fixes: callers at
    a depth no set covers (63) and lines too rare for their set (26) read a
    neighbouring depth's chart range, as grading does since `analysis/13`;
    and a limper who called an isolation (46, then on the `call`
    placeholder) starts from the limp placeholder times the charts' call
    frequency against the isolation.
  - **What was built.** `lookupPreflop(..., { uncoveredDepth: true })`: a
    spot whose effective stack no set of its table covers is replayed on the
    nearest charted depth below and above (`uncoveredDepthSets`, never two
    steps). `chartRange(..., { neighbourDepth: true })` asks for it and for
    `rareLineDepth`; the walks and the equity facts read every preflop range
    through `preflopClassRange` with those options (`WALK_RANGE_OPTIONS`).
    `rareLineChartSets` also lists the uncovered depths' neighbours, so the
    worker and the app load them. The flop library's placement
    (`chartLineOf`, `libraryEntry`) calls `chartRange` without options: a
    heads-up pot that reads the library keeps the answering set, and a
    neighbour-depth read only happens where the library could not be read
    anyway (its ranges missing).
  - **Validated against shown hands** (the opponents' showdowns in the
    owner's 5,448 hands, the hero left out; no ante, straddle or bomb pot;
    mean log-likelihood per combo, a hand outside the range scored at a
    twentieth of a uniform combo, as `analysis/17`; Δ ± its standard error,
    paired):
    - *Does the depth step hurt where the line is charted?* Each charted
      line (no all-in) re-read on its nearest other depth: −7.724 against
      the line's own chart's −7.693 (Δ −0.03 ± 0.03, n = 911). Barely.
    - *But the charts' own flat calls lose to the placeholder* at their own
      depth: cold calls −9.75 against −8.34 (the charts hold 9% of the shown
      hands, 38 combos on average: they 3-bet or fold), the big blind's
      defence −7.89 against −7.22; every other line is about even or better
      on the chart (3-bets −6.68 against −7.10, calls of a 3-bet −7.52
      against −8.56, opens −6.95 against −7.04).
    - *The proposal as written does not beat the placeholder:*

      | shown hands at | n | placeholder | proposal | shipped |
      |---|---|---|---|---|
      | flat calls at an uncovered depth or a rare line | 110 | **−7.97** | −8.67 (Δ −0.70 ± 0.22) | placeholder kept |
      | other lines there (open, iso, 3-bet, 4-bet, calls of a re-raise, the small blind's limp, checks) | 258 | −7.78 | **−7.63** (Δ +0.16 ± 0.13) | neighbouring depth |
      | limpers who called an isolation | 85 | −9.03 (`call`) | −9.20, limp × the charts' call frequency (Δ −0.18 ± 0.24) | |
      | | | | **−7.78**, the limp placeholder alone (Δ +1.25 ± 0.29) | limp placeholder |

      Any two cards scores −7.19 on every row: real players' ranges are
      wider than any of these. The charts' call frequency against an
      isolation removes the hands limp-callers show down (they call with
      what they limped), and so does the `call` placeholder (it lacks the
      offsuit broadways and weak aces of the limp range).
    - *Shipped,* on the final code (`preflopClassRange` against the
      `analysis/17` reading, every shown opponent whose range changes): 258
      read on a neighbouring depth −7.78 → −7.63, 104 limp-callers −9.14 →
      −7.86 (coverage 20% → 56%); all 362 −8.17 → −7.69 (Δ +0.48 ± 0.12).
  - **Flags.** `range-neighbour-depth` and `range-limp-call` (EN/HR), added
    wherever the placeholder's flag would be asked: the equity fact's range,
    a heads-up walk's villain (and the hero on a solved grade), a multiway
    opponent (`MultiwayOpponent.approx`). A limp-caller's range stays a
    placeholder (`placeholder-range`, labelled `limp:UTG`).
  - **Multiway placeholders** (the census of `analysis/17`, flop seen three
    or more ways, the hero in, no bomb pot): 479 of 767 opponents → **447**
    on a placeholder; 32 now read a neighbouring depth's chart, 46
    limp-callers start from the limp placeholder. The callers at uncovered
    depths and the rare-line callers stay on the placeholder, as the
    validation says they should.
  - **Measured on the owner's library** (5,448 hands, flop library and turn
    solving on; the 1,123 hands where any player's range changes analysed
    with `analysis/17` and `analysis/18` side by side, 1,555 hero decisions
    compared one by one; every other hand's ranges are identical):
    - preflop grades do not move (9 equity facts of a preflop all-in now
      against a neighbouring chart range, `preflop-range` for
      `placeholder-range`);
    - 279 postflop decisions carry a new flag (flop 104, turn 109, river
      66); 221 equity facts change;
    - postflop grades in these hands: Perfect 150 → 145, Good 14 → 21,
      Inaccurate 2 → 1, Mistake 15 → 11; graded 181 → 178 (three turn
      solves and one river solve now meet a line the new ranges never take,
      `*-unreached`; one river is solved that was not); 24 grades change
      class: turn solver 12, river solver 11, one multiway flop call (a
      Mistake of 1.7bb becomes Perfect); EV loss flop 4.3 → 2.2bb, turn 30.2
      → 40.8bb (one turn fold, already a capped Mistake, 12.0 → 25.9bb),
      river 10.1 → 10.7bb. One heuristic note appears and one goes.
  - `ANALYSIS_VERSION` `analysis/18`. Tests (`analysisRanges`): the
    uncovered depths' neighbours; a 75bb 3-bettor read on the 60bb set with
    the flag, refused without the option; a flat caller kept on the
    placeholder; the walk and the decision carry the flag; the sets listed
    for loading and nothing read that is not loaded; a limp-caller on the
    limp placeholder through the multiway walk to the decision; both
    languages.
  - **Open.**
    - The charts' flat-calling ranges explain shown calls worse than the
      placeholder even where the line is charted (cold calls hold 9% of the
      shown hands). Charted callers' ranges in the walks are the largest
      remaining range error; widening them (a population calling range, or
      the learner's villain statistics once the analysis is handed them) is
      the lever, not more chart depths.
    - Callers at uncovered depths and rare-line callers stay on the
      placeholder; the first limper and the over-limper too (`analysis/17`).
- 2026-10-10 — Population callers, `analysis/19` (`lib/analysis/population.ts`,
  `docs/CHARTS.md` §7.2). No migration, no chart regenerated.
  - **Why.** `analysis/18` found the charts' flat-calling ranges explain the
    calls players show down worse than the placeholder even at their own
    depth (cold calls −9.75 against −8.34), and `analysis/17` found nothing
    narrower than any two cards explains shown limps. Callers and limpers
    were the largest remaining range error.
  - **Data.** The opponents' showdowns in the owner's 5,448 hands (the hero
    left out; no ante, straddle or bomb pot; no preflop all-in), by the
    line of their last preflop decision: cold calls of a single raise 260,
    the big blind's defence 256, first limps 116, over-limps 48, limps then
    calls of the raise 102 (782). Scored as `analysis/17`: mean
    log-likelihood per combo, a hand outside the range at a twentieth of a
    uniform combo (any two cards −7.19). `npm run ranges:extract` writes a
    local file (never committed); `tests/scripts/caller-ranges/` fits and
    validates on it.
  - **Candidates**, held out (five folds by player, 256 players; every
    shown hand predicted by a fit that never saw its player), per line:

    | candidate | cold call | BB defence | first limp | over-limp | limp-call |
    |---|---|---|---|---|---|
    | the placeholder | −8.49 | −7.29 | −7.85 | −8.27 | −9.17 |
    | the charts (own depth, else neighbour; else the placeholder) | −9.65 | −7.95 | −7.40 | −9.06 | −9.30 |
    | the `analysis/18` reading | −9.36 | −7.80 | −7.85 | −8.27 | −7.85 |
    | any two cards | −7.19 | −7.19 | −7.19 | −7.19 | −7.19 |
    | the charts' call + 3-bet (raise) range | −8.91 | −7.73 | −8.17 | −8.97 | −9.16 |
    | logit on the charts' own EV (σ((EV(best of call, raise) − EV(fold)) / pot − b) / τ), b, τ fitted; with a floor | −7.05 | −7.05 | −6.99 | −7.13 | −7.91 |
    | **a shape fitted on shown hands** (logistic over nine class features) | **−6.80** | **−6.93** | **−6.90** | −7.17 | **−7.05** |

    The charts' economics, read as a quantal response, beat the placeholder
    and the charts but barely any two cards (+0.14 on cold calls, +0.14 on
    the big blind) and lose on limp-calls (the node after a limp is the
    tremble's). Adding the price, the seat band or the callers before to the
    fitted shape gains nothing (cold calls −6.83 against −6.84); one shape
    shared by the lines with a shift per line does as well as one per line
    (the three limp lines −7.01 either way, the two flat calls −6.90). The
    shared shape over all five lines shipped.
  - **The showdown's lean.** Shown hands lean strong. Two corrections, both
    in the fit: (1) each class's propensity to be shown, measured on the
    same players' 312 shown open-raises against the charts' open ranges
    (relative: AA 3.9, AKs 3.7, QJs 2.5, 22 1.3, K7o 1.1, 72o 0.8) - the fit
    maximises the likelihood of range × propensity and stores the range;
    (2) each shown hand weighted by how often its player plays the line
    against how often they show it down (capped at 4), so loose players who
    reach showdown often do not stand for everyone. The corrected ranges are
    wider (cold call about 430 → 540 combos) and score the same held out.
  - **Shipped: `population/1`**, 14 numbers (`population.ts`), no hand and
    nothing per player stored. Widths: cold call 540 combos (41%), the big
    blind 623 (47%), first limp 729, limp-call 712, over-limp 778. Pairs and
    suited hands high, offsuit trash low; big pairs below small ones on the
    flat lines (they re-raise: AA 43% of a cold call, 22 62%). Held out, as
    shipped (corrections on; five folds by player; Δ ± standard error
    clustered by player):

    | line | n | `population/1` | Δ placeholder | Δ charts | Δ `analysis/18` | Δ any two |
    |---|---|---|---|---|---|---|
    | cold call | 260 | −6.86 | +1.63 ± 0.16 | +2.79 ± 0.10 | +2.50 ± 0.11 | +0.33 ± 0.03 |
    | BB defence | 256 | −6.94 | +0.35 ± 0.09 | +1.01 ± 0.12 | +0.86 ± 0.11 | +0.25 ± 0.03 |
    | first limp | 116 | −6.96 | +0.89 ± 0.18 | +0.44 ± 0.08 | +0.89 ± 0.18 | +0.23 ± 0.03 |
    | over-limp | 48 | −7.09 | +1.18 ± 0.28 | +1.96 ± 0.15 | +1.18 ± 0.28 | +0.10 ± 0.06 |
    | limp-call | 102 | −7.00 | +2.17 ± 0.21 | +2.30 ± 0.17 | +0.85 ± 0.18 | +0.19 ± 0.04 |
    | all | 782 | −6.93 | +1.14 ± 0.09 | +1.74 ± 0.07 | +1.43 ± 0.07 | +0.26 ± 0.02 |

    Split by date instead (fitted on the hands before 2026-02-08, judged
    on the rest, and the other way round): all +1.14 ± 0.09 over the
    placeholder, +1.42 ± 0.07 over `analysis/18`, +0.25 ± 0.02 over any two
    cards; over-limp +0.04 ± 0.08 over any two. Under a proper score (95%
    the range, 5% uniform) and with the propensity applied to every
    candidate the differences are the same within 0.05. Every line clears
    the placeholder, the charts and the `analysis/18` reading by more than 3
    standard errors; the over-limp is not clearly better than any two cards.
  - **What reads it.** `preflopClassRange(..., { populationHero })`: every
    seat but the hero whose line is a flat call of a single raise, a limp
    from outside the blinds (first in or behind a limper) or such a limp
    then a call of the raise starts from its line's range, ahead of the
    charts, the neighbouring depth and the placeholder; NLHE cash with no
    ante, straddle, bomb pot or preflop all-in before the decision only.
    Source `placeholder` (not the charts'), label `cold-call:BTN` etc.,
    flag `range-population` (EN/HR). The analysis passes it to the walks
    (heads-up and multiway) and the equity facts. Unchanged: the hero's own
    range, the trainers' walks (they ask for no population), the small
    blind's completion and the big blind's check (blind against blind, the
    charts'), and the flop library's placement (a heads-up flop the library
    answers is narrowed by its chunk, solved from the charts' ranges).
    Checked on the final code: the 782 shown opponents −8.36 → −6.92 (Δ
    +1.44 ± 0.07), every one of them read from the population range.
  - **Measured on the owner's library** (`npm run ranges:measure`: the
    5,448 hands, flop library and turn solving on; the 585 hands where an
    opponent who saw the flop with the hero reads a population range - 288
    heads-up, 297 multiway; 829 such opponents: cold calls 296, the big
    blind 231, first limps 155, over-limps 76, limp-calls 71 - analysed with
    `analysis/18` and `analysis/19` side by side, 2,123 hero decisions
    compared one by one):
    - preflop does not move (587 decisions; no preflop equity fact reads a
      population range: they face an all-in);
    - 1,294 postflop decisions carry the new flag (flop 516, turn 494, river
      284); 865 equity facts change (flop 450, turn 283, river 132), the
      hero's equity up 3.3, 3.9 and 2.1 points on average: wider callers;
    - graded: flop 200 → 200, turn 356 → 361, river 236 → 235 (six turns
      and two rivers solved that were not, one turn and three rivers no
      longer solved: lines the new ranges never take); 123 grades change
      class (flop 5, turn 68, river 50) - the flop's five are multiway
      approximate Mistakes that become Perfect;
    - Perfect flop 171 → 176, turn 269 → 277, river 174 → 174; Mistake flop
      11 → 6, turn 35 → 30, river 18 → 11; EV loss flop 16.5 → 7.1bb, turn
      53.5 → 43.9bb, river 83.9 → 40.4bb (five river spots of 6-17bb become
      Perfect or Good: against a wider caller the hero's value bet, raise or
      check was right).
  - `ANALYSIS_VERSION` `analysis/19`. Tests (`analysisRanges`): the stored
    fit (weights in 0..1, widths, shape); the line of each seat (cold call,
    big blind, first limp, over-limp, limp-call; not the blinds' limp, not
    after an all-in); opponents only, and only when asked; the heads-up
    walk and the decision carry the flag in both languages; a limp-caller
    through the multiway walk.
  - **Open.**
    - The fit is one player's opponents (the owner's cash games, around
      $0.50/$1): a population, not a player. The learner's own villain
      statistics (VPIP − PFR, limp and cold-call frequency), once the
      analysis is handed them, should widen or narrow these per villain.
    - Shown hands still lean to players and hands that reach showdown; the
      two corrections use the opens as a yardstick, which assumes the
      showdown leans the same way after a call as after a raise.
    - Heads-up flops the library answers keep the charts' ranges through
      the chunk; reading the population there needs chunks solved from it.
    - Other lines (3-bets, calls of 3-bets, isolations) stay on the charts:
      `analysis/18` found them about even or better there.
- 2026-10-10 — Villain statistics, `analysis/20` (`lib/analysis/villain.ts`,
  `docs/CHARTS.md` §7.2). No migration, no chart regenerated.
  - **Why.** `analysis/19`'s open item: `population/1` is one range per line
    for everybody; the learner's own statistics on a villain (VPIP − PFR,
    limp and cold-call frequency) should widen or narrow it per player.
  - **Data.** The 782 shown opponents of `analysis/19` (same extract, same
    score: mean log-likelihood per combo, a hand outside the range at a
    twentieth of a uniform combo), and every opponent's statistics counters
    in every one of the 5,448 hands (`handFacts`, the counters the opponents
    panel sums; `npm run ranges:extract` now also writes them to a local
    `.stats.jsonl`, never committed). Each shown hand is scored with its
    player's statistics counted over their *other* hands (leave one out),
    and again over only the hands played *before* it (a time split); the
    population shape and the adjustment's parameters are fitted on the other
    four folds of players (five folds by player, as `population/1`);
    standard errors clustered by player. `tests/scripts/caller-ranges/villain.mjs`.
  - **The model.** The line's logit moves by δ = γ · (logit(r̂) − logit(p)
    − c), r̂ = (made + k·p) / (chances + k): the player's rate shrunk to the
    pool's p by k hands of prior weight, nothing below a minimum sample.
  - **Candidates**, held out, leave one out (Δ against `population/1` per
    combo; γ, k, c fitted per fold):

    | statistic (per line) | all (782) | cold call | BB defence | first limp | over-limp | limp-call |
    |---|---|---|---|---|---|---|
    | VPIP − PFR, one γ, no c | +0.015 ± 0.011 | +0.002 | +0.074 | −0.052 | +0.026 | −0.028 |
    | VPIP − PFR, γ per line, c | +0.021 ± 0.011 | +0.005 | +0.079 | −0.010 | −0.028 | −0.021 |
    | VPIP, γ per line, c | +0.030 ± 0.012 | +0.011 ± 0.013 | +0.075 | −0.016 | +0.069 ± 0.063 | 0.000 |
    | cold-call / limp frequency (BB: VPIP − PFR), γ per line, c | +0.020 ± 0.009 | −0.003 | +0.075 | −0.011 | +0.009 | −0.018 |
    | the same, BB on its call-vs-steal rate | +0.008 ± 0.008 | 0.000 | +0.036 ± 0.015 | −0.013 | +0.005 | −0.017 |

    Every statistic tried helps the big blind's defence (+0.04 to +0.08,
    3-5 standard errors) and nothing else: cold calls within ±0.01, limps
    and limp-calls slightly worse with every statistic (first limps −0.01
    to −0.06, more than 3 standard errors without a per-line γ), over-limps
    noise (48 hands). The fits want little shrinkage (k mostly at its floor
    of 1 with leave one out, 7-17 hands on the time split). A shift for
    the big blind alone was then chosen on these same held-out numbers - a
    mild selection, but the gain is there under every statistic and both
    splits.
  - **Shipped: `villain/1`**, four numbers (`villain.ts`): the big blind's
    defence only; VPIP − PFR over `vpip_opp`; at least 30 hands (`MIN`); k
    = 15 hands; the pool's rate p = 0.1741 (every opponent in the owner's
    library); γ = 1.318, c = −0.207 (fitted on every shown hand against the
    shipped `population/1`). Nothing per player stored. Held out as shipped
    (k and the minimum fixed, γ and c fitted per fold):

    | split | BB defence (256) | all (782) | BB defences moved (\|δ\| > 0.05) |
    |---|---|---|---|
    | leave one out | **+0.065 ± 0.019** (−6.944 → −6.879) | +0.021 ± 0.006 | 232 |
    | only earlier hands | **+0.060 ± 0.018** (−6.944 → −6.884) | +0.020 ± 0.006 | 186 |

    A proper score (95% the range, 5% uniform) gives +0.061 and +0.057; the
    weighted score (each hand by how often its player plays the line) +0.061
    and +0.057. About a quarter of what `population/1` gained over any two
    cards on this line (+0.25), so a small correction, but a real one.
  - **What reads it.** `AnalyzeOptions.villains` (by `villainKey(site,
    player)`: `{ vpipOpp, vpip, pfr }`) → `PreflopRangeOptions.villains` →
    `preflopClassRange`: an opponent's `bb-defence` population range with a
    sample of at least 30 hands is moved (`range-villain`, beside
    `range-population`), for the walks (heads-up and multiway, both
    narrowing models) and the equity facts. The decision records the sample
    whenever it carries the flag (`SpotFacts.villain`: position, line,
    hands, the raw and shrunk rate, the counters), and the sheet shows it
    ("Opponent's own stats: a BB defence: VPIP − PFR 24% over 312 hands in
    your library"; EN/HR) - exploit numbers only from the learner's own
    statistics, with their sample. Not on a shared sheet (read-only): the
    owner's statistics on a player are the owner's.
  - **Where the statistics come from.** The opponents panel's own report
    (`stats_opponents`, an invoker read under RLS, unchanged): cash games,
    rooms with persistent names, at least 30 hands, the 200 biggest
    samples (its cap). A learner who keeps no opponent rows (the panel's
    setting, off by default) gets exactly the `analysis/19` analysis. No
    migration, no new grant.
  - **Staleness.** Grades now depend on other hands, so the rebuild
    (`runAnalysis`) reads one snapshot at its start and hands it to every
    worker; each stored row records the counters its ranges read
    (`SpotFacts.villain.stats`). A row is not re-analysed when the
    statistics later grow - "missing" stays per version, so no migration -
    and the next version bump re-analyses every hand with that day's
    statistics. The hand view's fresh analysis (a hand with no row) uses a
    snapshot at most ten minutes old, and the turn and river study views
    hand back the stored counters (`villainsOfFacts`), so a re-solve reads
    the ranges the stored grade read, not today's.
  - **Also fixed.** `analysis/19`'s population labels (`cold-call:BTN`,
    `bb-defence:BB`, ...) were missing from the sheet's range names and read
    "any two cards"; they now read as lines in both languages.
  - **Measured on the owner's library** (`npm run ranges:villain-measure`:
    the 5,448 hands, flop library and turn solving on; every opponent's
    counters summed over the whole library; the 213 hands where an opponent
    who saw the flop with the hero is a big blind defending with at least
    30 hands of statistics - 133 heads-up, 80 multiway; 123 such ranges
    widened, 90 narrowed, a mean sample of 320 hands and a mean shift of
    +0.43 logits - analysed without and with the statistics, 751 hero
    decisions compared one by one):
    - preflop does not move (213 decisions);
    - 432 postflop decisions carry the new flag (flop 169, turn 163, river
      100); 243 equity facts change (flop 114, turn 85, river 44), on
      average by less than a fifth of a point either way (widened and
      narrowed ranges cancel);
    - graded: flop 89 → 89, turn 149 → 149, river 96 → 97 (one river
      solved that was not); 26 grades change class, all solver grades:
      turn 9, river 17; no flop grade moves (the library's heads-up flops
      keep the charts' ranges; the multiway flop calls held);
    - turn Perfect 111 → 114, Inaccurate 8 → 5, Mistake 9 → 9, EV loss
      13.1 → 12.3bb; river Perfect 71 → 70, Good 19 → 20, Mistake 5 → 7,
      EV loss 14.6 → 24.9bb (three river spots become Mistakes: a check
      worth 5.3bb and a fold worth 4.7bb against a widened big blind, and
      a 1.3bb check).
  - `ANALYSIS_VERSION` `analysis/20`. Tests (`analysisVillain`): the
    stored rule (lines, minimum, prior); nothing below 30 hands, without
    statistics or with broken counters; the shrinkage (exact formula, a
    larger sample moves further, the shrunk rate tends to the player's, a
    loose player widens and a tight one narrows); looked up by room and
    name, nobody else's; a cold caller unmoved; the walk, the flag and the
    sample on the decision, nothing without statistics (the whole analysis
    byte-identical below the minimum); the stored counters handed back for
    a study re-run; both languages, and the population lines named.
  - **Open.**
    - Limps and limp-calls did not move with any statistic tried; a limp
      frequency counted per position, or the limp-then-fold-to-a-raise
      frequency, might separate limp ranges better than overall looseness.
    - ~~The snapshot is the panel's 200 biggest samples; a library with more
      than 200 regulars of 30+ hands leaves the rest on the population.~~
      Done 2026-10-15: the run reads every opponent of the hands it
      analyses (`villain_counters`, `20270526090000`; entry below).
    - ~~The shared read still returns `facts.villain`~~ Done: it never did (`analysis_public_facts` lists keys); now also `- 'villain'` in `read_shared_analysis` and `withoutOwnerFacts` client-side (`20270407090000`, `analysis_share_villain.test.sql`).
    - The parameters are the owner's opponents' (one pool, around $0.50/$1);
      refit on more libraries when there are some.
- 2026-10-11 — Villain limp statistics: **nothing shipped**
  (`tests/scripts/caller-ranges/limp.mjs`, `limpCounters.ts`).
  `ANALYSIS_VERSION` stays `analysis/20`; no migration, no behaviour change.
  - **Why.** `analysis/20`'s open item: limps and limp-calls did not move with
    VPIP − PFR, VPIP or the overall limp frequency; a limp frequency counted
    per position, or what a limper does facing a raise, might separate limp
    ranges better than overall looseness.
  - **Data.** The 266 shown limps of `analysis/19`'s extract (first limps
    116, over-limps 48, limp-calls 102; 119 players; 224 of them have at
    least 30 hands of statistics behind them leave one out, 143 counting
    only earlier hands), scored as `analysis/19`/`analysis/20` (mean log-likelihood
    per combo, a hand outside the range at a twentieth of a uniform combo).
    New counters, counted from the hands for the study only
    (`limpCounters.ts`; `npm run ranges:extract` writes them, with `rfi` and
    `iso`, to the local `.stats.jsonl`, never committed): the open limp per
    position group (EP UTG..UTG+2, MP MP/LJ/HJ, LP CO/BTN, the small blind's
    completion), the over-limp, and a limper's answer to a raise behind
    (fold, call, re-raise). Pool rates over the library's 308 opponents: open
    limp 12.0% (EP 12.9, MP 13.2, LP 9.9, SB 15.3), over-limp 17.6%; facing a
    raise after a limp (803 times) fold 38.4%, call 56.7%, re-raise 5.0%.
    Players differ a lot (open limp, the 170 with 30+ hands: 10th percentile
    0%, median 6%, 90th 49%), but samples are thin where it matters: the
    median regular has 31 open-limp chances (EP 13, MP 8, LP 8), 7 over-limp
    chances and 2 limps that met a raise.
  - **Method.** `analysis/20`'s, unchanged: five folds by player; in each
    the population shape refitted on the other players, the adjustment's
    parameters on their shown limps; δ = γ · (logit(r̂) − logit(p) − c), r̂
    shrunk to the pool's p by k hands (k fitted, and fixed at 15), nothing
    below 30 hands (`vpip_opp`); every held-out limp scored with its player's
    statistics counted over their other hands (leave one out) and over only
    earlier hands; standard errors clustered by player. Twelve statistics ×
    seven forms (one γ; γ per line; each line alone with γ and c, the form
    `villain/1` shipped; γ per line and c; a *tilt*, δ[class] = u · (γ0 + γ1
    · z[class]) with z the class's standardised logit - stronger or weaker
    hands, not only more of them), 84 candidates, four runs each.
  - **Held out** (Δ against `population/1` per combo; γ per line and c, k
    fitted - the form of `analysis/20`'s table):

    | statistic | all limps (266) | first limp | over-limp | limp-call | all limps, earlier hands only |
    |---|---|---|---|---|---|
    | overall limp (`limp_opp`, `analysis/20`'s) | −0.006 ± 0.008 | −0.013 | +0.001 | −0.002 | +0.001 ± 0.005 |
    | VPIP − PFR | −0.005 ± 0.008 | −0.011 | +0.011 | −0.005 | +0.001 ± 0.006 |
    | open limp, EP + MP + LP | −0.009 ± 0.008 | −0.012 | −0.025 | +0.003 | −0.006 ± 0.003 |
    | open limp, with the SB's completion | −0.018 ± 0.009 | −0.022 | −0.045 | −0.000 | +0.001 ± 0.004 |
    | open limp in the hand's position group | −0.009 ± 0.009 | −0.018 | −0.013 | +0.003 | −0.010 ± 0.005 |
    | over-limp | −0.008 ± 0.010 | −0.008 | −0.008 | −0.007 | −0.010 ± 0.011 |
    | limp, then fold to a raise | −0.010 ± 0.006 | −0.011 | −0.025 | −0.001 | −0.008 ± 0.005 |
    | limp, then call a raise | −0.022 ± 0.011 | −0.014 | −0.095 | +0.003 | −0.017 ± 0.008 |
    | limp, then re-raise | −0.007 ± 0.005 | −0.007 | −0.032 | +0.005 | −0.011 ± 0.006 |
    | limp share (limps / limps + opens + isolations) | −0.017 ± 0.016 | −0.017 | −0.073 | +0.009 | −0.015 ± 0.008 |
    | each line its own (position open limp / over-limp / limp-call) | −0.012 ± 0.009 | −0.027 | +0.002 | −0.000 | −0.012 ± 0.007 |
    | the same, limp-calls on limp-then-fold | −0.015 ± 0.011 | −0.026 | −0.013 | −0.002 | −0.021 ± 0.012 |

    The other forms say the same. With one γ and no offset every statistic
    loses on the limps together in all four runs (leave one out and earlier
    hands, k fitted and 15: −0.004 to −0.016). The tilt loses too (all
    limps −0.004 to −0.033, first limps worst). Each line alone, the most
    consistent of the 84 × 4: a first limp on the player's over-limp rate
    +0.008 ± 0.005, +0.001 ± 0.004, +0.011 ± 0.008, +0.013 ± 0.008 (leave
    one out, k fitted / 15; earlier hands, k fitted / 15); a limp-call on the
    open-limp rate in its position +0.006 ± 0.005, +0.002 ± 0.002, +0.007 ±
    0.006, +0.007 ± 0.006; an over-limp never above zero. A few single cells
    reach two standard errors in one run and turn over in another (a first
    limp on limp-then-fold: +0.008 ± 0.004 on earlier hands, −0.018 ± 0.008
    leave one out); across 84 candidates × 4 runs × 3 lines that is what
    chance gives, and even the consistent ones are a tenth of the big
    blind's +0.065. Compare `analysis/20`: every statistic tried moved the
    big blind's defence by +0.04 to +0.08 in both splits.
  - **Not shipped.** No candidate beats population-only on held-out shown
    limps, so `population/1` stays the limp and limp-call range for
    everybody; `villain/1` still moves the big blind only. No counter added
    to the statistics, nothing in the app, no version bump.
  - **Open.**
    - Why nothing moves: the population limp ranges are already wide
      (`population/1`: first limp 729 combos, over-limp 778, limp-call 712)
      and the per-position and facing-a-raise samples are a handful of
      chances per player; a pool with more hands per regular (or several
      learners' libraries) may show what this one cannot.
    - The limp-call on its position's open-limp rate (+0.002 to +0.007) and
      the first limp on the over-limp rate (+0.001 to +0.013) are the only
      positive signs; worth re-testing, not shipping, when the shown limps
      double.
    - The limp lines' ranges could still differ by what the player does
      after the flop (a limper who check-folds most flops), which no
      preflop counter sees; untested.
- 2026-10-12 — A5b, the full-ring flop library live, `analysis/21`.
  - **The run.** All 13 full-ring lines × 100 representative flops of the
    9-max 100bb set (`charts/4`, hash `204ec7be`) solved on the owner's
    machine 2026-10-08 → 10-12 (~347 core-hours; the last 183 at six solves
    at a time in 6.75 h): 1,300 chunks, 92 MB, every solve below 1% of the
    pot. Uploaded to the `flop-library` bucket with `upload.sh`; the
    manifest and a sample of 40 chunks verified byte for byte from the
    public URL.
  - **Measured** (`floplib:measure`, 5,448 stored hands, both libraries):
    136 of 1,095 hero flop decisions graded from the library (122 mapped,
    14 exact), up from 127 with the 6-max library alone; as §10
    2026-10-08 predicted, few of the owner's full-ring heads-up flops sit
    on these lines (most are multiway or placed on 6-max sets).
  - **Fix.** The runner's closing estimate crashed after a finished run
    (an old call site missed the lines argument); no effect on the chunks.
- 2026-10-13 — Multiway flop narrowing from the library: **nothing shipped**
  (`tests/scripts/flop-library/multiwayNarrowing.test.ts`, study code
  `multiwayLibrary.ts` beside it). `ANALYSIS_VERSION` stays `analysis/21`; no
  migration, no behaviour change, nothing in `frontend/`.
  - **Why.** The open item of `analysis/15` and `/16`: multiway flop and turn
    calls are graded against ranges the heuristic narrowed through the flop,
    and the narrowing was named the larger risk (4-4 on 2-2-2 calling a bet
    and a call read 9% equity: the heuristic narrows the bettor to
    overpairs). The proposed lever: a flop narrowing from the library for
    multiway pots.
  - **What was built (study only).** Each flop player of a multiway pot is
    read as one of the two seats of the heads-up chunk of the closest line,
    on the chart set the aggressor's last preflop decision is read on (the
    100bb sets; any other depth has no library):
    - single raised: the aggressor's line against the big blind (`co-bb`
      for a cutoff open; full ring UTG+1/UTG+2 read `utg-bb`, MP `lj-bb`);
      3-bet: the 3-bet line of the same opener and 3-bettor, when the
      library has it; limped: `sb-limp`. Four or more raises, a preflop
      all-in, an ante or straddle: none;
    - roles: the aggressor plays the chunk's aggressor, every caller its
      caller (the big blind, or the button against the small blind's
      3-bet); limped, the last to act plays the big blind, everyone else the
      small blind;
    - the flop: the exact chunk, else its representative read by hand
      category (`readingChain`), as heads-up;
    - the street onto one heads-up line between the two roles: a check is
      followed into the tree only when the next actor has the other role
      (several players of one role checking are that role checking once); a
      call or a fold stays at the node (the next player of the same role
      answers the same bet); a bet or raise follows its edge (sizes by the
      translation, `OFF_TREE_DISTANCE`; a node the role's range reaches
      under 2% is not read);
    - `L(combo | action) = ε + (1 − ε) · strategy` at that node; an action
      the line cannot follow falls back to the heuristic (multiway
      adjustments included), and after an aggressive one that cannot follow,
      the rest of the street does too. Turn and river: the heuristic.
    The flag it would have carried (`multiway-library-narrowing`) was not
    added: nothing ships.
  - **Data.** The 5,448 stored hands of the test user (local stack, the
    owner's WePlay export), 1,282 flops three or more saw (no bomb pot).
    Every opponent shown down after one of them (the hero left out), scored
    on their range as the turn came, as `analysis/17`-`/20` score: mean
    log-likelihood per combo of the shown combo, a combo outside the range at
    a twentieth of a uniform combo. 725 shown players, 373 of them bet,
    raised or called on the flop (164 players); 128 of those (88 players) on
    a flop with a chunk, whose flop actions are 189, 145 read by the library
    (the rest fall back). Hands with a chunk: single raised 110 (8 exact
    flops), limped 60 (6), 3-bet 3. Starting ranges as the analysis reads
    them (population, charts, placeholders; no villain statistics).
  - **Method.** One parameter, ε, chosen held out: five folds by player,
    every player scored with the ε (0, 0.01, 0.03, 0.1, 0.3, 0.5, 1) that did
    best on the other four. Standard errors clustered by player. Also scored:
    each ε alone, the library's likelihood times the heuristic's (geometric
    mean, ε = 0.03), and no flop narrowing at all (every flop likelihood 1,
    the heuristic after it) for scale.
  - **Measured** (Δ against the heuristic per combo):

    | shown players | n | heuristic | library, ε held out | library ε = 0.03 | library × heuristic | no flop narrowing |
    |---|---|---|---|---|---|---|
    | bet, raised or called; a chunk read | 128 | −6.970 | **−0.261 ± 0.049** (ε 0.5-1) | −0.392 ± 0.088 | −0.114 ± 0.042 | −0.317 ± 0.047 |
    | the same, single raised | 80 | −6.914 | −0.212 ± 0.061 | −0.420 ± 0.104 | −0.139 ± 0.050 | −0.266 ± 0.059 |
    | the same, limped | 43 | −7.006 | −0.288 ± 0.086 | −0.365 ± 0.141 | −0.076 ± 0.067 | −0.417 ± 0.080 |
    | the same, 3-bet | 5 | −7.560 | −0.171 ± 0.106 | −0.176 ± 0.109 | −0.044 ± 0.035 | −0.274 ± 0.170 |
    | at least one own action read | 114 | −7.011 | −0.265 ± 0.048 | −0.412 ± 0.097 | −0.119 ± 0.047 | −0.316 ± 0.047 |
    | checked only; a chunk read | 140 | −6.843 | +0.036 ± 0.020 | −0.056 ± 0.048 | −0.002 ± 0.024 | +0.037 ± 0.022 |
    | everyone shown; a chunk read | 268 | −6.904 | −0.107 ± 0.027 | −0.217 ± 0.050 | −0.055 ± 0.024 | −0.132 ± 0.027 |
    | bet, raised or called; all | 373 | −7.206 | −0.090 ± 0.018 | −0.135 ± 0.033 | −0.039 ± 0.015 | −0.215 ± 0.042 |

    The heuristic's narrowing is worth +0.32 over none on the bettors and
    callers; the library's is worth less than none at a small ε (−0.39 at
    0.03 against −0.32), and every fold picks ε = 0.5 or 1 - at 1 the read
    actions are not narrowed at all. On them lower ε is worse throughout (ε =
    0: −0.50 ± 0.12): the heads-up strategy rules out hands multiway bettors and
    callers do hold. Mixing it into the heuristic only dilutes the
    heuristic. The one gain, +0.036 ± 0.020 on players who only checked,
    is no narrowing's (+0.037): the heuristic trims checks a little too hard
    multiway; the library adds nothing there either. Every row of bettors and
    callers with more than five shown loses by more than three standard
    errors.
  - **Control.** The heads-up flops the library reads today (shipped since
    `analysis/8`) give only 11 shown bettors and callers on this export
    (library −0.07 ± 0.37 against the heuristic, no narrowing −0.09 ±
    0.10) and 23 checkers: too few to say whether the heads-up library
    narrowing explains shown hands better than the heuristic heads-up. That
    question is open and is not this one.
  - **The grades it would move** (the hero's approximate flop and turn calls
    and folds in hands whose multiway flop has a chunk, computed twice on the
    same path - `flopCallEv`/`turnCallEv` and their grade, without the
    sensitivity check - on the heuristic walk and on the library walk): 103
    of the 219 approximate grades (flop 63 of 143, turn 40 of 76) sit on
    such hands. At ε = 0.03 no flop grade changes and 3 turn grades do; at
    ε = 0.5 one flop fold (Perfect → Inaccurate) and the same 3 turns. The
    turn's: Q♣K♠ folding 3.7bb into 11.2bb on 4♥A♠J♥ 8♥ heads-up after a
    three-way flop, share 29% → 25%, Mistake (0.7bb) → Perfect; T♠T♣ calling
    4bb into 16bb on 4♠7♠Q♣ 9♣ three-way, share 30% → 18%, Perfect →
    Mistake (0.8bb); K♣T♣ folding 8bb into 16bb on J♦7♥J♥ T♠, 58% → 59%,
    Perfect → Inaccurate (0.1bb). **The 4-4 on 2-2-2 hand** (8-handed,
    UTG opens, UTG+1, the button and the big blind call; the big blind
    checks 4♠4♥, the opener bets, UTG+1 folds, the button and the hero
    call; read on `utg-bb`, the representative 4♦4♥4♠): since
    `analysis/19`'s wider callers the heuristic share of the flop call is
    17% (not 9%), and the call is Perfect on both walks; the library reads
    35%. The turn fold after it (3♣, checked to the button, who bets 15bb
    into 20bb) is a Mistake on both, 3.3bb → 6.4bb. So the example
    that motivated this is real - the heuristic narrows a trips board's
    bettor too hard - but the library's reading is not better on the hands
    that were shown, and on this library it would move almost no grade.
  - **Not shipped.** The library narrowing loses to the heuristic held out
    on every subset of multiway flop bettors and callers, by more than the
    heuristic gains over no narrowing at small ε; the heuristic stays the
    multiway flop narrowing (`narrowing-heuristic` on multiway grades as
    before). No flag added, no version bump.
  - **Open.**
    - Why it loses, as far as the data says: a heads-up equilibrium bets and
      calls with a different, more polarised, mix than multiway players
      (who bet strong hands and call with pairs and draws), and the chunk's
      ranges are the charts' heads-up ones, not a cold caller's or a
      limper's. A multiway-specific reading (a solver over three ranges, or
      the library's strategy only as an ordering of hands with the
      heuristic's multiway shares) is untested.
    - The heuristic trims a check slightly too much multiway (not narrowing
      checks at all scores +0.04 ± 0.02 on checkers); a smaller
      `CHECK_VALUE`/`CHECK_AIR` trim multiway is worth a held-out test of
      its own.
    - Coverage is a third of the shown bettors and callers (128 of 373):
      other depths, 4-bet pots and BB-aggressor lines have no chunk.
    - The heads-up control is too small on this export (11 shown); with
      more libraries it should be scored the same way.
- 2026-10-14 — The multiway check trim, `analysis/22`
  (`lib/analysis/narrowing.ts`; study `tests/scripts/flop-library/checkTrim.test.ts`,
  `npm run floplib:check-trim`; grades `checkTrimGrades.test.ts`). No
  migration.
  - **Why.** The open item of 2026-10-13: on players who only checked a
    multiway flop, not narrowing at all scored +0.037 ± 0.022 per combo over
    the heuristic, so the heuristic trims a multiway check too hard. A
    smaller multiway trim, tested held out on its own.
  - **Data.** As 2026-10-13: the 5,448 stored hands of the test user, every
    opponent shown down after a flop three or more saw (the hero left out; no
    bomb pot). Flop rows: 676 shown players (205 players) scored on their
    range as the turn came. Turn rows: 417 (173 players) still in as the
    river came after a turn three or more began, scored on their range as
    the river came. Score as `analysis/17`-`/21`: mean log-likelihood per
    combo of the shown combo, a combo outside the range at a twentieth of a
    uniform combo. Starting ranges as the analysis reads them.
  - **Method.** The heuristic's check likelihood recomputed (study code; the
    shipped one reproduced to the bit) with other constants **only for flop
    and turn checks with three or more live players**; everything else is
    `heuristic/2` as it was. Candidates: a grid of `CHECK_VALUE` 0.5, 0.65,
    0.8, 1 × `CHECK_AIR` 0.7, 0.8, 0.9, 1 × `CHECK_DRAW` 0.6, 0.8, 1 (48),
    and the whole trim × 0, 0.25, 0.5, 0.75. Chosen held out with
    2026-10-13's folds: five folds by player, every player scored by the
    candidate that did best on the other four folds' flop and turn rows
    together. Standard errors clustered by player. Baseline: `analysis/21`
    (value 0.5, air 0.7, draw 0.6).
  - **Measured** (Δ against `analysis/21` per combo; the last three columns
    are fixed candidates, not held out):

    | shown players | n (players) | `analysis/21` | grid, held out | scale, held out | value 0.65, air 0.7, draw 1 | trim × 0.5 | no trim |
    |---|---|---|---|---|---|---|---|
    | flop and turn together | 1,093 (205) | −6.859 | **+0.025 ± 0.009** | +0.025 ± 0.009 | +0.030 ± 0.008 | +0.025 ± 0.009 | +0.012 ± 0.015 |
    | flop, everyone | 676 (205) | −6.905 | +0.030 ± 0.007 | +0.025 ± 0.007 | +0.034 ± 0.006 | +0.025 ± 0.007 | +0.025 ± 0.013 |
    | flop, checked only | 352 (157) | −7.042 | +0.034 ± 0.009 | +0.034 ± 0.008 | +0.034 ± 0.009 | +0.034 ± 0.008 | +0.044 ± 0.014 |
    | the same, a chunk read (2026-10-13's row) | 145 (93) | −6.858 | +0.031 ± 0.013 | +0.029 ± 0.013 | +0.030 ± 0.012 | +0.029 ± 0.013 | +0.034 ± 0.022 |
    | flop, checked then called or raised | 122 (76) | −6.840 | +0.077 ± 0.026 | +0.065 ± 0.025 | +0.092 ± 0.022 | +0.065 ± 0.025 | +0.063 ± 0.045 |
    | flop, never checked | 202 (119) | −6.704 | −0.006 ± 0.007 | −0.015 ± 0.011 | −0.002 ± 0.005 | −0.015 ± 0.011 | −0.030 ± 0.020 |
    | flop, three players | 468 (174) | −6.914 | +0.033 ± 0.008 | +0.028 ± 0.008 | +0.036 ± 0.007 | +0.028 ± 0.008 | +0.031 ± 0.013 |
    | flop, four or more | 208 (115) | −6.882 | +0.021 ± 0.010 | +0.019 ± 0.011 | +0.029 ± 0.008 | +0.019 ± 0.011 | +0.011 ± 0.024 |
    | turn, everyone | 417 (173) | −6.784 | +0.017 ± 0.017 | +0.024 ± 0.015 | +0.023 ± 0.015 | +0.024 ± 0.015 | −0.008 ± 0.027 |
    | turn, checked only | 237 (130) | −6.882 | +0.011 ± 0.016 | +0.025 ± 0.015 | +0.014 ± 0.015 | +0.025 ± 0.015 | +0.003 ± 0.029 |
    | turn, checked then called or raised | 42 (34) | −6.474 | +0.093 ± 0.066 | +0.040 ± 0.081 | +0.082 ± 0.063 | +0.040 ± 0.081 | +0.092 ± 0.097 |
    | turn, never checked | 138 (88) | −6.711 | +0.005 ± 0.032 | +0.019 ± 0.026 | +0.019 ± 0.026 | +0.019 ± 0.026 | −0.059 ± 0.054 |

    The grid picked value 0.65, air 0.7, draw 1 in four folds (value 0.8,
    air 0.9, draw 1 in the fifth); the scale picked 0.5 in all five. Both
    beat `analysis/21` held out by +0.025 ± 0.009, 2.8 standard errors.
    The gain comes from strong hands and strong draws: air keeps its trim
    in four folds of five (0.9 in the fifth), and dropping the trim
    entirely is better for pure checkers but costs the players who bet
    (their opponents' checked ranges get too wide), so it ends at +0.012 ±
    0.015 overall. The biggest single gain is on players who checked and
    then called or raised (+0.08 to +0.09): exactly the strong hands and
    draws the old trim pushed out. No subset with more than 20 shown is
    worse by more than a standard error; the only negative held-out cell is
    the flop players who never checked, −0.006 ± 0.007 (the change reaches
    them only through the field's strength).
  - **Control, heads-up.** Unchanged by construction (`players` unset or 2
    takes the heads-up constants; a unit test pins it). For scale, the same
    trims applied to heads-up checks on all 152 heads-up flops with a shown
    opponent (73 players; the heuristic walk): checkers +0.039 ± 0.015 at
    × 0.5 and +0.054 ± 0.025 with no trim (91 shown), bettors and callers
    +0.005 ± 0.016 (61). Heads-up checks look trimmed too hard as well, but
    on a sample a seventh the size; not changed here.
  - **Shipped.** `MULTIWAY_CHECK_VALUE = 0.65` (was `CHECK_VALUE` 0.5) and
    `MULTIWAY_CHECK_DRAW = 1` (was `CHECK_DRAW` 0.6) for a flop or turn check
    with three or more players in the pot; `CHECK_AIR` (0.7), the river,
    `CHECK_REPEAT` and every heads-up check unchanged. The narrowing's id
    stays `heuristic/2` (`+mw` multiway); `ANALYSIS_VERSION` →
    `analysis/22`.
  - **The grades it moves** (`analyzeHand` without turn solves, as
    2026-10-13 counted, over the 452 stored hands whose multiway flop the
    hero saw; 306 graded postflop decisions): 10 grades change, none on
    the flop. Flop approximate calls and folds 0 of 143 (two EV losses
    move); turn approximate 3 of 76; river approximate 0 of 23; river
    solves after a multiway flop 7 of 64 (two better, five worse, each
    one step between Perfect, Good and Inaccurate). Examples: Q♣K♠ folding
    the turn on 4♥A♠J♥ 8♥ after a three-way flop (2026-10-13's example),
    Mistake (0.66bb) → Inaccurate (0.09bb); A♦4♥ calling the turn on
    2♠5♠T♦ 8♦ three-way, Inaccurate (0.12bb) → Mistake (0.25bb); T♥8♥
    calling the river on 8♠7♣7♥ 4♥ T♣ after a five-way flop, Good (0.54bb)
    → Perfect. Heads-up turns after a multiway flop (solved, not counted
    here) move with the same ranges.
  - **Open.**
    - The heads-up control says the heads-up check trim may be too hard as
      well (+0.04 ± 0.015 at half the trim on 91 checkers); a held-out
      test on more heads-up shown hands, and the heads-up library's own
      narrowing scored the same way, before touching it.
    - The river keeps the old constants: no shown range after a river
      check can be scored this way (nothing narrows after it), so a river
      check trim needs a different test (the river call grades' agreement
      with a solve, or bluff-catchers' outcomes).
    - Turn rows alone are not significant (+0.017 ± 0.017 held out); the
      turn shares the flop's constants because they did no worse there.
- 2026-10-14 — The heads-up check trim, `analysis/23`
  (`lib/analysis/narrowing.ts`; study `tests/scripts/flop-library/headsUpCheckTrim.test.ts`,
  `npm run floplib:hu-check-trim`; grades `checkTrimGrades.test.ts` with
  `CHECKTRIM_GRADES_HEADSUP=1`). No migration.
  - **Why.** The open item of the multiway check trim: its heads-up control
    said heads-up checks are trimmed too hard as well (+0.039 ± 0.015 at
    half the trim on 91 players who only checked), on a sample too small to
    act on. A held-out test of its own, on every heads-up shown hand.
  - **Data.** The same 5,448 stored hands. Every opponent shown down after a
    flop two players saw (the hero left out; no bomb pot): 781 flops, with
    or without the hero (in a pot without the hero both players start from
    the population ranges, as opponents do). Flop rows: 882 shown players
    (193 players), scored on their range as the turn came. Turn rows: 849
    (189), on their range as the river came: 814 after a heads-up flop and
    35 from turns that began heads-up after a multiway flop (the multiway
    walk, as the analysis hands it on). Score, folds and clustered standard
    errors as the multiway check trim.
  - **The flop library.** Where a chunk covers the hero's heads-up flop the
    analysis narrows the flop with the library's strategy, and the
    heuristic's check only where the line leaves the tree. Each row is scored
    as analysed (the library where it reads, the candidate as its fallback)
    and on the plain heuristic walk. Of the 781 flops only 35 have a chunk:
    most shown hands are pots without the hero, which the analysis never
    grades, and of the hero's own pots a quarter are covered (34 of the 146
    flop rows from them). Of
    the 615 flop rows that checked the flop, 30 had the check read from the
    library and none fell back to the heuristic there; 585 went through the
    heuristic. Any candidate moves 1,198 of the 1,731 rows as analysed.
  - **Method.** As the multiway check trim, with the multiway constants
    fixed at `analysis/22`'s: the heuristic's check likelihood recomputed
    with other constants **only for flop and turn checks with two live
    players** (the river untouched; no shown range after a river check can
    be scored). Candidates: the same grid of value × air × draw (48) and the
    whole trim × 0, 0.25, 0.5, 0.75. Fitted on the rows as analysed, flop
    and turn together. Baseline: `analysis/22` (value 0.5, air 0.7, draw
    0.6, the river's constants). Fidelity: the shipped heuristic reproduces
    the study's winner to the bit (401 turn- and river-start ranges).
  - **Measured** (Δ against `analysis/22` per combo, as analysed; "heuristic
    walk" is the grid held out with no library; the last three columns are
    fixed candidates, not held out):

    | shown players | n (players) | `analysis/22` | grid, held out | scale, held out | grid, heuristic walk | trim × 0.5 | value 0.65, air 0.7, draw 1 | no trim |
    |---|---|---|---|---|---|---|---|---|
    | flop and turn together | 1,731 (194) | −6.987 | +0.016 ± 0.007 | **+0.019 ± 0.006** | +0.019 ± 0.006 | +0.023 ± 0.005 | +0.008 ± 0.006 | +0.022 ± 0.009 |
    | flop, everyone | 882 (193) | −7.024 | +0.021 ± 0.006 | +0.023 ± 0.005 | +0.024 ± 0.005 | +0.024 ± 0.004 | +0.014 ± 0.005 | +0.030 ± 0.007 |
    | flop, checked only | 467 (154) | −7.112 | +0.020 ± 0.008 | +0.019 ± 0.008 | +0.020 ± 0.008 | +0.022 ± 0.006 | +0.012 ± 0.006 | +0.025 ± 0.011 |
    | flop, checked then called or raised | 148 (83) | −6.896 | +0.057 ± 0.022 | +0.068 ± 0.016 | +0.073 ± 0.018 | +0.067 ± 0.014 | +0.033 ± 0.020 | +0.090 ± 0.024 |
    | flop, never checked | 267 (115) | −6.941 | +0.004 ± 0.003 | +0.004 ± 0.003 | +0.004 ± 0.003 | +0.005 ± 0.003 | +0.005 ± 0.004 | +0.006 ± 0.004 |
    | flop, the hero's pots | 146 (70) | −7.590 | +0.024 ± 0.011 | +0.025 ± 0.010 | +0.031 ± 0.013 | +0.022 ± 0.008 | +0.018 ± 0.008 | +0.028 ± 0.014 |
    | the same, a chunk read | 34 (27) | −7.220 | 0 | 0 | +0.033 ± 0.034 | 0 | 0 | 0 |
    | flop, a check through the heuristic | 585 (165) | −7.042 | +0.030 ± 0.009 | +0.032 ± 0.007 | +0.033 ± 0.008 | +0.034 ± 0.006 | +0.018 ± 0.007 | +0.043 ± 0.010 |
    | flop, pots without the hero | 736 (187) | −6.912 | +0.021 ± 0.007 | +0.022 ± 0.006 | +0.023 ± 0.006 | +0.025 ± 0.005 | +0.013 ± 0.006 | +0.031 ± 0.008 |
    | turn, everyone | 849 (189) | −6.949 | +0.010 ± 0.009 | +0.015 ± 0.009 | +0.015 ± 0.008 | +0.021 ± 0.007 | +0.003 ± 0.009 | +0.013 ± 0.012 |
    | turn, checked only | 515 (152) | −7.018 | +0.010 ± 0.013 | +0.014 ± 0.012 | +0.016 ± 0.011 | +0.022 ± 0.010 | −0.001 ± 0.013 | +0.015 ± 0.017 |
    | turn, checked then called or raised | 80 (52) | −6.925 | +0.032 ± 0.045 | +0.036 ± 0.041 | +0.027 ± 0.044 | +0.044 ± 0.035 | +0.025 ± 0.035 | +0.019 ± 0.067 |
    | turn, never checked | 254 (116) | −6.816 | +0.005 ± 0.014 | +0.009 ± 0.012 | +0.008 ± 0.013 | +0.011 ± 0.011 | +0.003 ± 0.011 | +0.008 ± 0.018 |
    | turn, after a multiway flop | 35 (27) | −6.815 | −0.002 ± 0.021 | −0.005 ± 0.022 | −0.004 ± 0.021 | −0.003 ± 0.017 | −0.020 ± 0.018 | −0.012 ± 0.030 |
    | turn, the hero acted on it | 148 (69) | −7.396 | +0.034 ± 0.012 | +0.035 ± 0.011 | +0.043 ± 0.014 | +0.030 ± 0.009 | +0.018 ± 0.011 | +0.038 ± 0.017 |

    The scale picked × 0.5 in three folds (× 0.25 and × 0 in the other
    two); held out it beats `analysis/22` by +0.019 ± 0.006, 3.2 standard
    errors. The grid's choices wander (value 0.8 with air 0.8–0.9 and draw
    0.6–0.8 in four folds, no trim in the fifth) and score less held out,
    +0.016 ± 0.007 (2.3 SE); in sample its best cell (value 0.8, air 0.9,
    draw 0.8, +0.023) is no better than × 0.5 (+0.023), so the one-parameter
    scale is the winner. No subset with more than 20 shown is worse than
    `analysis/22` by more than a standard error; the only negative held-out
    cell is the 35 turns after a multiway flop (−0.005 ± 0.022). Unlike
    multiway, the multiway winner (value 0.65, draw 1, air kept) does only
    half as well heads-up: heads-up the air trim is too hard as well. As
    multiway, the biggest gain is on players who checked and then called or
    raised (+0.07), the strong hands and draws the trim pushed out; turn
    rows alone are not significant (+0.015 ± 0.009 held out) and share the
    flop's constants because they did no worse.
  - **Shipped.** `HEADS_UP_CHECK_VALUE = 0.75`, `HEADS_UP_CHECK_DRAW = 0.8`,
    `HEADS_UP_CHECK_AIR = 0.85` (the trim × 0.5 written as constants; were
    `CHECK_VALUE` 0.5, `CHECK_DRAW` 0.6, `CHECK_AIR` 0.7) for a flop or turn
    check with two players in the pot. The river (heads-up and multiway),
    `CHECK_REPEAT`, the multiway constants and the flop library's own
    strategy are unchanged. The narrowing's id stays `heuristic/2`;
    `ANALYSIS_VERSION` → `analysis/23`.
  - **The grades it moves** (`analyzeHand` with the flop library and turn
    solves, `CHECKTRIM_GRADES_HEADSUP=1 CHECKTRIM_GRADES_TURN=1`, over the
    560 stored hands whose heads-up flop the hero saw; 1,452 postflop
    decisions, 925 graded after): 71 grades change, none on the flop.
    Flop solves 0 of 151 (the flop grade reads the library or the flop
    solve, not the narrowing of a check after it). Turn solves 36 of 464:
    13 better, 20 worse, 3 newly solved (ungraded before); one turn call is no longer solved. River solves 34 of
    310: 16 better, 17 worse, one newly solved and one no longer. Most move
    one step; 18 move two or three (mostly good ↔ mistake). A further 147 keep
    their grade with a different EV loss. Without turn solves (the setting
    of the multiway count) it is 29 grades, all on the river. Examples:
    9♦9♥ in the small blind checking the turn on K♥6♥A♥ 8♣ after the flop
    was checked through, Perfect → Mistake (2.13bb); T♥T♠ check-raising the
    turn on T♣5♠9♥ 3♦ against the button, Good (3.24bb) → Mistake (8.16bb);
    A♥J♣ on the button checking back the river on A♦Q♣4♦ 3♣ 4♥ in a 4-bet
    pot after the flop was checked through, Good (3.48bb) → Perfect, its
    turn call solved for the first time (Perfect).
  - **Open.**
    - The river check trim is still the old one, untested: nothing narrows
      after a river check, so it needs a different test (bluff-catchers'
      outcomes, or agreement with a solve).
    - Most of the evidence is from pots without the hero (736 of 882 flop
      rows); the hero's own pots agree (+0.025 ± 0.010 held out) but are a
      sixth of it.
    - The library reads the flop of only a few of the hero's heads-up pots
      on this export; where it does, its strategy is not scored against the
      heuristic here (34 rows; the grid held out on the heuristic walk
      scores +0.033 ± 0.034 there, too few to say anything).
- 2026-10-14 — The river check trim, held out: not shipped
  (study `tests/scripts/flop-library/riverCheckTrim.test.ts`,
  `npm run floplib:river-check-trim`). No migration, no version bump.
  - **Why.** The open item of both check trims above: the river checks
    (`CHECK_VALUE` 0.5, `CHECK_AIR` 0.7; `CHECK_DRAW` does nothing on the
    river, where no combo has outs) and `CHECK_REPEAT` (0.5) were never
    fitted. Nothing narrows after a river check, but the range after a
    player's last river action can be scored directly on the hand they show.
  - **Data.** The same 5,448 stored hands. Every opponent shown down (the
    hero left out; no bomb pot) who acted on the river and did not fold:
    1,408 river rows (236 players), 1,119 on a river that began heads-up
    (307 of them after a multiway flop) and 289 on a river that began with
    three or more. Heads-up flops through `walkRanges` (the hero's own flops
    read the flop library where a chunk covers them, as analysed), multiway
    flops through `walkMultiway` (from the hero's seat, or the first seat in
    a pot without the hero). 939 rows checked the river, 872 of them after
    an earlier postflop check, so most river checks are already trimmed at
    `CHECK_REPEAT` or less. For `CHECK_REPEAT` the flop and turn rows of the
    earlier studies are added (1,558 and 1,415; 4,381 rows, 244 players).
    Score, folds and clustered standard errors as the two check trims.
    Fidelity: the study's restated constants reproduce the shipped heuristic
    to the bit (600 river-start and end-of-river ranges).
  - **Method.** Only river checks recomputed; everything else is
    `analysis/23`. Candidates: `CHECK_VALUE` 0.3, 0.5, 0.65, 0.8, 1 ×
    `CHECK_AIR` 0.5, 0.7, 0.8, 0.9, 1 (25), and the whole trim × 0, 0.25,
    0.5, 0.75, 1.25, 1.5 (above 1 a harder trim). Three families: heads-up
    river checks only, multiway river checks only, both alike; the separate
    fits score each row with its own family's held-out choice. `CHECK_REPEAT`
    0, 0.25, 0.75, 1 on every street, fitted on all rows.
  - **Measured** (Δ against `analysis/23` per combo; the last four columns
    are fixed candidates, not held out):

    | river rows | n (players) | `analysis/23` | both alike, grid, held out | both alike, scale, held out | separate grids, held out | separate scales, held out | trim × 0.5 | no trim | trim × 1.5 | value 1, air 0.7 |
    |---|---|---|---|---|---|---|---|---|---|---|
    | every river row | 1,408 (236) | −6.835 | −0.002 ± 0.002 | −0.002 ± 0.002 | −0.002 ± 0.003 | −0.002 ± 0.003 | −0.005 ± 0.001 | −0.010 ± 0.002 | +0.001 ± 0.003 | −0.011 ± 0.003 |
    | checked only | 868 (193) | −6.859 | +0.000 ± 0.002 | +0.000 ± 0.002 | +0.001 ± 0.002 | +0.001 ± 0.002 | −0.008 ± 0.002 | −0.017 ± 0.003 | +0.005 ± 0.003 | −0.016 ± 0.003 |
    | check-call | 67 (49) | −6.743 | −0.008 ± 0.005 | −0.008 ± 0.005 | −0.012 ± 0.006 | −0.010 ± 0.005 | +0.008 ± 0.006 | +0.014 ± 0.011 | −0.016 ± 0.010 | −0.021 ± 0.030 |
    | check-raise | 4 (4) | −6.091 | +0.005 ± 0.025 | +0.005 ± 0.025 | +0.005 ± 0.025 | +0.005 ± 0.025 | −0.031 ± 0.055 | −0.079 ± 0.125 | +0.016 ± 0.043 | −0.135 ± 0.195 |
    | never checked | 469 (178) | −6.811 | −0.007 ± 0.007 | −0.007 ± 0.007 | −0.007 ± 0.007 | −0.007 ± 0.007 | −0.000 ± 0.001 | −0.000 ± 0.001 | −0.004 ± 0.007 | −0.002 ± 0.001 |
    | checked after an earlier check | 872 (199) | −6.847 | +0.002 ± 0.001 | +0.002 ± 0.001 | +0.002 ± 0.001 | +0.002 ± 0.001 | −0.006 ± 0.001 | −0.013 ± 0.002 | +0.005 ± 0.001 | −0.015 ± 0.004 |
    | checked, first check of the hand | 67 (51) | −6.843 | −0.028 ± 0.024 | −0.028 ± 0.024 | −0.027 ± 0.024 | −0.026 ± 0.024 | −0.019 ± 0.019 | −0.044 ± 0.033 | −0.023 ± 0.035 | −0.030 ± 0.035 |
    | heads-up | 1,119 (213) | −6.849 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.005 ± 0.001 | −0.011 ± 0.002 | +0.000 ± 0.004 | −0.013 ± 0.003 |
    | heads-up, checked only | 655 (167) | −6.864 | +0.000 ± 0.002 | +0.000 ± 0.002 | +0.000 ± 0.002 | +0.000 ± 0.002 | −0.009 ± 0.002 | −0.019 ± 0.004 | +0.005 ± 0.003 | −0.019 ± 0.004 |
    | heads-up, check-call | 58 (43) | −6.833 | −0.011 ± 0.005 | −0.011 ± 0.005 | −0.011 ± 0.005 | −0.011 ± 0.005 | +0.011 ± 0.006 | +0.018 ± 0.011 | −0.019 ± 0.011 | −0.013 ± 0.034 |
    | heads-up, never checked | 402 (158) | −6.834 | −0.008 ± 0.008 | −0.008 ± 0.008 | −0.008 ± 0.008 | −0.008 ± 0.008 | −0.000 ± 0.001 | −0.001 ± 0.001 | −0.005 ± 0.008 | −0.002 ± 0.001 |
    | heads-up, after a multiway flop | 307 (141) | −6.706 | −0.010 ± 0.010 | −0.010 ± 0.010 | −0.010 ± 0.010 | −0.010 ± 0.010 | −0.010 ± 0.003 | −0.019 ± 0.006 | −0.005 ± 0.011 | −0.022 ± 0.008 |
    | multiway | 289 (145) | −6.782 | +0.001 ± 0.002 | +0.001 ± 0.002 | +0.002 ± 0.002 | +0.003 ± 0.002 | −0.004 ± 0.002 | −0.008 ± 0.004 | +0.003 ± 0.002 | −0.004 ± 0.004 |
    | multiway, checked only | 213 (112) | −6.841 | +0.000 ± 0.003 | +0.000 ± 0.003 | +0.004 ± 0.002 | +0.004 ± 0.003 | −0.005 ± 0.003 | −0.011 ± 0.005 | +0.004 ± 0.003 | −0.003 ± 0.005 |
    | multiway, never checked | 67 (61) | −6.675 | +0.000 ± 0.000 | +0.000 ± 0.000 | −0.000 ± 0.000 | −0.000 ± 0.000 | +0.000 ± 0.000 | +0.001 ± 0.001 | −0.000 ± 0.000 | +0.001 ± 0.001 |
    | the hero's pots | 269 (115) | −7.073 | +0.002 ± 0.002 | +0.002 ± 0.002 | +0.002 ± 0.002 | +0.001 ± 0.002 | −0.004 ± 0.002 | −0.009 ± 0.004 | +0.003 ± 0.003 | −0.007 ± 0.004 |
    | pots without the hero | 1,139 (224) | −6.779 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.003 ± 0.003 | −0.005 ± 0.001 | −0.011 ± 0.002 | −0.000 ± 0.003 | −0.013 ± 0.003 |

    The held-out fits wander between the current trim and a harder one
    (× 1.25 in three folds, the current trim in one, × 1.5 in one; multiway
    alone value 0.3–0.5 with air 0.5, or × 1.5) and gain nothing held out:
    −0.002 ± 0.002 overall, whichever family. In sample the best cell on all
    river rows (× 1.25) is +0.001 ± 0.001. The current constants sit at the optimum, and the data does tell
    them from the alternatives: a softer trim loses (× 0.5 −0.005 ± 0.001,
    no trim −0.010 ± 0.002, keeping all value −0.011 ± 0.003), unlike the
    flop and turn, where the trim was too hard. A harder trim helps the
    players who only checked (+0.005 at × 1.5) by as much as it costs the
    check-callers (−0.016), the same trade in the other direction. Multiway
    rivers lean to a harder air trim (+0.003 to +0.004 on 289 rows), within
    two standard errors.
  - **`CHECK_REPEAT`** (Δ against 0.5; held out it picked 1 in two folds and
    0.75 in three):

    | rows | n (players) | `analysis/23` | held out | 0 | 0.25 | 0.75 | 1 |
    |---|---|---|---|---|---|---|---|
    | every row | 4,381 (244) | −6.885 | +0.001 ± 0.002 | −0.006 ± 0.002 | −0.003 ± 0.001 | +0.002 ± 0.001 | +0.002 ± 0.002 |
    | turn, everyone | 1,415 (237) | −6.870 | −0.003 ± 0.001 | −0.001 ± 0.002 | −0.000 ± 0.002 | −0.001 ± 0.001 | −0.003 ± 0.002 |
    | turn, checked after an earlier check | 769 (192) | −6.936 | −0.004 ± 0.002 | −0.000 ± 0.003 | +0.000 ± 0.002 | −0.002 ± 0.002 | −0.006 ± 0.004 |
    | river, everyone | 1,408 (236) | −6.835 | +0.005 ± 0.004 | −0.016 ± 0.004 | −0.008 ± 0.002 | +0.007 ± 0.003 | +0.008 ± 0.006 |
    | river, checked after an earlier check | 872 (199) | −6.847 | +0.004 ± 0.005 | −0.019 ± 0.004 | −0.010 ± 0.002 | +0.007 ± 0.003 | +0.002 ± 0.007 |

    The flop rows do not move (no check on the flop follows an earlier one).
    A weaker repeat discount (0.75) is a little better on the river and a
    little worse on the turn; held out +0.001 ± 0.002, nothing to ship.
  - **Not shipped.** Neither rule is met: the best held-out river candidate
    is −0.002 ± 0.002 against the current constants (the bar was more than
    two standard errors better), and `CHECK_REPEAT` held out is +0.001 ±
    0.002. `CHECK_VALUE`, `CHECK_AIR`, `CHECK_DRAW` and `CHECK_REPEAT` stay;
    no grade moves.
  - **Open.**
    - Most river checks are repeated checks (872 of 939), trimmed at half
      strength or less, so the score barely sees the river constants
      themselves; a first check on the river is only 67 rows (−0.03 ± 0.02
      for every alternative, too few to say anything).
    - A river grade the solver makes reads its ranges from the solve, so
      the river check trim reaches only approximate river grades, equity
      facts and the sensitivity check; and the hero's own heads-up rivers
      start from the turn solve where the turn was solved, which this study
      does not follow (it walks the heuristic from the flop).
    - Multiway rivers may want a harder air trim (value 0.3–0.5, air 0.5 in
      every fold, +0.002 ± 0.002 held out on 289 rows): worth another look
      with more multiway showdowns.
- 2026-10-15 — The library as an ordering of hands on multiway flops, held
  out: not shipped (study `tests/scripts/flop-library/multiwayOrdering.test.ts`,
  `npm run floplib:multiway-ordering`; the plan and line-following of
  `multiwayLibrary.ts`). No migration, no version bump; `ANALYSIS_VERSION`
  stays `analysis/23`.
  - **Why.** The open item of 2026-10-13: the library read multiway lost to
    the heuristic held out (−0.090 ± 0.018 per combo on the bettors and
    callers), and the suspected reason was the shares - a heads-up
    equilibrium bets and calls a different, more polarised, part of its
    range than multiway players. Untested there: keep the heuristic's
    multiway action shares and let the library decide only *which* combos
    carry them.
  - **Data.** The same 5,448 stored hands. Every opponent shown down after a
    flop three or more saw (the hero left out; no bomb pot): 676 flop rows
    (205 players) scored on their range as the turn came, 279 of them (138
    players) on a flop with a chunk; and 601 turn rows (195 players), every
    one of them who acted on the turn after a multiway flop (heads-up or
    not), scored on their range as the river came. 570 flop actions (every
    player's, shown or not) were narrowed by a hybrid. Score as
    `analysis/17`-`/23`: mean log-likelihood per combo of the shown combo, a
    combo outside the range at a twentieth of a uniform combo. Starting
    ranges as the analysis reads them.
  - **Method.** For each multiway flop action the library reads (2026-10-13's
    plan, roles and line; every other action, the turn and the river stay
    `analysis/23`'s heuristic), with H the heuristic's likelihood, S the
    library's frequency of the action for the combo (S′ = 0.03 + 0.97 · S)
    and w the actor's range, three hybrids with one parameter α each (α = 0
    is the heuristic):
    - geometric: L ∝ H^(1−α) · S′^α;
    - linear: L ∝ (1 − α) · H + α · S′ · Σw·H / Σw·S′;
    - rank: each combo's percentile in the range by H and by S is blended,
      (1 − α) · pH + α · pS, and the combo takes the heuristic's likelihood at
      that percentile (the heuristic's distribution of likelihoods in the
      library's order at α = 1);
    each rescaled so Σ w·L is the heuristic's Σ w·H (no L above 1: the scale
    by bisection with the cap), so the share of the range that takes the
    action is the heuristic's exactly. α ∈ {0, 0.1, 0.25, 0.5, 0.75, 1}, chosen
    held out per variant, and variant and α together ("any"): five folds by
    player (the earlier studies' hash), fitted on flop and turn rows
    together. Standard errors clustered by player. Baseline `analysis/23`.
  - **Measured** (Δ against `analysis/23` per combo; geometric and linear at
    α = 1 are the same model, the library's order at the heuristic's share;
    the last four columns are fixed candidates, not held out):

    | shown players | n (players) | `analysis/23` | geometric, held out | linear, held out | rank, held out | any, held out | geometric 0.5 | linear 0.5 | rank 0.5 | library order (α = 1) |
    |---|---|---|---|---|---|---|---|---|---|---|
    | flop and turn together | 1,277 (205) | −6.831 | 0 | 0 | −0.002 ± 0.005 | **−0.002 ± 0.005** | −0.030 ± 0.010 | −0.027 ± 0.008 | −0.030 ± 0.012 | −0.098 ± 0.019 |
    | flop, everyone | 676 (205) | −6.871 | 0 | 0 | −0.004 ± 0.005 | −0.004 ± 0.005 | −0.034 ± 0.010 | −0.030 ± 0.008 | −0.034 ± 0.013 | −0.103 ± 0.019 |
    | flop, a chunk read | 279 (138) | −6.710 | 0 | 0 | −0.009 ± 0.011 | −0.009 ± 0.011 | −0.082 ± 0.023 | −0.074 ± 0.018 | −0.082 ± 0.031 | −0.250 ± 0.045 |
    | flop, bet or raised | 162 (105) | −6.674 | 0 | 0 | −0.004 ± 0.008 | −0.004 ± 0.008 | −0.048 ± 0.016 | −0.066 ± 0.015 | −0.088 ± 0.042 | −0.172 ± 0.037 |
    | flop, called (no bet) | 162 (93) | −6.771 | 0 | 0 | −0.013 ± 0.016 | −0.013 ± 0.016 | −0.070 ± 0.029 | −0.050 ± 0.022 | −0.043 ± 0.026 | −0.187 ± 0.054 |
    | flop, checked only | 352 (157) | −7.007 | 0 | 0 | +0.001 ± 0.001 | +0.001 ± 0.001 | −0.011 ± 0.009 | −0.005 ± 0.007 | −0.004 ± 0.006 | −0.033 ± 0.017 |
    | flop, bet, raised or called, a chunk read | 130 (90) | −6.575 | 0 | 0 | −0.021 ± 0.025 | −0.021 ± 0.025 | −0.146 ± 0.043 | −0.145 ± 0.034 | −0.164 ± 0.063 | −0.447 ± 0.082 |
    | flop, checked only, a chunk read | 149 (96) | −6.828 | 0 | 0 | +0.002 ± 0.003 | +0.002 ± 0.003 | −0.025 ± 0.022 | −0.012 ± 0.016 | −0.011 ± 0.015 | −0.079 ± 0.040 |
    | flop, single raised, a chunk read | 172 (104) | −6.560 | 0 | 0 | −0.002 ± 0.016 | −0.002 ± 0.016 | −0.072 ± 0.027 | −0.059 ± 0.022 | −0.067 ± 0.038 | −0.217 ± 0.048 |
    | flop, limped, a chunk read | 102 (77) | −6.921 | 0 | 0 | −0.020 ± 0.011 | −0.020 ± 0.011 | −0.101 ± 0.034 | −0.098 ± 0.028 | −0.113 ± 0.041 | −0.310 ± 0.071 |
    | flop, 3-bet, a chunk read | 5 (5) | −7.560 | 0 | 0 | 0 | 0 | −0.044 ± 0.035 | −0.078 ± 0.048 | 0 | −0.176 ± 0.109 |
    | flop, the hero's pots | 140 (86) | −6.987 | 0 | 0 | −0.022 ± 0.015 | −0.022 ± 0.015 | −0.070 ± 0.022 | −0.064 ± 0.018 | −0.050 ± 0.027 | −0.172 ± 0.045 |
    | flop, pots without the hero | 536 (190) | −6.840 | 0 | 0 | +0.001 ± 0.004 | +0.001 ± 0.004 | −0.024 ± 0.010 | −0.022 ± 0.008 | −0.030 ± 0.014 | −0.085 ± 0.021 |
    | turn after a multiway flop | 601 (195) | −6.785 | 0 | 0 | −0.001 ± 0.005 | −0.001 ± 0.005 | −0.026 ± 0.012 | −0.024 ± 0.011 | −0.025 ± 0.012 | −0.091 ± 0.020 |
    | the same, a chunk read on the flop | 258 (134) | −6.690 | 0 | 0 | −0.003 ± 0.011 | −0.003 ± 0.011 | −0.060 ± 0.028 | −0.056 ± 0.026 | −0.059 ± 0.029 | −0.213 ± 0.047 |
    | turn, the hero's pots | 131 (81) | −6.906 | 0 | 0 | −0.011 ± 0.012 | −0.011 ± 0.012 | −0.062 ± 0.026 | −0.057 ± 0.021 | −0.027 ± 0.018 | −0.140 ± 0.046 |
    | turn, pots without the hero | 470 (181) | −6.752 | 0 | 0 | +0.001 ± 0.004 | +0.001 ± 0.004 | −0.016 ± 0.013 | −0.015 ± 0.013 | −0.025 ± 0.014 | −0.078 ± 0.022 |

    Every fold of the geometric and linear blends picks α = 0, the
    heuristic itself; the rank blend picks α = 0.1 or 0.25 (the smallest on
    the grid) and scores −0.002 ± 0.005 held out. In sample the best cell is
    rank 0.1 at +0.001. Every candidate loses more the more the library's
    order counts, monotonically, and at α = 1 (the library's order with the
    heuristic's share exactly) the bettors and callers on a chunk lose
    −0.447 ± 0.082, as much as 2026-10-13's library at ε = 0 (−0.50 ±
    0.12). So the shares were not the problem: with them fixed to the
    heuristic's, the heads-up strategy's *order* of hands is itself what
    explains multiway bettors' and callers' shown hands worse. The checkers
    barely move (a check's likelihood is close to 1 for most combos either
    way).
  - **Not shipped.** The held-out winner ("any", the rank blend at α 0.1-0.25)
    is −0.002 ± 0.005 against `analysis/23`, not more than two standard
    errors better; no variant is better anywhere by more than a standard
    error, and every fixed α ≥ 0.5 is worse on every subset with more than
    20 shown. The heuristic stays the multiway flop narrowing; no flag, no
    version bump, no grade moves.
  - **Open.**
    - The library's per-combo order on these flops is a heads-up order of
      the charts' heads-up ranges; a multiway reading would need a solve
      over three ranges (or multiway-specific chunks), not a reweighting of
      the heads-up one. Nothing cheaper is left to try from this library.
    - Coverage is unchanged: 279 of 676 shown flop rows sit on a chunk.
- 2026-10-15 — Opponents' statistics for every opponent analysed, not the
  200 biggest samples (`villain_counters`,
  `20270526090000_villain_counters.sql`; `lib/db/villainCounters.ts`).
  `ANALYSIS_VERSION` stays `analysis/23`; no grade moves on the measured
  library.
  - **Why.** `analysis/20`'s open item: the rebuild read one snapshot of
    `stats_opponents`, the opponents panel's report, which returns the 200
    biggest samples. A learner with more than 200 opponents of 30+ hands
    got the population range for everybody past the cap, silently.
  - **Change.** A read-only invoker function, `villain_counters(p_players,
    p_filters)`: the counters `villain.ts` reads (`hands`, `vpip_opp`,
    `vpip`, `pfr`) for exactly the `{site, player}` keys it is given, at
    most 500 per call, under `hand_stats`' RLS and `owner_id = auth.uid()`,
    with `stats_opponents`' rules (rooms with persistent names only, no bomb
    pots, the same `statsVersion` / `gameFormat` / `minHands` filters). No
    table grant changes, nothing `security definer`. The rebuild
    (`runAnalysis`) now collects the opponents of each chunk of hands before
    a worker analyses it and asks for theirs (cash games, at least 30 hands,
    the current statistics version), in calls of at most 500 keys; each
    player is asked once per run, a player in flight for another chunk is
    waited on (`VillainCounters`). The hand view's fresh analysis asks for
    its hand's opponents through a cache kept ten minutes. When
    `villain_counters` cannot be read (a database without it, a failed
    call) the run falls back to the old capped snapshot, never to nothing.
    The opponents panel and the Learn pool still read `stats_opponents`,
    unchanged.
  - **Measured** (the local test stack's 5,448 hands, counted Node-side
    with `handFacts` as the panel sums them; counts only): 287 opponents in
    cash hands, **172 with 30 or more hands, so none past the cap of 200**
    (the 200th-biggest sample is 23 hands). On this library the per-chunk
    counters are exactly the old snapshot's for every opponent a hand can
    look up, so the analysis' input is identical hand by hand and **no
    grade moves** (the analysis is deterministic in its input; nothing
    re-run for that reason).
  - **No version bump.** A library with 200 or fewer qualifying opponents
    (the owner's, and every library this could be measured on) gets
    byte-identical rows, so a bump would re-analyse every library for
    nothing. A library with more keeps its `analysis/23` rows, analysed with
    the population range for the opponents past the cap; every such row
    records the sample it was moved on (`SpotFacts.villain`, absent there),
    so nothing it shows is wrong about what it read, and the next version
    bump re-analyses it with every opponent's statistics. New hands are
    analysed with them from now on.
  - Tests: pgTAP `villain_counters.test.sql` (20: invoker, own rows only,
    the same counters as `stats_opponents`, filters, opaque-id never summed,
    the cap and malformed input refused, a second user, anon); Vitest
    `villainCounters.test.ts` (the hands' opponents once each, batches of at
    most 500 with 1,234 opponents all answered, each player asked once
    including one in flight, null with no statistics, a failed call
    forgotten and retried).
  - **Open.**
    - No library with more than 200 opponents of 30+ hands has been
      measured; when one exists, the grades its next bump moves are the
      measure of what the cap cost.
- 2026-10-16 — The coverage census, and three refusals of games the references
  cover, `analysis/24` (census `tests/scripts/flop-library/census.test.ts`,
  `npm run floplib:census`; fixes in `lib/charts/fromHand.ts`,
  `lib/analysis/preflop.ts`, `lib/analysis/flopLibrary.ts`; tests
  `tests/test/analysisCoverage.test.ts`). No migration.
  - **Why.** The cheap modelling ideas on the heads-up flop library are
    spent (2026-10-13 to 10-15: three not shipped). Before the next one,
    count where the hero's decisions go ungraded and why, and take the
    largest cause that needs no new flop-library solve (the machine is busy
    with the 6-max 150bb batch).
  - **Data.** The 5,448 stored hands of the test user (local stack), 8,005
    hero decisions in 5,339 hands with any (109 hands have no hero decision).
    Every hand analysed as the rebuild does: the chart library, the flop
    library from the local directory (the two shipped sets only; the 150bb
    set being solved there is never read), **turn solves on**, and every
    opponent's statistics summed over the file (`villain_counters`' sums).
    The whole file, no sample: 35 minutes in two processes, `nice`.
  - **The census** (`analysis/23`; "no grade" is analysed with facts and
    flags but no reference: a heads-up flop no chunk covers):

    | street | exact (chart, solver, library) | approximate | no grade | not analysed | all |
    |---|---|---|---|---|---|
    | preflop | 4,849 | 0 | 0 | 584 | 5,433 |
    | flop | 136 (14 exact chunks, 122 mapped) | 143 (`flop-realisation`) | 528 | 464 | 1,271 |
    | turn | 512 (48 `multiway-history`) | 76 (`turn-realisation`) | 0 | 216 | 804 |
    | river | 375 (64 `multiway-history`) | 23 (river `multiway-approx`) | 0 | 99 | 497 |
    | all | 5,872 (73.4%) | 242 (3.0%) | 528 | 1,363 | 8,005 |

    By table (seats): 9-max (7-10) 5,019 decisions, 73.3% graded exactly or
    approximately; 6-max (3-6) 2,986, 81.6%; no table of two seats, but 267
    decisions were dealt two-handed (224 on 8-seat tables), none graded
    preflop. By effective depth: 80-120bb 5,326 decisions, 77.8% graded;
    120-170bb 1,948, 76.1%; 170bb+ 633, 73.9%; under 80bb 98, 23.5%. Postflop at the decision: heads-up flops 136 of
    662 graded (525 no chunk), multiway flops 105 of 555 (450 `multiway`:
    checks and bets), heads-up turns 464 of 475, multiway turns 55 of 245,
    heads-up rivers 311 of 318, multiway rivers 17 of 98; turns and rivers
    that began heads-up after a multiway flop 139 of 165.
  - **Every cause, ranked** (hero decisions; preflop chart reasons with the
    lookup's detail):

    | cause | decisions | needs |
    |---|---|---|
    | heads-up flop, no chunk (no grade) | 528 | see below |
    | multiway check or bet (`multiway`) | 487 (flop 285, turn 141, river 61) | a multiway solver |
    | bomb pot (hand) | 262 | a bomb-pot model |
    | `chart-players`: heads-up (2 dealt) | 110 | a heads-up chart set |
    | `chart-players`: **a dead button** | 100 | nothing: fixed here |
    | `chart-off-tree`: **a poster's check** ("CO checks facing a bet") | 102 | nothing: fixed here |
    | `chart-off-tree`: the tree ends (squeeze tails, "no decision for SB") | 16 | a deeper tree |
    | `chart-stack-depth` (6-max under 32bb or 72-80bb; 9-max under 80bb) | 106 | chart sets at those depths |
    | tournament (hand) | 48 | ICM |
    | `chart-rare-line` (after the neighbouring depth) | 43 | longer chart solves |
    | `chart-cold-call` / `chart-multiway` / `chart-straddle` / other | 27 / 20 / 11 / 4 | bigger trees |
    | `turn-unreached` / `river-unreached` | 10 / 6 | nothing sound |
    | multiway side pot / re-raise; `*-multiway-flop` | 4 / 3; 4 | small |

    Of the 528 heads-up flops without a chunk: 274 the charts could not
    place - **104 where both players' lines placed, on sets of different
    depths** (fixed here, below), 64 heads-up hands, about 80 a player at a
    depth no set covers, the rest other refusals (rare lines, a poster's own
    check, cold calls); 128 on a set the library has none for (6-max 150bb
    66, 60bb 31, 200bb 13, the straddle set 6, 9-max 150bb 6, others 6); 103
    on lines the library does not solve (4-bet or longer 45, single raised
    37, 3-bet 11, limped 10); 23 other. Most of what is left needs solves: the library at
    other depths (150bb is being solved), more lines, a heads-up chart set.
  - **The three fixes** (none needs a solve):
    - **A dead button.** `assignPositions` names the live seats behind an
      empty button seat against a ring one longer with the button dropped
      (five players: SB, BB, UTG, HJ, CO), and no chart seat map took that
      (`chart-players`, "5 players dealt in (SB, BB, UTG, HJ, CO); the set
      is 6-max"). The game is the five-handed one with the cutoff in the
      button's place - it acts last before the blinds and last after the
      flop - so `preflopSpotFromHand` now maps such names onto the live ring
      of the same size (`liveNames`), for the hero's grade, every opponent's
      chart range and the flop library's placement. Exact: the same game,
      written another way (the test grades a dead-button hand and the same
      live-button hand: identical options, EVs and grade). Flagged
      `dead-button`.
    - **A poster's check.** A player sitting in posts a big blind from
      another seat and, unraised, checks: the tree has no check there ("CO
      checks facing a bet", `chart-off-tree`), so every decision after it
      was refused. In chips it is a limp of one big blind, and it is now
      read as one (`postedLimp`: a live post of exactly one big blind, no
      dead money, the street total one big blind). In range it is not: the
      poster holds any two cards, the charts' limper the range their limp
      tremble trained. Measured at the 77 nodes the owner's posters reach,
      the charts' limp range is far from any two (total-variation distance
      0.31 at the median, 0.78 at the 90th percentile; 25 of 77 within
      0.25), so these grades are **capped at Inaccurate** (`posted-blind`, as
      `rare-line-depth`), and the poster's own check stays refused (folding
      it costs the post, a limper's fold costs nothing).
    - **A flop pair across depths** (a bug in `analysis/9`). When the two
      flop players' own lookups land on sets of different depths, both are
      meant to be placed on the set nearest the pair's effective stack; the
      re-placement re-judged the deeper player's depth on that set against
      *their own* deepest opponent (often a third player who folded later),
      so a 100bb pair whose opener had a 150bb player behind was refused.
      Judged at the pair's effective stack now (every stack capped at the
      pair's), so the target set still refuses a pair 20% off its depth.
  - **Measured** (the census again at `analysis/24`, decision for decision
    against `analysis/23`, `CENSUS_BEFORE`):

    | | `analysis/23` | `analysis/24` | moved |
    |---|---|---|---|
    | preflop graded | 4,849 | **5,042** | +193: dead button 99 (Perfect 87, Inaccurate 3, Mistake 6, Blunder 3; 1 now `chart-rare-line`), poster 94 (Perfect 86, Inaccurate 8 of which 5 capped from Mistake or Blunder; 8 now `chart-multiway` or `chart-rare-line`) |
    | flop graded from the library | 136 | **163** | +27 (Perfect 20, Good 6, Mistake 1), all from the pair fix |
    | turn / river solver grades | 512 / 375 | 512 / 375 | 7 turn and 6 river grades move (their ranges now start from the library or the charts); one river newly solved, one now `river-unreached` |
    | all graded | 6,114 (76.4%) | **6,334 (79.1%)** | +220 |
    | not analysed or no grade | 1,891 | 1,671 | −220 |

    Preflop grades overall: Perfect 4,364 → 4,537, Inaccurate 202 → 213,
    Mistake 185 → 191, Blunder 81 → 84; 38 decisions keep their grade with
    other approximation flags (turn 19, river 12, flop 6, preflop 1). Examples: 6♥3♥ in the big blind four-handed
    behind a dead button, folding to the small blind's raise, Blunder (read
    as the live 4-handed blind battle); 3♦5♦ in the small blind four-handed,
    dead button, folding when it is folded to, Mistake; T♦Q♣ in the small
    blind seven-handed, dead button, folding to a lojack open and a hijack
    3-bet, Perfect; 9♦K♠ in the big blind raising after UTG limps and the
    hijack posts and checks, Inaccurate (`posted-blind`); J♣Q♦ on the cutoff
    c-betting 2♦9♣9♥ against the big blind, the two players' own lookups on
    the 150bb and 100bb sets (now the mapped `co-bb` chunk), Perfect.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/24`: two new approximation
    codes (`dead-button`, `posted-blind`, with their sentences in English and
    Croatian), the `posted-blind` cap, and the re-placement at the pair's
    stack. Charts, solvers and the library are unchanged; nothing else moves.
    The stored hands' positions are unchanged (the parser still names a dead
    button its way; stats read it as before).
  - **Open.**
    - The largest causes left need solves or models: 528 heads-up flops the
      library does not cover (the 6-max 150bb set being solved takes 66 of
      them, before the pairs that now re-place onto it), 487 multiway checks and bets, 262 bomb-pot decisions, 110
      heads-up preflop decisions (no heads-up chart set), 106 preflop at
      uncovered depths.
    - The poster's grade is capped because the charts' limper is not any two
      cards. A chart line with a forced any-two limper (or the limp tremble
      raised to any two at those nodes) would grade it uncapped.
    - The pair fix reads the deeper player's preflop range on the pair's
      set, at the pair's depth: the same approximation every placement
      within 20% already makes, not measured on its own.
- 2026-10-18 — A5b, the 6-max 150bb flop library live, `analysis/25`. No
  migration.
  - **The run.** All 12 6-max lines × 100 representative flops of the
    6-max 150bb set (`charts/4`, hash `f70ff13e`) solved on the owner's
    machine (~558 core-hours; sb-limp 100, btn-bb 82 the dearest): 1,200
    chunks, 81 MB, every solve below 1% of the pot (largest 0.99996%,
    300-iteration cap never reached, at most 280). Uploaded to the
    `flop-library` bucket with `upload.sh`; the manifest and **all 1,200
    chunks** (the 40-chunk sample among them) verified byte for byte from
    the public URL. A set is live once its manifest is in the bucket
    (`FlopLibraryLoader.ready`), so nothing registers it in code.
  - **Validation.** `--validate` has nothing to compare (only
    representatives are solved). Held out (`--validate --loo`, 552 pairs,
    each representative read from its nearest other one on the line),
    medians: strategy TV 17.5% (floor 7.2%), |ΔEV| 7.32% of the pot (floor
    1.87%), same top action 80.7% (92.2%), same check/call grade 72.9%
    (86.2%) — level with the 100bb set's 17.5%, 7.42%, 81.7%, 69.8%
    (2026-10-08).
  - **Measured** (5,448 stored hands, the local library, the two 100bb
    sets against the same plus 150bb):
    - `floplib:measure`: hero flop decisions graded from the library 163 →
      **211** of 1,095 (mapped 148 → 191, exact 15 → 20); the 48 new ones
      Perfect 34, Good 12, Inaccurate 1, Mistake 1.
    - `floplib:census` (turn solves on, `CENSUS_BEFORE` decision for
      decision): heads-up flops with no grade (no chunk) 501 → 453, by
      effective depth 120-170bb 141 → 98, 170bb+ 46 → 41, 80-120bb 304 →
      304; the 48 above are the only flop moves. Turn: one
      `turn-unreached` now solved (Good), 2 Good → Perfect, 3 Perfect →
      Good, 29 same grade with other approximation flags (their ranges now
      start from the 150bb chunk); river: 3 Good → Perfect, 1 Perfect →
      Good, 1 Good → Inaccurate, 23 flags only. All graded 6,334 → **6,383
      (79.7%)**.
    - The 2026-10-16 census (at `analysis/23`) counted 66 heads-up flops
      placed on the 150bb set without a chunk; 48 flops read a 150bb chunk
      now. Why the rest do not (a line the library does not solve, the stack outside
      `SPR_TOLERANCE`, the pair re-placed) is not broken down: the census
      rows carry no reason for a heuristic flop.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/25` (stored analyses re-run
    and read the new chunks). The census's default `CENSUS_SETS` now
    includes the 150bb set; the Learn "waits for the flop library" sentence
    names the three sets (English and Croatian).
  - **Fix.** `upload.sh` waited on its parallel uploads with a bare `wait`,
    which succeeds whatever the jobs did, so a failed chunk upload went
    unnoticed and the manifest was uploaded anyway. It now counts failed
    uploads and stops before the manifest. This run was unaffected (every
    chunk verified from the public URL).
  - **Open.**
    - The public Storage endpoint answered HTTP 429 to six parallel
      fetches during the verification (fine at two). The worker fetches a
      chunk per hand on demand and a failed fetch is the heuristic, silently;
      a large rebuild could lose library grades to rate limiting. Not
      measured in the app.
    - 453 heads-up flops still have no chunk: other depths (60bb, 200bb,
      9-max 150bb), longer lines (4-bet+), heads-up tables (2026-10-16).
- 2026-10-18 — The flop library loader rides out a rate-limited bucket
  (follow-up to the 150bb upload's open point). No `ANALYSIS_VERSION` bump,
  no migration: a chunk that is fetched grades as before.
  - **The fault.** A manifest fetch that failed (429, 5xx, a failed
    request) left the set empty for the worker's life, and a chunk fetch
    that failed was cached as absent: a large rebuild (the `analysis/25`
    re-run) could lose library grades to rate limiting, silently.
  - **Fix.** `FlopLibraryLoader` retries a 429, a 5xx or a failed request
    up to 4 times, 250 ms doubling with jitter (×0.5–1.5), or longer when a
    `Retry-After` asks (capped at 10 s). When the tries run out nothing is
    cached: that hand reads the heuristic and the next hand on the chunk
    (or set) fetches it again. A 404 is remembered as absent, as before.
    At most 2 fetches are in flight per loader (manifests and chunks
    together; "fine at two" in the verification), and callers of a chunk
    already in flight share its fetch. `LibraryFetch` gained an optional
    `status` and `headers`; test fetchers without them read as before.
  - **Open.** The cap is per loader: the analysis pool runs up to 4
    workers, each prefetching its page one hand at a time, so up to 4
    fetches reach the bucket at once. The retries cover that; not measured
    against the live bucket.
- 2026-10-18 — Heads-up charts, `charts/8`, `analysis/26`. No migration.
  - **Why.** The 2026-10-16 census ranked "`chart-players`: heads-up (2
    dealt)" at 110 hero preflop decisions, the largest preflop cause left
    that needs only a preflop solve (the machine-days go to the flop
    library).
  - **The tree** (`PreflopTreeConfig.headsUp`, docs/CHARTS.md §1.5). Two
    players, `SB, BB`; the small blind is the button, first to act preflop
    and last after the flop. The preflop action is the blinds' subgame of a
    bigger table, so the builder needed only a postflop rank per seat
    (`PreflopTree.postflop`), read by the in/out-of-position sizes, the
    solver's realisation roles and the measured spots. Sizes: open 2.5bb,
    the big blind's raise of a completion 4bb, 3-bet 10bb (4x out of
    position), the small blind's re-raise of a raised completion 12bb,
    4-bets 22bb (in position) / 30bb, 5-bet all-in. 10 action nodes, no cut.
    Trees of every other set are unchanged (the rank is `POSTFLOP_ORDER`
    without the flag; the 6-max 40bb set regenerated byte for byte).
  - **The set** `nlhe-cash-hu-100bb` (docs/CHARTS.md §6.9): A2c's pipeline,
    two measure-and-fit rounds from `charts/2`'s fit on seven heads-up spots
    (`HEADS_UP_REALISATION_SPOTS`, all measured both rounds), then 9,000
    iterations. **NashConv 0.001 mbb/hand** (0.011 at 3,000), every node
    kept, none unconverged: the standard of the other sets (2% self-loss bar,
    `excluded.unconverged` empty) met with room. 18 minutes on 3 threads,
    `nice`; a rerun writes the same bytes. 83 KB.
  - **What it plays.** The small blind continues 80.1% first in (raise
    58.0%, complete 22.1%), the big blind defends 65.4% against the 2.5bb
    open (call 40.5%, 3-bet 24.9%) and raises the completion 46.3%: the
    button enters most hands, the big blind defends most of them - the
    general heads-up principles, from our solver alone (no third-party
    chart used anywhere). Spot checks: the button opens K2o, A2o, T2s, 55
    and limps J4o, folds 32o; the big blind calls J7o, 3-bets A5s, T9s, AJo,
    QQ, folds 72o, Q5o and K2o to the open (narrower than a heads-up player
    might expect: the same flop-checked realisation as every set, §3.1
    known weakness, and 5% rake); AQo 4-bets 74%.
  - **Wiring.** `pickChartSet` reads two dealt in only on a set of two seats
    and never puts a bigger table on it (`seatMap`); the lookup rebuilds the
    heads-up tree (`model.tree.headsUp`). `seatsOfSet` / Reports / leaks know
    the heads-up seat order; the flop library has no heads-up lines
    (`flopLinesFor(2)` is empty, the heuristic's); the preflop trainer keeps
    to tables of three or more (`TRAINER_SETS`); the chart browser lists the
    set ("Heads-up, 100bb"). `chart-players` texts no longer say heads-up is
    refused (English and Croatian).
  - **Measured** (`floplib:census`, the 5,448 stored hands, turn solves on,
    decision for decision against the `analysis/25` rows of the same day):
    - The 110 heads-up preflop decisions: **65 graded** (Perfect 49,
      Inaccurate 5, Mistake 10, Blunder 1; raises 29, folds 18, checks 12,
      calls 6), **45 `chart-stack-depth`** (120-170bb 38, under 50bb 6,
      50-80bb 1). 36 of the 65 carry `stack-depth-near`, 2 `off-tree-size`.
    - Preflop graded 5,042 → **5,107**; preflop not analysed 391 → 326.
    - Postflop of those 105 hands: the opponents' ranges now start from the
      heads-up charts instead of the fallback ranges, so 20 turn and river
      grades move, all in heads-up hands (turn: Good → Mistake 3, Good →
      Inaccurate, Good → Perfect, Inaccurate → Perfect, Mistake → Good,
      Perfect → Good, Perfect → Inaccurate, Perfect → Mistake; river:
      Mistake → Perfect 3, Perfect → Good 3, Good → Perfect 2, Mistake →
      Good, Inaccurate → Good); 68 keep their grade with other flags
      (turn 39, river 29), and 14 ungraded flops change flags only.
      No decision gains or loses a grade postflop; no flop moves (no
      heads-up chunk). Nothing outside heads-up hands moves.
    - All graded 6,383 → **6,448** (80.5%).
  - **Shipped.** `CHARTS_VERSION` → `charts/8`, `ANALYSIS_VERSION` →
    `analysis/26` (grades change). `WEAK_CHART_VERSIONS` includes `charts/8`
    (the same model).
  - **Open.**
    - A heads-up 150bb set would take the 38 decisions at 120-170bb (one more
      ~20-minute solve); under 80bb there are 7.
    - The heads-up flops (64 hero decisions) have no flop-library lines; a
      heads-up `srp` / `3bp` / limped line set would be a new library batch.
    - The trainer and the study plan do not deal heads-up spots yet.
- 2026-10-18 — Heads-up 150bb charts, `charts/9`, `analysis/27`. No
  migration.
  - **Why.** After `charts/8` the largest heads-up preflop refusal left was
    `chart-stack-depth` at 120-170bb: 38 hero decisions (37 hands), the
    open item of the entry above.
  - **The set** `nlhe-cash-hu-150bb` (docs/CHARTS.md §1.5, §6.10): the
    heads-up tree and sizes of `charts/8` at 150bb (open 2.5bb, 3-bet 10bb,
    4-bets 22 / 30bb, 5-bet all-in). The 6- and 9-max 150bb sets keep their
    100bb sizes, and so does this one: nothing before the 5-bet comes near
    `allInAbove`. `sets.ts` builds both heads-up sets from one `headsUp(depth,
    version)`; the 100bb config is unchanged. Same pipeline and standard:
    two measure-and-fit rounds from `charts/2`'s fit on the seven heads-up
    spots (all measured both rounds), then 9,000 iterations. **NashConv
    0.001 mbb/hand** (0.011 at 3,000), 10 of 10 nodes kept,
    `excluded.unconverged` empty (2% self-loss bar). 17 minutes on 3
    threads under `nice`; a rerun writes the same bytes. 81,902 bytes.
  - **What it plays** (our solver only, no third-party chart): against
    100bb the button limps less and raises more (complete 12.5% / raise
    64.3%, was 22.1 / 58.0; continues 76.8%), the big blind defends a
    little wider against the open (67.7%, was 65.4; Q5o and 96o now call),
    and after a 4-bet the pots stay smaller: the big blind flats TT, AQo
    and AJo instead of shoving some, and the button calls a 150bb shove
    39.6% (was 53.5% at 100bb; QQ+, AK, TT call, AQo folds). Deeper
    stacks: more flatting, less stacking off, tighter calls of all-ins.
  - **Depth selection.** Nothing new in the lookup: heads-up reads only the
    heads-up sets, nearest depth by relative distance - 100bb up to 120bb
    (both 20% away there; the shallower, listed first, keeps it), 150bb from
    there to 180bb; under 80bb and over 180bb `stack-depth`. Rare lines and
    the opponents' ranges at an uncovered depth read the other heads-up set
    (`rareLineDepthSets`, `uncoveredDepthSets` stay within the table: never
    a 6-max set). Tests: `registry.test.ts` (the 120bb boundary, 181bb,
    the effective stack, the `stack-depth` note at 130bb), `headsUp.test.ts`
    (both sets' bands, a 150bb hand end to end, 200bb and 60bb refused),
    `analysisPreflop` / `analysisRanges` (the neighbour lists). The
    `uncovered-depth` detail says "heads-up" instead of "2-max".
  - **Measured** (`floplib:census`, the 5,448 stored hands, turn solves on,
    decision for decision against an `analysis/26` baseline run first; the
    baseline is byte-identical to the `charts/8` entry's rows):
    - The 38 heads-up preflop decisions at 120-170bb: **all 38 graded**
      (Perfect 26, Inaccurate 3, Mistake 9, Blunder 0; raises 20, folds 11,
      checks 6, call 1). 21 carry `stack-depth-near`, 1 `off-tree-size`.
      The Mistakes: four folds first in by the button (which plays 77% of
      hands at 150bb), one big-blind fold to the open, three raises, one
      check.
    - Heads-up preflop: 65 → **103 of 110 graded**; the 7 left are under
      80bb (`stack-depth`).
    - Preflop graded 5,107 → **5,145**. All graded 6,448 → **6,486**
      (81.0%).
    - Postflop, in those heads-up hands only: the opponents' ranges are
      read on their own depth instead of the 100bb set
      (`range-neighbour-depth` gone), so 11 turn and river grades move
      (turn: Mistake → Good 3, Perfect → Good 3, Good → Perfect; river:
      Good → Perfect 2, Perfect → Good 2) and 25 keep their grade with
      fewer flags (turn 13, river 10, flop 2). No decision gains or loses a
      grade postflop; no flop grade moves. Nothing else moves.
  - **Shipped.** `CHARTS_VERSION` → `charts/9`, `ANALYSIS_VERSION` →
    `analysis/27` (grades change). `WEAK_CHART_VERSIONS` includes `charts/9`
    (the same model). Texts name the heads-up depths (English and
    Croatian).
  - **Open.**
    - 7 heads-up decisions under 80bb (6 under 50bb): a 40bb heads-up set
      would need the short sizes (`SHORT`) and is not worth a solve for 7.
    - The heads-up flops still have no flop-library lines (entry above).
- 2026-10-18 — A5b, heads-up flop lines for the runner (nothing live, no
  `ANALYSIS_VERSION` change). No migration.
  - **Why.** The 64 hero flop decisions of heads-up hands (`charts/8`,
    `charts/9`) had no library lines (`flopLinesFor(2)` was empty).
  - **The lines** (`FLOP_LINES_HU`, from the heads-up tree's sizes): the
    small blind's 2.5bb open called (`sb-bb`, `rc`: pot 5, 97.5 behind at
    100bb), the limp checked (`sb-limp`, `ck`: 2 / 99), the 3-bet to 10
    called (`sb-bb-3bet`, `rrc`: 20 / 90), the limp raised to 4 and called
    (`sb-limp-raise`, `crc`: 8 / 96) and the 4-bet to 22 called
    (`sb-bb-4bet`, `rrrc`: 44 / 78); 50bb more behind at 150bb. The
    limp-raise re-raised (`crrc`) is left out (rare). The small blind is
    the button: it acts first preflop and last after the flop, so the big
    blind is player 0 (out of position) of every heads-up chunk.
  - **Fixes the reversal needed.** `flopPlayersOf` puts the big blind
    first on a two-seat table; `libraryEntry` orders the two players with
    `postflopFirst` (big blind first when two are dealt in; before, the
    small blind was always first, which would have read the hero's combos
    from the wrong player of a heads-up chunk); the trainer's script
    (`seatNumbers`) seats a heads-up table as button-small-blind on seat 1,
    big blind on seat 2, so `lineSpot` builds the spot from the analysis'
    own range walk as for the other tables.
  - **Coverage** (the 5,448 stored hands, `chunkFor` with every chunk
    assumed present): of the 64 heads-up flop decisions, 56 land on a line
    within `SPR_TOLERANCE` (100bb: sb-limp 18, sb-bb 16, 3-bet 0 + 1 out
    of tolerance, 4-bet 1, limp-raise 1; 150bb: sb-bb 11, sb-limp 7, 3-bet
    1 + 1 out, limp-raise 1), 6 are not placed preflop (stack depth).
  - **Pilot** (Ts7h4d, scratch out dir, `nice -n 10`, ≤3 solves at a time):
    100bb sb-bb 100 iterations, 0.82% of the pot, 42 min, peak 2.34 GB;
    sb-bb-3bet 80 it., 0.98%, 12 min, 0.79 GB; sb-bb-4bet 40 it., 0.69%,
    1 min, 0.35 GB; 150bb sb-bb-4bet 60 it., 0.83%, 2.7 min, 0.47 GB. The
    analysis reads each chunk (both players, `source: "solver"`, exact).
  - **Estimate.** 100bb (`--estimate`, fitted on the three): **~134
    core-hours**, 47 MB, up to ~2.1-2.4 GB resident (sb-bb); per line sb-bb
    43, sb-limp 37, limp-raise 24, 3-bet 20, 4-bet 11. The fit is linear in
    the work proxy and the 6-max limped pot took 2.6× its proxy's share,
    so sb-limp is likely nearer 90 and the set nearer 190 core-hours.
    150bb: fitted on the 4-bet alone it says 41, too low; the 6-max sets'
    ratio (558 / 281 core-hours) puts it at **~270-380**. Both sets: about
    a week of the nightly runs at 6 solves.
  - **How it runs.** `npm run floplib -- --set nlhe-cash-hu-100bb`, then
    `--set nlhe-cash-hu-150bb` (README). Nothing reads a set until its
    manifest is uploaded (`upload.sh`); that upload is the grade change
    (`ANALYSIS_VERSION`).
- 2026-10-19 — Bomb pots, `analysis/28` (fix in `lib/analysis/rangeWalk.ts`,
  `lib/analysis/analyze.ts`; study `tests/scripts/flop-library/bombPots.test.ts`,
  `npm run floplib:bomb-pots`; tests `tests/test/analysisBombPot.test.ts`).
  No migration.
  - **Why.** The census (2026-10-16) ranked 262 bomb-pot hero decisions as
    the largest cause left that might need no new solve: every bomb pot was
    refused whole (`bomb-pot`).
  - **How the parser marks them.** All 129 are WePlay "Liverpool / Niš Bomb
    Pot (3BB-5BB)" tables (8 seats, cash). Every dealt-in player posts an
    `ante` of 3-5bb (no `bomb-ante` action, no blinds), there is no preflop
    action at all, and `game.bombPot` is set (`dealtToStreet: flop`;
    `doubleBoard` on 3 hands). `StatsContext.isBombPot` reads it from the
    stream (two or more antes and no blind); the pot type is `bomb`.
  - **The 262 decisions** (the `analysis/27` census rows, `reason:
    bomb-pot`): 129 hands, all 9-max tables, 3-8 dealt in (8: 56 hands, 7:
    27, 6: 19, 5: 11, 3-4: 16); every flop is seen by everyone, so **every
    one is a multiway flop**. By street flop 175, turn 58, river 29; by
    action check 108, fold 99, bet 28, call 22, raise 5; facing a bet 126.
    Players at the decision: 2 (heads-up after folds) 34, 3-4 76, 5-8 152.
    The pot at the flop is 9-40bb (median 26), the effective stack 94-234bb
    (median 109; depth bands 80-120bb 166 decisions, 120-170bb 69, 170bb+
    27), so the flop SPR is 2.6-12.9 (median 4.5; under 4: 47 hands, 4-6:
    52, 6+: 30) - shallow, as bomb pots are meant to be. By what could
    grade them: calls and folds facing a bet on the multiway flop and the
    multiway turn and river 113 (the approximate grades), heads-up turns
    and rivers after the multiway flop 21 (the heads-up solves), checks,
    bets and raises three or more ways 127 and one heads-up flop raise
    (nothing grades them); 6 of the 262 are in the 3 double-board hands.
  - **The model.** A bomb pot has no preflop action, so every player's
    preflop range is **any two cards** - not a guess but the rules: all
    1,326 combos, the board and the hero's cards removed as everywhere.
    `preflopClassRange` returns it for every seat of a bomb pot (source
    `chart`: nothing placeholder about it; label `unknown:<position>`, "any
    two cards"). Nothing else is new: the multiway walk narrows those
    ranges with the shipped heuristic (`heuristic/2+mw`, the `analysis/22`
    check trims), a call or fold facing a bet gets the multiway approximate
    grade (`flop-realisation`, `turn-realisation`, the river's showdown EV),
    a turn or river that began heads-up the heads-up solve
    (`multiway-history`), and multiway checks and bets stay `multiway`.
    Every such grade is already capped at Mistake (flop and turn always,
    river and the solves unless the move is dominated). Every decision of a
    bomb pot carries the new flag **`bomb-pot`** (instead of `antes`: the
    antes are the pot, which every model reads as it is). A bomb pot on two
    boards (`doubleBoard`, or more than one runout) is still refused: each
    board plays for half the pot, which no model here reads. The flop
    library never reads a bomb pot (the charts refuse it, `chart-bomb-pot`).
  - **Validation: the realised ranges** (`floplib:bomb-pots`, the 5,448
    stored hands, the hero left out). Every opponent who acted on a flop
    three or more saw and showed their cards, scored on the narrowed range
    at the turn's and the river's start: log-likelihood of the shown combo
    (floor a twentieth of a uniform combo, as `analysis/17`-`/23`) minus
    its log-likelihood in the unnarrowed starting range (board removed) -
    the **lift**, what the narrowing explains, since the two kinds of pot
    start from very different ranges. Clustered by player. Nothing is
    fitted (no parameter was ever set on a bomb pot), so the whole sample
    is held out.

    | turn start | bomb pots | other multiway pots |
    |---|---|---|
    | everyone who acted on the flop | **+0.461 ± 0.091** (65 shown, 45 players) | +0.131 ± 0.025 (676, 205) |
    | bettors, raisers, callers | +0.758 ± 0.122 (40) | +0.285 ± 0.050 (324) |
    | checkers only | −0.015 ± 0.036 (25) | −0.011 ± 0.009 (352) |
    | shown combo outside the range | 0 of 65 | 81 of 676 (12.0%) |

    At the river's start: bomb pots +0.510 ± 0.155 (48 shown; bettors and
    callers on the flop +0.557 ± 0.258), other multiway pots +0.149 ±
    0.036 (604), outside the range 2 of 48 (4.2%) against 11.4%. The
    heuristic explains shown bomb-pot hands at least as well as it explains
    the ordinary multiway pots its grades already ship on - more, since any
    two cards leaves more to explain and nothing to get wrong preflop - and
    over-trims checks equally little in both. **The bar (not worse than the
    multiway heuristic on normal pots) is met.**
  - **Spot check** (`BOMB_GRADES=1`, all 97 grades read; ten here): 9♦8♣
    folding K♣K♦7♥ to half the pot three-way, Perfect; Q♠Q♣ folding
    3♥7♣6♦ to two thirds of the pot three-way, Mistake (19.6bb); Q♦Q♥ folding
    9♣6♣4♣ to a fifth of the pot, Mistake; K♦T♣ folding a full house
    (A♠K♠K♥A♥2♦) to a river bet heads-up, Mistake (capped from Blunder,
    `range-cap`); 3♣3♥ calling a flop bet four-way with bottom set, Perfect;
    4♣4♠ calling the turn with quads, Perfect; 4♠3♥ folding A♣K♣6♦ to a
    large bet four-way, Perfect; J♣K♣ calling a flop bet four-way with top
    pair and a flush draw, Perfect, and the heads-up turn call after it,
    Perfect. Two read harsher than a player would: K♣Q♣ folding a gutshot
    to two thirds of the pot four-way on T♣3♠A♦, Mistake (capped, `range-cap`; 1.8bb beyond the
    5% margin), and J♦T♥ folding a gutshot on a monotone K♠8♠7♠ to a third
    of the pot, Mistake (capped; 2.2bb) - the bettor's range narrowed from any two
    cards stays wider than such bettors usually are. Both are labelled
    approximate and capped; neither is a Blunder.
  - **Measured** (`floplib:census`, turn solves on, decision for decision
    against the `analysis/27` rows):
    - The 262 bomb-pot decisions: **97 graded** - 80 approximate (flop 56:
      Perfect 48, Inaccurate 1, Mistake 7; turn 17 Perfect; river 7
      Perfect) and 17 heads-up solves (`multiway-history`; turn Perfect 4,
      Good 4; river Perfect 4, Good 3, Mistake 2); 158 not analysed:
      `multiway` 124 (checks 102, bets 19, raises 3), `multiway-crowded` 33
      (calls and folds with more than three players still to answer),
      `multiway-side-pot` 1; 1 heads-up flop raise analysed with no grade
      (no chunk); 6 still `bomb-pot` (the 3 double-board hands).
    - **No other decision moves** (8,005 rows, outcome, grade, reason and
      flags identical outside the bomb pots).
    - All graded 6,486 → **6,583 (82.2%)**; approximate grades 242 → 322.
      The approximate flop grades of bomb pots are Mistake more often (7 of
      56) than other multiway flops' (4 of 143): wide ranges make a fold of
      a medium hand cost more, which is what the spot check shows.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/28`; the `bomb-pot`
    approximation with its sentence (English and Croatian); the hand
    reason `bomb-pot` now reads "Bomb pot on two boards".
  - **Open.**
    - 124 multiway checks, bets and raises in bomb pots wait for whatever grades
      multiway checks and bets elsewhere (the same `multiway` cause, now
      611 decisions).
    - Bomb pots on two boards (3 hands): each board's half-pot would need
      the approximate EVs per board.
    - The realisation factors were measured on heads-up pots with preflop
      ranges; in a bomb pot the ranges are wide and the SPR low. Not
      measured apart (only 56 flop grades).
- 2026-10-19 — Multiway checks and bets: **nothing shipped** (study
  `tests/scripts/flop-library/multiwayBets.test.ts`,
  `npm run floplib:multiway-bets`; study code `multiwayRiver.ts` beside it).
  `ANALYSIS_VERSION` stays `analysis/28`; no migration, no behaviour change,
  nothing in `frontend/`.
  - **Why.** The largest "not analysed" cause left after the bomb pots: the
    hero's checks, bets and raises three or more ways (`multiway`), **611**
    in the `analysis/28` census - flop 370 (check 339, bet 27, raise 4), turn
    168 (127, 33, 8), river 73 (53, 17, 3). Calls and folds facing a bet have
    approximate grades (`analysis/15`-`/17`, `/28`); these have none.
  - **Where they are** (the hero's multiway flops, `analyzeHand` at
    `analysis/28`; 605 of the 611 found this way): flop checks with players still to act 286, flop checks
    as the last to act 50, flop bets 26; turn checks 107 and 19, bets 33;
    river checks 45 and 8, bets 17 (64 of the river's 70 with at most three
    opponents and nobody all-in); raises 14. Nearly two in three are flop and
    turn checks with a player still to act.
  - **Three-way solves: not available.** `lib/solver` is a two-player DCFR
    (`game.ts`, `tree.ts`, `cfr.ts`: `player: 0 | 1` throughout, a heads-up
    showdown); a three-player river solver is a new solver, not a small tree
    on the existing one, so there is no multiway ground truth to measure
    against.
  - **Flop and turn: no candidate.** The EV of a check or a bet with cards to
    come needs what a *checked* pot and a *bettor who is called* go on to
    win. The shipped realisation tables (`floplib-r/2`, `turnsolve-r/1`)
    measure only a caller facing a bet, heads-up; nothing measures the other
    two, and both heads-up-to-multiway transfers tried so far lost held out
    (2026-10-13, 2026-10-15). So the study takes the river, where nothing is
    left to come and a check or a bet against fixed ranges is a small tree.
  - **The river model** (`multiwayRiver.ts`). At a hero river decision not
    facing a bet: the EV of checking and of betting a third, two thirds or a
    pot (or the size bet), net from the decision, against the walked ranges
    (as the river call grades read them, the hero's cards removed, slivers
    pruned). A bet: every opponent answers in turn (players behind first,
    then those who checked), calling or folding; callers' ranges are their
    calling ranges; nobody raises; everyone folding wins the pot. A check:
    as the last to act, the showdown share of the pot; with players behind,
    each in turn bets 56% of the pot (the stored hands' median river bet
    three or more ways; quartiles 41% / 86%) or checks, the hero then calls
    or folds, whichever is better, the others answering, and if all check,
    the showdown against the checked ranges. Two models of how the field
    plays it:
    - **the theory** - the narrowing model's own answers: the MDF split for
      calls, the heuristic's betting share for bets. This is what the
      multiway call grades assume for the players still to answer;
    - **the population** - two logistic models fitted on every player of the
      stored hands (the hero too): P(call or raise) facing a bet by street,
      log size per street, players to answer, a call before, only folds
      before, and whether the player had checked to the bettor; P(bet) when
      not facing a bet by street, players, a check before, last to act. The
      calling range is the top of the range by strength against the field at
      that share (the heuristic's call shape with its cut moved), the betting
      range the heuristic's betting shape rescaled to that share.
    The would-be grade: the chosen option's EV loss against the best option
    under each field, the **smaller** of the two (both must say it loses),
    beyond 5% of the pot, capped at Mistake - the convention of the
    approximate calls.
  - **Data.** The 5,448 stored hands of the test user (local stack); 1,253
    flops three or more saw (bomb pots on one board included). 1,267 bets
    with two or more players to answer them (3,138 answers), 5,942 decisions
    not facing a bet with three or more live (1,275 bets). Five folds by
    hand; standard errors clustered by hand.
  - **Measured 1: the field's answers, held out.** The theory over-predicts
    calls by two thirds; the population model is calibrated:

    | | called (observed) | theory | population, held out | log-loss theory − population |
    |---|---|---|---|---|
    | every answer (3,138) | 0.320 ± 0.009 | 0.520 | 0.321 | **+0.123 ± 0.010** |
    | flop (1,940) | 0.322 ± 0.011 | 0.500 | 0.323 | +0.097 ± 0.011 |
    | turn (893) | 0.335 ± 0.017 | 0.586 | 0.335 | +0.181 ± 0.022 |
    | river (305) | 0.262 ± 0.026 | 0.455 | 0.267 | +0.115 ± 0.026 |
    | river, checked to the bettor (120) | 0.200 ± 0.037 | 0.498 | 0.214 | +0.199 ± 0.051 |
    | turn, after folds only (314) | 0.264 ± 0.026 | 0.650 | 0.309 | +0.348 ± 0.043 |

    Everyone folding, per bet (a raise counts as not folding): flop 0.374 ±
    0.019 observed, theory 0.165, population 0.347; turn 0.420 ± 0.026,
    0.128, 0.388; river 0.558 ± 0.044, 0.262, 0.514 (a pot or more: 0.829 ±
    0.065, 0.401, 0.672 - the population model too low there, 2.5 SE). Bets
    when not facing one: 0.215 ± 0.005 observed, theory 0.440, population
    0.216 (log-loss +0.135 ± 0.006); river 0.198 ± 0.015, 0.317, 0.200.
    The extra features (only folds before, checked to the bettor) are worth
    +0.005 ± 0.002 over street, size, players and a call before. **The fold
    half of the model holds held out.**
  - **Measured 2: the showdown share, held out (nothing in it is fitted).**
    The player who shows first - at a river checked through three or more
    ways the first to act, at a called river bet the bettor - is shown
    whatever they hold (every one of the 134 and 45 here was), so their share
    against the others' ranges can be set against the share they won without
    selecting on the result. One pot, nobody all-in.

    | | n | won | narrowed ranges | won − predicted | against the preflop ranges | against any two cards |
    |---|---|---|---|---|---|---|
    | checked through, three or more | 134 | 0.424 ± 0.042 | 0.245 | **+0.178 ± 0.030** | 0.242 (+0.182 ± 0.033) | 0.292 (+0.132 ± 0.032) |
    | the same, predicted under 0.3 / 0.3-0.7 / over 0.7 | 88 / 36 / 10 | 0.196 / 0.819 / 1.000 | 0.084 / 0.467 / 0.871 | +0.11 / +0.35 / +0.13 | | |
    | heads-up control, checked through | 375 | 0.532 ± 0.025 | 0.422 | +0.110 ± 0.020 | 0.447 (+0.085 ± 0.020) | 0.538 (−0.006 ± 0.020) |
    | called bet, three or more: population calling ranges | 45 | 0.622 ± 0.071 | 0.421 | +0.201 ± 0.048 | | |
    | the same, the theory's (MDF) calling ranges | 45 | | 0.556 | +0.066 ± 0.041 | | |

    Against any two cards the heads-up share is exact (−0.006 ± 0.020), so
    the arithmetic holds; against the walked ranges it is **too low by 0.11
    heads-up and 0.18 multiway** - the opponents' ranges at a checked river
    are much stronger than what they turn over, multiway even stronger than
    any two cards. The narrowing barely changes it (0.245 against 0.242 on
    the preflop ranges): the checks keep too much value, and the starting
    ranges are not what reaches a checked river. A probe with every check's
    likelihood squared or raised to the fourth (`L^k`, not the analysis'
    narrowing): on the river only +0.169 / +0.154; on every street +0.147 /
    +0.087 ± 0.029 (heads-up +0.082 / +0.032 ± 0.020). No simple harder trim
    closes the multiway gap.
  - **Measured 3: the whole EV on the hero's 64 decisions** (river checks and
    bets in scope, the population fitted without the hand's fold): won from
    the decision on 0.377 ± 0.069 of the pot, population EV 0.292 (won −
    predicted +0.085 ± 0.063), theory 0.278 (+0.100 ± 0.067); checks +0.102 ±
    0.056 (48), bets +0.035 ± 0.193 (16). Low in the same direction as the
    share, and too few to tell the two fields apart.
  - **The would-be grades** of the 64 (held-out fits, no sensitivity check):

    | | Perfect | Inaccurate | Mistake |
    |---|---|---|---|
    | both fields (the smaller loss) | 61 | 2 | 1 |
    | the population alone | 33 | 7 | 24 |
    | the theory alone | 56 | 1 | 7 |

    The two fields disagree on 33 of the 64 and agree that a move loses on
    3. The disagreement is the bluff: with the population folding 30-75% of
    the time to a bet (most to a pot-sized one as the last to act), betting
    air is worth up to 7bb more than checking it, so the population calls 21 of 48 checks Mistakes ("should have
    bluffed"); the theory, folding a quarter to half as often, says those
    bets lose. Read one by one (all 64; ten here):
    - A♠K♦ checking behind on T♠6♦5♥8♣7♠, three-way: population Mistake
      (26% of the pot: a pot-sized bet 3.5bb, the check 0.55bb), theory
      Perfect (the bet 0.08bb). Both read ace-high's share at 6%.
    - A♥Q♠ checking behind on J♥2♣6♠3♦K♦: population Mistake (25%), theory
      Perfect. Same story; the hero lost the pot.
    - 5♥6♥ checking in a bomb pot on 9♣7♣3♠A♦2♠ (no pair, 42bb): population
      Mistake (11%, a pot bet +6.8bb), theory Perfect (every bet loses).
    - 4♦4♥ betting half the pot as the last to act on T♦8♦A♦8♠T♠ (counterfeited):
      population Perfect (+2.0bb against 0.7 for the check), theory Mistake
      (3.5%). The hero won the pot.
    - T♣J♣ betting 62% as the last to act on J♦5♠K♠2♦8♠ (second pair): both
      Mistake (8.5%: the check 8.3bb, the bet 6.0bb) - the bet is read as
      folding out worse and getting called by better. The hero won the pot. The
      check's 8.3bb rests on a 52% share that the measured bias says is low,
      and the bet's called share is lower still.
    - K♦T♦ (two pair) betting a pot into two players on 8♥A♥4♣T♣K♣:
      population Mistake (8.9%), theory Perfect. The hero lost the bet.
    - J♣K♠ (trips) betting half of 124bb as the last to act in a bomb pot on
      9♥3♦J♥J♠8♠: population Inaccurate (the check 85.7bb, the bet 77.3bb),
      theory Perfect (the bet 103bb). The hero lost the bet.
    - 4♣4♠ (quads) betting a fifth of 87bb in a bomb pot on Q♠4♥4♦K♣2♣ with
      players behind: theory Mistake (16%: checking to let them bet, 122.6bb),
      population Inaccurate (0.8%); both Inaccurate.
    - 9♥9♠ checking 62bb in a bomb pot on 7♠6♦5♦5♥K♣ with players behind:
      theory Mistake (7.7%: a third-pot bet +7.8bb), population Perfect.
      The hero lost the pot.
    - A♠7♠ (top pair) checking on 6♥K♣9♣5♦A♦ with players behind: theory
      Mistake (10.9%, bet a third), population Inaccurate (0.1%); both
      Inaccurate. The hero won the pot.
  - **Not shipped.** The bar was a held-out check of the model's fold rate
    and equity, ± SE. The fold rate holds (the population model, against a
    theory that is two thirds too sticky); **the equity does not**: the
    showdown share against the walked ranges is low by 0.18 ± 0.03 of the
    pot at multiway checked rivers (six standard errors) and by 0.20 ± 0.05
    at called bets with the population's calling ranges. An EV of a check or
    a bet is a difference of two such shares; a model off by a fifth of the
    pot cannot grade a choice that a 5% margin is meant to protect. Requiring
    both fields to agree would grade 64 decisions as 61 Perfect - Perfect by
    default (one field always likes the other move), not by knowledge - and
    3 others; that inflates Perfect for 10% of the cause and grades nothing
    on the flop or turn. Nothing ships; `multiway` stays the reason for all
    611.
  - **Open.**
    - **The walked ranges are too strong at a checked river** (+0.11 ± 0.02
      heads-up, +0.18 ± 0.03 three or more ways, the share of the first to
      show). The check-trim studies (`analysis/22`, `/23`, 2026-10-14) scored
      *which* combos a range holds (log-likelihood) and did not see it; a
      share-at-showdown criterion scores *how strong* the range is. Every EV
      read on walked ranges carries it: the multiway river call grades
      (`analysis/7`), the flop and turn approximate calls, and the ranges the
      heads-up turn and river solves start from. A narrowing study with this
      criterion (held out, with the log-likelihood as a guard) comes first;
      it moves other grades, so it is a version of its own.
    - **The players still to answer in the approximate call grades** answer
      by the MDF split (the theory): each calls 0.45-0.59 of the time where
      the stored hands' players call 0.26-0.34 (held out, log-loss +0.12 ±
      0.01 better for the population model). The call EVs therefore assume
      more overcalls than happen. Swapping the population model in moves
      shipped call grades - a version of its own, after the range strength.
    - The river model and both field models are in `multiwayRiver.ts`; with
      calibrated ranges it can be re-run as it is (the EV residual, the
      would-be grades and the disagreement table are the bar).
    - Flop and turn checks and bets (538 of the 611) need the realisation of
      a checked pot and of a called bettor; Rail's heads-up library and turn
      solves could measure both heads-up (as `floplib-r` and `turnsolve-r`
      did for the caller), but the multiway transfer is the open question it
      always was.
    - A three-player river solver (the only exact reference) would be a new
      solver (three ranges, a three-way showdown per terminal); not costed.
- 2026-10-20 — The players behind a multiway call, `analysis/29` (study
  `tests/scripts/flop-library/multiwayOvercall.test.ts`,
  `npm run floplib:multiway-overcall`; `populationResponders` in
  `lib/analysis/multiway.ts`). No migration.
  - **Why.** The open item of 2026-10-19 (multiway checks and bets): in the
    approximate call and fold grades (`analysis/15`-`/17`, `/28`) the
    players still to answer behind the hero's call answer by the MDF split,
    and on the stored hands players call far less often than that. That
    entry measured every answer to a first bet; the grades need a narrower
    thing - a player still to answer **after someone has called** - so this
    study measures exactly that, with the theory computed as the shipped
    call computes it.
  - **Data.** The 5,448 stored hands of the test user (local stack). At every
    call facing a bet in a pot three or more saw the flop of (one board, bomb
    pots included, every player as the caller), the one to three players
    still to answer behind it, each one's next action until someone raises:
    continue (call or raise) or fold. **667 answers** (414 hands, 177
    players): 638 behind a call of a bet, 29 behind a call of a raise. The
    theory for each is the narrowing model's call share with the caller as
    the hero (the same ranges, players, size and pruning as `callEv`). Five
    folds by hand and five by the answering player's name; standard errors
    clustered by hand (by player for the player folds).
  - **Measured 1: how often they continue.**

    | behind a call | n | continued | theory |
    |---|---|---|---|
    | every answer | 667 | 0.328 ± 0.021 | 0.494 |
    | of a bet | 638 | 0.307 ± 0.021 | 0.490 |
    | of a raise | 29 | 0.793 ± 0.087 | 0.584 |
    | flop | 431 | 0.325 ± 0.024 | 0.471 |
    | turn | 191 | 0.351 ± 0.042 | 0.562 |
    | river | 45 | 0.267 ± 0.075 | 0.424 |

    By fifths of the theory's share (behind a bet): 0.32 → continued 0.16,
    0.41 → 0.24, 0.48 → 0.28, 0.56 → 0.42, 0.68 → 0.43. **The theory ranks
    the spots right and is too high everywhere**: where it says a player
    calls more, they do, at about two thirds of the level.
  - **Measured 2: candidates held out** (log-loss per answer, theory minus
    candidate, positive = the candidate is better; every answer):

    | candidate | parameters | log-loss gain, by hand | by player | Brier gain |
    |---|---|---|---|---|
    | one rate per street | 3 | +0.024 ± 0.019 | +0.022 ± 0.020 | +0.012 ± 0.009 |
    | street × bet size (four buckets) | 12 | +0.025 ± 0.019 | +0.024 ± 0.019 | +0.012 ± 0.009 |
    | street × size × one or two-plus behind | 24 | +0.034 ± 0.019 | +0.033 ± 0.019 | +0.016 ± 0.009 |
    | logistic: street, log size, players behind | 7 | +0.024 ± 0.018 | +0.020 ± 0.023 | +0.013 ± 0.008 |
    | street × size, behind a bet only (the theory behind a raise) | 12 | +0.038 ± 0.019 | +0.039 ± 0.020 | +0.019 ± 0.009 |
    | the theory recalibrated per street, every answer | 4 | +0.056 ± 0.015 | +0.055 ± 0.018 | +0.026 ± 0.007 |
    | recalibrated, one intercept, behind a bet only | 2 | +0.068 ± 0.015 | +0.068 ± 0.018 | +0.031 ± 0.007 |
    | recalibrated, a slope per street, behind a bet only | 6 | +0.067 ± 0.015 | +0.064 ± 0.019 | +0.030 ± 0.007 |
    | **recalibrated per street, behind a bet only (shipped)** | **4** | **+0.070 ± 0.015** | **+0.068 ± 0.018** | **+0.032 ± 0.007** |

    The flat tables fix the level but throw away the theory's ranking, and
    gain barely one standard error; recalibrating the theory keeps both:
    `logit p = a[street] + b · logit m`, `m` the model's share, fitted on
    the 638 answers behind a bet: **a = −0.692 flop, −1.094 turn, −0.685
    river, b = 1.066** (fitted without each fold: b 0.93-1.20, the flop's a
    −0.63 to −0.73). A slope near 1 is a shift of the odds: a call's odds
    times about a half on the flop and river, a third on the turn. Behind a
    bet the shipped candidate gains +0.073 ± 0.016 (by player +0.071 ±
    0.019), **4.6 and 3.7 standard errors**; by street flop +0.049 ± 0.015
    (predicted 0.324, continued 0.325), turn +0.120 ± 0.034 (0.336 / 0.351),
    river +0.052 ± 0.042 (0.293 / 0.267, 45 answers). Behind a call of a
    **raise** every candidate fitted on everything loses (−0.28 to −0.34 ±
    0.10: they continue 0.79 of the time, more than the theory's 0.58), so
    there the model's own share stays; 29 answers are too few to fit.
  - **Which hands call.** Only the frequency moves; each player's calling
    range is the model's, weighted by the new chance. The alternative - the
    model's likelihood raised to the power that puts it at the lower share,
    a tighter range - was scored at the 45 called multiway river bets where
    the bettor shows first (2026-10-19's check): the bettor won 0.622 ±
    0.071 of the pot, predicted against the model's calling ranges 0.556
    (won − predicted +0.066 ± 0.041), against the tightened ones +0.070 ±
    0.042 (squared error −0.005 ± 0.004): no better, and 2026-10-19's
    top-of-the-range version was +0.201 ± 0.048. The power transform also
    cannot go below the mass the heuristic's call likelihood puts at 1 (the
    hands between the cut and the top 5%), which on real ranges is often
    above the target.
  - **The grades.** Every hero decision of the 443 multiway-flop hands with
    the hero in, analysed with the theory and with the recalibration fitted
    without the hand's fold (no library), and the census at `analysis/28`
    against `analysis/29` (flop library on, `CENSUS_SETS` the three shipped
    sets, 8,005 hero decisions, row by row against the bomb pots' rows of
    2026-10-19): **only multiway call and fold rows move, 6 of the 322
    approximate ones; 0 other rows** (the study, without the library, moves
    the same 6). 189 of the approximate calls and folds have players behind;
    the chances of the players behind fall from 0.4-0.6 to 0.2-0.45, the
    hero's share in the call rises (0.204 → 0.270 at the largest), and so
    calling is worth more: **5 harsher, all folds** (flop Perfect →
    Inaccurate 2, Inaccurate → Mistake 1; turn Perfect → Inaccurate 1,
    Perfect → Mistake 1), **1 milder** (a turn call Mistake → Perfect).
    Approximate grades flop Perfect 187 → 185, Inaccurate 1 → 2, Mistake
    11 → 12; turn Perfect 88 → 87, Inaccurate 1 → 2, Mistake 4; river
    unchanged (Perfect 29, Mistake 1). The other 183 move EV only (by up to
    4.6bb), inside their grade.
  - **The checks of `analysis/15`-`/16`.** The held-out library and turn
    solve tables and the heads-up pipeline checks have nobody behind the
    caller, so nothing in them moves; the three-way certain-folder tests
    still hold (a model share of ~0 recalibrates to ~3·10⁻⁵). On the stored
    hands, the hero's 44 approximate calls with players behind, the model's
    call EV against what the hero won from the call on (% of the pot):
    realised 0.992 ± 0.289, realised − theory +0.626 ± 0.287, realised −
    recalibrated +0.624 ± 0.287, squared error theory − recalibrated +0.016
    ± 0.014 (flop 28: +0.031 ± 0.020; turn 13: −0.006 ± 0.014; river 3):
    **no worse**, and too noisy to say better. Both are low on the flop by
    +0.96 ± 0.42 of the pot (28 calls: what later streets won, which the
    heads-up factor does not see multiway; an open item below).
  - **Read one by one** (all 6 changed and the 14 largest EV moves among the
    unchanged, read in the study's listing; ten here):
    - A♥J♥ folding the turn on Q♦5♠T♦3♣ to a third of 18.6bb, four-way, two
      behind (0.55 → 0.28 each): call EV +0.13 → +1.18bb, share 0.20 →
      0.27; Perfect → **Inaccurate**. Ace high and the nut gutshot at 25%
      pot odds; with the two behind folding two times in three the call
      pays, which is the point.
    - A♦4♥ calling the turn on 2♠5♠T♦8♦ (half pot, one behind 0.52 → 0.26):
      call EV −0.81 → −0.28bb, inside the 5% margin; Mistake → **Perfect**.
      A wheel gutshot and an overcard; the old grade charged it for an
      overcall half the time that comes a quarter of the time.
    - K♦3♦ folding the turn on T♦A♣J♥A♥ (half of a 4.5bb limped pot, one
      behind 0.61 → 0.35): call EV +0.21 → +0.58bb, share 0.31; Perfect →
      **Mistake** (7.9% of the pot beyond the margin). The least convincing:
      K-high with a gutshot reads 31% against limpers' placeholder ranges -
      the narrowing, not the players behind, is what makes it a Mistake;
      capped and flagged as everywhere.
    - 6♣8♠ folding a bomb-pot flop on K♠5♠2♠ (half of 34.9bb, four-way, two
      behind 0.53 → 0.35): call EV +0.79 → +2.33bb; Perfect → **Inaccurate**.
      Any-two-cards ranges make 24% plausible; mild.
    - J♥K♣ folding a bomb-pot flop on 8♠J♠9♠ (half of 38bb, one behind 0.74
      → 0.59): +2.63 → +3.07bb; Inaccurate → **Mistake**. Top pair on a
      monotone board in a pot of any two cards: a fold the old model already
      disliked, now a little more.
    - 7♥6♦ folding the flop on 5♠9♣7♠ five-way (55% of 8.5bb, three behind
      0.50 → 0.33): +0.17 → +0.50bb, just past the margin; Perfect →
      **Inaccurate**. Middle pair and the gutshot that makes the nine-high
      straight.
    - A♥Q♣ folding the turn on T♥9♣K♦2♦ four-way (38% of 22bb, two behind
      0.43/0.58 → 0.21/0.32): −0.83 → +0.71bb, still inside the margin;
      Perfect stays. The largest swing in sign: Broadway gutshot and an
      overcard pay once the overcalls halve.
    - 3♥3♦ folding the turn on Q♦6♥7♣5♣ (a third of 18bb, one behind 0.60 →
      0.34): −0.82 → +0.28bb, Perfect stays (inside the margin). A pair of
      threes and the gutshot to the 4.
    - A♠7♠ calling a 3% river bet into 39.8bb in a five-way bomb pot (three
      behind 0.67 → 0.44): call EV +4.80 → +0.21bb, share 0.144 → 0.031,
      Perfect stays. The share *falls* with fewer callers: the callers' and
      the bettor's ranges compete for the same aces (only two left), so a
      caller holding one makes the bettor hold one less often - exact card
      removal in `equityVsRanges`, not an error.
    - 8♦K♠ calling the flop on 6♣5♠K♥ five-way (83% of 49.9bb, three behind
      0.24 → 0.16): +12.70 → +15.40bb, Perfect stays: top pair gains from
      fewer overcalls, the common direction for made hands.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/29`. `populationResponders`
    (`RESPONDER_MODEL` `mw-behind/1`, `RESPONDER_RECALIBRATION`: four
    numbers) sets each player-behind's chance in `callEv` (flop, turn,
    river); `RiverCallInput.responders` / `AnalyzeOptions.responders` let a
    study pass `modelResponders` (the MDF split) or a held-out fit; the
    stored `facts.multiway.ev.responders` says `mw-behind/1` when it was
    used. The existing wording said the players behind "call or fold by the
    model", now wrong: the `multiway-approx` label and the *why* sentence
    say they call about as often as stored hands show, the model choosing
    which hands (en, hr); no new flag. Tests (`analysisMultiway`): the
    river call with a player behind exact against enumeration under both
    frequencies, the recalibration and its raise exception; the analysis
    suite, typecheck and lint pass. Only aggregate numbers are committed.
  - **Open.**
    - **The walked ranges' strength** (2026-10-19's first open item) comes
      first still: the hero's share in these calls is read on ranges that
      are too strong at shown showdowns; this change moves who is in the
      pot, not what they hold.
    - Behind a call of a **raise** players continue 0.79 ± 0.09 of the time
      (29 answers), above the model's 0.58; the model's share stays until
      there are enough to fit.
    - The calls' EV is low against what was won on the flop (+0.96 ± 0.42
      of the pot, 28 calls), for both fields: the heads-up realisation
      factor applied multiway (the open item of `analysis/15`).
    - The fit is one library's population (177 players, one site's
      stakes); refit (`npm run floplib:multiway-overcall` prints the
      weights) as libraries grow, and per site if they differ.
    - The same recalibration is the natural answer model for a multiway
      check-or-bet grade (2026-10-19), once the ranges are calibrated.
- 2026-10-20 — Checked rivers: why the walked ranges are too strong,
  `analysis/30` (study `tests/scripts/flop-library/checkedRanges.test.ts`,
  `npm run floplib:checked-ranges`; `CHECKED_TO_RIVER_VALUE` and
  `NarrowAction.checkedTo` in `lib/analysis/narrowing.ts`, set by both walks).
  No migration.
  - **Why.** The first open item of 2026-10-19 (multiway checks and bets) and
    2026-10-20 (the players behind a multiway call): at a river checked
    through, the first to act - shown whatever they hold - wins 0.424 ± 0.042
    of the pot three or more ways where the walked ranges say 0.245 (won −
    predicted +0.178 ± 0.030), heads-up +0.110 ± 0.020, while against any two
    cards the heads-up share is right (−0.006 ± 0.020). Harder check trims on
    every street did not close it. The question was where the strength comes
    from: the bets and calls kept, the weak hands that check, the preflop
    ranges, or who is shown.
  - **Data.** The 5,448 stored hands of the test user (local stack). 509
    rivers checked through (134 after a flop three or more saw, 375 heads-up;
    one pot, nobody all-in, the first to act shown - all of them are), the
    multiway walk from the hero's seat (no flop library), as the 2026-10-19
    check. Five folds by hand and five by the first to act's name; standard
    errors clustered by hand (by player for the player folds).
  - **Measured 1: who is shown is selected on winning.** Opponents at river
    showdowns, shown / not shown:

    | river | first to show, won | first to show, lost | later, won | later, lost |
    |---|---|---|---|---|
    | checked through, heads-up | 239 / 0 | 202 / 0 | 227 / 0 | **3 / 222** |
    | checked through, three or more | 51 / 0 | 65 / 0 | 77 / 0 | **28 / 177** |
    | a bet called, heads-up | 154 / 0 | 66 / 68 | 149 / 0 | 48 / 102 |

    The first to act at a checked river is always shown; **a later player is
    shown when they win and almost never when they lose** (1% heads-up). So
    the 2026-10-19 share (the first to act) is not selected on the result,
    but every earlier score that read "the opponents' shown hands" - the
    check trims of `analysis/22` and `/23`, the river trim of 2026-10-14, the
    preflop fits of `/18`-`/19` - scored a sample of winners, and rewards
    ranges that are too strong. The gap is range error, and the selection is
    a likely reason the ranges were fitted that way; it is not a selection
    artefact of the measurement.
  - **An unselected score.** Besides the share, the study scores every
    player at a checked river: the first to act's combo in their own walked
    range, and each later opponent either by their combo (shown) or by the
    range's chance of losing to the best hand shown before them (mucked) - a
    likelihood that uses the losers too ("unselected LL", nats per spot).
  - **Measured 2: where it is.** The first to act's own range is about right
    (their place in it by river value 0.473 ± 0.023 three or more ways,
    0.446 ± 0.014 heads-up; 0.5 is calibrated). The **later players' ranges
    are too strong**: they muck 0.628 ± 0.032 of the time three or more ways
    where the ranges say 0.505 (+0.122 ± 0.025), heads-up 0.489 against 0.396
    (+0.094 ± 0.022). The later players are the ones whose river check came
    **after a check** - checked to. Heads-up the excess sits on the lines
    started from the charts (opens +0.160 ± 0.037, isolations +0.24 ± 0.08,
    3-bets +0.32 ± 0.09) and not on the population lines (first limps +0.02
    ± 0.06, cold calls −0.04 ± 0.07, the big blind's check +0.00 ± 0.07);
    three or more ways on every line (+0.09 to +0.13). One candidate at a
    time, in sample (won − predicted, three or more / heads-up; baseline
    +0.178 / +0.110):
    - a river check made **checked to** keeping value 0.03 of the time with
      no repeat discount: +0.017 / −0.010 - the gap closes;
    - the flop and turn check trims × 3 multiway: +0.091, unselected LL
      −1.43 ± 0.16; × 2 heads-up: +0.084;
    - wider calls (the call's cut − 0.2): +0.175 / +0.097;
    - opponents' chart ranges mixed with any two cards at 0.3: +0.158 /
      +0.064, unselected LL +0.29 ± 0.12 / +0.41 ± 0.08.
    So the bias is not in the bets and calls kept nor the flop and turn
    checks: it is the **last check**. A player checked to on the river who
    holds the top of their range bets; `heuristic/2` trimmed that check like
    any other (value kept 0.5) and, since nearly every such check follows
    earlier checks, at a half or a quarter of the strength (`CHECK_REPEAT`):
    an x/x/x player checking behind kept 7/8 of their value hands. The
    preflop chart ranges are a second, smaller part (open below).
  - **Candidates, held out.** The river check recomputed (study code; the
    shipped heuristic reproduces the winner to the bit, 120 spots): checked
    to - value 0.5, 0.3, 0.15, 0.03 × air 0.7, 1 × repeat discount 0.5, 1;
    the first river check's value 0.5, 0.25; flop and turn checks made
    checked to with value as shipped, 0.5, 0.3 (96). Chosen held out by the
    share's squared error and by the unselected LL. The unconstrained winner
    (value 0.15, air 1, no discount; every fold by hand, four of five by
    player) closes the gap: won − predicted +0.030 ± 0.028 three or more
    ways, −0.013 ± 0.020 heads-up; squared error +0.053 ± 0.014 and +0.012
    ± 0.006 better, unselected LL +0.17 ± 0.06 and +0.09 ± 0.02. **It fails
    the guard**: on the earlier studies' shown-hand rows it loses −0.028 ±
    0.008 per combo on every river row, −0.112 ± 0.033 on multiway rivers
    checked only - exactly the shown winners it now finds less likely.
  - **Shipped: the strongest candidate that passes the guard.** A river
    check made checked to keeps value `CHECKED_TO_RIVER_VALUE` = **0.3** of
    the time (was 0.5) with **no** `CHECK_REPEAT` discount; air (0.7), the
    first river check and every flop and turn check unchanged. Within the
    family that passes the guard (value 0.5, 0.4, 0.3, no discount) it is the
    held-out choice in every fold, by hand and by player, for both scores:

    | checked rivers | n | `analysis/29` won − predicted | `analysis/30` | squared error, better by | unselected LL, better by |
    |---|---|---|---|---|---|
    | three or more ways | 134 | +0.178 ± 0.030 | **+0.103 ± 0.028** | +0.037 ± 0.008 (4.6 SE) | +0.172 ± 0.034 (5.1 SE) |
    | heads-up | 375 | +0.110 ± 0.020 | **+0.053 ± 0.020** | +0.010 ± 0.003 (3.3 SE) | +0.066 ± 0.011 (6.0 SE) |

    (By player: +0.037 ± 0.008 and +0.010 ± 0.003.) The guard - the earlier
    shown-hand rows, paired, per combo, clustered by player: flop and turn
    rows of `analysis/22`/`/23` (644 + 855 + 417 + 998) and the bomb pots'
    turn and river starts (`/28`) **0 exactly** (nothing before a river check
    moves); the river rows of 2026-10-14, all 1,408: +0.003 ± 0.004;
    multiway checked only (213) −0.008 ± 0.018; heads-up checked only (655)
    +0.008 ± 0.007; others 0.000. Bomb-pot rivers (47, no earlier check)
    −0.029 ± 0.033. Nothing worse by a standard error. The guard-passing
    family was set in sample on the guard, not held out.
  - **What it moves: almost nothing graded.** A river check made checked to
    is the last action heads-up (the pot goes to showdown) and multiway is
    followed only by the players behind; so only a hero decision after a
    checked-to river check reads it. Census (`npm run floplib:census`, the
    flop library on, the three shipped sets, 8,005 hero decisions) against
    `analysis/29` row by row: **1 row moves** - a river fold, approximate,
    Perfect → Mistake (harsher); 0 other rows. Of the hero's decisions after
    a checked-to river check (23, all read here, `analyzeHand` at both
    versions): that 1 grade, 6 approximate calls and folds whose EV moves
    inside their grade, and 16 decisions not graded (`multiway` checks and
    bets, one `multiway-crowded` fold) whose equity fact rises. The flop and turn
    approximate calls and the solves' starting ranges do not read a river
    check: **the strength of those ranges is not changed here** (the
    preflop part below is what reaches them).
  - **Read one by one** (all 23; ten here):
    - A♠K♠ folding the river on 9♠Q♥2♥T♦A♥ seven-way: three checks (the
      hero's the third), a bet and a call, then the second checker
      check-raises to 7bb; equity 0.098 → 0.271, call EV −8.26 → +1.87bb: **Perfect →
      Mistake** (4.0% of the pot; the half-strength check agrees). The one
      grade that moves, and the least convincing: the checked-to trim moves
      value out of a range that then check-raises - a trap the data (rivers
      checked through) never saw. Capped and flagged as every approximate
      call; an open item below.
    - K♣Q♠ checking behind on 4♠5♣K♠7♠4♦ three-way (top pair): equity
      against the field 0.53 → 0.62 (the two checkers hold fewer kings).
    - A♣4♣ betting small on 3♠9♥K♦T♠A♥ after three checks
      (top pair, weak kicker): 0.59 → 0.75 - the largest equity move.
    - J♣K♠ (trips) betting into two checkers on 9♥3♦J♥J♠8♠: 0.71 → 0.77;
      called by one.
    - T♣J♣ betting after two checks on J♦5♠K♠2♦8♠ (second pair): 0.52 →
      0.63 - the 2026-10-19 example whose check "rested on a share the bias
      says is low"; it is less low now.
    - T♣A♣ checking behind on 5♣2♦6♠5♦6♣ (ace high on a double-paired
      board): 0.57 → 0.64.
    - 7♣7♦ checking last on J♦2♠A♥8♦9♣: 0.26 → 0.30; A♦8♠ on 4♥6♠K♣K♦Q♦:
      0.25 → 0.30 - weak made hands gain most, as they should if the
      checkers hold less.
    - 6♣6♦ folding to a bet on Q♦Q♥4♥9♠4♠ (two checks before the bet, both
      checkers still to answer): equity 0.050 → 0.055, call EV −6.42 → −6.25bb,
      Perfect stays.
    - 7♠T♣ (two pair) folding to a 13bb bet into 112bb after hero and one
      other checked: equity 0.096 → 0.102, −16.3 → −15.6bb, Perfect stays.
    - A♥3♥ checking in a seven-way checked pot on 9♠K♠9♣5♥4♦: 0.007 →
      0.016 - nothing changes the answer with ace high against six.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/30`. `CHECKED_TO_RIVER_VALUE`
    (0.3) and `NarrowAction.checkedTo` (a check after another decision on
    the street, set by `walkRanges` and `walkMultiway`; read on the river
    only); the narrowing's id stays `heuristic/2`. No wording changes (no
    label or flag describes the check trim). Tests (`analysisRiver`): the
    checked-to likelihood (value at 0.3, air unchanged, no repeat discount,
    the flag ignored on the turn) and the walk setting the flag on each
    street's second check; the analysis suite, typecheck and lint pass.
    Only aggregate numbers are committed.
  - **Open.**
    - **Opponents' chart ranges are too strong** (opens, isolations,
      3-bets: the heads-up later players above). Mixing any two cards in at
      0.15 on top of `analysis/30`: won − predicted +0.081 three or more
      ways, +0.016 heads-up, unselected LL **+0.49 ± 0.11 and +0.48 ± 0.07**
      - the largest gain in this study, and the part that reaches the flop
      and turn grades and the solves' starting ranges. It changes nearly
      every postflop grade against a raiser and the `analysis/18` shown-hand
      checks score it on winners; a version of its own, fitted on
      unselected hands (the first to show, the mucks), with its own census.
    - **The guard and the bar disagree.** The unselected scores want a
      harder checked-to trim (value 0.15, air not trimmed: the gap closes to
      +0.030 / −0.013); the shown-hand checks, which score winners only,
      refuse it. Rescoring the earlier studies with the mucks counted (as
      here) would settle which to trust; until then the residual (+0.103 ±
      0.028, +0.053 ± 0.020) stays.
    - **Check-raises.** A check made checked to is now mostly not value, so
      a later raise reads the top of a weaker range (the A♠K♠ example). How
      often a checked-to river check-raise holds value is not measured.
    - The 2026-10-19 river check-or-bet model can be re-run on these ranges
      (`multiwayRiver.ts`); its equity half had been the reason it failed.
    - A heads-up river the analysis solves starts from the turn's ranges
      and never reads a river check; the flop library's heads-up flops were
      not part of this walk (no library), as in the 2026-10-19 check.
- 2026-10-20 — Opponents' chart ranges in the population's order,
  `analysis/31` (study `tests/scripts/flop-library/preflopWidth.test.ts`,
  `npm run floplib:preflop-width`; `populationOrdered`,
  `POPULATION_ORDER_MIX` in `lib/analysis/population.ts`, read by
  `preflopClassRange`). No migration.
  - **Why.** The first open item of `analysis/30`: mixing any two cards
    into opponents' chart ranges at 0.15 gained about half a nat per
    checked river on the unselected score, the largest gain in that study,
    and it is the part that reaches flop and turn grades and the solves'
    starting ranges. Which chart ranges are too strong, and what is the
    least-parameter fix?
  - **Data.** The 5,448 stored hands of the test user (local stack). The
    unselected score of `analysis/30` (the first to show scored by their
    combo in their own walked range; each later player by their combo when
    shown, else by the range's chance of losing to the best hand shown
    before them), extended from the 509 rivers checked through to every
    river showdown in one pot with nobody all-in: **857** (checked through
    134 three or more ways / 375 heads-up; a bet called 127 / 221, the last
    bettor shown first). The multiway walk from the hero's seat, no flop
    library (as `analysis/30`). Five folds by hand and five by the first to
    show's name; standard errors clustered by hand (by player for the
    player folds). Opponents only: the hero's range never changes.
  - **Measured 0: not how often - which hands.** Opponents' first preflop
    decision (NLHE cash, no ante or straddle), how often they raise where
    they could, against the share of hands in the chart range they are
    walked from - frequencies, no showdown, nothing selected:

    | spot | chances | raised | chart range |
    |---|---|---|---|
    | open 6-max UTG / HJ / CO / BTN | 1,892 / 890 / 1,388 / 1,118 | 21.0 / 20.1 / 26.8 / 39.9% (± 0.9-1.5) | 17.4 / 19.7 / 26.0 / 38.6% |
    | open 6-max SB | 596 | 41.4 ± 2.0% | 18.7% |
    | open 9-max UTG / UTG+1 / LJ / HJ / CO / BTN | 1,778 / 721 / 1,094 / 747 / 489 / 311 | 14.3 / 13.0 / 19.6 / 23.2 / 29.2 / 34.1% | 12.0 / 13.1 / 15.7 / 19.7 / 26.5 / 38.6% |
    | isolation 6-max / 9-max | 1,237 / 2,339 | 17.8 / 15.1% | 18.6 / 13.1% |
    | 3-bet 6-max / 9-max | 4,649 / 4,916 | 7.9 / 6.1% | 10.4 / 7.8% |

    Outside the small blind (which raises twice as often as its chart
    range holds) opponents raise within a few points of the charts, and
    3-bet *less*. Yet at showdown the same lines are too
    strong: the later players walked from a chart line muck more than their
    ranges say (observed − predicted at `analysis/30`, every river
    showdown): isolations **+0.259 ± 0.052** (61), 3-bets **+0.294 ±
    0.088** (24), opens +0.082 ± 0.026 (211; UTG +0.120, HJ +0.159, BTN
    +0.044), against the population's lines at about zero (cold calls
    −0.007 ± 0.032, the big blind +0.014 ± 0.044, over-limps −0.004). So
    the charts' ranges are about the right size with the wrong hands in
    them.
  - **Measured 1: candidates, in sample** (unselected log-likelihood gain
    per spot over `analysis/30`, all 857; clustered by hand):
    - *Wider* (more combos): any two cards mixed in at 0.05-0.3, best
      +0.452 ± 0.049 (0.2); the population shape added under a union,
      best +0.536 ± 0.056 (shift −1.5) - both roughly double the opens'
      width, against Measured 0.
    - *Same width, other hands* (`mix`): (1 − m) · w + m · σ(β·f + a), β
      `population/1`'s shared shape, a set so the shape holds the range's
      combos: m 0.25 +0.397, 0.5 +0.509, **0.75 +0.542 ± 0.055**, 1
      +0.494. The same width spread uniformly instead (`flat`): best
      +0.445. Spread by all-in equity against any two cards (the top of
      that order at the same width): +0.136 at m 0.6, +0.022 at 0.9 - a
      stronger order is *worse*. It is the population's selection of
      hands, not strength, that the charts miss.
    - *Per line* (any two at 0.15, one line at a time): opens +0.163 ±
      0.030, isolations +0.070, the small blind's limp +0.070, 3-bets
      +0.056, calls of a 3-bet +0.055, the big blind's check +0.017;
      4-bets and the charts' flat calls (ante and straddle games) +0.002.
      The mix with one line left out: without opens +0.334, without
      isolations / 3-bets / calls of 3-bets / limps +0.459 to +0.468,
      without the big blind's check +0.528: every chart line contributes,
      opens most; no line hurts.
    - Tables apart (the mix on 6-max only +0.295, 9-max only +0.215,
      heads-up only +0.032): both table sizes, no reason to split.
    - Placeholder ranges too (a line no chart covers; the limp-call
      placeholder of `analysis/18`): +0.590 ± 0.057 against +0.542.
    - The shape's pair × low-rank term ranks big pairs below small ones
      (fitted on flat calls, where big pairs leave by re-raising); without
      it (pairs in rank order) +0.593 ± 0.055 against +0.590 - the same.
      Shipped without it: the lines this reads are mostly raises, where
      the big pairs stay in.
    - Width 1.25 × the chart's combos for the shape's part: +0.599 (+0.006
      over the same width; not shipped - Measured 0 says the width is
      right).
  - **Held out.** Every candidate tried above (76: any two, union, mix
    and flat at each level, per line, per table, the orders, the widths,
    with and without placeholders) chosen on the other four folds: by hand
    the mix at 0.75 (with placeholders; three folds at width 1.25, two at
    width 1 pairs in rank order), **+0.576 ± 0.057 (10.2 SE)**; by player
    the same family, **+0.599 ± 0.064 (9.3 SE)**. Every group better: the
    rivers checked through three or more ways +0.437 ± 0.151 (2.9 SE),
    heads-up +0.612 ± 0.084, the called bets +0.445 ± 0.125 and +0.676 ±
    0.118. **Restricted in sample:** the family (the same width, the
    population's order, placeholders included) and the pairs-in-order
    variant were picked by me across three in-sample grids; the per-fold
    choice over all 76 is the held-out number above. Within the shipped
    candidate's own one-number family (m 0.25, 0.5, 0.6, 0.75, 0.9, 1) 0.75
    is chosen in every fold, by hand and by player: **+0.593 ± 0.055 (10.8
    SE) by hand, ± 0.063 (9.4 SE) by player**.
  - **Shipped.** An opponent's chart or placeholder range keeps its width
    and takes **`POPULATION_ORDER_MIX` = 0.75** of it in `population/1`'s
    order without the pair term, `populationOrdered`: one new number; the
    order is the stored shape's, its shift solved per range. Not for the
    population's own lines (already that shape), a bomb pot, the hero, the
    trainers (no `populationHero`), after a preflop all-in, or a heads-up
    flop the flop library answers (`populationOrder: false`: the chunk was
    solved from the charts' ranges and zeroes what they lack; those hands
    keep `analysis/30`'s ranges through the flop and the solves after it).
    An UTG open (6-max 100bb, 200 combos): A9o-A2o 0 → 0.12-0.19, A5s 0 →
    0.41, JTo 0 → 0.14; KQo 1 → 0.43, KJo 1 → 0.37, 66-99 ~1 → 0.46-0.56,
    AA 0.96 → 0.75, AKs 0.92 → 0.94. A big blind 3-bet against the button:
    AJo 0 → 0.36, A9s 0 → 0.42; KQo 1 → 0.40, 66-99 1 → 0.43-0.52. The
    study's re-implementation and the shipped code agree on every preflop
    range to 4·10⁻¹⁵ and on every aggregate to the third decimal; single
    spots differ (up to 0.8 nats) where a threshold in the narrowing flips
    on that last bit.
  - **The checks.**
    - `analysis/30`'s rows (rivers checked through, won − predicted, held
      out): three or more ways +0.103 ± 0.028 → +0.091 ± 0.028, heads-up
      +0.053 ± 0.020 → +0.038 ± 0.019; the called bets +0.065 → +0.058
      and +0.098 → +0.090. Closer everywhere, by less than a standard
      error: the share is mostly the river trims'.
    - The shown-hand rows of `analysis/22`/`/23`/`/28` and the 2026-10-14
      river trim (candidate − `analysis/30` per combo, clustered by
      player): flop three or more +0.269 ± 0.043 (644), heads-up +0.483 ±
      0.051 (855); turn +0.229 ± 0.050 (417) and +0.460 ± 0.049 (998);
      river all +0.410 ± 0.042 (1,408), checked only +0.237 ± 0.066 (213
      multiway) and +0.404 ± 0.055 (655 heads-up); bomb pots 0 exactly.
      Even the shown winners - the sample selected toward strength - are
      better explained: the old ranges were not only too strong but held
      the wrong hands.
    - `analysis/29`'s overcall check (`npm run floplib:multiway-overcall`,
      `OVERCALL_CHART_ORDER=1` for the before): the shipped recalibration
      held out +0.073 ± 0.016 → +0.072 ± 0.015 behind a bet (theory 0.490
      → 0.489); the hero's 44 approximate calls, realised − population
      +0.624 ± 0.287 → +0.621 ± 0.288; called multiway river bets, the
      bettor's share won − predicted +0.059 ± 0.041 → +0.054 ± 0.039.
    - Nothing worse by a standard error anywhere.
  - **What is left.** At the shipped ranges the later players still muck
    more than predicted after an isolation (+0.219 ± 0.049, 61) and a
    3-bet (+0.180 ± 0.078, 24), and at called rivers heads-up (+0.089 ±
    0.028); the first to show's place in their preflop range is
    calibrated on every chart line (opens +0.037 ± 0.026 above 0.5,
    3-bets +0.054 ± 0.052, isolations −0.020 ± 0.056).
  - **The grades.** Census (`npm run floplib:census`, the flop library on,
    the three shipped sets, 8,005 hero decisions; run twice at
    `analysis/31`, identical row for row) against `analysis/30` row by row:
    **72 rows move, 0 on a flop the library answers**. 754 rows read a
    reordered range (flop 319, turn 268, river 167). By street and kind:

    | | harsher | milder | newly graded | no longer graded |
    |---|---|---|---|---|
    | flop, approximate (multiway) | 1 | 1 | | |
    | turn, approximate (multiway) | | 1 | | |
    | turn, solver | 18 | 18 | 3 | 2 (`turn-unreached`) |
    | river, solver | 16 | 9 | 2 | 1 (`river-unreached`) |

    Turn solver Perfect 383 → 387, Good 80 → 72, Inaccurate 7 → 10,
    Mistake 51 → 53; river solver Perfect 277 → 274, Good 82 → 83,
    Inaccurate 9 → 7, Mistake 16 → 21; flop approximate Inaccurate 2 → 3,
    Mistake 12 → 11; turn approximate Perfect 87 → 88, Mistake 4 → 3. No
    preflop row moves (preflop grades read the charts, not these ranges).
  - **Read one by one** (27 moved grades with `analyzeHand` at both
    versions; ten here):
    - 6♣A♣ folding the river on 7♥6♥7♣2♦J♥ to a bet, after calling the
      button's 3-bet and its flop bet and checking the turn through: the
      3-bettor's range at the river 18.9 → 3.9 combos, the hero beats 0.23
      → 0.58 of it; Good → **Mistake** (14.3bb, 40% of the pot, capped).
      The largest move: a 3-bet range with more weak aces and suited hands
      has more misses that bet a river after checking the turn.
    - J♠A♠ betting the river on A♣8♦Q♥9♠6♣ in a 3-bet pot the small blind
      called (top pair, jack kicker): the caller's range is 0.47 combos at
      the end, the hero beats 0.98 → 0.46 of it; Perfect → **Mistake**
      (10.7bb, capped). The population's order puts aces high, so a call
      of a 3-bet that check-calls an ace-high board to the river is more
      often a better ace than the chart's range says.
    - 6♣7♣ folding the turn on 8♥9♦3♦Q♠ to a bet, after the hero's flop
      check-raise was re-raised by the cutoff's 3-bet range: that range's
      strong share 0.24 → 0.19, weak 0.21 → 0.31; Perfect → **Mistake**
      (3.4bb). The open-ender now has the price.
    - A♥A♣ betting the turn on Q♠3♦9♥T♥ against a cold 4-bettor who
      checked the flop: the hero beats 0.68 → 0.83 of the 4-bet range (its
      strong share 0.58 → 0.32); Mistake → **Perfect**. The chart's 4-bet
      range is the solver's; the reordered one holds more of the hands
      players actually 4-bet and then check.
    - Q♠8♠ calling the turn in the small blind's 3-bet pot on 8♥9♠A♠5♦
      (bottom pair and a flush draw): Mistake (7.5bb, capped) →
      **Perfect**; the river fold after it is no longer reached
      (`river-unreached`): the 3-bettor's line there is a sliver of the
      new range.
    - 9♥J♥ calling a turn bet on Q♣T♣7♥4♠ (an open-ender) against the UTG
      opener: equity 0.18 → 0.24; Mistake → **Perfect**.
    - 8♦8♥ calling a flop bet three-way on 3♦Q♥2♥ against the hijack's
      isolation and a limp-caller: equity against the isolation 0.23 →
      0.30, the field 0.18 → 0.24; Mistake → **Perfect**. The isolation
      line moves most in `Measured 0` and here.
    - J♥T♥ folding the flop on Q♥4♣8♠ (a gutshot and a backdoor flush) to
      the UTG opener's bet with the big blind behind: equity 0.25 → 0.29;
      Perfect → **Inaccurate**.
    - K♦Q♦ folding the turn on 5♦A♠5♥A♣ to a third-pot bet from the small
      blind's 3-bet range after a flop checked through: the hero beats
      0.28 → 0.41 of it; Perfect → **Mistake** (0.56bb). The least
      convincing: a 3-bettor who checks a paired-ace flop and bets small
      is read through the heuristic's trims, which know nothing of how
      the population slowplays.
    - Three tiny blind-against-blind pots (the big blind betting the turn
      with a weak queen, Q-high or a gutshot after the small blind limped
      and both checked the flop, 0.09-0.25bb): Perfect/Good → **Mistake** by share
      of a 2bb pot. The small blind's limp in the population's order holds
      more aces and queens than the chart's limping range, so the stab is
      called or beaten more often - right in direction, harsh in grade on a
      2bb pot.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/31`. `POPULATION_ORDER`
    `population-order/1`, `POPULATION_ORDER_MIX` (0.75), `populationOrdered`
    and `populationOrderApplies` in `population.ts`;
    `PreflopRangeOptions.populationOrder` (default on with
    `populationHero`); the analysis passes it off for a heads-up hand the
    flop library answers (`rangeOptions(..., chartOrder)` in
    `handSolvers`, the full and the halved walk). New approximation
    `range-population-order` (EN/HR) on every decision whose walk or
    equity read such a range; `docs/CHARTS.md` §7.2. Tests
    (`analysisRanges`, `flopLibraryPilot`): the width kept, a quarter of
    the chart's weight always kept, pairs in rank order, any two cards
    unchanged; read for opponents' chart and placeholder ranges only (not
    the hero, the trainers, `populationOrder: false`, a population range,
    after a preflop all-in); the walk and the decision carry the flag in
    both languages; a turn on the library's flop keeps the charts' range
    while the same hand without the library reorders it. The study
    `preflopWidth.test.ts` (`npm run floplib:preflop-width`, prints only)
    and `OVERCALL_CHART_ORDER` in `multiwayOvercall.test.ts`. The analysis
    suite, typecheck and lint pass. Only aggregate numbers are committed.
  - **Open.**
    - **A raising order.** The order is `population/1`'s, fitted on flat
      calls and limps, reused for raises with only its pair term dropped.
      A shape of its own for opens, isolations and 3-bets, fitted on the
      unselected score (the first to show and the mucks, now 857 rivers),
      is the next step; isolations (+0.22 ± 0.05 mucks still unexplained)
      and 3-bets (+0.18 ± 0.08) are where it is needed.
    - **The small blind's open** is twice the charts' frequency (41% of
      chances against an 18.7% chart range, 6-max): a width the order
      does not change. A per-position width from the frequencies (Measured
      0, no showdown needed) would be the cleanest widening; the score did
      not ask for wider ranges elsewhere (width 1.25 gained +0.006).
    - **The library's heads-up flops keep the charts' ranges** (their
      chunks were solved from them): those hands, and the turn and river
      solves after them, still read `analysis/30`'s ranges. Re-solving the
      library from reordered ranges, or reweighting a chunk's ranges by
      the order before narrowing, would make them consistent.
    - The tiny blind-against-blind pots: a grade by share of a 2bb pot
      turns 0.1bb into a Mistake; worth a floor in big blinds (not new to
      this version, made visible by it).
    - The fit is one library's population (one site's stakes); refit
      (`npm run floplib:preflop-width` prints the candidates) as libraries
      grow.
- 2026-10-20 — Raising lines' order and the small blind's open width:
  **nothing shipped** (study `tests/scripts/flop-library/preflopWidth.test.ts`,
  `npm run floplib:preflop-width`, new candidate options `tauBy`, `termBy`,
  `kBy`, `sbWidth` and `PW_REF`, `PW_PICK`). `ANALYSIS_VERSION` stays
  `analysis/31`; no migration, nothing in `frontend/`, no grade moves, so no
  census diff.
  - **Why.** The two open items of `analysis/31` with a preflop fix:
    (1) after the population order, the later players walked from an
    isolation still muck more than their ranges say (+0.219 ± 0.049, 61)
    and after a 3-bet (+0.180 ± 0.079, 24) - is there a raising-line order
    with one or two numbers that explains them? (2) The small blind opens
    41% of its chances against an 18.7% chart range: does the width at the
    observed frequency help?
  - **Data and score.** As `analysis/31`: the 5,448 stored hands, the 857
    river showdowns, the unselected score (the first to show by their
    combo, each later player by their combo when shown, else by the
    range's chance of losing to the best hand shown before), five folds by
    hand and five by the first to show's name. Every candidate is built on
    the study's `analysis/31` (`mix 0.75 popnp +ph` on every chart line;
    the shipped code scores −0.001 ± 0.001 against it), and every gain
    below is per spot **over `analysis/31`**, clustered by hand unless
    said. Library-answered heads-up flops are untouched either way (the
    study walks without the library; the shipped option would have gone
    through the same `populationOrder` gate).
  - **Measured 1: a raising order - nothing.** For isolations and 3-bets
    (`R2`) only, everything else at `analysis/31`:
    - their own mix: m 0.5 −0.022 ± 0.010, 0.9 +0.004 ± 0.003, 1.0
      +0.006 ± 0.005;
    - a temperature on the order (σ(τ·z + a), τ < 1 flatter, i.e. weaker
      hands in): τ 0.25 −0.014 ± 0.011, 0.5 −0.004 ± 0.007, 0.75 +0.001
      ± 0.003, 1.5 −0.010 ± 0.007; on opens, isolations, 3-bets and 4-bets
      together τ 0.5 −0.030 ± 0.016, 0.75 −0.014 ± 0.010;
    - their own width (the order's part × k): 0.75 −0.005 ± 0.004, 1.25
      +0.003 ± 0.002, 1.5 +0.000 ± 0.005 (Measured 0 has 3-bets at 0.77 of
      the chart's frequency);
    - one raise-fitted shape term (± 1 on one feature: suited, ace, pair,
      broadway, gap, high rank, low rank; 14): best pair −1 +0.005 ±
      0.003, high rank +1 +0.004 ± 0.005, ace +1 +0.003 ± 0.006; worst ace
      −1 −0.011 ± 0.006.
    Held out, a fold choosing among the mix / temperature / width family
    (16 with `analysis/31`): +0.004 ± 0.005 (0.8 SE) by hand, +0.001 ±
    0.005 (0.2 SE) by player; among the terms (15): −0.000 ± 0.004 /
    +0.003 ± 0.004. Far from the bar.
  - **Why not: the mucks and the shown hands pull apart.** The flattest
    order (τ 0.25) is the only one that moves the mucks much - isolations
    +0.219 → +0.155 ± 0.048, 3-bets +0.180 → +0.076 ± 0.080 - but the
    3-bettors who show first then sit too high in their preflop range (PIT
    − 0.5 +0.054 → +0.111 ± 0.048) and the score loses 0.014. m 1.0 moves
    the mucks a little (+0.205, +0.141) for +0.006. The isolators and
    3-bettors who reach a river and muck held weaker hands than their
    walk says, but those who show do not: the preflop range is not where
    the gap is. The likelier place is the heuristic's postflop trims of the
    raiser's line (a c-bet and barrel taken as strength), which no preflop
    order can fix.
  - **Measured 0 again, per table** (opponents' first decision, NLHE cash,
    no ante or straddle): the small blind opens **41.4 ± 2.0%** of 596
    chances at 6-max (chart 18.7%), **27.8 ± 3.4%** of 176 at 9-max
    (chart 18.0%), heads-up 40.7 ± 6.4% of 59 (chart 59.3%; not tried).
  - **Measured 2: the small blind's open at its frequency.** `open:SB`
    (3 or more players dealt) widened to a share s of all 1,326 combos,
    the added width in the population order (the range's own quarter
    kept): s 0.25 +0.006 ± 0.004, 0.30 +0.010 ± 0.005, 0.35 +0.012 ±
    0.007, 0.414 +0.014 ± 0.008; all of it in the order +0.015 ± 0.008;
    6-max only +0.017 ± 0.008; **per table at the frequencies (0.414 /
    0.278), no number fitted on the score: +0.016 ± 0.008**. All of it at
    heads-up rivers (called bets +0.043 ± 0.024, checked +0.010 ±
    0.011; multiway exactly 0): the small blind's open reaches few river
    showdowns (37 first to show, 12 later players). The later players'
    mucks after it +0.186 ± 0.076 → +0.157 ± 0.059, the first to show's
    place −0.014 → +0.020 ± 0.044.
  - **Held out.** The per-table candidate takes its widths from Measured 0,
    not from the score, so held out it is itself: **+0.016 ± 0.008, 2.0 SE
    by hand, 1.9 SE by player** - under the bar (> 2 SE both ways). A fold
    choosing among the six small-blind candidates and `analysis/31`:
    +0.014 ± 0.008 (1.9 SE) / +0.015 ± 0.008 (1.8 SE); among all 39 of
    this entry the same choices, the same numbers. **Restricted in
    sample:** the per-table variant was added after the first grid showed
    the 6-max-only one ahead; the per-fold choices above include it.
  - **The checks** (for the small blind's open, the only near miss;
    candidate − `analysis/31`): the shown-hand rows of `analysis/22`/
    `/23`/`/28` and the river trim, clustered by player: flop heads-up
    +0.004 ± 0.005 (855), turn heads-up +0.004 ± 0.005 (998), river
    heads-up +0.017 ± 0.011 (464), heads-up checked only +0.006 ± 0.006
    (655), river all +0.008 ± 0.005 (1,408); three or more ways and bomb
    pots 0 exactly. `analysis/30`'s rows (first to show's share won −
    predicted): heads-up checked +0.038 → +0.038, called +0.090 → +0.088;
    multiway unchanged. Nothing worse - but none of it reaches the bar.
    `analysis/29`'s overcall check reads the shipped code and was not run
    (nothing shipped).
  - **Open.**
    - **The raisers' excess mucks are postflop.** Score the heuristic's
      flop and turn trims for an isolator's and a 3-bettor's betting line
      (the unselected score per street, the river trim of 2026-10-14 as
      the model) rather than their preflop range.
    - **The small blind's open, ready to re-test.** One candidate, no
      fitted number: `{"kind":"mix", ..., "sbWidth":{"6":0.414,"9":0.278}}`
      in the study (`PW_REF="a31 twin"`). It is right in direction on every
      check and 1.9-2.0 SE short only for lack of river showdowns after a
      small-blind open; re-run as the libraries grow. Shipping it would
      move only heads-up grades (and none on a library flop).
    - The heads-up small blind (button) opens 41% against a 59% chart
      range (59 chances): too few to test.
    - `analysis/31`'s other open items stand (the library's heads-up flops
      on the charts' ranges, the 2bb-pot grade floor, refits as libraries
      grow).
- 2026-10-20 — Bets and the initiative: the preflop aggressor's postflop
  line, `analysis/32` (study `tests/scripts/flop-library/raiserNarrowing.test.ts`,
  `npm run floplib:raiser-narrowing`; `BET_EVIDENCE`, `INITIATIVE_CHECK_POWER`,
  `NarrowAction.initiative` and `NarrowAction.bombPot` in
  `lib/analysis/narrowing.ts`, set by both walks). No migration.
  - **Why.** The first open item of the raising-order entry (#219): at
    `analysis/31` the later players walked from an isolation or a 3-bet
    still muck more than their ranges say at river showdowns (+0.22 ± 0.05,
    +0.18 ± 0.08), and no preflop order fixes it (the mucks and those who
    show first pull apart). Is it how the heuristic narrows the raiser's
    postflop line - a c-bet and barrels read as strength, a check as
    weakness?
  - **Data and score.** As `analysis/31`: the 5,448 stored hands, the 857
    river showdowns (one pot, nobody all-in), the unselected score (the
    first to show by their combo in their own walked range; each later
    player by their combo when shown, else by the range's chance of losing
    to the best hand shown before them), five folds by hand and five by the
    first to show's name, standard errors clustered by hand (by player for
    the player folds). Preflop ranges are `analysis/31`'s; the multiway walk
    from the hero's seat, no flop library. The *initiative*: the last player
    to bet or raise on the latest street that had a bet (preflop's last
    raiser on the flop, kept through a street checked through); an
    initiative bet is that player's bet before anyone else's on the street,
    an initiative check their check before any bet. Candidates change the
    heuristic's likelihood L of those actions: L^t (t < 1 says less),
    max(L, m) (the middle and bottom bet at least m), per street, per
    preflop line group (R1 opens, R2 isolations and 3-bets, R4 4-bets, or
    anyone), and the same for every bet as a control.
  - **Measured 0: where the excess mucks are** (`analysis/31`, observed −
    predicted, later players): R2 **+0.208 ± 0.041** (85), R1 +0.041 ±
    0.025 (211), everyone else +0.022 ± 0.015 (615). 84 of the 85 R2 rows
    are heuristic-walked: the hero's flop was a library flop in 69 of the
    857 spots, with 1 R2 row among them - **the excess is the heuristic's,
    not the library's**. By the R2 player's own postflop line: no
    initiative bet at all (45) +0.221 ± 0.057, a flop c-bet only (28)
    +0.218 ± 0.076; check-check-check (25) +0.221 ± 0.074, bet-check-check
    (15) +0.237 ± 0.083. The excess is as large on the lines with no bet as
    on c-bet lines: **it is not in the raisers' bets**.
  - **Measured 1: candidates, in sample** (unselected LL gain per spot
    over `analysis/31`, all 857; R2 mucks observed − predicted after):
    - initiative bets, L^t on every street: t 0.75 +0.039, 0.5 +0.077,
      **0.25 +0.091 ± 0.020** (R2 mucks +0.161), 0 +0.074; at 0.5 per
      street flop +0.012, turn +0.013, river +0.054; raisers only (R1, R2,
      R4) at 0.25 +0.050 ± 0.015; R2 only +0.027 ± 0.009. Floors: best m
      0.5 +0.086 ± 0.020.
    - **every bet** (the control, not only the initiative holder's): L^t
      0.75 +0.067, 0.6 +0.108, 0.5 +0.121 ± 0.020, **0.4 +0.126 ± 0.023**,
      0.3 +0.124; at 0.4 per street flop +0.028 ± 0.013, turn +0.029 ±
      0.013, river +0.083 ± 0.016. Raises too (at 0.5): +0.125 against
      +0.121 - nothing added.
      **It is bets in general, not the raiser's**: a donk bet, a probe or a
      stab is read as too strong as much as a c-bet.
    - initiative checks, L^c: c 0.5 −0.045 (a softer give-up is worse), 1.5
      +0.017, **2 +0.027 ± 0.010**, 3 +0.014; at 2 per street flop +0.007,
      turn +0.017 ± 0.005, river +0.008; R2 only +0.012 ± 0.005. No
      `CHECK_REPEAT` discount for an initiative check instead: +0.012 ±
      0.003.
    - both: every bet at 0.4 and initiative checks at 2 **+0.134 ± 0.025**,
      R2 mucks +0.208 → **+0.134 ± 0.040**. The same two rules applied
      only to R2 players move the R2 mucks as far (+0.135) for +0.031
      overall; only to R1 +0.028; only to R4 −0.001.
  - **The guard cut bomb pots.** Every bet at 0.5 failed one shown-hand row
    of `analysis/28`: bomb-pot flops three or more ways −0.044 ± 0.034
    (1.3 SE). Bets in a bomb pot (any two cards, no preflop betting) keep
    their likelihood - **restricted in sample on the guard**, as
    `analysis/30` was.
  - **Held out.** The family every bet (no bomb pot) at t 0.75, 0.6, 0.5,
    0.4, 0.3 × initiative check c 1, 1.5, 2, plus the initiative-only family
    (t 0.75, 0.5, 0.25, 0, 1 × the same c) and `analysis/31` - 31
    candidates, a fold choosing on the other four: by hand every bet at
    0.4 with checks at 2 (three folds) or 1.5 (two), **+0.131 ± 0.024 (5.5
    SE)**; by player 0.4 with 2 (four) or 1.5 (one), **+0.132 ± 0.025 (5.3
    SE)**. By group (by hand): checked rivers three or more +0.021 ± 0.030,
    heads-up +0.037 ± 0.022, called bets three or more +0.232 ± 0.093,
    heads-up +0.299 ± 0.062; heuristic-walked spots +0.138 ± 0.025, the 69
    with a library hero flop +0.050 ± 0.059. **Restricted in sample:** the
    family's shape (powers, every bet rather than the raiser's, the
    bomb-pot cut) was picked by me across seven in-sample grids (about
    150 candidates); the held-out number is the per-fold choice over the
    final 31.
  - **Shipped.** `BET_EVIDENCE` = **0.4**: every postflop bet's likelihood
    to the power 0.4 (not a raise, not in a bomb pot);
    `INITIATIVE_CHECK_POWER` = **2**: a check by the initiative holder
    squared. Two numbers, the held-out choice in seven of ten folds (the
    other three chose checks at 1.5). The study's twin and the shipped code
    agree on all 857 spots to 0 nats.
  - **The checks** (`analysis/31` → `analysis/32`).
    - `analysis/30`'s rows, the first to show's share won − predicted (in
      sample): rivers checked through three or more +0.091 → +0.063 ±
      0.028, heads-up +0.038 → −0.005 ± 0.019; called bets three or more
      +0.058 → +0.022 ± 0.026, heads-up +0.090 → +0.057 ± 0.023; the
      squared error better in every group (held out +0.005 to +0.009).
      Later players' mucks: R2 +0.208 → +0.134 ± 0.040, R1 +0.041 →
      −0.022 ± 0.025, others +0.022 → +0.006 ± 0.015.
    - The shown-hand rows of `analysis/22`/`/23`/`/28` and the 2026-10-14
      river trim (candidate − `analysis/31` per combo, clustered by player):
      flop three or more −0.005 ± 0.014 (644), heads-up +0.004 ± 0.006
      (855); turn +0.027 ± 0.022 (417), +0.029 ± 0.013 (998); river three
      or more +0.078 ± 0.110 (76), heads-up **+0.191 ± 0.045** (464),
      checked only −0.011 ± 0.023 (213) and +0.011 ± 0.022 (655), all
      +0.071 ± 0.020 (1,408); bomb pots: flop 0 exactly, turn −0.006 ±
      0.012 / +0.002 ± 0.013, river −0.030 ± 0.044 (9) to +0.040 ± 0.030.
      Nothing worse by a standard error; the shown winners themselves are
      better explained on the river.
    - `analysis/29`'s overcall check (`npm run floplib:multiway-overcall`,
      the shipped code at both versions): behind a bet the theory moves
      0.489 → 0.501 against 0.307 continued and the shipped recalibration
      gains +0.072 ± 0.015 → +0.082 ± 0.016 over it (its log-loss 0.590 →
      0.588); the hero's 44 approximate calls, realised − population
      +0.621 ± 0.288 → +0.585 ± 0.286; called multiway river bets, the
      bettor's share won − predicted +0.054 ± 0.039 → +0.043 ± 0.039.
      Nothing worse.
  - **The grades.** Census (`npm run floplib:census`, the flop library on,
    the three shipped sets, 8,005 hero decisions) against `analysis/31`
    (its second run, identical to the first) row by row: **102 rows move,
    none of them a flop decision the library answers**. By street and
    kind:

    | | harsher | milder | newly graded | no longer graded |
    |---|---|---|---|---|
    | flop, approximate (multiway) | 5 | 1 | | |
    | turn, approximate (multiway) | 8 | | | |
    | turn, solver | 21 | 20 | 1 | 1 (`turn-unreached`) |
    | river, approximate (multiway) | 7 | | | |
    | river, solver | 12 | 23 | 3 | |

    Turn solver Perfect 387 → 382, Good 72 → 81, Inaccurate 10 → 7,
    Mistake 53 → 52; river solver Perfect 274 → 288, Good 83 → 75,
    Inaccurate 7 → 5, Mistake 21 → 20, not graded 81 → 78. The
    approximate multiway folds turn harsher (Mistake: flop 11 → 14, turn
    3 → 9, river 2 → 8): a bet into several players now holds more weak
    hands, so folding to it costs more. 7 moved rows are turn and river
    solver grades of hands whose flop the library answers, all milder
    (Mistake → Good five times): the library's flop is untouched, but the
    sensitivity re-solve (`halved`, a heuristic walk) now reads bets at 0.2
    and moves those grades by two classes, so the milder half-strength
    grade is shown (`range-sensitive`).
  - **Read one by one** (27 moved grades with `analyzeHand` at both
    versions; the study's toggle reproduces every `analysis/31` census
    grade; ten here):
    - A♣Q♠ folding the turn on A♥6♣2♥T♠ to the button's 3-bet range after
      calling its flop bet: the 3-bettor barrels 28bb; equity 0.469 →
      0.525, Good → **Mistake** (7.1bb, 10.8% of the pot, capped). The
      raiser's barrel this entry set out to test: top pair top kicker
      against a 3-bettor's double barrel now has the price.
    - T♠T♣ folding the river three-way on 4♠7♠Q♣9♣9♦ to the big blind's
      10bb bet after it led the turn: equity 0.124 → 0.397; Perfect →
      **Mistake** (5.1bb, capped). A donk-bettor's line, not a raiser's -
      the largest move, and why the rule is every bet.
    - T♦T♥ folding the river four-way on K♠J♥3♥4♥K♣ to the small blind's
      third-pot bet after every street checked through: equity 0.106 →
      0.358; Perfect → **Mistake** (2.5bb). A stab into a checked field was
      read as the top 28% of a range; the population stabs wider.
    - 7♥6♥ folding the river three-way on 6♣Q♠5♥K♥J♠ to the small blind's
      5bb bet after checks: 0.067 → 0.192; Perfect → **Inaccurate**
      (0.16bb).
    - K♦9♦ calling a 1bb flop stab three-way on Q♠4♦2♣ from an UTG
      limper: 0.213 → 0.244; Mistake → **Perfect**.
    - A♠Q♠ betting the river on T♠8♥K♦Q♥K♠ (the opener checked the flop,
      bet the turn small and was called): check 6.04 → 7.56bb, bet 33%
      5.85 → 7.56bb; Mistake → **Perfect**. The hero's own line now reads
      weaker (the flop give-up squared, the turn bet at 0.4), and the
      solved big blind pays a river bet more often.
    - K♦K♠ (the big blind's 3-bet) betting the river on A♣T♦A♥4♠T♣ after
      its flop c-bet was called and the turn checked through: check 14.34
      → 12.14, bet 33% 14.21 → 10.71; Good → **Mistake** (1.4bb). The
      3-bettor's turn give-up caps its own range harder, and the solve
      prefers to keep checking with a hand that beats the bluffs only.
    - K♥K♠ betting the turn on 6♥5♥8♠5♠ after the big blind's flop donk
      bet was called: Good → **Mistake** (0.45bb). The least convincing: a
      donk range with more draws and air makes checking an overpair better
      in the solve, on the turn's coarse sizes.
    - T♥T♠ (a set) raising the turn on T♣5♠9♥3♦ against the button's
      barrel, a library flop: Mistake → **Good** through the sensitivity
      re-solve (`range-sensitive`), not the library's chunk.
    - A♥Q♠ calling the turn on T♣7♠A♣6♦ against the hijack's turn stab
      after a checked flop: Perfect → **not graded** (`turn-unreached`):
      the stab now comes from a wider range the solved turn rarely stabs
      with at that size.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/32`. `BET_EVIDENCE` (0.4)
    and `INITIATIVE_CHECK_POWER` (2) in `narrowing.ts`, applied in
    `heuristicModel`; `NarrowAction.initiative` (a check by the initiative
    holder before any bet on the street) and `NarrowAction.bombPot`, set by
    `walkRanges` and `walkMultiway`. The narrowing's id stays
    `heuristic/2` (as `analysis/30`). No wording changes (every grade that
    reads it already carries `narrowing-heuristic`). Tests
    (`analysisRiver`): a bet's likelihood is the bomb-pot one to the power
    0.4, a raise unchanged; an initiative check is the plain one squared,
    the flag ignored on a bet; the walk marks the initiative (kept through
    a street checked through, passed by a bet); the river bluff-share test
    reads the bet before the power; the off-tree cap test barrels the turn
    (a turn checked back by the flop's bettor is now a give-up the solved
    river no longer overbets from: `river-unreached`). The analysis suite,
    typecheck and lint pass. Only aggregate numbers are committed.
  - **Open.**
    - **The isolators and 3-bettors still muck too often** (+0.134 ±
      0.040, 85, down from +0.208): neither their preflop range (#219) nor
      their postflop narrowing explains the rest; the 25 R2
      check-check-check rows are still +0.165 ± 0.073. Next candidates: the
      calling ranges against them (a call of a raiser's bet keeps the top
      `MDF` - does the field call c-bets wider?) and the river check-down
      of a raiser in a 3-bet pot specifically.
    - **The sensitivity check compounds the change.** `halved` reads a bet
      at 0.4 × 0.5 = 0.2 of the evidence; on library flops it is the only
      way the change reaches a grade (7 rows, all milder). Whether the
      half-strength walk should halve the evidence before `BET_EVIDENCE` is
      a separate question.
    - **The approximate multiway folds turn harsher** (20 rows). The
      overcall check agrees in direction (the hero's approximate calls
      still realise more than predicted); the multiway bettor's share is
      the next thing to score on its own.
    - **Bomb pots** keep the old bet reading on one 1.3 SE guard row (65
      shown hands); refit when there are more.
    - The fit is one library's population; refit (`npm run
      floplib:raiser-narrowing`) as libraries grow.
- 2026-10-20 — The big-blind floor: a postflop grade judges its EV loss
  against a pot of at least 12.5bb, `analysis/33` (`FLOOR_POT_BB` and
  `GradeInput.bbFloor` in `lib/analysis/grading.ts`; `bbFloored` in
  `reference.ts`). No migration.
  - **Why.** The open item of `analysis/31`: grades are by share of the pot
    (§2), so in a limped blind-against-blind pot of 2bb a 0.09-0.25bb loss
    is a **Mistake** (over 2%) and anything over 0.16bb would be a
    **Blunder** (over 8%, capped at Mistake only by `range-cap`). Is a share
    of a tiny pot still a measure the model can stand behind?
  - **Data.** The census (`npm run floplib:census`, flop library on, the
    three shipped sets, turn solves on) over the 5,448 stored hands, 8,005
    hero decisions, at `analysis/30`, `analysis/31` and `analysis/32`; the
    census rows now carry each grade's inputs (`evLoss`, `potBb`,
    `chosenFreq`, `maxFreq`; still no cards, no names), so a floor can be
    tried on the rows before it is written. The range model's own error is
    read as how far the chosen move's EV loss moved between versions, the
    same decision, both versions graded, postflop, only where it moved
    (`analysis/30` → `analysis/32`, the two range changes of this week):

    | pot before the decision | moved | \|ΔEV loss\| median | p75 | p90 | as a share of the pot, median | p90 |
    |---|---|---|---|---|---|---|
    | under 10bb | 98 | 0.055bb | 0.139bb | 0.234bb | 0.9% | 4.2% |
    | 10-20bb | 89 | 0.143bb | 0.404bb | 0.762bb | 1.1% | 4.9% |
    | 20bb and up | 109 | 0.466bb | 1.713bb | 3.641bb | 1.3% | 9.7% |

    Above 10bb the movement grows with the pot (the share is what is
    stable, as §2 assumes); under 10bb it stops shrinking in big blinds:
    p75 0.10 / 0.16 / 0.12bb and p90 0.21 / 0.16 / 0.25bb in pots under
    2.5bb (7 moved, all `analysis/31`'s limps), 4-6bb (41) and 6-10bb (49).
    In a 2bb pot that is a p90 share of 10%, past the Mistake threshold.
    The model's error there is a fraction of a big blind, not a fraction of
    the pot, and 0.25bb (2% of 12.5bb) is where the p90 movement sits.
  - **The rule.** Postflop, the pot the shares are taken of is
    `max(pot, 12.5bb)`: a loss of at most 0.25bb is never worse than
    Inaccurate and at most 1bb (8% of 12.5bb) never a Blunder; the
    frequency rules (Perfect within 5 points, Good from 3.5%) and the caps
    are untouched, and a pot of 12.5bb or more is graded exactly as before
    (tested). Negligible stays 0.1% of that pot (0.0125bb in a small pot).
    The move score reads the same pot; `evLossPot`, the number shown, is
    still the share of the real pot. Every postflop grader sets it (the
    turn, river and flop-library solves through `gradeMapped`, the
    approximate multiway calls through `gradeCall`), and so do drills and
    poll answers on postflop decisions (`gradeDrill`, `asAnswered`).
    One constant, not two floors: both thresholds keep their 1:4 ratio,
    and 12.5bb sits above a limped or single-raised flop (2-7bb) and a
    single-raised turn after a small called c-bet, below a 3-bet pot.
  - **Preflop is left alone.** Preflop grades read the charts' EVs (a full
    preflop solve, no narrowed ranges), every pot is 1.5-3bb by
    construction, and their shares were the scale the charts' grades were
    read on since A2. The same floor there would move 258 of the 5,145
    preflop grades (Mistake → Inaccurate 185, Blunder → Inaccurate 37,
    Blunder → Mistake 36; 222 of the 295 preflop Mistakes and Blunders lose
    0.25bb or less) - a separate question, not this one (Open).
  - **The grades.** Census at `analysis/33` (three shards, the same hands)
    against `analysis/32` row by row: **28 rows change grade, 25 milder,
    3 harsher; no preflop row moves**; 12 more keep their grade and lose a
    flag (11 `range-cap`: the uncapped grade is no longer a Blunder, so the
    cap no longer applies; 1 `range-sensitive`).

    | | milder | harsher |
    |---|---|---|
    | flop, solver (library) | Good → Perfect 5, Mistake → Inaccurate 1 | |
    | flop, approximate (multiway) | Mistake → Inaccurate 2 | |
    | turn, solver | Mistake → Inaccurate 12, Good → Perfect 3 | |
    | turn, approximate (multiway) | Mistake → Inaccurate 1 | |
    | river, solver | Good → Perfect 1 | Good → Inaccurate 3 |

    Postflop Mistakes 111 → 95 (turn solver 52 → 40), Inaccurate 24 → 43,
    Good 196 → 184, Perfect 1,112 → 1,121.
    Of the 1,443 graded postflop decisions 788 are in pots under 12.5bb;
    230 move score, the postflop mean 88.2 → 89.5 (pots under 12.5bb 89.0
    → 91.4). The 9 Good → Perfect are losses of 0.006-0.012bb in 4.5-6bb
    pots (0.1-0.3% of them), negligible on the floor's pot.
  - **Read one by one** (census rows; no cards or names in the rows):
    - The tiny blind-against-blind turn stabs of `analysis/31`'s entry:
      a turn bet in a limped 2bb pot losing 0.09bb (4.5%, played 3.5% by
      the solve), 0.18bb (9%, twice, `range-cap`) and 0.25bb (12.5%,
      `range-cap`): Mistake → **Inaccurate**, the sentence now says why.
      Four more turn bets in limped 2.5bb pots (0.08-0.15bb) the same.
    - A turn bet in a single-raised 5bb pot losing 0.245bb (4.9%):
      Mistake → **Inaccurate**; the largest loss the floor forgives.
    - A multiway flop fold in a limped 4bb pot, 0.237bb beyond the
      realisation margin: Mistake → **Inaccurate**.
    - A turn bet in a limped 2.5bb pot losing 0.455bb (18%) stays a
      **Mistake** (over 0.25bb), and loses `range-cap`: it was a Blunder by
      share, and is a Mistake now by the rule, not by the cap.
    - A turn fold in a single-raised 8.9bb pot losing 0.77bb stays a
      **Mistake** (`range-cap` gone the same way).
    - The 3 harsher: river checks in single-raised 5.5bb and limped 6.5bb
      pots and a river bet in a limped 2.5bb pot, rarely played by the
      solve (1.5-2.6%), 0.07-0.19bb. At `analysis/32` the full narrowing
      said Mistake and the half-strength one Good, two classes apart, so
      the sensitivity check showed the milder Good (`range-sensitive`). The
      floor turns the full grade into Inaccurate, one class from Good, and
      the check keeps the full grade (§3.5's rule, unchanged). Good →
      **Inaccurate**: what the rule says once the full grade is no longer
      an outlier.
  - **Shipped.** `ANALYSIS_VERSION` → `analysis/33`. `FLOOR_POT_BB` (12.5)
    and `GradeInput.bbFloor` in `grading.ts`, set by `gradeMapped`
    (`river.ts`), `gradeCall` (`multiway.ts`) and the drill graders
    (`training/grade.ts`, every source but `chart`); §2 of this plan says
    so. Wording (EN/HR): an Inaccurate or a Mistake the share alone would
    have made worse says the pot was under 12.5bb, what the floor allows
    and why (`bbFloored` in `reference.ts`). Tests (`analysisSpots`,
    `analysisRiver`, `training`, `analysisMultiway`, `analysisCorpus`): the
    floor's thresholds at 0.25bb and 1bb, the score on the floor's pot, a
    pot of 12.5bb or more graded exactly as without it, the frequency
    rules and the caps untouched; the sentence in both languages and when
    it is not said (pot at the floor, preflop, a cap); drills floored for
    every source but the charts; the corpus regrades postflop with the
    floor and preflop without it; the approximate calls' range-cap tests
    moved to a loss over the floor. The census rows carry the grade's
    inputs. The analysis suite, typecheck and lint pass. Only aggregate
    numbers are committed.
  - **Open.**
    - **Preflop tiny losses.** 222 of 295 preflop Mistakes and Blunders
      lose 0.25bb or less (54 under 0.05bb). Whether the charts' EVs are
      precise to that (the solve's own exploitability, rake, the charts'
      implied-odds caveat) is the question before any preflop floor; a
      floor in bb there would be a different number from this one.
    - **The sensitivity check's two-class rule** makes a milder full grade
      able to make the shown grade harsher (3 rows here). Comparing the two
      narrowings' EV losses rather than their grade classes would remove
      the step.
    - The error measured is version-to-version movement on 98 small-pot
      decisions, not a held-out error; remeasure as range changes ship.
