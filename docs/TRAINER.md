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

## 4. Not in this version (next phases)

- **T2 — full hand.** Play on after the answer: the opponent's move sampled
  from the reference, the next street dealt (preflop chart → library flop →
  live turn → river), graded at every hero decision; "pause after" then
  means a street or a mistake.
- **T3 — the range panel live.** The hero's range grid and equity beside the
  felt while answering (as GTO Wizard's right panel), off by default
  (it gives the answer away).
- **T4 — drills.** Saved presets ("BB vs BTN SRP flop") in a list, as
  GTO Wizard's *My drills*; the app keeps answers (a local `trainer_results`).
- **T5 — modes.** Frequency input, grouped difficulty, multi-table, timebank.
- Turn leaks get a trainer target (today `trainerTarget` has none for the
  turn, so "For you" skips them).
