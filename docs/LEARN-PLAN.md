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

## 2. The course

Ten modules plus an orientation, in four tracks. 62 lessons (M0's 4 plus 58).
Lesson ids are the `LessonId` union in `frontend/src/lib/learn/course.ts`;
titles are in the dictionary (`course.titles`), outlines and bodies in
`frontend/src/lib/learn/lessons/`.

| Track | Module | Lessons | L1 |
|---|---|---|---|
| Foundations | **M0 Orientation** | how to study with Rail; equilibrium, exploits and why the solver mixes; reading your analysis and leaks; variance, bankroll and judging decisions | written |
| | **M1 Poker maths** | pot odds; equity, outs and quick estimates; expected value; counting combinations; alpha and MDF; realisation and implied odds | written |
| | **M2 Thinking in ranges** | from one hand to a range; range advantage; nut advantage; reading the flop; who the next card helps; narrowing a range street by street | written |
| Preflop | **M3 Preflop** | seats and opening ranges (6-max and full ring); open sizes online and live; facing an open; 3-betting; facing 3-bets and 4-bets; blind defence and blind vs blind; squeezes; limpers and isolation | written |
| After the flop | **M4** Single-raised pots as the raiser | why the raiser bets; flop bets by board type; which hands bet; out of position as the raiser; checking back and betting later; facing a check-raise | L2 |
| | **M5** Single-raised pots as the caller | defending a flop bet; check-raising; floating and stabbing in position; leading into the raiser; facing a second barrel; big blind vs button end to end | L2 |
| | **M6** 3-bet and 4-bet pots | SPR and commitment; betting as the 3-bettor; calling a 3-bet; **in position after a check: small, big or check** (owner's request); 3-bet pots on the turn and river; 4-bet pots | M6-L4 written; rest L3 |
| | **M7** The turn | kinds of turn card; betting again; sizes and overbets; after a checked flop | L2 |
| | **M8** The river | value, bluffs and the middle; thin value; picking bluffs; bluff-catching; river sizes; raises and leads | L2 |
| | **M9** Multiway | what changes with three players; betting into two; defending and leading; preflop choices that make pots multiway | L3 |
| Live and exploits | **M10** | live dynamics; straddles preflop; straddled pots after the flop; 200bb deep; adjusting to the pool; player types | L3 |

Every lesson in the catalogue already has its prerequisites, linked concepts,
exercise definitions and the spots and flags that tie it to leaks, so a later
phase only writes the words and builds the widgets it waits for.

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
| **L1** (this) | The Learn tab and course map; the full catalogue; written lessons for M0–M3 and M6-L4 in English and Croatian; `chart-quiz`, `solver-spot` (river and turn), `calc` with answer-first reveal, `classify`, `own-hands`; recommendations, the plan's lesson task, review cards, automatic progress; storage for signed-in learners, browser storage for signed-out ones. |
| **L2** | M4, M5, M7, M8 written; the `range-split` widget, turn and river first (graded per hand class by Rail's turn and river solves), then flop when the library is on. |
| **L3** | M6, M9, M10 written; the `range-paint` widget; the placement test; mastery from real-hand improvement (the leak finder's mistake rate in the lesson's spots before and after); the range-walk widget (M2-L6). |
| **L4** | Curated example hands with source attribution in the lessons' `examples` slot (a separate research job is collecting them from a video channel); flop drills once `FLOP_LIBRARY_ENABLED` is on (M4, M5, M6-L4's flop split, the texture triad and the SPR toggle). |

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
