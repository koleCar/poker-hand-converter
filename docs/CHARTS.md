# CHARTS — preflop reference charts, `charts/3`

Phases A2a, A2a.1 and A2c of [`ANALYSIS-PLAN.md`](ANALYSIS-PLAN.md) (§3.1 is the spec).
Rail's preflop reference for **NLHE cash**: a library of chart sets
(**6-max at 40 / 60 / 100 / 150 / 200bb, 9-max at 100 / 150 / 200bb**, §6),
each one for every decision point
of a preflop betting tree and every one of the 169 hand classes, a frequency
and an EV in big blinds per action. Grading (§2) reads both.

The charts are **ours**. They are computed by our own solver (`lib/solver`,
DCFR) on a model described below, reproducibly, from a seed. Nothing from GTO
Wizard, Upswing or any published chart is used as input, as a target or for
tuning. `charts/1` (A2a) set the realisation model's constants by hand;
`charts/2` (A2a.1) **measures** them with our own postflop solver (§4) - the
only inputs are the rules, the sizes, the rake and the solvers. `charts/3`
(A2c) runs the same pipeline for more tables and depths and adds the library
that picks a set per spot (§6).

```
frontend/src/lib/solver/
  handClasses.ts    169 classes, combo counts, class-level card removal
  preflopEquity.ts  169x169 all-in equity, seeded Monte Carlo
  preflopModel.ts   equity realisation (odds form, roles, class features), rake
  preflopRealisation.ts  realised shares measured on a turn+river solve
  preflopTree.ts    the action abstraction and its cuts, 2-9 seats, any depth
  preflopCfr.ts     DCFR for up to nine players; best response, NashConv
frontend/src/lib/charts/
  format.ts         CHARTS_VERSION, JSON format, encode/decode, loadCharts
  build.ts          solved game -> chart set (reach, ranges, scenarios, filters)
  generate.ts       one solve -> chart set, as a pure function
  realisation.ts    charts/2: spots, measurement jobs, the fit, the rounds
  lookup.ts         real preflop line -> node + options + approximations
  fromHand.ts       PhfHand -> the spot of one hero preflop decision; the sets a hand needs
  registry.ts       charts/3: the sets, which one answers a spot, lazy loading
  data/nlhe-cash-<6|9>max-<depth>bb.json   the committed sets (generated)
tests/scripts/preflop-charts/      npm run charts:generate (sets.ts, worker pool, cache),
                                   charts:report, charts:coverage, charts:compare
tests/test/charts/ (data, sets, registry, lookup, realisation, generate), tests/test/solver/preflop.test.ts
```

`lib/charts` follows `lib/solver`'s import rule (ESLint-enforced): it may
import only `lib/solver`, `lib/phf/types`, `lib/cards` and `lib/equity`, so
it runs under plain Node in the tests and in a Web Worker in the browser.

---

## 1. The game

Six players, UTG, HJ, CO, BTN, SB, BB, or nine, UTG, UTG+1, UTG+2, LJ, HJ,
CO, BTN, SB, BB - the stats engine's names (`positionRing`), which name a
seat by its distance from the button, so 6-max's UTG and 9-max's LJ are the
same seat. Blinds 0.5/1; no ante; every stack the set's depth (40, 60, 100,
150 or 200bb). Postflop order SB, BB, then the seats in table order, decides
who is in position.

### 1.1 Action abstraction

| Spot | Options |
|---|---|
| Unopened, UTG–BTN | fold, open to **2.5bb**. No open limps. |
| Unopened, SB | fold, complete (limp), raise to **3bb** |
| BB after an SB limp | check, raise to **4bb** |
| Facing an open | fold, call, 3-bet to **3x in position / 4x out of position**, plus **1x per caller** (squeeze); against the BB's raise over a limp, 3x |
| Facing a 3-bet | fold, call, 4-bet to **2.2x in position of the 3-bettor / 2.5x out of position** |
| Facing a 4-bet | fold, call, 5-bet **all-in** |
| Facing an all-in | fold, call |

Sizes round to 0.5bb. Why these: 2.5bb is the modal online open; the SB opens
bigger because it plays out of position against one player; 3x/4x is the
standard 3-bet split by position (out of position needs a bigger price to
deny realisation); +1x per caller keeps the squeezer's price per opponent;
2.2–2.5x 4-bets leave ~75bb behind (one more decision, the shove).

**By depth** (`tests/scripts/preflop-charts/sets.ts`, recorded in each set's
`model.tree.sizing`). One rule for every A2c set, `allInAbove: 0.4`: a raise
that would put more than 40% of the starting stack in is all-in instead -
the point where the stack-to-pot ratio behind leaves no real decision but
the shove.

| Depth | Open | SB | 3-bet | 4-bet | 5-bet |
|---|---|---|---|---|---|
| 40bb | **2.2bb** (sizes round to 0.1bb) | 3bb | 3x / 4x (+1x per caller) | **all-in**, except 2.2x of an in-position 3-bet (14.5bb, 36%) | all-in |
| 60bb | 2.5bb | 3bb | 3x / 4x (+1x per caller) | 2.2x / 2.5x over a plain 3-bet; **all-in** over a squeeze or the SB's re-raise of an iso (42-46%) | all-in |
| 100bb | 2.5bb | 3bb | 3x / 4x (+1x per caller) | 2.2x / 2.5x (at most 33% of the stack) | all-in |
| 150, 200bb | 2.5bb | 3bb | 3x / 4x (+1x per caller) | 2.2x / 2.5x | all-in |

Deep, the 5-bet stays a shove: a real non-all-in 5-bet maps onto it by
action translation and is usually `offTree` (§7), which caps the grade.

### 1.2 What the tree leaves out

A complete six-player no-limit tree is astronomically large. The tree keeps
real 6-max play and **marks** each removal so the lookup can refuse instead
of guessing (`preflopTree.ts`):

- **No open limps** except the SB's (`cut: ["limp"]`); no limp-behind.
- **No cold call of a 3-bet or 4-bet** (`cut: ["cold-call"]`): a player who has
  not put money in voluntarily (the blinds count as not having done so) may
  fold or re-raise. Facing an all-in such a player just folds (no node).
- **At most four entrants.** Once four players are in voluntarily, the rest
  fold (no node). Players already in may *always* continue. (A first version
  capped players per pot; a 4-bettor whose opponents had called a shove ahead
  of it was then forced to fold, and the solver learned to fold AA to a
  3-bet. Cap who enters, never who continues.)

The 6-max tree has 3,825 action nodes at 100bb and deeper, 1,365 at 60bb and
1,159 at 40bb (an all-in 4-bet ends the raising a level earlier); the 9-max
tree at 100bb and deeper 28,591. The cap of four
entrants is the same at nine seats: more seats means more ways to reach a
four-way pot, not bigger pots.

## 2. Hands and card removal

Preflop, suits are symmetric: 1326 combos reduce to **169 classes** (13 pairs ×
6 combos, 78 suited × 4, 78 offsuit × 12), indexed as the 13×13 grid (row and
column 0 = ace; pairs on the diagonal, suited above, offsuit below).

Card removal is modelled **between the hero and each opponent**, exactly at
class level: given one combo of class `i`, `m[i][j]` combos of class `j` remain
(`COMPAT`, brute-force tested), and an opponent holds class `j` with
probability `m[i][j]/1225`. **Card removal between two opponents is ignored**:
opponents are drawn independently given the hero. Consequences:

- blockers work for the hero (A5s blocks AA/AK when 4-betting);
- the folded players' ranges do not shift the remaining players' hands
  (the "folded ranges hold fewer aces" effect, small);
- each player evaluates the game under its own conditional distribution, so
  the players' values do not sum exactly to minus the rake (reported as
  `valueBbByPosition`; the gap is a few hundredths of a bb).

## 3. Equity

`E[i][j]`: all-in equity of class `i` against a random compatible combo of
class `j`, over random five-card boards (`preflopEquity.ts`). One
representative combo per hero class (exact by suit symmetry), every compatible
combo on the opponent side. **120,000 seeded boards** (`mulberry32`, seed
0x5eed), each evaluated once for all 1326 combos; ~80 s. The table is
symmetrised so `E[i][j] + E[j][i] = 1`, which makes heads-up pots conserve
chips. Conservative standard error per entry ~0.0011. Known values check out
(AA–KK 0.82, AKs–QQ 0.46, 72o–AA 0.12; tested to wide tolerance).

## 4. Equity realisation (what a flop is worth)

The solver stops at the flop. A pot that sees one is split by a **realised
share** per player, `preflopModel.ts`:

```
pairwise:   share(i vs j) = e·w_i / (e·w_i + (1 − e)·w_j)
weight:     log w(i) = bias[potType][role] + Σ_f coef[potType][role][f] · φ_f(i)
multiway:   share_p = x_p + (1 − Σ_k x_k)/n,  x_p = Π_{q≠p} share(p vs q)
value:      share · (pot − rake) − own contribution
```

The **odds form** instead of `R × equity`: shares of two players always sum to
one, stay in [0,1], and bend marginal hands most while leaving AA near its
equity. A constant `R` would make AA "realise" 68% out of position and would
not conserve the pot. **Number of players** enters only through the multiway
combination (`x_p` is "p beats everyone"; at most one player can, so
`Σx ≤ 1`); up to four players can see a flop.

**Roles.** A player's weight depends on its role against each opponent: in
or out of position, and last preflop raiser (`Agg`) or not (`Caller`; both
players of a limped pot, and two callers of someone else's raise). The biases
come from position and initiative edges `P`, `I` (odds multipliers):
`ipAgg = (ln P + ln I)/2`, `oopCaller = −(ln P + ln I)/2`,
`ipCaller = (ln P − ln I)/2`, `oopAgg = −(ln P − ln I)/2`. A raiser in position
against a caller gets the odds multiplier `P·I` for a class of average
features, two callers get `P`.

**Class features** `φ` (`REALISATION_FEATURES`): `pair`, `pairLow` (22 = 1,
AA = 0), `suited`, `gap0`/`gap1`/`gap2` (connector, one-, two-gapper),
`offGap3` (offsuit, three or more between), `high`/`low` (the ranks / 12,
unpaired), `suitedAce`, `offAce`. Eleven numbers per role say how a class
plays after the flop *relative to its raw equity* - raw strength is already
in `e`. The fit centres them over the 169 classes (combo-weighted), so that
`P` and `I` are the edges for an average class; the stored `bias` absorbs the
centring.

### 4.1 `charts/1`: set by hand

`charts/1` fixed the numbers from first principles and published realisation
bands: one playability for every role (suited ×1.15; connectors ×1.06,
one-gappers ×1.04, two-gappers ×1.02; pairs ×1.12; offsuit gap 3+ ×0.90),
faded by the pot type, and `P`/`I` of 1.25/1, 1.30/1.10, 1.20/1.08 and
1.08/1.04 for limped, single-raised, 3-bet and 4-bet pots. It is kept, in
this form, as `CHARTS1_REALISATION`: the generator's starting point. It
under-rated implied-odds hands: UTG opened A9o and A8o and folded 55–22, the
big blind defended 48% against a button open, nobody flatted in position.
Raising its pair and suited bonuses within defensible bounds barely moved
that.

### 4.2 `charts/2`: measured with our postflop solver

The coefficients are **fitted to our own postflop solver**
(`lib/charts/realisation.ts`, `lib/solver/preflopRealisation.ts`). Evidence
for choosing this over hand-set implied-odds terms: on the solver's own
numbers the fitted model's share error is 27–43% below `charts/1`'s and
35–55% below raw equity's (table below), and nothing in it is a number we picked to get
a chart we liked.

1. **Spots.** Thirteen heads-up flop terminals (`REALISATION_SPOTS`) cover
   every role in every pot type: BTN, CO and UTG open and the BB calls
   (raiser in position); CO and UTG open and the BTN calls, the SB opens and
   the BB calls (raiser out of position); BB and SB 3-bet the BTN, the BTN
   3-bets CO and UTG; a 4-bet pot each way; SB limps and BB checks. Each
   player's range is its reach there under the current charts - except the
   button's flat and the small blind's limp, measured on **every hand that
   continues** there (`candidates`): actions the charts take rarely have a
   range of a few classes that comes and goes from round to round, and the
   question the preflop solve asks is how the candidates would realise.
2. **Measurement.** Per spot, the same 120 seeded flop+turn deals
   (`mulberry32`, seed `0x7ea1`). On each, the turn and river are solved with
   the postflop engine (`cfr.ts`, 60 DCFR iterations, every river card) at
   the real pot and stacks, with a 75%-pot bet or all-in and all-in as the
   only raise, no rake. Per class and player the solve gives the share of the
   pot realised (root EV / pot: winning the opponent's chips counts, folding
   gets nothing) and the check-down equity on the same deals.
3. **Target.** Per class, `R = Σ share / Σ check-down equity` over the deals
   (most board noise cancels between the two), times the class's equity
   against the opponent's range from the 169×169 table.
4. **Fit.** Per pot type, Levenberg–Marquardt on `P`, `I` and the
   coefficients, minimising the probability-weighted squared share error over
   every spot, both players and every class in range. Raiser and caller in the
   same seat share their coefficients; a player counts `combos/(combos + 50)`
   of its range (a ten-combo range a sixth of a 400-combo one); a 1e-4 ridge
   keeps unidentified directions at zero. Classes that realise more than 0.92
   of the pot (AA and KK winning the stacks) are left out: the odds form caps
   a share at one pot (§9).
5. **Rounds.** Start from `charts/1`; solve (1,500 iterations), measure, fit
   on **every round's measurements so far**; three rounds; then the final
   3,000-iteration solve with the last fit. Every round is recorded in the set
   (`model.realisationFit.rounds`): spots and their combos, the fit error
   against `charts/1` and raw equity, measured and fitted range-average
   realisation per spot, and the widths that round's charts had.

**What is simplified.** The flop is dealt and *checked*: a flop solve is ~50×
a turn solve, out of reach for ~4,700 solves. That gives both players a free
card and keeps ranges uncapped (good for the hands that would have folded the
flop), and it takes away a street of betting (bad for the hands that flop
sets and flushes: two streets at a 75% bet rarely get 100bb in). A test with a
second, stack-geometric turn size (2.5× pot) raised in-position realisation of
pairs and suited connectors by 0.02–0.04 and lowered the BB's by 0.02, at
2.3× the cost; it is not in the generator. Sixty iterations leave a solve a
few percent of the pot from equilibrium, but its game values are already within
0.5% of the pot of a 300-iteration solve's (benchmark spot, BB vs BTN); the
fit's remaining error is mostly board sampling and the odds form's shape.

### 4.3 What the fit found (committed set)

Share error against the solver's measurements, final round (all three rounds'
spots; weighted RMS, in fractions of the pot):

| Pot type | fitted | `charts/1` | raw equity | `P` | `I` |
|---|---|---|---|---|---|
| limped | **0.034** | 0.060 | 0.061 | 1.08 | – |
| single-raised | **0.037** | 0.055 | 0.082 | 1.20 | 1.05 |
| 3-bet | **0.036** | 0.054 | 0.074 | 1.29 | 1.12 |
| 4-bet | **0.043** | 0.059 | 0.066 | 1.11 | 1.27 |

Range-average realisation `R` (realised share / equity), measured on the
last round's ranges, out of position / in position:

| Spot | measured | fitted |
|---|---|---|
| BTN opens, BB calls | 0.83 / 1.12 | 0.85 / 1.11 |
| CO opens, BB calls | 0.84 / 1.12 | 0.86 / 1.10 |
| UTG opens, BB calls | 0.85 / 1.10 | 0.87 / 1.09 |
| CO opens, BTN continues (candidates) | 0.88 / 1.10 | 0.89 / 1.09 |
| SB opens, BB calls | 0.95 / 1.07 | 0.94 / 1.08 |
| BB 3-bets BTN, BTN calls | 0.99 / 1.01 | 0.99 / 1.02 |
| BTN 3-bets CO, CO calls | 0.86 / 1.12 | 0.86 / 1.11 |
| SB limps (candidates), BB checks | 1.02 / 0.97 | 1.01 / 0.98 |

The big blind's 0.83 against a button open sits at the top of the 0.75–0.85
band public literature quotes (Acevedo, *Modern Poker Theory*, 2019,
ch. 2–3) — expected, since a checked flop is a free card (§4.2). By hand
group, single-raised pots, in / out of position: suited connectors and
one-gappers 1.28 / 0.99, suited aces 1.08 / 0.85, small pairs 22–66
1.13 / 0.95, offsuit broadways 0.99 / 0.78, offsuit aces A2o–A9o 0.93 / 0.70
(every round's groups are in `model.realisationFit`). That spread - suited
and connected hands well above their equity, dominated offsuit hands well
below - is what `charts/1`'s hand-set playability (×1.15, ×1.06, ×0.90)
under-stated by half, and it is where the charts moved.

**Initiative and rake.** The fitted initiative edge in single-raised pots is
1.05 (`charts/1`: 1.10); position carries most of the caller's deficit. Rake is
unchanged (5%, 3bb cap, final pot = flop pot × `RAKE_POT_GROWTH`): it costs a
caller in a 5.5bb pot ~0.17bb, real, and not something to fit away.

### 4.4 Rake

`STANDARD_RAKE` = 5%, capped at 3bb, no flop no drop. Only pots that
see a flop (or are all-in) are raked; the final pot is estimated as flop pot ×
`RAKE_POT_GROWTH` (our estimate of how much a pot grows after the flop, on
average — it decides how often the cap binds). A 5.5bb SRP pays ~0.48bb, a
4-bet pot hits the cap. The players' values sum to minus the expected rake per
hand (`model.convergence.rakeBbPerHand`), plus the small gap from ignoring
card removal between opponents (§2).

## 5. The solver

`preflopCfr.ts`: **Discounted CFR** (Brown & Sandholm 2019; α=1.5, β=0, γ=2,
the same engine parameters as the postflop solver), alternating updates over
the six players, every node carrying a 169-vector per player. A traversal
for player `p` stops where `p` folds (the rest of that subtree is `−contribution`
weighted by the opponents' reach), skips opponent actions nobody takes, and
applies share matrices column by column skipping zero-reach classes.
`cfr.ts` (the heads-up postflop engine) is untouched.

**No equilibrium guarantee.** CFR converges to a Nash equilibrium only in
two-player zero-sum games; with six players (or with rake) the average
strategy is at best a coarse correlated equilibrium. What can be measured is
how far the result is from a Nash equilibrium **of this model**:

- **NashConv**: for each player, a best response against the others' average
  strategies, minus that player's value; summed. Zero exactly at a Nash
  equilibrium. Exact for this model (every payoff is multilinear in the
  reaches; tested: with the others frozen, CFR for one player converges to
  its best response).
- **Strategy change** between checkpoints (reach-weighted L1, per node).
- **Heads-up blind-vs-blind solve** on its own, a true two-player game.

Measured for the committed set (M-series Mac, Node 24):

| | |
|---|---|
| Iterations | 3,000 (checkpoints every 500), after three 1,500-iteration rounds (§4.2) |
| NashConv | 1.00 → 0.34 → 0.20 → 0.13 → 0.10 → **0.075 mbb/hand** (`charts/1`: 0.06) |
| Best-response gain per position | UTG 0.005, HJ 0.009, CO 0.031, BTN 0.010, SB 0.011, BB 0.008 mbb/hand |
| Strategy change, last checkpoint | 0.002 (mean L1 per node) |
| Heads-up BvB, 1,000 iterations | 0.025 mbb/hand |
| Time | see §10 (~27 min from scratch, ~10 min with the caches) |

## 6. The chart sets

### 6.1 One set

Every set is one file, `data/<id>.json`; `nlhe-cash-6max-100bb.json`, for
example, is 736 KB (736,170 bytes) with 281 nodes. Header
(`model`) records every assumption above - the fitted realisation model's
every coefficient (`realisation`) and how it was fitted, round by round
(`realisationFit`) - plus the convergence history and a hash; then one node
per line: line key, actor, scenario, pot, options, and base64 arrays:

- `freq`: uint8/255 per action per class, rounded so each class sums to exactly 1;
- `ev`: int16, 0.01bb, net chips from the start of the hand (BB fold = −1.00);
- `range`: uint8/255 per class, how much of each class reaches the node.

**Line keys.** One letter per action in table order, folds included: `f` fold,
`k` check, `c` call/limp, `r` raise (the tree's size), `a` all-in. `"fffrf"`
= UTG, HJ, CO fold, BTN opens, SB folds: the BB's node.

**Scenarios** follow the stats engine's counters (`lib/stats/preflop.ts`):
`rfi` (with `steal` from CO/BTN/SB), `vs-limp` (iso), `vs-open` (3-bet
opportunity; `vsSteal` for a blind against a steal), `squeeze` (open +
callers), `vs-iso`, `vs-3bet` (4-bet; `cold` if not yet in), `vs-4bet`,
`vs-allin`.

**What is left out of the set:**

1. nodes reached less than **1e-5** of hands at equilibrium (`minReach`) —
   strategies there are the least trained, and the lines are rare enough that
   "not in the chart set" (`rare-line`) is the honest answer;
2. nodes where, for some class in range, the chart's own mix loses more than
   **2% of the pot** to that class's best action at the final EVs — nodes the
   equilibrium stops visiting early in the solve, whose averages are relics
   (2 nodes in `charts/2`; listed in `model.excluded`);
3. per class, **off-range** entries (stored range 0) get the **best response**
   (argmax EV) rather than an average strategy that never applied — what a
   player who got there anyway should do.

### 6.2 The library (`charts/3`)

`lib/charts/registry.ts` lists the committed sets (`CHART_SETS`: id, seats,
depth, a loader) and decides which one answers a spot (`pickChartSet`):

1. **Table.** `k` players dealt in are read on the smallest set with at least
   `k` seats: 3-6 handed on a 6-max set, 7-9 handed on a 9-max set. Fewer
   players than seats is the `short-handed` approximation (§6.3). Heads-up
   and ten or more are refused (`players`, §6.5).
2. **Depth.** Among that table's sets, the nearest to the effective stack
   (the hero against the deepest opponent still in), by relative distance.
   Further than **20%** from every one is refused (`stack-depth`); more than
   5% away is the `stack-depth` approximation, with the set and both depths.
   Strategies are **never interpolated** between two depths: a mix of two
   solutions is a solution of neither. Covered: 32-240bb on 6-max except
   72-80bb (20% from neither 60 nor 100), 80-240bb on 9-max.

| Set | Version | Nodes / tree | Bytes | Chunk, gzip | NashConv (mbb/hand) | Generation |
|---|---|---|---|---|---|---|
| `nlhe-cash-6max-40bb` | charts/3 | 335 / 1,159 | 785,898 | 181 KB | 0.038 | 35 min |
| `nlhe-cash-6max-60bb` | charts/3 | 368 / 1,365 | 881,956 | 211 KB | 0.058 | 36 min |
| `nlhe-cash-6max-100bb` | charts/2 | 281 / 3,825 | 736,170 | 171 KB | 0.075 | 27 min (10 cached) |
| `nlhe-cash-6max-150bb` | charts/3 | 343 / 3,825 | 853,183 | 212 KB | 0.121 | 48 min |
| `nlhe-cash-6max-200bb` | charts/3 | 355 / 3,825 | 886,115 | 224 KB | 0.130 | 57 min |
| `nlhe-cash-9max-100bb` | charts/3 | 1,033 / 28,591 | 2,381,005 | 570 KB | 0.256 | 126 min |
| `nlhe-cash-9max-150bb` | charts/3 | 1,139 / 28,591 | 2,641,632 | 645 KB | 0.313 | 131 min |
| `nlhe-cash-9max-200bb` | charts/3 | 1,129 / 28,591 | 2,623,202 | 641 KB | 0.485 | 133 min |
| **all eight** | | | **11,789,161** | **2.86 MB** | | ~2 h 15 min wall, 4 at a time |

Generation times are each set's own, measured with four sets running at once
(three turn+river worker threads each, M-series Mac, 10 cores). A 9-max
iteration costs ~8x a 6-max one (28,591 action nodes against 3,825), so the
9-max sets dominate. The 9-max sets converge a little less far in the same
3,000 iterations (NashConv 0.26-0.49 against 0.04-0.13); every best-response
gain per seat is under 0.2 mbb/hand.

`CHARTS_VERSION` is `charts/3`; each set carries its own `id` and the
`version` of the generator that made it: the 6-max 100bb set is still
`charts/2`'s, byte for byte (regenerated with the A2c code: identical
bytes), the others are `charts/3`. Grades store the set's id
(`facts.chart.set`).

**A library is a chart set.** `ChartLibrary` extends `ChartSet`; its own
fields are the default set's (6-max 100bb), so code that reads one set's
nodes - Reports, the 13x13 viewers - keeps working, while `lookupPreflop`
sees a library and answers from the set the spot needs (`result.set`).

**Lazy loading.** Each set is its own dynamic `import()`, so the bundler
gives it its own chunk and nothing loads a set it does not need:

- the analysis worker loads the library with its default set, and before a
  page of hands the sets those hands need (`requiredChartSets`: every
  player's preflop decisions, since opponents' chart ranges feed the
  postflop analysis; `ensureChartSets`). A set not loaded is `unavailable`,
  which the rebuild never stores;
- the chart browser and the hand view's study chart load the one set they
  draw (`preflopChartSet(id)` in `lib/chartSet.ts`); the browser has a
  table-and-depth selector (`?set=`).

Measured on `next build`: every set is its own chunk (the "Chunk" column
above; 0.67-0.84 MB raw for 6-max, 2.3-2.6 MB for 9-max), none of them in
any page's first load; the manifest (ids, seats, depths, loaders) is a few
hundred bytes in the pages and workers that import `lib/charts`. A hand
from a 9-handed 150bb table makes the worker fetch one 645 KB (gzip) chunk
once, not the library.

### 6.3 Smaller tables: earliest seats folded

A `k`-handed table is read on an `n`-seat set by distance from the button:
the blinds are the blinds, the table's other seats are the set's last
`k - 2`, and the set's first `n - k` seats fold before the hand starts.
Five-handed on 6-max: UTG -> HJ with UTG folded; 4-handed: CO, BTN with UTG
and HJ folded; 8-handed on 9-max: UTG -> UTG+1, UTG+1 -> UTG+2 with UTG
folded; 7-handed: UTG -> UTG+2, with UTG and UTG+1 folded.

**Why not separate 7- and 8-max sets.** In the charts' model this reading is
exact up to convergence: card removal between opponents is ignored (§2), so a
folded player's range multiplies every other player's counterfactual values
by a constant per hand class, which regret matching does not see; the game
after the folds is the smaller table's game. Measured
(`npm run charts:compare`: a native solve with the bigger set's realisation
model, sizes and depth, against the bigger set read short-handed, and
against a second native solve at 80% of the iterations as the noise floor):

| Table | Read as | Per-class frequency difference | Noise floor | Largest action-share difference | Noise floor |
|---|---|---|---|---|---|
| 5-handed | 6-max 100bb, UTG folded | 0.09% | 0.05% | 0.41 pts | 0.42 pts |
| 4-handed | 6-max 100bb, UTG, HJ folded | 0.12% | 0.05% | 0.62 pts | 0.36 pts |
| 3-handed | 6-max 100bb, UTG, HJ, CO folded | 0.18% | 0.07% | 0.45 pts | 0.17 pts |
| 8-handed | 9-max 100bb, UTG folded | 0.07% | 0.07% | 0.80 pts | 0.38 pts |
| 7-handed | 9-max 100bb, UTG, UTG+1 folded | 0.15% | 0.05% | 0.77 pts | 0.48 pts |

(Per-class difference: the share of each class that plays differently,
reach- and range-weighted; action-share difference: the largest gap in a
reported frequency at a node reached at least 1e-3.) Every RFI width agrees
to 0.1 point (8-handed: UTG+1 11.4 / 11.4, LJ 15.9 / 15.9, BTN 39.4 / 39.4);
mean EV differences are 0.05-0.15bb, mostly in deep, rarely reached nodes.
The reading is within a few tenths of a percent of a native solve - inside
twice the solver's own noise between two iteration counts.

What the reading leaves out is the real effect of the folds - folded ranges
hold fewer aces and kings, so the players left hold slightly more - which no
set models anyway (§2). A separate 8-max set would have cost another ~2 hours of
generation for differences inside the solver's own noise.

### 6.4 The realisation model per set

Reused from `charts/2`, unchanged: the odds form, the class features, the
thirteen spots (`REALISATION_SPOTS`, which name seats every table has), the
measurement (120 seeded flop+turn deals per spot, 60-iteration turn+river
solves, 75% bet or all-in), the fit, the rake. **Refitted per set**: every
A2c set runs the whole pipeline at its own table and depth - the spots are
measured on its own ranges at its own stack-to-pot ratios, so a 40bb single
raised pot (SPR ~7) and a 200bb one (SPR ~36) get the implied odds they
have. The rounds start from `charts/2`'s fitted model rather than `charts/1`
and run two rounds instead of three (the start is already a fit); the 40bb
set measures no 4-bet pot (both measured 4-bets are shoves at 40bb) and
keeps `charts/2`'s 4-bet coefficients for the few 4-bets that stay a raise.

Fit error (share RMS, single-raised pots, final round) and the measured
big-blind realisation against a button open, by set:

| Set | SRP fit error (fitted / charts/1 / equity) | P / I | BB vs BTN open: R out / in position |
|---|---|---|---|
| 6-max 40bb | 0.032 / 0.049 / 0.073 | 1.19 / 1.02 | 0.85 / 1.10 |
| 6-max 60bb | 0.034 / 0.051 / 0.077 | 1.19 / 1.04 | 0.84 / 1.12 |
| 6-max 100bb (charts/2) | 0.037 / 0.055 / 0.082 | 1.20 / 1.05 | 0.83 / 1.12 |
| 6-max 150bb | 0.038 / 0.053 / 0.084 | 1.21 / 1.04 | 0.83 / 1.13 |
| 6-max 200bb | 0.039 / 0.056 / 0.085 | 1.19 / 1.04 | 0.83 / 1.13 |
| 9-max 100bb | 0.038 / 0.054 / 0.081 | 1.22 / 1.05 | 0.83 / 1.12 |
| 9-max 150bb | 0.039 / 0.055 / 0.083 | 1.22 / 1.05 | 0.83 / 1.12 |
| 9-max 200bb | 0.041 / 0.056 / 0.084 | 1.20 / 1.05 | 0.84 / 1.12 |

Depth moves the single-raised realisation less than expected: the out of
position caller realises 0.85 of its equity at 40bb and 0.83 from 100bb up.
It moves the limped and 4-bet pots more (limped `P` 1.11 at 40bb, 1.02 at
200bb; 4-bet pots exist only from 60bb). Every round of every set is in its
`model.realisationFit`.

### 6.5 Not covered, by decision

- **Straddles** stay refused (`straddle`). A straddle is a third blind that
  moves the first decision and every price; covering it means another tree
  (straddler acting last preflop, opens against 4bb) per table and depth.
  In the WePlay export 52 of 6,121 hero preflop decisions (0.8%) have one -
  not worth a set yet.
- **Heads-up** stays refused (`players`): the button is the small blind and
  acts last after the flop, which no set models (our blind-versus-blind is
  the small blind out of position). 111 decisions (1.8%) in the WePlay export.
- **Ten or more players, antes, open limps, cold calls of 3-bets**: as before.
- **Depths**: under 32bb, 72-80bb and over 240bb (6-max); under 80bb and over
  240bb (9-max).

## 7. Lookup

```ts
lookupPreflop(charts, spot, hand?, heroAction?) -> ChartLookup
preflopSpotFromHand(hand: PhfHand, nth = 0, heroSeat?) -> { spot, heroAction, heroCards } | reason
```

`spot` = positions dealt in, hero, the preflop decisions before the hero's
(folds included), starting stacks in bb, ante/straddle flags. The walk replays
the real actions on the tree; raises map to the node's one raise size via
`lib/solver`'s `translateSize`, on pot fractions (`(to − bet to match) /
(pot after calling)`). The result is the node, the hero class's options
`{action, sizeBb, freq, ev}`, the index of the hero's own action, `inRange`,
`unmodelled` (options the tree cut here) and `approximations` (§3.5):

- `sizing` — a real raise differs from the chart's; `distance` in pot
  fractions; `offTree` beyond 0.25 of the pot (§3.3: caps the grade);
- `stack-depth` — effective stack within 20% of the answering set's depth
  but more than 5% from it (`set`, `realBb`, `chartBb`);
- `short-handed` — fewer players than the set's seats, read with the earliest
  seats folded (§6.3).

`charts` is one set or the library (§6.2); the result names the set that
answered (`set`). With one set the lookup reads only that set's table sizes
(3 to its seats) and depth (±20%), as before.

Refusals, `{ ok: false, reason, detail }`: `straddle`, `ante`, `players`
(heads-up, ten or more, or positions that are not a `k`-handed ring - a dead
button), `stack-depth` (no set within 20%), `limp` (an open limp other than
the SB's), `multiway` (a fifth entrant), `cold-call`, `off-tree`,
`rare-line`, `action-not-modelled` (the hero's real action is not an option
here), `unavailable` (the library has not loaded the set), `bad-input`.
`preflopSpotFromHand` itself refuses non-NLHE-cash games and bomb pots.
Coverage on the corpora is in §6.6.

## 8. Results (committed set)

`charts/1` → `charts/2` (`npm run charts:report` prints these for any set):

| | `charts/1` | `charts/2` |
|---|---|---|
| RFI UTG / HJ / CO / BTN | 16.7 / 21.1 / 27.4 / 40.7% | **15.4 / 19.7 / 26.1 / 39.3%** |
| SB first in (limp + raise) | 52.6% (28.1 + 24.5) | 59.9% (41.8 + 18.1) |
| BB vs BTN open: defend (call + 3-bet) | 48.3% (31.9 + 16.4) | **61.7% (49.1 + 12.7)** |
| BB vs CO open | 38.5% (27.6 + 10.9) | 41.8% (32.6 + 9.1) |
| BB vs HJ open | 28.6% (20.7 + 7.9) | 32.6% (25.5 + 7.2) |
| BB vs UTG open | 22.2% (15.4 + 6.7) | 26.1% (20.4 + 5.7) |
| BB vs SB open | 69.0% (48.5 + 20.6) | 66.6% (47.6 + 19.1) |
| SB vs BTN open | 15.5% (0.0 + 15.5) | 14.5% (1.9 + 12.7) |
| SB vs CO / HJ / UTG | 10.9 / 9.3 / 8.4% (flat 0.1 / 0.9 / 1.7) | 11.9 / 10.8 / 9.2% (flat 2.2 / 3.2 / 3.0) |
| BTN vs CO open | 15.3% (0.0 + 15.3) | 14.4% (0.2 + 14.3) |
| BTN vs HJ / UTG | 12.7 / 10.9% (flat 0.7 / 1.3) | 11.7 / 10.9% (flat 1.0 / 2.0) |
| HJ, CO vs earlier opens | 3-bet or fold | 3-bet or fold |
| Opener vs 3-bet: UTG v BTN (fold / call / 4-bet) | 41.5 / 42.0 / 16.5% | 42.2 / 40.5 / 17.3% |
| CO v BTN | 39.1 / 45.4 / 15.5% | 43.8 / 37.8 / 18.4% |
| BTN v BB | 43.9 / 44.7 / 11.4% | 46.5 / 41.5 / 12.1% |
| BB vs SB limp: check / raise | 59.1 / 40.9% | 58.3 / 41.7% |

**What moved.** UTG now opens 66+, A7s+, K7s+, Q9s+, JTs, T9s, AJo+, KJo+, QJo
and half of ATo; A9o and A8o, which `charts/1` opened, fold. HJ adds 55, A4s–A6s,
98s and 87s. The big blind defends 61.7% against a button open, four calls to
every 3-bet, and calls more than it 3-bets against every open. Against the
cutoff the button 3-bets suited connectors (T9s, J9s, 76s–54s) where
`charts/1` 3-bet ATo and A9o.

### Sanity bands (tested, `tests/test/charts/data.test.ts`)

From `charts/1`, unchanged: RFI widths strictly increase UTG < HJ < CO < BTN
and fall in UTG 13–20%, HJ 16–25%, CO 22–33%, BTN 38–55%, SB 40–70%; AA never
folds; KK never folds before an all-in (except cold against a 3-bet and a
4-bet) and folds a heads-up 5-bet shove at most half the time; 72o never opens
UTG; every class's frequencies sum to 1; for classes in range the chart's mix
is within 2% of the pot of the best action's EV and the best action is played;
off-range classes play their best response; NashConv under 1 mbb/hand.

Added by A2a.1, from general poker theory, never from a published chart:

| Band | Result | Tested |
|---|---|---|
| BB defends 55–70% vs a BTN 2.5x open, mostly by calling | 61.7%, call 49.1% | yes |
| BB calls more than it 3-bets vs every open; defends wider vs later opens | 20.4 / 25.5 / 32.6 / 49.1% calls | yes |
| UTG RFI 14–20%, pocket pairs and suited hands ahead of weak offsuit aces | 15.4%; 66+, A7s+, T9s, JTs; A9o–A2o fold | yes |
| Flats in position exist | BTN vs UTG 2.0%, vs HJ 1.0% | yes (> 1% vs UTG) |
| BTN flats a CO open at a meaningful frequency | **0.2%** | **not met** (§9) |
| UTG opens most pairs, 33+ (ideally 22+) | **66+** | **not met** (§9) |
| UTG opens some suited connectors / wheel aces | T9s, JTs; no 87s–54s, no A5s | partly (§9) |
| RFI monotone; SB sensible; AA/KK never fold | yes; SB limps 42%, raises 18% | yes |

### 8.2 The A2c sets (`charts/3`)

`npm run charts:report` prints the full tables for every set. RFI widths
(raise first in; the SB's limp + raise), continue = call + 3-bet:

| | 40bb | 60bb | 100bb | 150bb | 200bb |
|---|---|---|---|---|---|
| **6-max** UTG / HJ / CO / BTN | 16.8 / 19.9 / 25.1 / 35.1 | 16.0 / 20.3 / 26.1 / 37.6 | 15.4 / 19.7 / 26.1 / 39.3 | 16.8 / 20.0 / 26.5 / 40.9 | 16.4 / 20.3 / 26.9 / 38.9 |
| SB first in (limp + raise) | 62.3 (38.5 + 23.8) | 57.8 (32.3 + 25.5) | 59.9 (41.8 + 18.1) | 61.8 (46.8 + 14.9) | 66.4 (54.7 + 11.7) |
| BB vs BTN open (call + 3-bet) | **78.1** (67.1 + 11.0) | 63.0 (50.2 + 12.8) | 61.7 (49.1 + 12.7) | 62.0 (50.1 + 11.9) | 62.1 (49.7 + 12.4) |
| BB vs UTG open | **51.2** (45.7 + 5.6) | 28.5 (22.3 + 6.2) | 26.1 (20.4 + 5.7) | 26.2 (20.5 + 5.7) | 26.7 (21.0 + 5.7) |
| UTG vs BTN 3-bet: fold / call / 4-bet | 45.0 / 36.7 / 18.3 | 51.7 / 25.7 / 22.6 | 42.2 / 40.5 / 17.3 | 43.2 / 37.7 / 19.2 | 41.1 / 40.6 / 18.2 |

| 9-max | 100bb | 150bb | 200bb |
|---|---|---|---|
| UTG / UTG+1 / UTG+2 | **10.2 / 11.4 / 13.5** | 10.6 / 11.7 / 13.8 | 10.8 / 12.2 / 13.4 |
| LJ / HJ / CO / BTN | 15.9 / 20.3 / 26.9 / 39.4 | 16.4 / 20.1 / 26.8 / 40.7 | 16.3 / 20.3 / 26.7 / 39.3 |
| SB first in (limp + raise) | 58.8 (40.0 + 18.8) | 61.3 (45.5 + 15.8) | 66.6 (54.6 + 12.0) |
| BB vs BTN open | 62.0 (49.5 + 12.5) | 62.0 (49.7 + 12.3) | 61.1 (48.5 + 12.7) |
| BB vs UTG open | 19.5 (16.0 + 3.5) | 19.9 (17.0 + 2.9) | 19.9 (17.5 + 2.4) |
| UTG vs BTN 3-bet: fold / call / 4-bet | 46.3 / 35.2 / 18.5 | 45.0 / 36.3 / 18.7 | 46.7 / 33.7 / 19.6 |

**What the sets say.** The early full-ring seats open 10-14%, tighter than
6-max's UTG (15-17%), and the 9-max LJ - the same seat as 6-max's UTG -
opens 15.9-16.4%, within a point of it at every depth: the table size
changes only the seats in front. Deeper, the small blind limps more (42%
at 100bb, 55% at 200bb) and raises less; the button and the big blind barely
move. At **40bb** the big blind defends much wider (78% against a button
open, 51% against UTG): the 2.2bb open lays it 3.1:1 and the fitted
out-of-position caller realises 0.85 of its equity there, against 0.83
deeper (§6.4). That is the model's answer; it is wider than published
short-stack defence usually is, and the flop measurement (§9) is where to
check it.

### Sanity bands for every set (tested, `tests/test/charts/sets.test.ts`)

Every set: frequencies sum to 1; EVs consistent with frequencies (the
chart's mix within 2% of the pot of the best action for every class in
range, off-range classes on their best response); AA never folds; KK never
folds before an all-in except cold (fold or re-raise only) or against two
re-raisers; 72o never opens first in; RFI widens with position (within a
point among the three earliest full-ring seats, strictly from the LJ on);
the SB continues 35-75% first in; the BB defends 40-80% against a button
open; NashConv under 1 mbb/hand (6-max) or 2 (9-max). Across sets: each of
9-max's three earliest seats opens tighter than 6-max's UTG at the same
depth, and 9-max's LJ within 4 points of it; the 40bb set opens 2.2bb and
shoves its 4-bets past 40% of the stack; 150 and 200bb keep raise-sized
4-bets.

## 9. Known limits

- **The flop is checked in the measurement** (§4.2). Free cards favour the
  caller and the hands that would fold the flop; a missing street of betting
  costs the hands that flop sets and flushes their implied odds (two streets
  at a 75% bet rarely get 100bb in). The second effect is the likely reason
  for the two bands `charts/2` misses:
  - **UTG folds 55–22, 87s–54s and A5s** (EV of opening 55 −0.06bb, 22
    −0.31bb against folding). The fit reproduces what the solver measured for
    these hands (small pairs realise 1.13 of their equity in position, 0.95
    out of it); the measurement itself is short of their set value.
  - **The button almost never flats a cutoff open (0.2%)**; it flats UTG 2.0%
    and HJ 1.0%. Flatting and 3-betting are within a few hundredths of a bb
    of each other for 88, ATs, A8s and AJo, so small changes in the model
    move flats in and out (an intermediate run of the generator had 5.7%).
    Lines through a cutoff-button flat are in the set now (`ffrc`), but the
    flat itself is graded against an almost-pure 3-bet.
  A stack-geometric turn size (2.5× pot) measured +0.02–0.04 realisation for
  pairs and suited connectors in position, not enough to flip 22–44, at 2.3×
  the generation time; it is not in. The lasting fix is a flop measurement:
  A5b's flop library, or flop solves for the realisation spots.
- **The odds form caps a share at one pot.** AA and KK realise 1.3–1.5× their
  equity in position (they win the stacks); the model gives them ~1.05. They
  are left out of the fit; their preflop strategy (raise, re-raise) does not
  depend on it, but the EV of flatting with them is understated.
- **Class features, not classes.** Eleven features per seat describe 169
  classes; the fit's error is about 0.035 of the pot per class. Two hands with
  the same features (A7s and A6s) realise alike by construction.
- **Multiway pots** use the pairwise shares combined by `x_p + (1 − Σx)/n`;
  no multiway pot is measured.
- **A fixed point, approximately.** Three rounds; between the last two the BB's
  defence against the button moved 61.2% → 61.7% and UTG's RFI 15.5% → 15.4%;
  the SB's limp frequency moved most between rounds (`model.realisationFit`).
- **No card removal between opponents**, see §2.
- **Rake on the flop pot** is estimated from a growth factor, not played out.
- **Out of scope by construction**: antes, straddles, heads-up, ten or more
  players, depths under 32bb, 72-80bb and over 240bb (§6.5), open limps,
  cold calls of 3-bets, five-way pots, MTT/ICM.
- **Smaller tables are read on bigger sets** (§6.3): exact in the model up
  to convergence, but the real card removal of the folded seats is not
  there.
- **No interpolation between depths**: a 125bb stack is graded on the
  150bb set, with a `stack-depth` note; strategies between two depths are
  whatever the nearer set says.
- **The 9-max sets are less converged** (NashConv 0.26-0.49 mbb/hand against
  0.04-0.13 for 6-max at the same 3,000 iterations) and bigger (2.4-2.6 MB
  each), and keep 7-15 rare nodes out as unconverged
  (`model.excluded`); the 6-max 200bb set leaves out `rcf` (the button
  facing an UTG open and a HJ flat, reach 0.15%) the same way.
- **Reports and the study plan** read the 6-max 100bb set only: Reports'
  references are per node of the default set (decisions graded on other
  sets are counted and left out, with A3's note), and the study plan's
  trainer links name 6-max seats.
- Lines reached less than 1e-5 at equilibrium are not in the set; real
  players reach some of them.

## 10. Regenerating

```bash
cd tests
CHARTS_PARALLEL=4 CHARTS_THREADS=12 npm run charts:generate   # every set, ~2 h 15 min wall on 10 cores
CHARTS_SETS=nlhe-cash-6max-60bb npm run charts:generate       # one set
npm run charts:report        # the §8 tables for every committed set (CHARTS_FILE=... for one file)
npm run charts:coverage      # §6.6: graded decisions on the corpora, 6-max 100bb alone vs the library
npm run charts:compare       # §6.3: a native short-handed solve against a bigger set read short-handed
```

`tests/scripts/preflop-charts/sets.ts` lists every set's table, depth, sizes,
rounds and starting model. `charts:generate` writes
`frontend/src/lib/charts/data/<id>.json` per set and prints each round's fit,
convergence, the §8 tables, size, and whether the bytes changed. With
`CHARTS_PARALLEL` above 1 it runs one child process per set (a preflop solve
is single-threaded), splits `CHARTS_THREADS` between them for the
turn+river workers and logs each to `.cache/logs/<id>.log`; the results do
not depend on the split. Regenerating the 6-max 100bb set with the A2c code
writes its committed `charts/2` bytes exactly (checked, cached and after the
solver's fold-mass cache, which changes no number). The figures below are
the 6-max 100bb set's alone. Time, measured on an M-series Mac (10 threads, Node 24): ~80 s for
the equity table (once), then per round ~110 s for the 1,500-iteration solve
and ~7 min for 1,560 turn+river solves on worker threads, and ~3.5 min for the
final solve - 1,587 s in all with nothing cached. The turn+river results are
cached in `tests/scripts/preflop-charts/.cache/realisation-<hash>.json`, keyed
by every job's ranges, deal, pot, stack, menu and iterations, so rerunning
after a change to the fit or the report skips the solves (586 s);
`CHARTS_NO_CACHE=1` ignores it, and a change to the postflop solver must clear
`.cache/` (the key does not cover code). The worker is bundled with esbuild
into `.cache/`.

Deterministic: the equity sample and the deals are seeded, the solvers read no
clock or random source, worker results are put back in job order, and the
cache round-trips doubles exactly - a rerun of the same code writes identical
bytes (checked on the full run, cached and uncached; a small configuration is
checked in `tests/test/charts/realisation.test.ts`). Overrides for
experiments: `CHARTS_ITERATIONS`, `CHARTS_BOARDS`, `CHARTS_OUT`,
`CHARTS_ROUNDS`, `CHARTS_ROUND_ITERATIONS`, `CHARTS_MEASURE_BOARDS`,
`CHARTS_THREADS`, `CHARTS_SETS`, `CHARTS_PARALLEL`. Not part of `npm test`.

Any change to a constant, size, cut or the engine changes the numbers; the
set's `model.hash` changes with them, and the analysis version
(`ANALYSIS_VERSION`) must be bumped when grades are stored from the new set.
