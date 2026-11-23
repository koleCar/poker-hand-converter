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
- **Explanations.** After an answer, in reading order (one panel since
  2026-11-19, canvas `ideas-trainer` A; it replaced the Range / Strategy /
  Your hand / Why tabs):
  1. the verdict on the felt — grade, the move, EV lost, the better move;
  2. the hero's whole range on the left (`RangeGrid`): every class split
     into the reference's actions, bets left, the passive play right; a
     hover zooms the class (each action's frequency) and lists its combos
     under it, each with its own mix (postflop, from the solve's
     `StudyCombo`s); under the grid each action's share of the range;
  3. on the right the short *why* (`Brief`, `lib/training/brief.ts`): a
     headline — the hand's role, then the play (`Thin value — bet small`);
     what the best play earns over yours (or over the next best when you
     found it); at most three points, each one deciding number; example
     hands from the range — first to act on a solved street value / thin
     value / bluffs by how much of the opponent's range they beat,
     elsewhere by the play — each with the EV of its play (a click rings
     its class); the hand's facts as chips;
  4. folded under Details: the analysis' own sentences (`explain`), the
     **rule of thumb** for the kind of spot (`principles.ts`), and on the
     web the whole chart or range and the Learn links.
  While answering only the range can be opened (one button, remembered).
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
  sessions.ts    sessions: SessionStore, spotKey, pickRepeat, figures, defaultName, localSessionStore
  focus.ts       "For you": trainable areas, rotation, the general list
  felt.ts        the table read off the replayer's frames; the action strip
  principles.ts  which rule of thumb explains a spot
  Trainer.tsx    the session list and the switch to a session's training and history;
                 SessionTrainer.tsx, SessionReview.tsx, SeenBefore.tsx, SettingsSheet.tsx (a new session),
                 SpotFelt.tsx, Feedback.tsx (verdict, Brief), DecisionPanel.tsx, RangeGrid.tsx
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

### The app's answers in the account (2026-11-13)

Every graded spot answer in the desktop app is kept in the account like the
web's (`trainer_results`, so the study plan counts it): the row is built by
the shared `components/trainer/results.ts`, put in an outbox on this
computer (`app/src/trainer/outbox.ts`, 1 000 at most) and sent fifty at a
time through Rust (`trainer_results_record` → `record_trainer_results` with
the account's token, `rail_sync::ingest::trainer`, every row held to the
table's checks first). A wait - signed out, the plan, the rate limit, no
account in the build, the server unreachable - keeps the rows for the next
answer, the next opening of the Trainer or the next sign-in; a refusal
drops that batch. Turn answers and whole-hand answers are not kept, as on
the web (the table has no turn mode).

## 6. Sessions (2026-11-16)

The owner's rule: **a session's settings are fixed.** The player picks what to
train once - every choice, the modes (For you, Preflop, Flop, Turn, River) and
One spot | Whole hand included, lives in the settings - names it, and trains
it without changing anything. Changing a setting starts a new session with a
new name; the old one stays as it was. Designed on the map canvas (Ideas,
"Trainer — sesije": TR-Sessions, TR-New, TR-Train, TR-Review).

- **The list** (`Trainer.tsx`): every session with its settings in one line,
  hands (and today's), the mean move score, the grade bar, EV lost and when it
  was last played; Continue, and a menu (review history, rename, a new session
  from these settings, archive / restore). Sorted by recent, hands or score.
- **A new session** (`SettingsSheet.tsx`): the name (built from the settings by
  `defaultName` - "BB vs BTN open" - until the player types their own; Auto
  goes back to it) and the settings. Settings another session already trains
  (`sameTraining`: every field but the panels shown) offer to continue it.
  Opened from a running session ("Change settings", `S`) it says that a change
  starts a new session; with nothing changed, Start stays off.
- **Training** (`SessionTrainer.tsx`): the session's name (its menu) and its
  settings, locked, on the top row; no mode or play switch. Beside the table,
  the session's figures from its answers, today's or all: hands, score, streak,
  EV lost, the grade bar, and "Played again" (spots answered more than once,
  how many are right now).
- **Repeat played spots** (settings → Training; off / sometimes ≈ 1 in 6 /
  often ≈ 1 in 3, spots only): a spot the session has dealt before comes back,
  the worst latest answers first, never one answered in the last 12 deals
  (`pickRepeat`). It is dealt again exactly from its deal (`SpotRef`: the
  request and the seed - the generators are pure in their seed); a reference
  that changed since (the key differs) is dealt anew. Nothing marks it before
  the answer; after it, "You have played this spot before" lists every earlier
  answer and says whether this one is better (`SeenBefore.tsx`). A spot's
  identity is `spotKey`: the node (chart line; library line and path; the
  turn's or river's line and what was faced), the hero's seat, the cards in
  any order and the board.
- **History** (`SessionReview.tsx`): the figures, the score per 20 hands, the
  answers grouped by what the settings leave open (kind of hand preflop, best
  move, seat, street, day; a row filters the hands), every answer newest first
  with grade filters and "Played more than once"; an answer opens to every time
  its spot was played and "Play it again", which deals that spot next.
- **Where sessions live** (`SessionStore`, `host.sessions`): on the web in the
  account (`lib/db/trainerSessions.ts`; `20271116090000_trainer_sessions.sql`:
  `trainer_sessions`, `trainer_session_answers`, written by
  `save_trainer_session` and `record_trainer_session_answers`, read by
  `trainer_session_list`; Pro-gated like the Trainer, exported and deleted
  with the account); in the app and a web build without a database on this
  device (`localSessionStore`, 1 500 answers a session kept). The app opens the
  last session again; the web keeps the open one in the address
  (`?session=<id>`). A link with settings (a leak's, the study plan's) opens a
  new session on them. Every answer still goes to `trainer_results` too.
- The saved drills of T4 became sessions on the first opening (`drills.ts`
  is read once and emptied).

## 7. From Analytics (2026-11-22, docs/ANALYTICS.md Step 9)

Analytics' "Practise ▸" links (a finding, a drill-down spot, a hand class)
and "Play it ▸" (a hand) open the Trainer on that spot - the web's
`/analysis/train?from=analytics&stat=…&spot=…&size=…&classes=…&you=…&ref=…&cost=…&tone=…`,
the desktop's `#/trainer/<the same query, encoded>` (read with
`useRouteParam`, dropped from the address once read).

- **The target** (`components/trainer/analytics.ts`, `analyticsLink`): the
  stat's street and what it faces (a `facing = bet` predicate) with the
  checker spot's seats, pot and role (`pot|role|hero|opponent`), as a
  `FocusTarget` with `sizes`, `classes` and `from: { stat, spot, you, ref,
  cost, tone }`; on the flop the library line of the two seats, on the turn
  and river the seats themselves (`hero`, `villain`) and, out of position, a
  bet after the hero's check (`facing: "check-bet"`). A spot the dealers
  cannot hold (a bomb or 4-bet pot, several opponents, a line the library
  lacks) is dealt as near as they can and the bar says so.
- **Settings.** `targetSettings` maps it onto three new fields: `size` (a
  size bucket; the sheet's "Bet faced" row), `classes` (the Hands row's chip
  "Hands you tend to fold") and `from`. The link opens that spot's session
  straight away (one training the same spot is continued, with the newer
  figures), one spot at a time.
- **The deal** (`lib/training/focusDeal.ts`): the villain's bet faced only of
  the bucket (the flop tree's edge, the turn's and river's first bet), the
  hero's combo only of the classes, read exactly as the checker rows read a
  played decision (`toCall / (pot − toCall)`; `ANALYTICS.handClass` of
  `madeHand` and `draws`). A narrowed deal tries 8 seeds, not 3.
- **The bar and the goal** (`FromAnalytics.tsx`): the leak in Analytics' own
  words, the spot and size, the cost, "← Back to the stat"; beside the table
  your rate here and the target (from the link), and this drill's rate with
  the reference's on the same hands (`drillGoal`, judged like the checker
  with a 5-point floor). Answers carry their action and the reference's mix
  (`SessionAnswer.action`, `mix`) on the device and in the visit; the account
  keeps neither, so the drill's rate counts this visit's answers.
- **Play it** (`played.ts`, `PlayedPlayer.tsx`): the played decision dealt
  once - the real seats, line, board and cards, nothing after the decision -
  with the analysis' stored options as the buttons, graded against them as a
  drill of your own mistakes is (`gradeDrill`: the move made keeps its stored
  grade, so the reference is the one the analysis used: the chart node, the
  flop library, the turn or river solve). Recorded like a whole hand's
  decision; then the drill goes on. The hand comes from `get_hand` and
  `analysis_hand` (web) or the store's `hand_phf` and stored analysis
  (desktop, `handAnalysisOf`).

## 8. Not in this version

- The app's sessions are per computer, not in the account.
- Whole-hand decisions are kept in a session but never dealt again (a hand's
  opponent draws its moves; there is no deal to repeat).
- A whole hand has no mix input and no multi-table.
