# CHARTS — preflop reference charts, `charts/6`

Phases A2a, A2a.1, A2c, A2d and A2e (and `charts/6`, the 200bb re-solve) of [`ANALYSIS-PLAN.md`](ANALYSIS-PLAN.md) (§3.1 is the spec).
Rail's preflop reference for **NLHE cash**: a library of chart sets
(**6-max at 40 / 60 / 100 / 150 / 200bb, 9-max at 100 / 150 / 200bb, and
6-max 100bb with a 2bb UTG straddle**, §6),
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
that picks a set per spot (§6). `charts/4` (A2d) adds limped pots to every
set: open limps, over-limps, isolation raises and the limpers' answers
(§1.3), solved once per set on its committed realisation fit (§6.7).
`charts/5` (A2e) adds the straddle set: a third blind, the straddler's
option last, its own realisation measured on its own spots (§1.4, §6.8).
`charts/6` solves the two 200bb sets for 9,000 iterations instead of 3,000,
so their big blind facing a single limp converges and is in the set (§5.1).

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
  data/nlhe-cash-6max-100bb-straddle.json  the straddle set (charts/5, generated)
tests/scripts/preflop-charts/      npm run charts:generate (sets.ts, worker pool, cache),
                                   charts:report, charts:coverage, charts:compare
tests/test/charts/ (data, sets, straddle, registry, lookup, realisation, generate), tests/test/solver/preflop.test.ts
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
| Unopened, UTG–BTN | fold, open to **2.5bb**; since `charts/4` also limp (§1.3) |
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

- **Limps** (`charts/4`, §1.3): at most three limpers (the SB's completion
  counts); a fourth would-be limper may only fold or isolate
  (`cut: ["limpers-cap"]`, the lookup's `multiway`). Behind a limp from a
  seat other than the blinds the pot's 4-bet is all-in. Before `charts/4`
  there were no open limps except the SB's (`cut: ["limp"]`).
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

### 1.3 Limped pots (`charts/4`, A2d)

Open limps were the biggest refusal in the owner's library after A2c: 933
hero decisions behind a limp (most of them 8- and 9-handed pots), 17% of all
preflop decisions. `charts/4` puts them on the tree (`maxLimpers: 3`):

| Spot | Options |
|---|---|
| Unopened, UTG–BTN | fold, **limp**, open |
| Behind one or two limpers (the SB: up to three) | fold, **over-limp**, **isolate** |
| Behind three limpers | fold, isolate (`limpers-cap`) |
| BB behind limpers | **check**, isolate |
| Facing an isolation raise | fold, call, re-raise **3x** (+1x per caller of the isolation) |
| Behind an open limp, facing a re-raise | fold, call, **all-in** (the 4-bet is a shove) |

**Isolation sizes**: 4bb over one limper in position of it, +1bb per limper
beyond the first, +1bb when the raiser is out of position of a limper (a
blind isolating): the button over an UTG limp 4bb, over two limpers 5bb; the
small blind or big blind over a button limp 5bb; the big blind over three
limpers 7bb. The big blind over the small blind's completion is `charts/3`'s
4bb, so the blind-versus-blind tree is unchanged. Limpers count as entrants
(at most four), so three limpers and an isolation close the pot to the rest.

**Caps, and why.** A limp multiplies the tree: every seat's unopened
decision gains an edge, and each limped pot grows its own isolation and
re-raise subtree. Measured (100bb, action nodes):

| | no limps | 1 limper | 2 limpers | 3 limpers | 3, 4-bet all-in behind a limp (shipped) |
|---|---|---|---|---|---|
| 6-max | 3,825 | 8,355 | 12,396 | 14,837 | **10,361** |
| 9-max | 28,591 | 62,261 | 94,958 | 118,947 | **79,131** |

Three limpers covers 922 of the library's 933 limp refusals (eleven were
behind four); the 4-bet shove behind a limp removes a raise level that
limped pots almost never reach (no decision in the library faces a 4-bet
in a limped pot) and is a third of the tree.

**The equilibrium hardly limps - the tremble.** At equilibrium no seat but
the small blind limps more than a fraction of a percent, so the nodes behind
a limp would be off the equilibrium path: CFR weights a player's regrets by
the opponents' reach, and with nobody limping nobody's strategy facing a
limp is ever trained (the first experiments showed exactly that). The solve
is therefore **ε-perturbed** (Selten's trembling hand; the perturbed games
of Farina, Kroer and Sandholm): at every unopened decision of a seat other
than the blinds, every class limps with probability at least `ε = 0.005`
(`limpFloor`). Regret matching runs on the free part of the strategy and the
game is played with the perturbed one, in every traversal, the best response
and the evaluation; NashConv is measured in the perturbed game
(`preflopCfr.ts`, "Trembling limps"). Consequences:

- a limper's range behind its limp is its equilibrium limps plus 0.5% of
  every class: **the reference's limper may hold any hand** - which is what
  a hero facing a real limper is graded against. Its own later decisions
  (fold, call or re-raise an isolation) are trained for every class, as
  anyone's are;
- every chart's unopened nodes show the 0.5% limp for every class (72o UTG
  limps 0.5%, folds 99.5%): within the grading's Perfect band, and a real
  open limp with 72o is graded against folding at its EV;
- the rest of the tree barely moves: raise-first-in widths within 0.6
  points of `charts/3` (§8.3).

**Nodes kept.** Nodes behind an open limp are kept down to a reach of
`1e-6` (`minLimpReach`) instead of `1e-5`: their reach is the tremble's
(1 limper ~1e-3, 2 limpers ~1e-5 to 1e-4, 3 limpers ~1e-6), and
it is what grades a hero there. The unconverged-node rule (§6.1) still
applies.

**Opponents' ranges after a limp.** The charts' limper holds any hand, so
the postflop walk does not start from it: an opponent who open-limped keeps
the labelled placeholder limp range (`chartRange`, `lib/analysis/preflop.ts`);
everyone else facing the limp (the isolator, the big blind who checked)
starts from the charts as before.

### 1.4 Straddled pots (`charts/5`, A2e)

A straddle is a **third blind**: a forced 2bb from the first seat left of the
big blind (6-max's UTG), posted before the cards. `charts/5` adds one set
for it, `nlhe-cash-6max-100bb-straddle`, on its own tree
(`PreflopTreeConfig.straddle`):

- **It is a blind, not a raise.** The pot is unopened (`level` 0) at 2bb to
  match - the stats engine's rule too (`lib/stats/preflop.ts`: a straddle is
  a blind). The action starts at the HJ; the straddler acts **last**
  preflop with the option the big blind has without a straddle: behind
  limpers it checks or isolates, folded to it the pot is a walk.
- **Action order is the set's seat order.** The tree's `players` and the
  set's `game.positions` are `HJ, CO, BTN, SB, BB, UTG`, so a line key is
  still one letter per action in that order (`"ffr"` is the HJ and CO
  folding and the button opening: the small blind's node), and every walk
  of a line (the lookup, Reports, the trainer, the browser) reads it with
  the set's own seats. `game.straddle` records `{ position: "UTG", bb: 2 }`.
- **Both blinds face the straddle**: fold, complete to 2bb (a blind's limp,
  like the small blind's completion without a straddle: no tremble, and no
  all-in 4-bet behind it) or raise first in.
- **Sizes against 2bb** (`sets.ts`): every size the big blind sets doubles -
  the open is 2.5 straddles (**5bb**), a blind's raise first in 3 straddles
  (**6bb**), an isolation **8bb** over one limper, +2bb per further limper
  and +2bb out of position of a limper (the straddler isolating a button
  limp: 10bb). 3-bets and 4-bets are the same multiples of the raise faced
  (3x / 4x +1x per caller; 2.2x / 2.5x), so they scale by themselves.
- **A 50-straddle game.** 100bb behind a 2bb straddle is 50 straddles, and
  the A2c rule `allInAbove: 0.4` makes some 4-bets shoves: over the
  straddler's 4x 3-bet (20bb) a 2.2x 4-bet is 44bb, past 40% of the stack.
  A 4-bet over an in-position 3-bet (15bb x 2.5 = 37.5bb) stays a raise.
- The limp tree (`maxLimpers` 3, the 0.5% tremble from the HJ, CO and
  button) and every cut of §1.2 as in `charts/4`.

| | Nodes in the tree | Kept |
|---|---|---|
| 6-max 100bb, no straddle (`charts/4`) | 10,361 | 752 |
| 6-max 100bb, UTG straddle (`charts/5`) | **4,906** | (§6.2) |

The straddled tree is half the size: one fewer seat ever opens (the
straddler only has its option), and the shallower 50-straddle stack ends the
raising a level earlier more often.

**What it does not cover**: a straddle from any other seat (a button or
Mississippi straddle), a re-straddle, a straddle of another size, 3-handed
(the seat left of the big blind is the button) or 7 and more handed, and
other depths; each is refused as `straddle`, with what it was (§7).

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
the six (or nine) players, every node carrying a 169-vector per player. A traversal
for player `p` stops where `p` folds (the rest of that subtree is `−contribution`
weighted by the opponents' reach), skips opponent actions nobody takes, and
applies share matrices column by column skipping zero-reach classes. A folded
opponent's reach never changes below its fold, so its mass is computed once
there rather than at every terminal below (A2c: the same numbers in the same
order - the 6-max 100bb set regenerates byte for byte - about 1.25x faster at
nine seats, where terminals dominate).
`cfr.ts` (the heads-up postflop engine) is untouched.

Two additions in `charts/4` (A2d):

- **The limp tremble** (`limpFloor`, §1.3): an ε-perturbed game, solved by
  regret matching on the free part of each trembling node's strategy and
  played with the perturbed one; best responses and NashConv are the
  perturbed game's.
- **Multiway products kept between traversals.** In a pot of three or four,
  each traversal multiplied every pair's share matrix by a reach vector;
  `S_ab π_b` depends on `b`'s reach alone, which only `b`'s own traversal
  changes, so it is now computed once and kept until then (`pairProduct`,
  stamped by `b`'s traversal count and the solver's mode). The same numbers
  in the same order - a 20-iteration checksum is identical - at about two
  thirds of the time on the limp trees, whose limped pots are mostly three-
  and four-way with wide ranges.

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

### 5.1 The deep limp nodes: 9,000 iterations at 200bb (`charts/6`)

After `charts/4` both 200bb sets left the **big blind facing a single limp**
out as unconverged (§6.1) from most seats: 6-max from the HJ, CO and button
(`fcfff`, `ffcff`, `fffcf`), 9-max from the HJ, CO and button
(`ffffcfff`, `fffffcff`, `ffffffcf`); the chart's own mix lost 2.2-2.8% of
the pot for one class after 3,000 iterations, so a big blind there was
`rare-line`.

**Why: early regrets the tremble cannot outvote.** The node is reached only
through the limp's tremble (about 6e-4 of hands). CFR weights the big
blind's regrets there by the opponents' reach - mostly the limper's
probability of limping. In the first iterations the limper's strategy is
near uniform (a third of every class limps), later it is the tremble's 0.5%
plus a few traps: the counterfactual values, and with them each iteration's
regret, shrink by about 60x. DCFR discounts a positive regret by
`t^1.5 / (t^1.5 + 1)` per iteration, a product that stays far from zero, so
the regrets of the first few dozen iterations are never forgotten - and at
the tremble's weight it takes thousands of iterations to wear them down.
Measured on the 6-max 200bb solve at 3,000 iterations (the committed set,
reproduced checkpoint for checkpoint): the big blind with AQo behind a
cutoff limp has cumulative regret +0.24 for checking and +0.20 for
isolating, while isolating is worth 0.105bb more per hand and each
iteration moves the check's regret by -3e-5. Regret matching therefore
still mixes 55/45, and the average (weighted `t^2`) carries the mix of every
earlier iteration: 2.55% of the pot lost. It is not the DCFR parameters
being wrong for the game, a degenerate class or a tree error: the same
nodes clear the 2% bar by 3,000 iterations at 100bb and in the 6-max 150bb
set, and at 200bb the worst class shrinks steadily with more iterations
(6-max 200bb):

| Iterations | 1,000 | 2,000 | 3,000 | 4,000 | 5,000 | 6,000 | 7,000 | 8,000 | 9,000 |
|---|---|---|---|---|---|---|---|---|---|
| BB vs HJ limp, worst class (% of the pot) | 2.19 | 2.48 | 2.24 | 1.83 | 1.51 | 1.26 | 1.05 | 0.83 | 0.77 |
| BB vs CO limp | 3.06 | 3.56 | 2.55 | 1.89 | 1.38 | 1.18 | 1.00 | 0.85 | 0.76 |
| BB vs button limp | 3.99 | 2.96 | 2.25 | 2.07 | 1.81 | 1.44 | 1.11 | 1.03 | 0.97 |
| Nodes left out as unconverged (the set) | 72 | 34 | 19 | 12 | 8 | 3 | 3 | 2 | 2 |
| NashConv (mbb/hand) | 1.25 | 0.49 | 0.33 | 0.26 | 0.23 | 0.21 | 0.20 | 0.19 | **0.18** |

The 9-max 200bb solve shows the same thing (measured to 1,000 iterations:
the big blind with AQs behind an HJ limp carries regret +0.16 for checking
and +0.14 for isolating while isolating is worth 0.15bb more). At 9,000
iterations it keeps the big blind facing a limp from every seat, leaves 7
nodes out instead of 61 (all reached under 1e-5) and measures NashConv
0.25 (1.60, 0.66, 0.44, 0.35, 0.30, 0.28, 0.27, 0.26, 0.25 at 1,000 to
9,000).

**The fix: a longer solve, nothing else.** The two 200bb sets are solved for
**9,000 iterations** (`SetConfig.iterations` in `sets.ts`), on the same
committed fit, tree, tremble and engine; every other set keeps 3,000 and
its bytes. 9,000 rather than the ~4,500 where the 6-max nodes cross 2%:
half the bar is a margin, and 9-max converges more slowly. A principled
change to the solve (forgetting regrets the tremble's scale makes stale,
or starting the trembling nodes at the tremble) would have changed every
set's numbers, including the 6-max and 9-max 100bb sets the flop library
is keyed to; a longer solve changes only the two sets that need it.

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

### 6.2 The library (`charts/3`, `charts/4`)

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

**`charts/4` (A2d), the limp trees** - every set regenerated, on its committed
fit (§6.7), with `charts/3` in brackets:

| Set | Nodes kept / tree | Behind an open limp | Bytes | Chunk, gzip | NashConv (mbb/hand) | Solve |
|---|---|---|---|---|---|---|
| `nlhe-cash-6max-40bb` | 834 / 3,988 (335 / 1,159) | 501 | 1,948,227 | 486 KB (181) | 0.058 (0.038) | 7 min |
| `nlhe-cash-6max-60bb` | 883 / 6,341 (368 / 1,365) | 514 | 2,120,012 | 545 KB (211) | 0.065 (0.058) | 10 min |
| `nlhe-cash-6max-100bb` | 752 / 10,361 (281 / 3,825) | 476 | 1,869,915 | 486 KB (171) | 0.094 (0.075) | 14 min |
| `nlhe-cash-6max-150bb` | 814 / 10,361 (343 / 3,825) | 468 | 1,988,228 | 530 KB (212) | 0.139 (0.121) | 14 min |
| `nlhe-cash-6max-200bb` (`charts/6`, §5.1) | **829** / 10,361 (`charts/4`: 815) | 469 | 2,033,580 | 538 KB | **0.182** (`charts/4`: 0.332) | 45 min, 9,000 iterations |
| `nlhe-cash-9max-100bb` | 2,705 / 79,131 (1,033 / 28,591) | 1,693 | 6,403,193 | 1,640 KB (570) | 0.313 (0.256) | 110 min |
| `nlhe-cash-9max-150bb` | 2,888 / 79,131 (1,139 / 28,591) | 1,736 | 6,873,614 | 1,776 KB (645) | 0.270 (0.313) | 112 min |
| `nlhe-cash-9max-200bb` (`charts/6`, §5.1) | **2,841** / 79,131 (`charts/4`: 2,795) | 1,735 | 6,768,378 | 1,731 KB | **0.247** (`charts/4`: 0.439) | 6 h 04 min, 9,000 iterations |
| **all eight** | | | **30,005,147** (`charts/4`: 29,848,576) | **8.7 MB** | | |
| `nlhe-cash-6max-100bb-straddle` (`charts/5`, §6.8) | 854 / 4,906 | 492 | 2,022,496 | 539 KB | 0.166 | 43 min with two measurement rounds |

Solve times are each set's own: one 3,000-iteration solve (no measurement
rounds, §6.7) per set, five sets at once on a 10-core M-series Mac shared with
another agent's flop solves; peak memory 0.35-0.53 GB for a 6-max set,
1.5-2.5 GB for a 9-max one. A 9-max iteration now costs ~2 s (the first
hundreds ~3.5 s), against ~0.6 s for `charts/3`'s tree: 2.8x the action nodes
and three- and four-way limped pots between wide ranges. At `charts/4` the
6-max 200bb set converged least far of the 6-max sets (0.33, most of it the
small blind's 0.16).

**`charts/6`, the 200bb sets solved longer** (§5.1): the two 200bb rows are
the 9,000-iteration solves, each in its own process next to the
flop-library batch's four solves (the 9-max one at times thermally
throttled; ~2 s per iteration after the first thousand, peak
2.1 GB). Left out as unconverged: 6-max **19 -> 2**, 9-max **61 -> 7**,
every one left reached under 1e-5 of hands except the 6-max small blind
behind two limps (`fcfc`, 3e-4); the big blind facing a single limp
is in both sets from every seat, and so are the 9-max cold-call and 3-bet
nodes `rc` and `rrr` (reached 3e-4 and 1e-4) that `charts/4` also left out.
Raise-first-in and defence widths move by at most 0.3 points, limped-pot
frequencies by up to 2.6 (the 6-max small blind facing an UTG limp folds
23.7% instead of 26.3%, §8.3). Best-response gains per seat: 6-max under
0.02 mbb/hand except the small blind's 0.13; 9-max under 0.05 except the
button's 0.09.

`CHARTS_VERSION` is `charts/6` (the 200bb sets re-solved, §5.1); before it
`charts/5` (A2e) added the straddle set (§6.8). The other six sets above
are `charts/4`'s, unchanged byte for byte, each carrying its own `id` (the
6-max 100bb set on `charts/2`'s fit, the others on their A2c fits). Grades
store the set's id (`facts.chart.set`).

`charts/3` (A2c), for the record: 6-max 40 / 60 / 100 / 150 / 200bb had
335 / 368 / 281 / 343 / 355 nodes of 1,159 / 1,365 / 3,825 trees, NashConv
0.038-0.130; 9-max 1,033-1,139 nodes of 28,591, NashConv 0.26-0.49; 11.8 MB
in all, ~2 h 15 min to generate with the realisation rounds.

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
above; 1.8-2.1 MB raw for 6-max, 6.3-6.8 MB for 9-max with `charts/4`), none
of them in any page's first load; the manifest (ids, seats, depths, loaders)
is a few hundred bytes in the pages and workers that import `lib/charts`. A
hand from a 9-handed 150bb table makes the worker fetch one 1.8 MB (gzip)
chunk once, not the library.

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

- **Straddles, but one** (`charts/5`, A2e, §1.4). A2d refused them by cost
  (52 of 5,388 hero preflop decisions, 1.0%, 4- to 6-handed at 100-120bb
  almost all of them). A2e builds the one set that covers most of them, a
  6-max 100bb set with a 2bb straddle from UTG; every other straddle - another
  seat, a re-straddle, another size, 3 or 7+ handed, another depth - stays
  refused (`straddle`), and a straddle set per depth or table is the case to
  reopen if a library brings more straddled games.
- **Heads-up** stays refused (`players`): the button is the small blind and
  acts last after the flop, which no set models (our blind-versus-blind is
  the small blind out of position). 111 decisions (1.8%) in the WePlay export.
- **Ten or more players, antes, cold calls of 3-bets**: as before. **A
  fourth limper** is `multiway` (§1.3); open limps themselves are covered
  since `charts/4`.
- **Depths**: under 32bb, 72-80bb and over 240bb (6-max); under 80bb and over
  240bb (9-max).

### 6.6 Coverage

The owner's local library (5,448 hands, 5,388 hero preflop decisions; the
rows stored at `analysis/4` against a fresh `analyzeHand` with the library,
`analysis/5` (A2c) and `analysis/6` (A2d, `charts/4`); `npm run
charts:library` on an export of the stored hands):

| | `analysis/4` (6-max 100bb) | `analysis/5` (`charts/3`) | `analysis/6` (`charts/4`) |
|---|---|---|---|
| Preflop decisions graded | 1,281 (23.8%) | 3,817 (70.8%) | **4,687 (87.0%)** |
| Refused: table size (`players`) | 3,024 | 210 (heads-up, dead buttons) | 210 |
| Refused: stack depth | 674 | 106 | 106 |
| Refused: open limp | 256 | 933 | **0** |
| Refused: rare line | 65 | 151 | 165 |
| Refused: straddle | 52 | 52 | 52 |
| Refused: off-tree / cold call / multiway / other | 25 / 10 / 0 / 1 | 83 / 27 / 8 / 1 | 118 / 27 / 20 / 3 |
| Solver-graded turns on a placeholder range | 395 of 465 (85%) | **194 of 459 (42%)** | - |
| Solver-graded rivers on a placeholder range | 261 of 310 (84%) | **129 of 310 (42%)** | 128 of 307 (42%, turns not solved) |

**A2d, behind a limp.** 1,000 hero decisions have a limp from a seat other
than the blinds before them (the 933 refused as `limp`, and 67 that A2c
refused for something else first): **871 graded** - Perfect 763, Good 15,
Inaccurate 49, Mistake 33, Blunder 11 - and 129 refused: off-tree 47
(mostly a player posting a dead big blind, whose check in turn no tree
seat has, and four entrants that close a pot), stack depth 27, table size
21, rare line 13, a fourth limper or entrant 12, straddle 7, the action not
on the tree 2. Graded preflop decisions by scenario: RFI 2,078, facing an
open 1,429, **facing limpers 601**, facing a 3-bet 283, squeeze 257,
**limper facing an isolation 10**, 4-bet 27, all-in 2; the isolation raises
facing a raise land on `vs-open` and `squeeze` nodes (+200 and +41 against
`analysis/5`). Grades: Perfect 89.9%, Good 0.4%, Inaccurate 4.1%, Mistake
3.9%, Blunder 1.7%; 224.4 bb lost (182.8 at `analysis/5`). The rivers are
measured without the turn solve here; the share on a placeholder range does
not move, because an opponent who open-limped keeps the placeholder limp
range (§1.3).

**A2e, straddled hands** (`analysis/10` against `analysis/9`, the same
`npm run charts:library` run on both): the 52 hero preflop decisions in
straddled hands were all `straddle`; **41 are graded** now, on the straddle
set - Perfect 36, Inaccurate 2, Mistake 3 (0.8 bb lost) - and 11 stay
refused as `straddle`: 10 at an effective stack outside 80-120bb (44-65bb
and 168-188bb, mostly 4-handed), one whose straddler is not the seat left
of the big blind. Every other count is unchanged (4,687 -> 4,728 graded,
87.0% -> 87.8%); the 41 are RFI 23, facing an open 10, facing limpers 5,
squeeze 3. Solver-graded rivers on a placeholder range: 172 -> 166 of 370
(the straddled pots' players now start from the straddle set's ranges).

**`charts/6`, the 200bb re-solve** (`analysis/11` against `analysis/10`,
the same export, compared decision by decision with
`CHARTS_LIBRARY_DUMP`): the library has **no** hero decision as the big
blind facing a single limp at 200bb, so no `rare-line` refusal becomes
graded - the 165 are 6-max and 9-max 100bb lines for the most part (the
200bb sets had 7, all on the 9-max set and none of them a big blind behind a limp). Five of the 295
decisions graded on the 200bb sets change: four grades (6-max: Good ->
Perfect; 9-max: Good -> Perfect, Good -> Inaccurate, Mistake ->
Inaccurate) and one 9-max decision that becomes `rare-line` (the small
blind facing an HJ limper's re-raise of its isolation, the big blind
calling: `ffffcffrcr`, reached exactly 1e-6 at `charts/4` and just under it
now). Graded 4,728 -> 4,727; Perfect 4,249 -> 4,250, Good 20 -> 17,
Inaccurate 192 -> 194, Mistake 186 -> 185; 225.1 bb lost (225.2).

Graded decisions by set at `analysis/6`: 6-max 100bb 1,957, 9-max 100bb
1,325, 6-max 150bb 727, 9-max 150bb 290, 9-max 200bb 217, 6-max 200bb 78,
6-max 60bb 72, 6-max 40bb 21 (`analysis/5`: 1,689, 961, 637, 215, 167, 75,
54, 19). At `analysis/5` 2,648 carried `short-handed` (mostly 7-8 handed on 9-max, 3-5 handed
on 6-max) and 1,834 `stack-depth-near`. The refusals that grow are the ones
the bigger tables now reach: open limps (most 8-handed pots behind a
limper) and rare lines. Grades: Perfect 90.4%, Good 0.1%, Inaccurate 3.7%,
Mistake 4.0%, Blunder 1.8%; 182.8 bb lost. The placeholder ranges that are
left are opponents whose own line has no node (limped pots, mostly).
`npm run charts:coverage` prints the same tables for the WePlay and GG
corpora in the repository.

### 6.7 `charts/4`: the limp tree on the committed fits

`charts/4` regenerates every set with the limp tree (§1.3), but **does not
re-measure the realisation**: each set is solved once (3,000 iterations) with
the fitted model its `charts/2` / `charts/3` file already records
(`reuseFit` in `sets.ts`), and that file's `model.realisationFit` is carried
over with a `reusedBy` note - so a rerun reads the same model and writes the
same bytes. Why that is sound: the fit's thirteen spots are heads-up raised
pots and the blinds' limped pot, measured on the charts' own ranges; the
tremble moves those ranges by little more than its 0.5% (raise-first-in
widths by at most 0.6 points, the big blind's defence against a button open
by 0.1 at most, §8.3) - the size of the drift between the last two fit
rounds of `charts/2` (0.5 points), which is the fit's own noise.
Re-measuring all eight sets would have cost another ~3 hours on a shared
machine for a change of that size. Limped pots behind an open limp use the
fitted `limped` (no raise) and `srp` (an isolation) coefficients; no
multiway limped pot is measured (as no multiway pot ever was, §9).

### 6.8 `charts/5`: the straddle set (A2e)

`nlhe-cash-6max-100bb-straddle` is the 6-max 100bb game with a 2bb straddle
from UTG (§1.4), generated by the same pipeline as an A2c set: two
measure-and-fit rounds from `charts/2`'s fitted model, then the final
3,000-iteration solve, the limp tree and its tremble as in `charts/4`
(`sets.ts`). It is **not** solved on a committed fit: a straddled pot is a
50-straddle game, its stack-to-pot ratios a 50bb game's, and the straddler is
a blind none of the fitted spots had.

**Its own spots** (`STRADDLE_REALISATION_SPOTS`): the thirteen spots name
an UTG that opens, and a straddler never opens. The straddle set measures
fifteen heads-up spots with the same roles - the button, cutoff and HJ open
and the straddler calls (raiser in position), the button opens and the big
blind calls, the cutoff and HJ open and the button continues (candidates,
raiser out of position), the small blind opens and the straddler calls; the
straddler and the small blind 3-bet the button, the button 3-bets the
cutoff and HJ; two 4-bet pots with the 4-bettor out of position (in
position the 4-bet over a 4x 3-bet is all-in, §1.4); and the two limped
pots a blind's completion makes, the small blind's and the big blind's, the
straddler checking behind (candidates). 1,800 turn+river solves a round.

| Pot type | fit error (fitted / `charts/1` / equity), final round | `P` | `I` |
|---|---|---|---|
| limped | **0.032** / 0.053 / 0.058 | 1.12 | – |
| single-raised | **0.033** / 0.050 / 0.074 | 1.15 | 1.06 |
| 3-bet | **0.034** / 0.052 / 0.071 | 1.36 | 1.22 |
| 4-bet | **0.028** / 0.065 / 0.060 | 0.78 | (1) |

Range-average realisation, measured on the last round's ranges, out of
position / in position: the straddler calling a button open 0.86 / 1.10, a
cutoff open 0.86 / 1.10, an HJ open 0.86 / 1.09; the big blind calling a
button open 0.86 / 1.15; the small blind's open against the straddler
0.97 / 1.05; the small blind's and the big blind's completion against the
straddler 1.01 / 0.98 and 0.99 / 1.01. The straddler realises what a big
blind does in an unstraddled game (0.83-0.85) and a little more: it closes
the action and is in position on the blinds. With both measured 4-bet pots
on an out-of-position 4-bettor the initiative edge cannot be told from
position (`I` fixed at 1), so the 4-bet `P` below 1 is the 4-bettor's
initiative carried as position.

**Convergence** (same Mac, Node 24, four turn+river threads next to the
flop-library batch's four solves): NashConv 2.85 -> 0.86 -> 0.46 -> 0.27 ->
0.20 -> **0.166 mbb/hand** at 3,000 iterations; best-response gains HJ
0.015, CO 0.025, BTN 0.032, SB 0.022, BB 0.042, UTG (the straddler) 0.030;
strategy change at the last checkpoint 0.003; heads-up blind versus blind
0.127. Eight nodes left out as unconverged, all reached under 5e-5 of hands
(the big blind behind the small blind's completion, `fffc`, among them: the
small blind completes almost never). Values per hand: HJ +0.23, CO +0.28,
BTN +0.36, SB -0.19, BB -0.53, the straddler -0.73 bb; rake 0.59 bb.
**Time**: 2,555 s (43 min): two rounds of a 1,500-iteration solve
(~5 min) and 1,800 turn+river solves (~18 min on four threads), then the
final solve (~11 min). 430 MB resident. A rerun reads the turn+river results from the cache (`.cache/realisation-*.json`) and takes 15 min; it wrote the same numbers.

**What the set says** (`npm run charts:report`; continue = call + 3-bet):

| | |
|---|---|
| RFI HJ / CO / BTN | 18.7 / 23.2 / 31.2% (limps 0.7-0.9%, the tremble) |
| SB first in | 25.2% (all raises; it completes almost never) |
| BB folded to | 71.3%: completes 52.5%, raises 18.9% |
| Straddler vs HJ / CO / BTN open | 44.8 / 54.8 / 66.5% (calls 38.1 / 47.0 / 56.6%) |
| Straddler vs SB / BB open | 66.3 / 81.1% |
| BB vs HJ / CO / BTN open (straddler behind) | 12.5 / 13.6 / 16.6% |
| Opener vs a 3-bet: HJ v BTN, BTN v BB (fold / call / 4-bet) | 51.0 / 26.4 / 22.6, 50.2 / 32.5 / 17.2 |
| Straddler behind the BB's completion: check / raise | 55.4 / 44.6% |
| BTN vs an HJ limp: fold / over-limp / isolate | 75.6 / 7.9 / 16.5% |

Against the unstraddled 6-max 100bb set (`charts/4`) every seat opens
tighter from the HJ on (the HJ 18.7% against about 20%, the button 31.2%
against about 39%): three blinds behind, a 5bb open lays them more than a
2.5bb open lays two, and 100bb is 50 straddles. The straddler defends like
a big blind that closes the action (two thirds against a button open, as
the unstraddled big blind's 61.7%), and the big blind in front of it, with
the straddler still to act, plays a cold caller's 13-17%.

Sanity bands (`tests/test/charts/straddle.test.ts`): frequencies sum to 1
and EVs are consistent with them; AA never folds; 72o never opens; RFI
widens HJ < CO < BTN; the straddler defends wider against later opens and
wider than the big blind in front of it; NashConv under 1 mbb/hand.

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

**Straddled spots** (`charts/5`, A2e). `preflopSpotFromHand` records every
straddle posted (`spot.straddles`: who, and its street total in bb).
`pickChartSet` reads a straddled spot **only** on a straddle set, and an
unstraddled one never on it. A straddle set answers exactly one straddle,
of its size (±1%), posted by the first seat left of the big blind
(`positionRing(k)[2]`: UTG 6- and 5-handed, the CO 4-handed), 4 to 6
players, the effective stack within the set's ±20% (`straddleMismatch`).
Anything else is refused as `straddle`, with a detail that names it ("a
straddle at 150bb effective; the straddle sets cover 100bb ±20%", "BTN
straddled; only a straddle from the first seat left of the big blind (UTG)
is charted", "2 straddles (a re-straddle)", "a 3bb straddle", "a straddle
3-handed"). A spot the set can read is mapped like any smaller table, the
straddler onto the set's straddler: 5-handed the set's HJ folds before the
hand, 4-handed the HJ and the CO (`short-handed`). The replay starts with
the straddle in (`real`: 2bb to match). Given one set instead of the
library, a set without a straddle refuses every straddled spot and the
straddle set every unstraddled one. A straddled spot with antes is `ante`.

Refusals, `{ ok: false, reason, detail }`: `straddle`, `ante`, `players`
(heads-up, ten or more, or positions that are not a `k`-handed ring - a dead
button), `stack-depth` (no set within 20%), `multiway` (a fifth entrant, or
a fourth limper - `charts/4`), `limp` (an open limp other than the SB's, only
on a set without limp trees), `cold-call`, `off-tree`,
`rare-line`, `action-not-modelled` (the hero's real action is not an option
here), `unavailable` (the library has not loaded the set), `bad-input`.
`preflopSpotFromHand` itself refuses non-NLHE-cash games and bomb pots.
Coverage on the corpora is in §6.6.

## 8. Results

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

### 8.3 Limped pots (`charts/4`, A2d)

`npm run charts:report` prints these for every set. Facing one limp, the
rest folding: fold / over-limp / isolate (the big blind: check / isolate);
then the limper facing the button's isolation, the blinds folding:

| | 6-max 40bb | 6-max 100bb | 6-max 200bb (`charts/6`) | 9-max 100bb | 9-max 200bb (`charts/6`) |
|---|---|---|---|---|---|
| Second seat vs first seat's limp | 85.5 / 3.6 / 10.9 | 85.5 / 1.2 / 13.3 | 85.7 / 2.1 / 12.2 | 92.1 / 0.5 / 7.4 | 92.4 / 1.4 / 6.3 |
| CO vs first seat's limp | 80.4 / 7.4 / 12.3 | 80.9 / 3.7 / 15.4 | 80.8 / 4.6 / 14.7 | 82.5 / 6.8 / 10.7 | 80.4 / 8.9 / 10.6 |
| BTN vs first seat's limp | 71.3 / 15.6 / 13.2 | 70.6 / 10.6 / 18.8 | 70.9 / 10.9 / 18.2 | 74.6 / 14.1 / 11.3 | 72.5 / 15.5 / 12.0 |
| SB vs first seat's limp | 27.8 / 63.6 / 8.5 | 23.8 / 68.3 / 7.9 | 23.7 / 68.7 / 7.6 | 29.3 / 65.9 / 4.8 | 23.6 / 73.3 / 3.1 |
| BB vs first seat's limp | 94.2 / 5.8 | 94.8 / 5.2 | 95.9 / 4.1 | 96.7 / 3.3 | 97.1 / 2.9 |
| BTN vs CO limp | 69.0 / 9.6 / 21.5 | 68.2 / 2.9 / 28.9 | 67.1 / 3.4 / 29.5 | 67.6 / 2.2 / 30.2 | 67.0 / 3.8 / 29.1 |
| BB vs CO limp | 90.7 / 9.3 | 88.8 / 11.2 | **92.3 / 7.7** | 91.6 / 8.4 | **91.9 / 8.1** |
| First-seat limper vs BTN isolation: fold / call / re-raise | 49.7 / 25.6 / 24.7 | 50.3 / 23.1 / 26.6 | 51.7 / 23.7 / 24.6 | 46.2 / 30.7 / 23.2 | 48.9 / 25.9 / 25.2 |

(60bb and 150bb sit between their neighbours: the button isolates an UTG
limp 16.1% / 18.4% at 6-max, a CO limp 25.8% / 30.4%.)

**What the limp trees say.**

- **Isolation widens with position and with a later limper**: at 6-max 100bb
  the HJ, CO and button isolate an UTG limp 13.3%, 15.4%, 18.8%, and the
  button a cutoff limp 28.9%; at 9-max 7.4% from UTG+1 to 11.3% on the
  button, 30.2% against a cutoff limp - the more players behind, the less the
  isolation buys. Premium hands always isolate (AA, KK at every node facing
  limpers; tested), and the worst fold (72o; tested).
- **Over-limping is a late-position and small-blind play**: the button
  over-limps an early limp 10-16% (suited aces, small pairs, suited
  connectors), the small blind completes behind 58-72%, a seat right behind
  the limper almost never.
- **The big blind checks behind 93-97%** against an early limp and 89-93%
  against a cutoff limp, isolating with the top of its range.
- **The limper facing an isolation** (any hand, by the tremble) folds about
  half, calls a quarter and re-raises a quarter: its best response holds the
  pairs and suited aces to call and re-raises the strongest and some
  blockers.
- **The equilibrium itself limps rarely**: 0.4-0.7% from every seat but the
  small blind - the 0.5% tremble plus a few traps (AA limps 3.9% UTG at 6-max
  100bb, KK 2.7%, QQ 6.7%, AKs 8.2%, at the same EV as opening them to the
  hundredth of a big blind). Raise-first-in widths move by at most 0.6
  points from `charts/3` (6-max 100bb UTG 15.4% -> 15.1% raise, plus 0.6%
  limps; 9-max 100bb UTG 10.2% -> 9.6%), and the blinds' defence hardly at
  all (BB vs a button open 61.7% in both at 6-max 100bb).
- **Left out as unconverged** (§6.1): at `charts/4` both 200bb sets
  dropped the big blind facing a single limp from most seats (its mix lost
  2.2-2.8% of the pot for one class after 3,000 iterations); `charts/6`
  solves them for 9,000 iterations and keeps it from every seat (§5.1).
  The 9-max 150bb set still leaves the big blind behind an HJ limp out.
  Otherwise 1 to 47 nodes per set, nearly all behind a limp and reached
  under 1e-4 of hands.

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

Added by A2d, per set (`sets.test.ts`, "limped pots"): the tree records
three limpers and the tremble, and keeps over 100 nodes behind an open limp,
some with three limpers and some with a limper facing an isolation; no seat
but the small blind limps more than 5% first in; isolation widens from seat
to seat behind the first seat's limp (within 3 points) and from its first
follower to the button, and the button isolates a cutoff limp at least as
often as an UTG one; AA isolates over 90% and KK over 60% at every node
facing limpers, 72o folds over 90% (all but the big blind); the big blind
checks behind over 60% of its range against any single limp; AA never folds
as the limper facing an isolation. KK may fold behind an open limp at nodes
reached under 1e-5 (a re-raiser's range there can be AA alone).

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
- **One straddle shape** (§1.4, §6.8): 6-max 100bb, a 2bb straddle from the
  seat left of the big blind. The straddle set's sizes are the unstraddled
  game's doubled (a 5bb open); live straddled games often open bigger, which
  the lookup reads as a sizing approximation (`offTree` past 25% of the pot).
  Its heads-up blind-versus-blind calibration is the unstraddled
  two-player game at its sizes, not a straddled one (none is two-player).
- **Out of scope by construction**: antes, every other straddle, heads-up, ten or more
  players, depths under 32bb, 72-80bb and over 240bb (§6.5), a fourth
  limper, cold calls of 3-bets, five-way pots, MTT/ICM, players posting a
  dead big blind out of turn.
- **The limper may hold any hand** (§1.3). The reference faces a limp as
  the tremble makes it - every class 0.5% - plus the equilibrium's few
  traps, not as a recreational player's limping range (weak aces, small
  pairs, suited hands, few premiums). Isolating is therefore graded against
  a limper who folds to it about half the time and re-raises a quarter; a
  real limper who calls wider makes isolation with marginal hands worse
  than the chart says. A population limp range would be an exploitative
  input, which the charts do not take (§0 of the plan); the
  `limp-tremble` approximation says so on every grade behind a limp.
- **Behind an open limp the 4-bet is all-in**, at every depth: 100-200bb
  shoves where real players 4-bet smaller. No decision in the owner's
  library faces a 4-bet in a limped pot.
- **The limp trees reuse the committed realisation fits** (§6.7): limped
  pots outside the blinds and the multiway limped pots are valued by the
  blinds' fitted limped-pot coefficients and the pairwise multiway rule, not
  measured.
- **The limp trees converge a little less far** (§6.2: at 3,000 iterations
  6-max 200bb 0.33 and 9-max 200bb 0.44 mbb/hand, 0.18 and 0.25 at
  `charts/6`'s 9,000) and are bigger: 1.9-2.1 MB per 6-max set and
  6.4-6.9 MB per 9-max set (0.5 and 1.7 MB gzip), 30 MB in all.
- **Iterations per set, not per node.** The tremble's nodes learn at its
  0.5% weight, slowly (§5.1); the 200bb sets buy convergence with 3x the
  iterations, which costs the 9-max set ~6 hours. A solver that rescales
  or forgets the early, large regrets of trembling lines would converge
  them in far fewer, at the price of regenerating every set.
- **Smaller tables are read on bigger sets** (§6.3): exact in the model up
  to convergence, but the real card removal of the folded seats is not
  there.
- **No interpolation between depths**: a 125bb stack is graded on the
  150bb set, with a `stack-depth` note; strategies between two depths are
  whatever the nearer set says.
- **The 9-max sets are less converged** (NashConv 0.27-0.31 mbb/hand at
  100 and 150bb against 0.06-0.14 for 6-max at the same 3,000 iterations;
  at 200bb 0.25 against 0.18 at 9,000) and bigger, and keep
  rare nodes out as unconverged (`model.excluded`).
- **Reports, Leaks and the study plan read every set** since A2d (a set
  filter on Reports; each leak and focus area on the set it was met on);
  see the plan's §10.
- Lines reached less than 1e-5 at equilibrium are not in the set; real
  players reach some of them.

## 10. Regenerating

```bash
cd tests
CHARTS_PARALLEL=5 CHARTS_THREADS=5 npm run charts:generate    # every set, ~6 h wall: the 9-max 200bb set's 9,000 iterations (charts/6)
CHARTS_SETS=nlhe-cash-6max-200bb npm run charts:generate      # a 200bb set: 9,000 iterations (sets.ts), 45 min; 9-max ~6 h
CHARTS_SETS=nlhe-cash-6max-60bb npm run charts:generate       # one set
CHARTS_SETS=nlhe-cash-6max-100bb-straddle CHARTS_THREADS=4 npm run charts:generate   # the straddle set, ~43 min (two rounds)
npm run charts:report        # the §8 tables for every committed set (CHARTS_FILE=... for one file)
npm run charts:coverage      # §6.6: graded decisions on the corpora, 6-max 100bb alone vs the library
npm run charts:compare       # §6.3: a native short-handed solve against a bigger set read short-handed
CHARTS_LIBRARY=library.jsonl npm run charts:library   # §6.6: the same on an export of stored hands (one PHF JSON per line)
CHARTS_LIBRARY=library.jsonl CHARTS_LIBRARY_DUMP=run.jsonl npm run charts:library   # also every decision's outcome, to diff two runs
```

`charts/4` (A2d) sets carry `reuseFit` in `sets.ts`: the generator solves
each once on the realisation model and fit record of its own committed file
(§6.7), without rounds, so the turn+river measurement below does not run. A
rerun writes the same bytes (checked on the 6-max 40bb set, and for
`charts/6` on the 6-max 40, 60, 100 and 150bb sets: regenerated with the
`charts/6` generator, byte for byte the committed files). The 200bb sets
also carry `iterations: 9000` (§5.1); `CHARTS_ITERATIONS` overrides every
set's count for experiments.

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
