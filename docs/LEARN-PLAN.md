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
   yet (a flop the library did not solve is read from its nearest solved
   flop, multiway and 4-bet-pot flops are not in the library, straddles have
   no charts, ranges rest on the narrowing model), the lesson says so with the
   analysis' own words.
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

### Restructure from L1 (shipped in L1.1, see §7)

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
| `solver-spot` | river spots (A7) and **turn spots** (new, `lib/training/turn.ts`), optionally "the villain checked" or "bet" (in position), and for the turn the flop line before it (checked through, or a bet called; L3); **flop spots** from the flop library (L2, `lib/training/flop.ts`): facing a check, a bet or a raise, any seat, a line filter | the river / turn solve, the flop library's chunk, through `analyzeHand` | river, turn; flop in L2 |
| `calc` | a number to work out (pot odds, draw equity by exact enumeration, EV trees, combos, alpha/MDF, SPR, grades, steal and big-blind prices, bb/100, all-in EV, multiway folds), answered before the calculator reveals it | `math.ts`, exact equity, `grade()` | yes |
| `classify` | sort a board or hand: suits, pairing, connectedness, high card, dynamism, hand class; range advantage, nut advantage and turn-card shifts on the concept library's illustrative ranges | `texture.ts`, `madeHand`/`draws`, `rangeVsRange`, `nutShare` | yes |
| `own-hands` | the learner's decisions matching the lesson's spots or flags, worst EV loss first, spoiler-safe | the stored grade (`gradeDrill`) | yes |
| `range-split` | put hand classes into check / small / big (or fold / call / raise); the river adds an overbet group | the solve's mix per class: `flopBucket` categories on a library flop, `turnCategory` on a turn solve, `riverCategory` on a river solve | L2 (`lib/training/split.ts`); river in L3 |
| `depth-split` | the same split at 200bb against 100bb | flop solves at other depths | placeholder |
| `range-paint` | paint a 13×13 range: a seat's first-in range, or the hands of a river range that bet or continue | the chart, or the river solve, cell by cell (`lib/training/paint.ts`) | L3; the straddle paint still planned |
| `range-walk`, `pot-tracking`, `profile-quiz`, `placement` | see §5 | | placeholders |

Pass rules are per exercise (a share of the items, e.g. 7 of 10). Own hands
and planned widgets never count towards passing; flop spots and flop splits
count where they can be played: the flag on (`FLOP_LIBRARY_ENABLED`, since
`analysis/8`) and the library reachable (a Supabase URL).

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

5. **Mastery from real-hand improvement** (L3). Once a signed-in learner has
   passed a lesson, the lesson page compares their own graded decisions in its
   spots before and after the day they passed it (`lib/learn/mastery.ts`).

Later (L4+): a placement test with test-out, interleaved module capstones,
"isolate one variable" comparison views, a live/online path toggle, re-check
nudges, a daily five-minute dose.

## 5. Phases

| Phase | Delivers |
|---|---|
| **L1** (shipped, #110) | The Learn tab and course map; the full catalogue; written lessons for M0–M3 and M6-L4 in English and Croatian; `chart-quiz`, `solver-spot` (river and turn), `calc` with answer-first reveal, `classify`, `own-hands`; recommendations, the plan's lesson task, review cards, automatic progress; storage for signed-in learners, browser storage for signed-out ones. |
| **L1.1** (shipped) — restructure (principles 8–9) | <ul><li>Tracks and modules as in §2; M0–M2 out of the map (intro panel and reference)</li><li>their key ideas folded into the first lesson that uses them</li><li>the new ids added as "coming soon"</li><li>the plan's lesson tasks and leak recommendations re-pointed</li><li>tests updated</li></ul> |
| **L2** (shipped) — flop | Track 2 written (F1–F5); flop spots from the library; the `range-split` widget (flop buckets from the library, turn categories from a turn solve); the raiser's flop bets by board group from Rail's own library. See §8. |
| **L3** (shipped) — turn and river | Tracks 3–4 written; `range-paint`; the river split; mastery from real-hand improvement. See §10. |
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

## 7. What L1.1 shipped

- **The map is the §2 table.** Five tracks (Preflop, Flop, Turn, River,
  Exploits) and 18 modules, P1–P3, F1–F5, T1–T3, R1–R3, X1–X4, with lesson
  codes from the module (`P1-L1` … `X4-L4`). 56 lessons: the 45 L1 ids that
  stay, moved into place, and 11 new ones as "coming soon", with titles,
  outlines and planned exercises in English and Croatian:
  `preflop-by-stack-depth` (chart quizzes on the 40, 60, 150 and 200 bb sets),
  `turn-check-raise-and-probe`, `3bp-turn` and `3bp-river` (split from
  `3bp-turn-and-river`), `reading-hud-stats`, `exploiting-overfolders`,
  `exploiting-calling-stations`, `exploiting-aggressive-players`,
  `underbluffed-rivers`, `node-locking-in-rail` and `when-not-to-exploit`. A
  new planned exercise kind, `node-lock`, names the exploit lab's widget.
- **M0–M2 left the map** and became **reference pages** at
  `/learn/reference/<id>` (`REFERENCE_IDS`, 16 pages): the L1 text, widgets and
  checkpoints, read-only, with no practice and no progress. Chosen over
  pointing at the concept library because the concept pages have their own,
  shorter text: this keeps every written L1 page reachable unchanged. The old
  `/learn/<id>` addresses redirect there (308); `/learn/3bp-turn-and-river`
  redirects to `/learn/3bp-turn`; `reference` is a reserved `/learn` segment.
  The pages are in the sitemap.
- **M0 is the map's intro panel**: "How Rail teaches" (the study loop, what a
  grade and EV loss mean, how leaks become recommendations, your own hands and
  review cards) and the list of reference pages by group.
- **Ideas folded into the first lesson that needs them**, each linking its
  reference page the first time the term is used. Lesson text and outline
  goals may hold `[[ref-id|label]]` links (`refLinks`, rendered by
  `RichText`); the tests hold every target to a reference id and English and
  Croatian to the same targets.
  - *Facing an open* (written): two lines in place on pot odds and
    realisation; *card removal* links its page.
  - *Defending a flop bet*, *picking river bluffs*, *flop bets by board type*
    (not written yet): a goal in the outline on alpha / MDF, combos and card
    removal, and range and nut advantage, for L2 and L3 to write. Their
    catalogue entries gained the matching drills (`alpha-mdf` and `combos`
    calcs, `range-advantage` and `nut-advantage` classify items).
- **Recommendations and the plan re-pointed.** No match, prerequisite, plan
  task or link names a removed id (`LessonId` no longer holds them, so the
  compiler checks it). Leak patterns and flags the maths lessons carried moved
  to the lessons on the map: flop and turn calls to *defending a flop bet* and
  *facing a second barrel*, river calls and `fold-nuts` to *bluff-catching*,
  `free-fold` to *which hands bet and which check*. Every heuristic flag still
  has a lesson. The fundamentals plan's lesson is now the first unpassed of
  *seats and opening ranges*, *facing an open*, *the blinds*, *3-betting*.
- **Old progress is kept, not shown.** No migration: the database checks only
  a lesson id's shape. Progress rows and review cards for removed ids stay as
  they are; the app reads them through `isLessonId` (dropped), and the review
  queue's counts and deals ask only for lessons on the map. A plan saved
  before L1.1 that names a removed lesson links to its reference page.

## 8. What L2 shipped

- **Track 2 written**, English and Croatian, all 19 lessons of F1–F5:
  `cbet-why-and-when`, `cbet-by-texture`, `hand-classes-on-the-flop`,
  `checking-back-and-delayed-cbets` (F1); `oop-as-the-raiser`,
  `facing-a-check-raise` (F2); `defending-vs-cbets`, `check-raising`,
  `floating-and-stabbing-ip`, `probes-and-donk-bets`, `bb-vs-btn-blueprint`
  (F3); `spr-and-commitment`, `cbetting-as-the-3bettor`,
  `playing-3bp-as-the-caller`, `four-bet-pots` (F4, with M6-L4's
  `range-splitting-ip-vs-checks-3bp` revised); `multiway-principles`,
  `multiway-as-the-raiser`, `multiway-defence` (F5). Bodies in
  `lib/learn/lessons/f1.*`–`f5.*`.
  - The ideas L1.1 folded in are written in place: alpha / MDF where a flop
    bet is defended (and priced again for a check-raise), range and nut
    advantage where flop bets are sized.
  - **No basics; every number is arithmetic the course test recomputes** (pots,
    alpha, MDF, prices, SPR, the geometric bet, multiway folds and the MDF
    split) or Rail's own at runtime. Frequencies are never written into the
    text; the words give directions, and those were **checked against Rail's
    own library before writing** (e.g. the big blind folds more than MDF to a
    small c-bet; the in-position 3-bettor bets small with most of its range;
    out of position the 3-bettor still bets most flops; the small blind as
    raiser checks nearly every low board). Where Rail's library contradicted
    L1's wording, the text and outline goals were changed: M6-L4's split
    (big bets are rare for the in-position 3-bettor; its checks grow on
    monotone and ace-high boards) and the 3-bet-pot outlines.
  - **Honesty banners** (principle 5): `flop-mapped` on every lesson with flop
    drills (drills are dealt on solved flops, a real hand on another flop is
    read from its nearest solved flop by category), `multiway-heuristic` on
    F5 (the library is heads-up), `conceptual` on 4-bet pots (not in the
    library). `flop-library-off` is gone.
- **Flop spots** (`lib/training/flop.ts`): a line of `FLOP_LINES` and a flop
  the library holds (`planFlop`, drawn first so the worker can fetch the one
  chunk), the chunk's suits relabelled at random (the same canonical flop:
  exact, never mapped), the line before the hero's decision drawn from the
  solve's own frequencies (`heroNode`: facing a check, a bet or a raise, or
  the first decision), the hero's combo from its range at the node.
  `gradeAnswer(…, { flopLibrary })` runs `analyzeHand` on the finished hand,
  which reads the same chunk and lands on the same node (tested on the
  pilot: `source: "solver"`, not mapped, same menu). Filters: pot, seat,
  role, facing, and a line (`bb-vs-btn-blueprint` deals `btn-bb` only).
- **The range split** (`lib/training/split.ts`, `SplitItemView`): the hero's
  whole range at the node, every combo by its `flopBucket` category (made hand
  × draw) on a library flop, or by `turnCategory` on a turn solve (A5a); the
  largest categories (at least 3% of the range, at most 8); groups check /
  small (≤ half the pot) / big, or fold / call / raise. A class is right when
  the solve plays the pick within 15 points of its most played group (a mixed
  class has more than one right answer); an item is right at 70% of its
  classes. The item carries the solve's numbers, so the browser grades it.
  Live on `cbet-by-texture`, `hand-classes-on-the-flop`, `check-raising` and
  M6-L4 (flop), and `turn-check-raise-and-probe` (turn, lesson not written).
- **The raiser's flop bets by board group** (`flop-bets` widget,
  `lib/learn/flopBets.ts`): for BTN–BB and UTG–BB (the button checked to) and
  the big blind's 3-bet against the button, the share of the raiser's range
  that bets, and bets big, at its first decision, averaged per board group
  over the library's 100 flops. The rows are `lib/learn/data/flop-bets.json`
  (13 KB), written from the full run by `npm run floplib:bets`; the tests
  recompute every row the committed pilot holds from its chunks and every
  group from the rows. Rail's own solves only, labelled as such.
- **In the browser**: the trainer worker builds a `FlopLibraryLoader` on
  `flopLibraryBase(SUPABASE_URL)` and fetches the one chunk a job needs
  (`prepareFlopLibrary` / `trainingChunk`), never bundled. Flop exercises
  count towards passing where they can be played (flag on and a Supabase
  URL, `FLOP_DRILLS_AVAILABLE`); without one they say so. **Loader fix:**
  `FlopLibraryLoader.ready` now shares an in-flight manifest fetch — the
  trainer worker answers jobs concurrently, and a second job used to read
  the half-loaded manifest as empty and deal nothing (no grade change; the
  analysis worker loads sequentially).
- **No migration.** Flop spots and splits are `solver-spot` review cards
  (items `k: "flop"` and `k: "split"`; the database checks only the card
  kind and the item's size). A new planned kind, `depth-split` (200bb against
  100bb), replaces X4's planned flop split.
- **Recommendations and the plan**: flop leaks now land on the F lessons by
  their spot match (written lessons win, best action decides between
  *why the raiser bets* and *which hands bet and which check*); L1.1's
  stand-in (the 3-bet-pot split for every in-position flop leak) is gone, and
  a multiway flop leak goes to F5. The plan's lesson tasks follow, since they
  ask the same matcher for written lessons.
- **Verified** in the browser against the full library served locally: the
  split (fold / call / raise on an HJ–BB flop) and a big-blind flop spot
  graded "Perfect, graded against the solver" from the chunk.

## 9. Open after L1, L1.1 and L2

- **`btn-sb` is never read by the analysis**: `chartLineOf` places a
  button–small-blind pot as `fffrc` (the big blind's later fold is not part
  of either flop player's line), but its chunks are keyed `fffrcf`, so real
  hands on that line keep the heuristic flop. The drills skip the line
  (`analysisReadsLine`); fixing the analysis is a grade change (a version
  bump), for the analysis track. (Fixed in `analysis/9`: the line is read and
  dealt again.)
- Flop drills cover the library: 6-max, 100bb, heads-up, eleven lines. 9-max,
  other depths, 4-bet pots and multiway flops are taught in words and graded
  in your own hands by the heuristic.
- The turn split reads A5a's coarse turn tree (check, 75%, all-in), so its
  groups are check / big or fold / call / raise. (The river split, with its
  overbet group, shipped in L3.)
- The trainer history (`trainer_results`) keeps preflop and river answers
  only; flop and turn spots count in the lesson, not in the study plan's
  trainer tasks.
- The `range-advantage`, `nut-advantage` and turn-card classify items use the
  concept library's hand-written ranges, not Rail's charts; their buckets are
  set on those ranges (`practice.ts`). The flop-bets table and the split now
  give Rail's own numbers next to them; moving the classify items onto the
  library's ranges is still open.
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
- A leak area does not know the pot type, so a flop leak in a 3-bet pot can
  land on the single-raised lesson for the same spot. (Since L3 river leaks
  land on R1–R2; T3 and R3 carry no leak match for this reason.)
- Reference pages keep L1's wording, so a few lines still read as part of a
  lesson ("this lesson"); the cross-links to the next page were made into
  reference links.

## 10. What L3 shipped

- **Tracks 3 and 4 written**, English and Croatian, all 14 lessons of T1–T3
  and R1–R3: `turn-card-classes`, `double-barreling`,
  `turn-sizing-and-overbets`, `turn-after-flop-checks-through` (T1);
  `facing-turn-barrels`, `turn-check-raise-and-probe` (T2); `3bp-turn` (T3);
  `river-polarisation`, `thin-value`, `choosing-bluffs-blockers`,
  `river-sizing` (R1); `bluff-catching`, `facing-river-raises` (R2);
  `3bp-river` (R3). Bodies in `lib/learn/lessons/t.*` and `r.*`.
  - Combos and card removal, folded into *picking river bluffs* by L1.1, are
    written there and link their reference page.
  - **No basics; the maths in place**: alpha, minimum defence, the price of a
    call, the bluff share of a polarised range, the value bet's break-even,
    the geometric bet and the SPR of a 3-bet pot, each where it decides
    something. Every number is arithmetic the course test recomputes.
  - **Directions checked against Rail's own solves before writing**
    (`tests/scripts/learn-directions`, `npm run learn:directions` from
    `tests/`: a few dozen turn solves and a few hundred river solves of the
    trainer's own generator, by hand category). Among what it showed: the
    raiser barrels most on pairing cards and overcards and least on the card
    that puts a third of a suit on the board, where even top pairs check; out
    of position a flush draw folds to a turn bet more often than a middle
    pair; the turn check-raise is mostly strong made hands; river middle pairs
    check most of all, ace-high far more than no pair; river overbets are more
    common in position after a check; middle pairs fold more as the bet grows;
    a raise of a river bet is folded to by most one-pair hands, and small bets
    are raised more often; in 3-bet pots the river all-in is the most common
    bet. **Where Rail contradicted the L1.1 outlines, the outlines changed**:
    the turn probe and lead (rare in Rail's solves, in both lines), the missed
    flush draw as a weak bluff (not what the solve does by category; the goal
    is now "bluff first with hands that cannot win by checking"), and the river
    raise lesson's population claims (now: read a raise as strong, from
    Rail's own solve; its title is now "Facing a river raise").
  - **Honesty banners**: `approximate-ranges` on every T and R lesson (ranges
    narrowed by the heuristic model), and a new one, `turn-tree`, on the T
    lessons: the turn is solved with one bet size, so smaller turn bets and
    overbets are taught in words and on the river.
- **Turn and river practice** on the existing generators, graded by
  `analyzeHand`: `solver-spot` exercises with the `facing` filters and, new, a
  **flop-line filter for turns** (`TurnSpotOptions.flop`: the flop checked
  through, or a bet called; `drawFlopPattern`; an unfiltered seed deals what
  it always did). `range-split` on the turn (barrels, probes, defence,
  3-bet pots) and, new, **on the river** (`riverSetup`, the river spot's
  first half shared with the split and the paint; `riverCategory` rows; an
  overbet group above the pot; a raise of the hero's bet reached through the
  hero's bet).
- **`range-paint`** (`lib/training/paint.ts`, `PaintItemView`): paint the
  13×13 grid; a cell Rail plays at least 75% of the time must be painted, at
  most 25% left empty, anything between counts either way; the score is over
  the cells that matter (every cell to paint, and every cell painted),
  weighted by combos; an item is right at 80%. Two sources: a chart set's
  first-in range for a seat (`positions-and-opening-ranges`' `paint-a-seat`,
  planned since L1, is live) and a river node solved on demand — the hands
  that bet (`river-polarisation`) or that continue against a bet
  (`bluff-catching`). Click, drag, arrow keys and Space; colour is never
  alone (✓, −, +). Cards are `chart-quiz` or `solver-spot` review cards
  (items `k: "paint"`): no migration. The straddle paint stays planned.
- **Mastery from real-hand improvement** (`lib/learn/mastery.ts`,
  `LessonMastery`): on a passed lesson, for a signed-in learner, the leak
  finder's report (`analysis_leaks`, invoker, RLS) is read twice — hands
  played before the day the lesson was passed, and from it on — and the rows
  matching the lesson's spots (its leak match and its own-hands spots, with
  the own-hands pot type) are summed: decisions, EV lost per decision (bb and
  % of the pot), share graded Inaccurate or worse. The change is the leak
  finder's own Welch z on the mean move score; below 20 graded decisions on
  either side it says "not enough hands yet". Nothing stored, **no
  migration**.
- **Recommendations and the plan**: turn and river leaks now land on the T
  and R lessons (a turn barrel leak on *the second barrel*, a turn
  check-raise or lead on T2-L2, a river bet on *thin value*, a river check
  on *picking river bluffs*, a river call on *bluff-catching*, a raised river
  bet on R2-L2). The 3-bet-pot lessons carry no leak match (a leak area does
  not know the pot type) and are reached from the map, the course order and
  their own hands. The plan's lesson tasks follow, since they ask the same
  matcher for written lessons.

## 11. Open after L3

- **Mastery is measured, not acted on.** It is shown on the lesson page; the
  map's "mastered" still means the exercises passed, and a lesson whose own
  hands got worse is not re-recommended yet.
- Mastery splits on the day a lesson was passed, by when hands were played,
  and reads the current analysis version only: a library not re-analysed
  since a version bump shows "not enough hands" until it is. Lessons matched
  only by flags (e.g. *SPR and commitment*) have no spots to measure.
- The turn is solved with one bet size: the turn sizing lesson's overbets are
  practised on the river split. A finer turn tree is the analysis track's.
- The river spot generator answers checks and bets in position; a river
  raise is practised in the split only (the solver-spot `facing` has no
  `raise` on the river).
- The direction check (`npm run learn:directions`) uses the trainer's
  heuristic narrowing and the 6-max 100bb charts; 9-max and other depths are
  taught by the same words.
- The paint widget and the river split were checked in the browser (chart
  and river sources, keyboard, 375px); mastery by its unit tests only (no
  signed-in session with analysed hands was used).
