# CHARTS — preflop reference charts, `charts/1`

Phase A2a of [`ANALYSIS-PLAN.md`](ANALYSIS-PLAN.md) (§3.1 is the spec). Rail's
preflop reference for **NLHE cash, 6-max, 100bb**: for every decision point
of a preflop betting tree and every one of the 169 hand classes, a frequency
and an EV in big blinds per action. Grading (§2) reads both.

The charts are **ours**. They are computed by our own solver (`lib/solver`,
DCFR) on a model described below, reproducibly, from a seed. Nothing from GTO
Wizard, Upswing or any published chart is used as input, as a target or for
tuning; the constants are set from first principles and public literature on
equity realisation, and are all in this document.

```
frontend/src/lib/solver/
  handClasses.ts    169 classes, combo counts, class-level card removal
  preflopEquity.ts  169x169 all-in equity, seeded Monte Carlo
  preflopModel.ts   equity realisation, multiway combination, rake
  preflopTree.ts    the 6-max action abstraction and its cuts
  preflopCfr.ts     DCFR for up to six players; best response, NashConv
frontend/src/lib/charts/
  format.ts         CHARTS_VERSION, JSON format, encode/decode, loadCharts
  build.ts          solved game -> chart set (reach, ranges, scenarios, filters)
  generate.ts       the whole generator as a pure function
  lookup.ts         real preflop line -> node + options + approximations
  fromHand.ts       PhfHand -> the spot of one hero preflop decision
  data/nlhe-cash-6max-100bb.json   the committed set (generated)
tests/scripts/preflop-charts/      npm run charts:generate
tests/test/charts/, tests/test/solver/preflop.test.ts
```

`lib/charts` follows `lib/solver`'s import rule (ESLint-enforced): it may
import only `lib/solver`, `lib/phf/types`, `lib/cards` and `lib/equity`, so
it runs under plain Node in the tests and in a Web Worker in the browser.

---

## 1. The game

Six players, UTG, HJ, CO, BTN, SB, BB; blinds 0.5/1; no ante; every stack
100bb. Postflop order SB, BB, UTG, HJ, CO, BTN decides who is in position.

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

The 6-max tree has 3,825 action nodes.

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
weight:     w = playability(hand)^PLAYABILITY_EXPONENT[potType]
              · POSITION_EDGE[potType]^(±½)     IP +, OOP −
              · INITIATIVE_EDGE[potType]^(±½)   last raiser +, caller −
multiway:   share_p = x_p + (1 − Σ_k x_k)/n,  x_p = Π_{q≠p} share(p vs q)
value:      share · (pot − rake) − own contribution
```

The **odds form** instead of `R × equity`: shares of two players always sum to
one, stay in [0,1], and bend marginal hands most while leaving AA near its
equity — the shape realisation estimates have. A constant `R` would make AA
"realise" 68% out of position and would not conserve the pot.

| Constant | limped | SRP | 3-bet | 4-bet | all-in |
|---|---|---|---|---|---|
| `POSITION_EDGE` (odds ×, IP over OOP) | 1.25 | 1.30 | 1.20 | 1.08 | 1 |
| `INITIATIVE_EDGE` (raiser over caller) | 1 | 1.10 | 1.08 | 1.04 | 1 |
| `PLAYABILITY_EXPONENT` | 1 | 1 | 0.6 | 0.3 | 0 |
| `RAKE_POT_GROWTH` (final / flop pot) | 2.0 | 1.75 | 1.4 | 1.15 | 1 |

`PLAYABILITY`: suited ×1.15; connectors ×1.06 / one-gappers ×1.04 /
two-gappers ×1.02; pocket pairs ×1.12; offsuit hands with a gap of 3+ ×0.90.

**Calibration.** The edges shrink with the stack-to-pot ratio (~18 SRP, ~4.5
3-bet, ~1.5 4-bet, 0 all-in). They are set so the implied range-average
realisation lands in the bands public literature gives (Acevedo, *Modern
Poker Theory*, 2019, ch. 2–3, and widely quoted training figures): a big
blind with 42% raw equity against a button open realises ~0.80 of it, the
button ~1.14. No chart or solution from any product is used as a target.

**Number of players** enters only through the multiway combination (`x_p` is
"p beats everyone"; at most one player can, so `Σx ≤ 1`). AA against two
random hands gets ~0.77 (true all-in equity 0.73). Up to four players can see
a flop.

**Rake.** `STANDARD_RAKE` = 5%, capped at 3bb, no flop no drop. Only pots that
see a flop (or are all-in) are raked; the final pot is estimated as flop pot ×
`RAKE_POT_GROWTH` (our estimate of how much a pot grows after the flop, on
average — it decides how often the cap binds). A 5.5bb SRP pays ~0.48bb, a
4-bet pot hits the cap. The players' values sum to −0.257bb per hand
(`model.convergence.rakeBbPerHand`): the expected rake, plus the small gap
from ignoring card removal between opponents (§2).

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
| Iterations | 3,000 (checkpoints every 500) |
| NashConv | 1.32 → 0.94 → 0.32 → 0.20 → 0.13 → 0.09 → **0.06 mbb/hand** |
| Best-response gain per position | UTG 0.007, HJ 0.012, CO 0.015, BTN 0.011, SB 0.006, BB 0.007 mbb/hand |
| Strategy change, last checkpoint | 0.002 (mean L1 per node) |
| Heads-up BvB, 1,000 iterations | 0.08 mbb/hand |
| Time | ~80 s equity table (cached afterwards) + ~220 s solve |

## 6. The chart set

`data/nlhe-cash-6max-100bb.json`, ~630 KB, 280 nodes. Header (`model`) records
every assumption above plus the convergence history and a hash; then one node
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
   (2 nodes; listed in `model.excluded`);
3. per class, **off-range** entries (stored range 0) get the **best response**
   (argmax EV) rather than an average strategy that never applied — what a
   player who got there anyway should do.

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
- `stack-depth` — effective stack within ±20% but more than 5% from 100bb;
- `short-handed` — five players dealt in, read as 6-max with UTG folded.

Refusals, `{ ok: false, reason, detail }`: `straddle`, `ante`, `players` (not 5
or 6 dealt in), `stack-depth` (effective stack outside 80–120bb), `limp` (an
open limp other than the SB's), `multiway` (a fifth entrant), `cold-call`,
`off-tree`, `rare-line`, `action-not-modelled` (the hero's real action is
not an option here), `bad-input`. `preflopSpotFromHand` itself refuses
non-NLHE-cash games and bomb pots. On the GG fixture corpus, ~58% of hero
preflop decisions get a node; most of the rest are deeper than 120bb or
behind an open limp.

## 8. Results (committed set)

| | |
|---|---|
| RFI UTG / HJ / CO / BTN | **16.7% / 21.1% / 27.4% / 40.7%** |
| SB first in | 52.6% (limp 28.1%, raise 24.5%) |
| BB vs BTN open | defends 48.3% (call 31.9%, 3-bet 16.4%) |
| SB vs BTN open | 3-bet 15.5%, no flat |
| BTN vs CO open | 3-bet 15.3%, no flat |
| CO open vs BTN 3-bet | 4-bet 15.5%, call 45.4%, fold 39.1% |

### Sanity bands (tested, `tests/test/charts/data.test.ts`)

RFI widths strictly increase UTG < HJ < CO < BTN and fall in UTG 13–20%,
HJ 16–25%, CO 22–33%, BTN 38–55%, SB 40–70% (folklore-wide bands that catch a
broken generator, not a model change). AA never folds; KK never folds before
an all-in and folds a heads-up 5-bet shove at most a quarter of the time;
72o never opens UTG; every class's frequencies sum to 1; for classes in range
the chart's mix is within 2% of the pot of the best action's EV and the best
action is played; off-range classes play their best response; NashConv under
1 mbb/hand.

## 9. Known limits

- **Equity realisation is a model, not a postflop solve.** It underrates
  implied-odds hands: early-position charts prefer high cards (UTG opens
  A9o and A8o, mixes 66, folds 55–22 and every suited connector below QJs),
  the opposite of what postflop-solved charts do. Raising the pair and suited bonuses within
  defensible bounds barely moves it; it needs a postflop-aware value of a
  flop (A5's flop library could supply realisation per class).
- **Flatting is rare.** With rake on every flop and the realisation edges,
  3-bet-or-fold dominates for the SB, the BTN against the CO, and others, and
  the BB defends ~48% against a button open (lower than common rake-game
  references). Lines through such flats (`CO opens, BTN calls`) are then
  `rare-line`.
- **No card removal between opponents**, see §2.
- **Rake on the flop pot** is estimated from a growth factor, not played out.
- **Out of scope by construction**: antes, straddles, 9-max, other depths,
  open limps, cold calls of 3-bets, five-way pots, MTT/ICM.
- Lines reached less than 1e-5 at equilibrium are not in the set; real
  players reach some of them.

## 10. Regenerating

```bash
cd tests
npm run charts:generate      # ~5 min first run, ~4 min with the cached equity
```

It writes `frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json` and prints
convergence, widths, size, and whether the bytes changed. Deterministic: the
equity sample is seeded and the solver reads no clock or random source, so a
rerun of the same code writes identical bytes (checked on the full run; a
small configuration is checked in `tests/test/charts/generate.test.ts`). The
equity table is cached in `tests/scripts/preflop-charts/.cache/`
(git-ignored). `CHARTS_ITERATIONS`, `CHARTS_BOARDS` and `CHARTS_OUT` override
the defaults for experiments. Not part of `npm test`.

Any change to a constant, size, cut or the engine changes the numbers; the
set's `model.hash` changes with them, and the analysis version
(`ANALYSIS_VERSION`) must be bumped when grades are stored from the new set.
