# The Trainer

A poker spot on a table, the moves as buttons, and after the answer: the
grade, what the reference does with that exact hand, the hand's facts and
*why*. "For you" deals the spots where the player's own analysis says they
lose the most. Web (`/analysis/train`) and the desktop app (the Trainer
screen) render the same component. A Pro feature.

## 1. What GTO Wizard's trainer does (studied 2026-11-13)

- **Setup:** a table where hero and opponent are picked by clicking seats;
  start spot (preflop / flop / custom); preflop action as chips (any, SRP,
  3-bet, 4-bet, squeeze…); one "start" button; a full settings dialog with
  tabs (game, board, hands, modes, display); saved drills in a sidebar.
- **Play:** an action strip over the table (every action so far, street by
  street), the felt, big coloured buttons (fold blue, call green, raises in
  shades of red), a right panel with the hero's range grid, the overall
  frequencies, hand strength and equity, hand and draw categories.
- **Feedback:** a pill on the felt with the move, its GTO frequency and an
  accuracy marker; the hand plays on to the end (full hand / street / spot).
- **Modes:** tables 1–4, difficulty (standard, grouped, simple), input by
  action or by frequency, pause after mistake or after every action, speed,
  auto new hand, RNG, timebank.
- **What it does not do:** say *why*. The feedback is numbers.

## 2. Rail's approach

- **Same reference as the analysis, same grader.** Every answer is graded by
  `analyzeHand` on the spot's hand with the answer appended (`lib/training`):
  preflop from Rail's charts, flops from Rail's flop library, turns and
  rivers solved on the spot. A trainer grade is the analysis grade of the
  same spot by construction, so practice and review never disagree.
- **"For you" first.** The leak finder groups the player's costly decisions
  into focus areas (`focusAreas`, the same areas the study plan uses); each
  has a trainer target. The Trainer works through the areas the sample
  vouches for, costliest first, six hands each (`components/trainer/focus.ts`).
  The bar names the leak ("Calling too wide — BB vs BTN open, costs you
  3.2 bb/100"). With no account, no analysed hands or only turn / multiway
  leaks, it deals the spots most players misplay (`GENERAL`).
- **Explanations.** After an answer, in reading order:
  1. the verdict on the felt — grade, the move, EV lost, the better move;
  2. the strategy for *this* hand — every option's frequency and EV;
  3. the hand's facts — made hand, equity against the range, pot odds,
     minimum defence, SPR, draws, blockers;
  4. *why* — the analysis' own sentences for the decision (built only from
     computed facts, `explain`), then a **rule of thumb** for the kind of
     spot (`principles.ts`: preflop by family and the blinds facing an
     open; postflop by street, what the hero faces and the preflop role);
  5. on the web, the whole chart or range and the Learn links.
- **Easy settings.** One sheet, every choice a row of chips (one click, no
  dropdowns), only the rows the current mode reads: table, situation, seats;
  pot, position, preflop role, facing, line; hands (as the range holds them
  or mostly close decisions); after an answer (always wait, or move on by
  itself after a right one); shown panels. A one-line summary of the spot
  sits on the settings button. `S` opens it.
- **Clean UI** (the owner's direction): no screen title, the modes and the
  settings on one row, figures small, results signed and coloured.

Keys: `1`–`9` the buttons in order, `F` fold, `C`/`X` check or call, `A`
all-in, `N`/`Enter` next hand, `S` settings.

## 3. Architecture

```
web/src/components/trainer/      host-neutral (no Next, no web i18n, no Supabase)
  host.tsx       TrainerHost: words, deal, grade, focus, record, onSettings, study, extraModes
  settings.ts    TrainerSettings; parse / fields; spotOptions(mode); targetSettings(target)
  focus.ts       "For you": trainable areas, rotation, the general list
  felt.ts        the table read off the replayer's frames; the action strip
  principles.ts  which rule of thumb explains a spot
  Trainer.tsx    the screen; SpotFelt.tsx, Feedback.tsx, SettingsSheet.tsx
web/src/lib/i18n/ns/trainer.{en,hr}.ts   its words (plain data; the analysis' words re-used)

web:  components/analysis/train/WebTrainer.tsx   host: lib/trainer.ts worker, fetchLeaks,
      trainer_results, address + localStorage, ChartGrid / RiverStudy / LearnLinks
app:  src/trainer/door.ts (UI) + jobs.ts (worker)  the only doors to @rail/web-trainer / web-lib
      src/trainer/worker.ts   the training jobs; flop library files relayed to Rust
      src/trainer/host.ts     host: the store's leak rows (top_leaks, all time), localStorage
      src/screens/Trainer.tsx the screen (route `trainer`, Pro via ROUTE_FEATURE, hidden during play)
```

The old trainer's addresses still work: a study plan task or a leak link
(`?mode=preflop&family=…`, `targetQuery`) opens the Trainer on that spot;
`?mode=drills` (or `spots=`) opens *Your mistakes*, the spaced-repetition
drills of the player's own hands, unchanged.

**Pro:** on the web the Analysis tab's plan gate (`AppFrame`, feature
`analysis`) covers `/analysis/train`; in the app `ROUTE_FEATURE.trainer =
"analysis"`. No new entitlement feature: the trainer is part of the analysis.

## 4. T2 — the whole hand (2026-11-13)

"One spot | Whole hand" beside the modes. A whole hand is the hero against
one opponent (as GTO Wizard's *GTO opponent*), from preflop (Preflop, or a
preflop leak in For you) or from the flop (Flop, or a flop or river leak),
to a fold or the showdown (`lib/training/play.ts`, `components/trainer/HandPlayer.tsx`):

- **The opponent plays the reference.** At its decision the analysis runs
  from its seat with its cards (`only` that decision) and its move is drawn
  from the frequencies for that exact hand; everyone else folds. Off the
  reference (no grade for its spot) it checks or calls, and the hand says so.
- **Its cards fit its line.** Preflop: drawn from its range after its own
  actions on the chart line (`opponentRanges`; not acted yet: any two). From
  the flop: both hands from the preflop ranges the analysis' walk reads.
- **Every hero decision is a trainer answer.** The buttons are the
  analysis' options for the hero's hand there; the answer is graded by the
  analysis on the hand with it appended, with the same feedback as a spot.
  The flop library's chunks load as the hand reaches them (`analyse`: run,
  record what was asked, load it, run again). Turns are graded by the turn
  solve, rivers on the heuristic-narrowed ranges (as the river trainer).
- **Played on in the background.** While the feedback is read the worker
  already plays the opponent and deals the next street; "Continue" (`N`)
  usually shows it at once (a turn solve can take a few seconds).
- **The end:** the result in bb, the opponent's cards at a showdown, and the
  hand's decisions with their grades and the EV lost over the hand.
- Where the hero's next decision has no reference (a flop the library has
  not solved, an off-tree line), the hand stops there and says so.
- Families a hand can start from preflop: first in, vs open, vs 3-bet, blind
  vs blind, vs 4-bet (`PLAY_FAMILIES`: no squeezes or limpers, which put a
  third player in the pot).

## 5. T3–T5 (2026-11-13)

- **T3, the range panel** (settings → Show → "Range while answering": off /
  range only / range and strategy; off by default, since the strategy gives
  the answer away). A 13×13 grid of the hero's range at the node, each class
  shaded by how much of it reaches the node and, with the strategy, split
  into the reference's actions; the hero's class ringed; each action's share
  of the range under it. Read from the reference the answer is graded by
  (`lib/training/rangeView.ts`): the chart node preflop, the library chunk on
  the flop (`flopStudy`), the turn solve (`turnStudy`), the river solve
  (`riverStudy`). After the answer the strategy always shows.
- **T4, saved drills.** Settings → My drills: the current settings saved
  under a name, opened with one click, deleted (`components/trainer/drills.ts`,
  this browser's or this computer's storage, 30 at most). The app keeps its
  answers too: the last 200 on this computer, the last ten beside the
  session (`app/src/trainer/History.tsx`); the web keeps them in the account
  (`trainer_results`) as before.
- **T5, ways to train** (settings → Training):
  - *Answer with a mix*: a slider per action (5% steps) instead of one
    action; graded against the reference's mix for the hand
    (`lib/training/frequency.ts`): accuracy = 1 − total variation distance,
    EV lost = Σ share × (best EV − EV), the grade from the accuracy
    (≥90% Perfect, ≥75% Good, ≥55% Inaccurate, ≥35% Mistake).
  - *One button per action*: a bet's or a raise's sizes behind one button,
    credited with the size the reference prefers for the hand.
  - *Time to answer*: 7 / 15 / 25 s; out of time, a check where there is
    one, else a fold - graded like any answer.
  - *Tables*: 1–4 at once (spots only), two per row on a wide screen, each
    dealing and grading on its own; the keys go to the first table waiting
    for an answer, then N to the first answered one.
- **Turn leaks in For you.** The study plan has no turn trainer target, so
  the Trainer reads a turn area's spot itself (`focus.ts`, `turnTarget`): its
  role and side from the scenario, a spot facing a bet practised in
  position, its pot (no multiway, no 4-bet pot), a heads-up area on the
  heads-up set.

## 6. Not in this version

- The app's answers are not synced to the account (no study plan in the app).
- A whole hand has no mix input and no multi-table.
- Saved drills are per device, not per account.
