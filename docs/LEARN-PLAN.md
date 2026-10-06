# Learn — the course plan

The **Learn** tab (`/learn`) is Rail's course in cash-game poker: tracks,
modules and short lessons, each ending in practice that Rail's own engine
generates and grades — and, for a signed-in player, in their own hands. It sits
on top of the concept library (A8a), the trainer (A7), the study plan (A8b),
the leak finder (A6), the preflop chart sets (A2) and the postflop solver
(A4/A5). See `docs/ANALYSIS-PLAN.md` for those.

This plan grew out of a curriculum study done for the owner (October 2026): a
read of how two training products lay out their material (one a sequenced
course with levels and quizzes, the other a weekly video library plus a
drill engine), a topic map, and a list of questions learners keep asking in
two public poker communities. Only ideas were kept, in our own words; no
text, titles, charts, frequencies or example hands from those sources are in
Rail. **Every number a lesson shows comes from Rail's charts, solver or
calculators at runtime, or is plain arithmetic the tests recompute.**

---

## 1. Principles

1. **One idea per lesson, practice right after it.** Short sections, then a
   "predict, then reveal" checkpoint, then exercises.
2. **Retrieval before explanation.** A checkpoint asks first and explains
   after; a calculator exercise takes the learner's number first and opens the
   calculator on it second.
3. **Rail grades, never a rubric.** Chart quizzes and solver spots are graded
   by `analyzeHand` itself (the trainer's one-grader rule); sums by
   `lib/learn/math.ts`; board and hand words by `texture.ts`.
4. **Your own hands last.** The last exercise of a lesson is the learner's own
   analysed decisions in that spot, worst EV loss first, replayed
   spoiler-safe — something no reference course can do.
5. **Honest about what is not solved.** Where the engine cannot solve a spot
   yet (the flop library is off, straddles have no charts, ranges rest on the
   narrowing model), the lesson says so with the analysis' own words.
6. **Nothing locks.** Prerequisites are advice; every lesson opens. A lesson not
   written yet is in the map as "coming soon".
7. **Progress is automatic.** A lesson is passed when its gradable exercises
   pass. No "mark as seen".
8. **No basics in the course (owner's rule, 2026-10-06).** The course assumes
   the learner already plays: no lessons on names, positions as vocabulary,
   board types, hand rankings, or the general maths and range vocabulary. Those
   stay in the concept library (`/analysis/learn`) as reference, linked from a
   lesson the first time it uses a term. A lesson teaches the maths it needs in
   place, in one or two lines, at the spot where it decides something.
9. **The order is the order of a hand (owner's rule, 2026-10-06).**
   1. How to play **preflop**.
   2. How to play the **flop**, situation by situation.
   3. The **turn**.
   4. The **river**.
   5. Then **exploits**: how to adjust against real people, and which
      adjustments pay most.

## 2. The course

Five tracks, in the order of a hand (principle 9), with no basics track
(principle 8). Lesson ids are the `LessonId` union in
`frontend/src/lib/learn/course.ts`. Titles are in the dictionary
(`course.titles`); outlines and bodies are in `frontend/src/lib/learn/lessons/`.

### Restructure from L1

L1 shipped a Foundations track: M0 orientation, M1 poker maths, M2 thinking in
ranges.

**Out of the course map.** M1 and M2 leave the map. Their pages become concept
reference, in the concept library or as a `/learn/reference/...` page. Their
ideas are folded into the first lesson that needs them:
- pot odds and realisation in *facing an open*;
- alpha / MDF in *defending a flop bet*;
- combos and blockers in *picking bluffs*;
- range and nut advantage in *flop bets by board type*.

M0's "how Rail teaches / reading your analysis" becomes the map's short intro
panel, not a lesson. Nothing is deleted from the database: old progress rows
for removed ids are left in place and simply not shown.

### The tracks

| Track | Module | Lessons (existing ids; *new* in italics) |
|---|---|---|
| **1. Preflop** | **P1** Opening | positions-and-opening-ranges, open-sizing, limpers-and-isolation |
| | **P2** Facing raises | facing-an-open, three-betting, facing-3bets-and-4bets, squeezes-and-multiway-preflop |
| | **P3** Blinds and depth | blind-play-and-bvb, multiway-preflop-choices, *preflop-by-stack-depth* (40 / 60 / 150 / 200bb, from the chart sets) |
| **2. Flop** | **F1** SRP, raiser in position | cbet-why-and-when, cbet-by-texture, hand-classes-on-the-flop, checking-back-and-delayed-cbets |
| | **F2** SRP, raiser out of position | oop-as-the-raiser, facing-a-check-raise |
| | **F3** SRP, caller | defending-vs-cbets, check-raising, floating-and-stabbing-ip, probes-and-donk-bets, bb-vs-btn-blueprint |
| | **F4** 3-bet and 4-bet pots | spr-and-commitment, cbetting-as-the-3bettor, playing-3bp-as-the-caller, range-splitting-ip-vs-checks-3bp, four-bet-pots |
| | **F5** Multiway flops | multiway-principles, multiway-as-the-raiser, multiway-defence |
| **3. Turn** | **T1** Betting again | turn-card-classes, double-barreling, turn-sizing-and-overbets, turn-after-flop-checks-through |
| | **T2** Defending the turn | facing-turn-barrels, *turn-check-raise-and-probe* |
| | **T3** Turn in 3-bet pots | *3bp-turn* (split from 3bp-turn-and-river) |
| **4. River** | **R1** Betting the river | river-polarisation, thin-value, choosing-bluffs-blockers, river-sizing |
| | **R2** Facing river bets | bluff-catching, facing-river-raises |
| | **R3** River in 3-bet pots | *3bp-river* (split from 3bp-turn-and-river) |
| **5. Exploits** | **X1** Reading people | player-profiles, *reading-hud-stats* (the opponents panel's numbers, and how many hands each needs before it means anything) |
| | **X2** The pool | population-exploits, *exploiting-overfolders*, *exploiting-calling-stations*, *exploiting-aggressive-players*, *underbluffed-rivers* |
| | **X3** Exploit lab | *node-locking-in-rail* (lock an opponent's frequency at a node, re-solve, see the best response and what it gains and risks), *when-not-to-exploit* (sample size, counter-exploits, the cost of being wrong) |
| | **X4** Live and deep | live-game-dynamics, straddle-preflop, straddle-postflop-low-spr, deep-stacks-200bb |

**Removed from the path:** `how-rail-teaches`, `gto-mixing-and-simplifying`,
`reading-rail-reports` and `variance-bankroll-and-tilt` (intro panel and
reference), all of M1 and all of M2.

**Exploit lessons are engine-backed like everything else.** Rail has its own
evidence for them:
- the owner's own database: villain stats (M4 opponents panel, `villain_stats`) give pool tendencies with sample sizes;
- the solver: an *exploit lab* fixes an opponent's strategy at a node and computes the best response against it, a best response with one player's strategy frozen, which `lib/solver` already does for exploitability.

No population figures are copied from anywhere. A number about "the pool" is
either the learner's own data, with its sample size, or clearly labelled
theory with no number.

## 3. Exercises

| Kind | What | Graded by | L1 |
|---|---|---|---|
| `chart-quiz` | preflop trainer spots by family, seat, raiser and chart set (6/9-max, 40–200bb, limped) | the charts, through `analyzeHand` | yes |
| `solver-spot` | river spots (A7) and **turn spots** (new, `lib/training/turn.ts`), optionally "the villain checked" or "bet" (in position); flop when the library is on | the river / turn solve, through `analyzeHand` | river, turn |
| `calc` | a number to work out (pot odds, draw equity by exact enumeration, EV trees, combos, alpha/MDF, SPR, grades, steal and big-blind prices, bb/100, all-in EV, multiway folds), answered before the calculator reveals it | `math.ts`, exact equity, `grade()` | yes |
| `classify` | sort a board or hand: suits, pairing, connectedness, high card, dynamism, hand class; range advantage, nut advantage and turn-card shifts on the concept library's illustrative ranges | `texture.ts`, `madeHand`/`draws`, `rangeVsRange`, `nutShare` | yes |
| `own-hands` | the learner's decisions matching the lesson's spots or flags, worst EV loss first, spoiler-safe | the stored grade (`gradeDrill`) | yes |
| `range-split` | put hand classes into check / small / big (or fold / call / raise) | the solver per `flopBucket` category | placeholder |
| `range-paint` | paint a 13×13 range | a chart | placeholder |
| `range-walk`, `pot-tracking`, `profile-quiz`, `placement` | see §5 | | placeholders |

Pass rules are per exercise (a share of the items, e.g. 7 of 10). Own hands
and planned widgets never count towards passing; flop spots count once the
flop library is on.

## 4. Smart features

1. **Lessons recommended from leaks.** `lib/learn/recommend.ts` matches the
   leak finder's focus areas (and flags seen often) to the lesson that teaches
   them; the map shows "recommended: you lose X bb / 100 here", and the study
   plan adds a `lesson` task per area (and one for the fundamentals plan).
2. **Your hands as the last exercise** (above).
3. **Spaced repetition of missed items.** Every missed chart, solver, calc or
   classify item becomes a review card scheduled by the drills' SM-2
   (`drill_next`), played at `/learn/review`, mixed across lessons.
4. **Automatic progress.** A lesson is passed when its gradable exercises
   pass, recorded the moment the last one does.

Later (L3+): a placement test with test-out, mastery from real-hand
improvement, interleaved module capstones, "isolate one variable" comparison
views, a live/online path toggle, re-check nudges, a daily five-minute dose.

## 5. Phases

| Phase | Delivers |
|---|---|
| **L1** (shipped, #110) | The Learn tab and course map; the full catalogue; written lessons for M0–M3 and M6-L4 in English and Croatian; `chart-quiz`, `solver-spot` (river and turn), `calc` with answer-first reveal, `classify`, `own-hands`; recommendations, the plan's lesson task, review cards, automatic progress; storage for signed-in learners, browser storage for signed-out ones. |
| **L1.1** — restructure (principles 8–9) | <ul><li>Tracks and modules as in §2; M0–M2 out of the map (intro panel and reference)</li><li>their key ideas folded into the first lesson that uses them</li><li>the new ids added as "coming soon"</li><li>the plan's lesson tasks and leak recommendations re-pointed</li><li>tests updated</li></ul> |
| **L2** — flop | Track 2 written (F1–F5); the `range-split` widget (turn/river buckets now, flop buckets when the flop library is on). |
| **L3** — turn and river | Tracks 3–4 written; `range-paint`; mastery from real-hand improvement. |
| **L4** — exploits | Track 5 written, plus the **exploit lab**: solver node-locking UI, the opponents-panel tie-in, pool tendencies from the learner's own villain stats with sample sizes. |
| **L5** | Placement test, curated example hands (`examples` slot), flop drills once `FLOP_LIBRARY_ENABLED` is on. |

## 6. What L1 shipped

- **Routes.** `/learn` (the course map: tracks → modules → lessons, with
  not started / in progress / mastered, "coming soon", and recommended
  badges), `/learn/<lesson>` (a lesson), `/learn/review` (review cards). The
  map and the lessons are public and indexable (the written lessons are in the
  sitemap); `/learn/review` is not indexed. The concept library stays at
  `/analysis/learn` and is linked from the map ("Concept library"); its old
  URLs are unchanged, and the Analysis tab's sub-nav now calls it "Concepts".
- **Main navigation.** "Learn" is a top-level tab for everyone, last in the
  bar: a signed-out visitor sees three tabs (Forum, Upload hand, Learn), a
  signed-in player with hands six. At 375px the strip already scrolled
  sideways with five tabs and keeps the current one in view, so a sixth costs a
  swipe, not a second row; the Analysis tab's own eight-section sub-nav is
  unchanged. Chosen over hiding Learn inside Analysis because the course works
  signed out and is the natural first stop for a new player.
- **The catalogue** (`course.ts`): 62 lessons with ids, codes, prerequisites,
  concepts, exercises, leak matches and honesty notes; an empty `examples`
  slot for curated hands.
- **25 written lessons**, English and Croatian, with sections, inline concept
  widgets, "predict, then reveal" checkpoints, rules of thumb and when they
  break, and exercise lines. Every computed number is listed with its formula
  and recomputed by `tests/test/course.test.ts`; English and Croatian are held
  to the same structure.
- **M6-L4** (owner's request): both in-position roles, the three buckets and
  their jobs, texture and SPR shifts at Rail's own 3-bet sizes, a population
  note; the flop split is conceptual (banner) and the drills run on turn and
  river spots after a check, in both roles.
- **Engine additions** (additive): `generateTurnSpot` and `turnAnswer` (turn
  spots, graded by `gradeAnswer(…, { turn: true })`, the analysis' turn solve);
  a `facing` filter on river and turn spots; `practice.ts` (calc and classify
  generators and graders).
- **Storage** (`20270317090000_learn_progress.sql`): `lesson_progress`,
  `lesson_cards`; definer writers `record_lesson_results`, `add_lesson_cards`,
  `review_lesson_card`; the plan's `lesson` task kind; `learn` reserved.
  pgTAP `learn_progress.test.sql`. Signed out: the same model in
  `localStorage`, with an explicit "add it to this account" offer after
  signing in.

## 7. Open after L1

- The `range-advantage`, `nut-advantage` and turn-card classify items use the
  concept library's hand-written ranges, not Rail's charts; their buckets are
  set on those ranges (`practice.ts`). Moving them onto chart ranges is an L2
  task once the flop library gives real flop ranges.
- Turn spots use A5a's coarse tree (check, 75%, all-in when short), so the
  turn "small bet" bucket of M6-L4 is taught in words; the river offers several
  sizes.
- A review card regenerates its item from its seed with the current charts and
  solver: after a chart or analysis version bump the same card deals a
  slightly different spot of the same kind.
- `own-hands` cannot tell a 3-bet pot from a single-raised one by spot key; it
  filters by the analysis' pot type instead (M6-L4).
- Recommendations read the leak finder at the current analysis version only;
  a library not yet re-analysed shows none.
- The lesson's results and cards are graded in the browser and only
  shape-checked by the database, as trainer answers are.
