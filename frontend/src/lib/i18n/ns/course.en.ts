/**
 * Strings for the Learn tab (`/learn`, Learn L1), English. Spread into `en.ts`
 * as `course`; `course.hr.ts` is the same shape.
 *
 * Only the short strings live here: lesson, reference-page (L1.1), module
 * and track titles (the course map and the study plan name lessons
 * client-side, and a plan saved before L1.1 may still name a reference
 * page), the page chrome and the exercises' words. A lesson's outline and body are in
 * `lib/learn/lessons/`, read by the server only.
 *
 * Numbers arrive already formatted for the reader's locale, so these
 * functions only place them in a sentence.
 */

const titles = {
  "how-rail-teaches": "How to study with Rail",
  "gto-mixing-and-simplifying": "Equilibrium, exploits and why the solver mixes",
  "reading-rail-reports": "Reading your analysis and your leaks",
  "variance-bankroll-and-tilt": "Variance, bankroll and judging decisions",
  "pot-odds": "Pot odds, step by step",
  "equity-and-outs": "Equity, outs and quick estimates",
  "expected-value": "Expected value",
  "combos-and-card-removal": "Counting combinations",
  "bluffing-math-alpha-mdf": "The maths of bluffing: alpha and MDF",
  "equity-realisation-and-implied-odds": "Realising equity, and implied odds",
  "thinking-in-ranges": "From one hand to a range",
  "range-advantage": "Range advantage",
  "nut-advantage": "Nut advantage",
  "board-texture": "Reading the flop",
  "who-the-next-card-helps": "Who the next card helps",
  "range-narrowing": "Narrowing a range street by street",
  "positions-and-opening-ranges": "Seats and opening ranges, 6-max and full ring",
  "open-sizing": "How much to open, online and live",
  "facing-an-open": "Facing an open: fold, call or 3-bet",
  "three-betting": "Building a 3-betting range",
  "facing-3bets-and-4bets": "When you are 3-bet or 4-bet",
  "blind-play-and-bvb": "Defending the blinds, and blind against blind",
  "squeezes-and-multiway-preflop": "Squeezes and pots with callers",
  "limpers-and-isolation": "Playing against limpers",
  "cbet-why-and-when": "Why the preflop raiser bets the flop",
  "cbet-by-texture": "Flop bets by board type",
  "hand-classes-on-the-flop": "Which hands bet and which check",
  "oop-as-the-raiser": "Raising preflop, out of position after",
  "checking-back-and-delayed-cbets": "Checking back, and betting later",
  "facing-a-check-raise": "When your flop bet is raised",
  "defending-vs-cbets": "Defending against a flop bet",
  "check-raising": "Check-raising the flop",
  "floating-and-stabbing-ip": "Calling in position and taking it away",
  "probes-and-donk-bets": "Leading into the raiser",
  "facing-turn-barrels": "Facing a second barrel",
  "bb-vs-btn-blueprint": "Big blind against the button, start to finish",
  "spr-and-commitment": "Stack-to-pot ratio and commitment",
  "cbetting-as-the-3bettor": "Betting the flop as the 3-bettor",
  "playing-3bp-as-the-caller": "Calling a 3-bet and playing after",
  "range-splitting-ip-vs-checks-3bp": "In position after a check in a 3-bet pot: small, big or check",
  "four-bet-pots": "4-bet pots",
  "turn-card-classes": "Kinds of turn card",
  "double-barreling": "Betting the turn again",
  "turn-sizing-and-overbets": "Turn sizes, overbets and checking back",
  "turn-after-flop-checks-through": "The turn after a checked flop",
  "river-polarisation": "The river: value, bluffs and the middle",
  "thin-value": "Thin value",
  "choosing-bluffs-blockers": "Picking river bluffs",
  "bluff-catching": "Calling down with a bluff-catcher",
  "river-sizing": "River bet sizes",
  "facing-river-raises": "Facing a river raise",
  "multiway-principles": "What changes with three or more players",
  "multiway-as-the-raiser": "Betting into two opponents",
  "multiway-defence": "Defending and leading multiway",
  "multiway-preflop-choices": "Preflop choices that make pots multiway",
  "live-game-dynamics": "How live games differ",
  "straddle-preflop": "Straddles before the flop",
  "straddle-postflop-low-spr": "Straddled pots after the flop",
  "deep-stacks-200bb": "Playing 200 big blinds deep",
  "population-exploits": "Adjusting to the player pool",
  "player-profiles": "Recognising player types",
  "preflop-by-stack-depth": "Preflop at 40, 60, 150 and 200 big blinds",
  "turn-check-raise-and-probe": "Leading and check-raising the turn",
  "3bp-turn": "3-bet pots on the turn",
  "3bp-river": "3-bet pots on the river",
  "reading-hud-stats": "Reading opponent stats, and when to trust them",
  "exploiting-overfolders": "Against players who fold too much",
  "exploiting-calling-stations": "Against players who call too much",
  "exploiting-aggressive-players": "Against players who bet and raise too much",
  "underbluffed-rivers": "River bets with too few bluffs",
  "node-locking-in-rail": "Node-locking in Rail: the best response to a read",
  "when-not-to-exploit": "When not to exploit",
} as Record<string, string>;

export const courseEn = {
  titles,

  modules: {
    p1: "Opening",
    p2: "Facing raises",
    p3: "Blinds and stack depth",
    f1: "Single-raised pots: raiser in position",
    f2: "Single-raised pots: raiser out of position",
    f3: "Single-raised pots: the caller",
    f4: "3-bet and 4-bet pots",
    f5: "Multiway flops",
    t1: "Betting again",
    t2: "Defending the turn",
    t3: "The turn in 3-bet pots",
    r1: "Betting the river",
    r2: "Facing river bets",
    r3: "The river in 3-bet pots",
    x1: "Reading people",
    x2: "The player pool",
    x3: "The exploit lab",
    x4: "Live and deep",
  } as Record<string, string>,

  tracks: {
    preflop: "Preflop",
    flop: "The flop",
    turn: "The turn",
    river: "The river",
    exploits: "Exploits",
  } as Record<string, string>,

  moduleCode: (code: string) => `Module ${code}`,

  map: {
    heading: "Learn",
    intro:
      "A course in cash-game poker in the order of a hand: preflop, the flop situation by situation, the turn, the river, then exploits. Every lesson teaches one idea, lets you predict before it shows you, and ends with practice generated and graded by Rail's own charts, solver and calculators — and, signed in, with your own hands.",
    introPanel: {
      heading: "How Rail teaches",
      points: [
        "Learn one idea, predict before the lesson shows you, then practise it on spots that Rail's own charts, solver and calculators deal and grade.",
        "A grade is the EV you gave up against Rail's reference, in big blinds and as a share of the pot: a close call costs almost nothing, a real mistake costs a lot.",
        "Your analysis ranks leaks by the big blinds they cost per 100 hands, and a lesson marked “Recommended” teaches the spot that costs you most.",
        "Signed in, a lesson ends with your own hands in its spot, the costliest first; items you miss come back as review cards.",
      ],
      more: "The course assumes the basics. The ideas it builds on are reference pages, linked from a lesson the first time it uses a term:",
    },
    reference: {
      heading: "Reference",
      groups: {
        orientation: "Using Rail",
        maths: "Poker maths",
        ranges: "Ranges and boards",
      } as Record<string, string>,
    },
    concepts: "Concept library",
    conceptsHint: "Every idea the lessons use, with a worked example and a calculator.",
    review: (due: number) => (due === 1 ? "1 review card due" : `${due} review cards due`),
    reviewNone: "No review cards due",
    reviewLink: "Review",
    progress: (done: number, total: number) => `${done} of ${total} written lessons mastered`,
    progressTested: (done: number, tested: number, total: number) => `${done} of ${total} written lessons mastered, ${tested} tested out`,
    statusLabel: "Status",
    status: {
      "not-started": "Not started",
      "in-progress": "In progress",
      "tested-out": "Tested out",
      mastered: "Mastered",
    } as Record<string, string>,
    recheck: (before: number, after: number) => `Re-check: worse in your own hands since (${before} graded decisions before, ${after} after)`,
    recheckNote:
      "“Re-check” marks a lesson you passed or tested out of whose spots you have played worse since, by more than the sample's noise: at least 20 graded decisions on each side, by the leak finder's own test. Fewer hands, or a mere lean, never re-checks a lesson.",
    capstone: (code: string) => `Module ${code} review`,
    placement: "Placement test",
    placementHint: "Already play these spots? Test out of a module instead of working through it.",
    comingSoon: "Coming soon",
    recommended: "Recommended",
    recommendedLeak: (per100: string) => `Recommended: you lose ${per100} bb / 100 hands here`,
    recommendedFlag: (count: number, flag: string) => `Recommended: ${count} of your decisions flagged “${flag}”`,
    recommendedNote:
      "Recommendations come from your leaks at the current analysis version: the spots that cost you the most, matched to the lesson that teaches them.",
    localNote: "Your progress is kept in this browser only. Sign in to keep it in your account and to practise on your own hands.",
    signIn: "Sign in",
    accountNote: "Your progress is kept in your account.",
    merge: {
      body: (lessons: number) =>
        lessons === 1
          ? "This browser has progress on 1 lesson from when you were signed out."
          : `This browser has progress on ${lessons} lessons from when you were signed out.`,
      add: "Add it to this account",
      discard: "Discard it",
      done: "Added to your account.",
    },
    lessonCount: (written: number, total: number) => `${written} of ${total} lessons written`,
    prereqs: "Read first:",
  },

  lesson: {
    breadcrumb: "Learn",
    goals: "In this lesson",
    prereqs: "Read first",
    prereqsNote: "Advice, not a lock: every lesson opens.",
    concepts: "Concepts used",
    heuristics: "Rules of thumb",
    breaks: "When they break",
    practice: "Practice",
    practiceIntro:
      "The lesson is mastered when every exercise below that Rail can grade is passed. Missed items come back later as review cards.",
    exerciseLabel: (n: number) => `Exercise ${n}`,
    passRule: (needed: number, count: number) => `Pass: ${needed} of ${count} right`,
    passed: "Passed",
    notYet: "Not passed yet",
    best: (correct: number, total: number) => `Last try: ${correct} of ${total}`,
    mastered: "Lesson mastered",
    masteredBody: "Every graded exercise is passed. The review queue keeps what you missed coming back.",
    next: "Next lesson",
    previous: "Previous lesson",
    back: "Back to the course",
    comingSoonTitle: "This lesson is coming soon",
    comingSoonBody:
      "Its outline is here so you can see where it fits. The written lesson and its drills arrive with a later phase of the course.",
    comingSoonPractice: "Practice it will have:",
    referenceEyebrow: "Reference",
    referenceGoals: "On this page",
    referenceNote: "A reference page: an idea the course assumes, without practice or progress. Lessons link here the first time they use the term.",
    optional: "Optional",
    notCounted: "Does not count towards passing",
  },

  notes: {
    "flop-mapped":
      "The flop drills here are dealt from Rail's flop library: twelve heads-up 6-max 100bb lines, each solved on 100 representative flops. A drill's flop is one of those, so it is graded combo for combo. Your own hands on any other flop are read from the nearest solved flop by hand category, and the analysis marks those grades as mapped.",
    "multiway-heuristic":
      "Rail's flop library is heads-up. Multiway flops are read by the analysis' heuristic and the minimum-defence split, with facts and flags but no solver grade, so this lesson's practice is arithmetic and your own hands.",
    "approximate-ranges":
      "Approximate: the ranges here are hand-written teaching ranges or rest on Rail's narrowing model, not on a solve of the whole hand. The direction is what to take away.",
    "turn-tree":
      "Rail solves the turn with one bet size, three quarters of the pot, plus all-in when the stacks are short, and a coarse river below it: the same tree that grades your own turns. Smaller turn bets and overbets are taught here in words and on the river, whose solve has more sizes.",
    conceptual: "Conceptual: Rail does not analyse this spot yet, so this lesson teaches the idea without a graded drill.",
    "straddle-not-analysed": "Rail analyses one straddle only: a single 2bb straddle from the seat left of the big blind, 4-6 handed, near 100bb. Other straddled pots are taught in words.",
    "locked-read":
      "The exploit lab locks one tendency of the opponent on a river Rail solves on demand, keeps the rest of the opponent's strategy at the solve, and computes your best response. A lock is your read of a player, not a fact, and the lab works on the river only; the ranges rest on Rail's narrowing model.",
  } as Record<string, string>,

  exerciseKinds: {
    "chart-quiz": "Preflop spots dealt from Rail's charts, graded as the analysis grades your hands",
    "solver-spot": "Postflop spots solved on the spot by Rail's solver",
    calc: "Numbers to work out before the calculator shows them",
    classify: "Boards and hands to sort, graded by Rail's board and hand reader",
    "own-hands": "Your own analysed hands in this spot",
    "range-split": "Sorting a whole range's hand classes into actions, graded by Rail's solve per class",
    "depth-split": "Sorting hand classes at 200bb against 100bb (planned)",
    "range-paint": "Painting a range on the 13×13 grid, graded cell by cell against Rail's chart or solve",
    "range-walk": "Guessing a range street by street on your own hand (planned)",
    "node-lock": "Locking an opponent's tendency in Rail's solver and playing the best response against it",
  } as Record<string, string>,

  checkpoint: {
    label: "Predict",
    hint: "Pick an answer, then see why.",
    right: "Right.",
    wrong: (answer: string) => `Not quite — the answer is “${answer}”.`,
    reveal: "Rail's calculator, on these numbers:",
  },

  exercise: {
    start: "Start",
    restart: "Try again",
    next: "Next",
    check: "Check",
    yourAnswer: "Your answer",
    progress: (at: number, count: number) => `${at} of ${count}`,
    score: (correct: number, total: number) => `${correct} of ${total} right`,
    resultPassed: (correct: number, total: number) => `${correct} of ${total} right — passed.`,
    resultFailed: (correct: number, total: number, needed: number) => `${correct} of ${total} right — ${needed} needed. Try again when you are ready.`,
    cardsAdded: (count: number) => (count === 1 ? "1 missed item added to your review cards." : `${count} missed items added to your review cards.`),
    saved: "Saved.",
    savedLocal: "Saved in this browser.",
    saveFailed: (message: string) => `Could not save: ${message}`,
    correct: "Right",
    incorrect: "Not right",
    answerWas: (answer: string) => `Answer: ${answer}`,
    generating: "Dealing…",
    solving: "Solving the spot with Rail's solver…",
    grading: "Grading…",
    failed: (message: string) => `Something went wrong: ${message}`,
    retry: "Retry",
    noSpot: "No spot matched these settings. Try again.",
    planned: {
      "depth-split": "Planned: sort the same range at 200bb and at 100bb, and compare both splits with Rail's solves.",
      "range-paint": "Planned: paint a straddled seat's range on the 13×13 grid, once Rail has straddle charts to score it against.",
      "range-walk": "Planned: replay one of your hands and guess the opponent's range on each street, then compare with Rail's narrowing.",
      "node-lock": "Planned: lock an opponent's frequency at one decision, re-solve it with Rail's solver, and compare the best response with the baseline.",
    } as Record<string, string>,
    waits: {
      widget: "This exercise needs a widget that is not built yet.",
      "flop-library": "Waits for flop solves at this depth: Rail's flop library covers 6-max 100bb heads-up lines only.",
      "villain-stats": "Waits for opponent statistics in the analysis.",
      "straddle-charts": "Waits for straddle charts, which Rail does not have yet.",
    } as Record<string, string>,
    flopOff: "Flop spots need Rail's flop library, which is not switched on yet. This exercise opens when it is.",
    flopUnavailable:
      "Flop spots are dealt from Rail's flop library, which this copy of Rail cannot reach (it has no database configured). The exercise works on the hosted site.",
  },

  flopBets: {
    line: "Line",
    lines: {
      "btn-bb": "Button opens, big blind calls (button checked to)",
      "utg-bb": "Under the gun opens, big blind calls (UTG checked to)",
      "btn-bb-3bet": "Big blind 3-bets the button and is first to act",
    } as Record<string, string>,
    caption: (flops: number) => `The preflop raiser's first flop decision on ${flops} flops Rail solved, by board group`,
    group: "Board group",
    flops: "Flops",
    bet: "Bets",
    big: "Bets big",
    groups: {
      "ace-high": "Ace-high, unpaired",
      "king-queen-high": "King- or queen-high, unpaired",
      middle: "Jack- to eight-high, unpaired",
      low: "Seven-high or lower, unpaired",
      monotone: "Monotone",
      paired: "Paired",
      trips: "Trips",
    } as Record<string, string>,
    source:
      "Rail's own flop library: the 6-max 100bb chart ranges for the line, solved on each flop with bets of 33% and 75% of the pot. “Bets” is the share of the whole range that bets; “bets big” the share that bets 75% or all-in. Each solved flop counts once, so a group's figure is a plain average over its flops.",
  },

  split: {
    question: (street: string) =>
      `Your whole range is here on the ${street === "river" ? "river" : street === "turn" ? "turn" : "flop"}. Put each hand class where you think Rail's solve mostly plays it.`,
    groups: { check: "Check", small: "Small bet", big: "Big bet", overbet: "Overbet", fold: "Fold", call: "Call", raise: "Raise" } as Record<string, string>,
    you: "You",
    first: (street: string) => `You are first to act on the ${street === "river" ? "river" : street === "turn" ? "turn" : "flop"}.`,
    /** `self`: the hero ("You check."), else a seat ("BB checks."). */
    step: (who: string, kind: string, sizePot: number, self = false) =>
      kind === "check"
        ? `${who} ${self ? "check" : "checks"}.`
        : kind === "call"
          ? `${who} ${self ? "call" : "calls"}.`
          : kind === "allin"
            ? `${who} ${self ? "go" : "goes"} all-in.`
            : `${who} ${kind === "raise" ? (self ? "raise" : "raises") : self ? "bet" : "bets"} ${Math.round(sizePot * 100)}% of the pot.`,
    pot: (pot: string, toCall: string | null) => (toCall ? `Pot ${pot} · ${toCall} to call` : `Pot ${pot}`),
    share: (share: string) => `${share} of your range`,
    check: "Check my split",
    railMix: (mix: string) => `Rail: ${mix}`,
    overall: (mix: string) => `Your whole range, as Rail plays it: ${mix}.`,
    result: (correct: number, total: number, passed: boolean) =>
      `${correct} of ${total} classes where Rail plays them${passed ? " — counts as right." : " — not enough to count as right."}`,
    libraryNote: (line: string, iterations: string, exploitability: string) =>
      `From Rail's flop library: the ${line} chart ranges solved on this flop (bets of 33% and 75% of the pot, one raise, all-in), ${iterations} iterations, within ${exploitability}% of the pot. A small bet here is up to half the pot. A class counts as right when Rail plays your choice within 15 points of its most played one.`,
    turnNote:
      "From a turn solve on demand: the charts' preflop ranges narrowed on the flop by Rail's heuristic model, the turn solved with bets of 75% of the pot and all-in. A class counts as right when Rail plays your choice within 15 points of its most played one.",
    riverNote:
      "From a river solve on demand: the charts' preflop ranges narrowed on the flop and turn by Rail's heuristic model, the river solved with bets of 33%, 75% and 150% of the pot and all-in. A small bet is up to half the pot, a big one up to the pot, an overbet more. A class counts as right when Rail plays your choice within 15 points of its most played one.",
    made: {
      "fh+": "Full house or better",
      flush: "Flush",
      straight: "Straight",
      set: "Set",
      trips: "Trips",
      "two-pair": "Two pair",
      overpair: "Overpair",
      "tp-top": "Top pair, top kicker",
      "tp-good": "Top pair, good kicker",
      "tp-weak": "Top pair, weak kicker",
      middle: "Second pair or a pair below the top card",
      weak: "Weak pair or underpair",
      "ace-high": "Ace high",
      nothing: "No pair",
    } as Record<string, string>,
    draws: {
      combo: "flush and straight draw",
      nfd: "nut flush draw",
      fd: "flush draw",
      oesd: "open-ended straight draw",
      gut: "gutshot",
      bd: "backdoor draws",
    } as Record<string, string>,
  },

  paint: {
    questionOpen: (seat: string) => `Paint every hand ${seat} plays when the action folds to it: raises or limps.`,
    questionBet: "Paint the hands of your range here that Rail's solve bets.",
    questionContinue: "Paint the hands of your range here that Rail's solve continues with: calls or raises.",
    how: (inside: string, outside: string, pass: string) =>
      `Click or drag to paint, arrow keys and Space work too. A hand Rail plays at least ${inside} of the time must be painted, one it plays at most ${outside} left empty, and anything in between counts either way. You need ${pass} of the hands that matter, weighted by combos.`,
    cell: (hand: string, on: boolean) => `${hand}, ${on ? "painted" : "not painted"}`,
    cellGraded: (hand: string, on: boolean, share: string, state: string | null) =>
      `${hand}, ${on ? "painted" : "not painted"}, Rail ${share}${state === "right" ? ", right" : state === "missed" ? ", should be painted" : state === "extra" ? ", should be empty" : ""}`,
    notInRange: (hand: string) => `${hand}: not in the range here`,
    railShare: (hand: string, share: string) => `${hand}: Rail ${share}`,
    clear: "Clear",
    check: "Check my painting",
    result: (score: string, passed: boolean) => `${score} of the hands that matter right${passed ? " — counts as right." : " — not enough to count as right."}`,
    counts: (missed: number, extra: number) =>
      `${missed === 1 ? "1 hand" : `${missed} hands`} left empty that Rail plays (−), ${extra === 1 ? "1 hand" : `${extra} hands`} painted that Rail does not (+).`,
    legend: "✓ right · − should be painted · + should be empty. Hover a hand, or focus it, to see how often Rail plays it.",
    chartNote: (set: string) => `From Rail's ${set} chart: each hand's share of plays when the action folds to the seat.`,
    riverNote: (iterations: string, exploitability: string) =>
      `From a river solve on demand (the charts' preflop ranges narrowed on the flop and turn by Rail's heuristic model; bets of 33%, 75% and 150% of the pot and all-in; ${iterations} iterations, within ${exploitability}% of the pot). A hand's share is over the combos of it your range still holds here.`,
  },

  mastery: {
    title: "In your own hands since you passed it",
    titleTested: "In your own hands since you tested out of it",
    loading: "Reading your analysed hands…",
    failed: (message: string) => `Could not read your hands: ${message}`,
    noSpots: "This lesson is not tied to one spot of the leak finder, so Rail cannot measure it from your hands.",
    since: (day: string) => `Your graded decisions in this lesson's spots, before and after ${day}.`,
    before: "Before",
    after: "After",
    decisions: (n: number) => (n === 1 ? "1 decision" : `${n} decisions`),
    perDecision: (bb: string, pot: string) => `${bb} lost per decision (${pot} of the pot)`,
    mistakes: (rate: string) => `${rate} graded Inaccurate or worse`,
    none: "No graded decisions",
    tooFew: (min: number) => `Not enough hands yet: Rail names a change from ${min} graded decisions on each side.`,
    trend: {
      better: "Better since you passed it: the change is bigger than the sample's noise.",
      "leaning-better": "Leaning better since you passed it, though it could still be noise.",
      steady: "About the same as before: no change the sample can see yet.",
      "leaning-worse": "Leaning worse since you passed it, though it could still be noise. A replay of the lesson may help.",
      worse: "Worse since you passed it, by more than the sample's noise. Worth a second look at the lesson.",
      "too-few": "Not enough hands yet.",
    } as Record<string, string>,
    method:
      "Measured by mean move score with the leak finder's own test, on hands played before and after the day you passed the lesson, at the current analysis version. Nothing is stored: it updates as you upload and analyse more hands.",
  },

  spot: {
    flopNote: (line: string, iterations: string, exploitability: string) =>
      `A flop spot from Rail's flop library: the ${line} chart ranges solved on this flop (bets of 33% and 75% of the pot, one raise, all-in; ${iterations} iterations, within ${exploitability}% of the pot), the same solve that grades your own flops on this line.`,
    flopFirst: "You are first to act on the flop.",
    raised: (villain: string, to: number) => `${villain} raises to ${Math.round(to * 100) / 100} bb.`,
    lineName: (id: string) => {
      const parts = id.split("-");
      const seats = parts.filter((p) => p !== "3bet" && p !== "limp").map((p) => p.toUpperCase());
      return `${seats.join("–")}${parts.includes("3bet") ? " 3-bet pot" : parts.includes("limp") ? " limped pot" : ""}`;
    },
    turnNote: "A turn spot: Rail solves the turn and a coarse river (bet 75% of the pot or all-in), the same solve that grades the analysis' turns. It takes a second or two.",
    ownCards: "Your hand",
    turnFirst: "You are first to act on the turn.",
    turnRanges:
      "Ranges: the charts' preflop ranges, narrowed on the flop by a heuristic model — an approximation, the same one the analysis' turn grades rest on.",
  },

  calc: {
    units: {
      pct: "%",
      bb: "bb",
      count: "combos",
      chances: "chances",
    } as Record<string, string>,
    tolerance: (value: string) => `within ${value}`,
    questions: {
      "pot-odds": (pot: string, bet: string) => `The pot is ${pot} and your opponent bets ${bet}. How much equity does a call need?`,
      "outs-equity": "Both cards are still to come and nobody bets again. How often does your hand win (ties count half)?",
      ev: (pot: string, bet: string, folds: string, equity: string) =>
        `You bet ${bet} into ${pot}. Your opponent folds ${folds} of the time; when called you win ${equity} of the time and no more betting happens. What is the bet's EV?`,
      combos: (hand: string, shape: string) => `How many combinations of ${hand} (${shape}) can your opponent still hold?`,
      "alpha-mdf-alpha": (size: string) => `You bet ${size} of the pot as a pure bluff. How often must your opponent fold for it to break even?`,
      "alpha-mdf-mdf": (size: string) => `Your opponent bets ${size} of the pot. How much of your range must continue so a pure bluff cannot profit?`,
      spr: (pot: string, stack: string) => `The flop pot is ${pot} with ${stack} behind in the effective stack. What is the SPR?`,
      grade: (pot: string) => `Pot ${pot}. The reference's options are below, and you played the highlighted one. Which grade does it get?`,
      steal: (open: string, blinds: string) => `You open to ${open} with ${blinds} in the blinds. How often must everyone fold for the open to break even on its own?`,
      "blind-price": (open: string) => `The button opens to ${open}, the small blind folds. How much equity does the big blind need to call?`,
      per100: (lost: string, hands: string) => `Your leaks report says you lost ${lost} over ${hands} graded hands. How many bb per 100 hands is that?`,
      "allin-ev": (stack: string, dead: string, equity: string) =>
        `Your opponent shoves ${stack}; ${dead} is already in the pot. You call with ${equity} equity. What is the call's EV?`,
      "multiway-all-fold": (opponents: number, folds: string) =>
        `You bluff into ${opponents} opponents, each folding ${folds} of the time on their own. How often do they all fold?`,
      "multiway-mdf-split": (opponents: number, size: string) =>
        `A bet of ${size} of the pot goes into ${opponents} players. How much of their range must each defend so that together they fold no more than the bet needs?`,
      "sample-margin": (value: string, n: string) =>
        `An opponent's stat reads ${value} over ${n} chances. How far either side of it does the 95% interval reach (in points)?`,
      "sample-needed": (value: string, margin: string) =>
        `A stat sits near ${value}. How many chances does it need before its 95% interval is within ± ${margin}?`,
      "pot-tracking": "A live full-ring game, $0.5/$1 blinds, everyone 200 bb deep. Keep count as the hand goes: how many big blinds are in the pot when the turn is dealt?",
    },
    potSteps: {
      preflop: "Preflop",
      flop: "Flop",
      act: (position: string, type: string, to: string) =>
        type === "fold"
          ? `${position} folds`
          : type === "check"
            ? `${position} checks`
            : type === "call"
              ? `${position} calls`
              : type === "bet"
                ? `${position} bets ${to}`
                : `${position} raises to ${to}`,
    },
    combosShape: {
      pair: "a pair",
      suited: "the suited hand",
      "offsuit-or-suited": "the hand, suited and offsuit together",
    } as Record<string, string>,
    working: {
      "pot-odds": (afterCall: string, call: string, answer: string) => `If you call, the pot is ${afterCall} and ${call} of it is yours: ${answer}.`,
      "outs-equity": (outs: number, rule4: string, exact: string) =>
        `${outs} turn cards put you ahead. The ×4 shortcut says about ${rule4}; enumerating every turn and river gives ${exact}.`,
      ev: (foldPart: string, callPart: string, answer: string) => `Folds: ${foldPart}. Calls: ${callPart}. Together: ${answer}.`,
      combos: (total: number, removed: number, left: number) => `${total} combinations in a full deck; the cards you can see remove ${removed}, leaving ${left}.`,
      alpha: (alpha: string, mdf: string) => `Alpha (folds needed) is ${alpha}; MDF is the other side: ${mdf}.`,
      spr: (answer: string) => `Stack ÷ pot = ${answer}.`,
      grade: (evLoss: string, evLossPot: string) => `EV loss ${evLoss} (${evLossPot} of the pot).`,
      steal: (answer: string) => `Risk ÷ (risk + reward) = ${answer}.`,
      "blind-price": (pot: string, call: string, answer: string) => `The big blind calls ${call} to play for ${pot} plus the call: ${answer}.`,
      per100: (answer: string) => `Lost ÷ hands × 100 = ${answer}.`,
      "allin-ev": (win: string, lose: string, required: string, answer: string) =>
        `Win: +${win}. Lose: ${lose}. The call needs ${required} equity; its EV is ${answer}.`,
      multiway: (alpha: string, answer: string) => `The bet needs ${alpha} folds in all; the answer is ${answer}.`,
      "sample-margin": (variance: string, answer: string) => `1.96 × √(${variance} ÷ chances) = ${answer}.`,
      "sample-needed": (variance: string, answer: string) => `1.96² × ${variance} ÷ margin² = ${answer} chances.`,
      "pot-tracking": (preflop: string, flop: string, answer: string) => `${preflop} went in before the flop (the blinds included) and ${flop} on the flop: ${answer}.`,
    },
    revealWidget: "The calculator, on these numbers:",
    cards: { flop: "Flop", board: "Board", you: "You", opponent: "Opponent" },
    inputLabel: (unit: string) => (unit ? `Your answer (${unit})` : "Your answer"),
    invalid: "Enter a number.",
    optionsTable: {
      option: "Option",
      freq: "Reference frequency",
      ev: "EV",
      chosen: "Played",
    },
  },

  classify: {
    questions: {
      texture: {
        suits: "How many suits does this flop show?",
        pairing: "Is the flop paired?",
        connectedness: "How connected is this flop?",
        "high-card": "What is the flop's top card class?",
      } as Record<string, string>,
      dynamism: "Is this flop static, dynamic, or in between?",
      "hand-class": "Where does your hand sit on this flop?",
      "range-advantage": "Button open against a big-blind call: on this flop, is the opener clearly ahead, or is it close?",
      "nut-advantage": "UTG open against a big-blind call: the opener holds more of the strongest hands. Is that lead big or small here?",
      "turn-card": "Button open against a big-blind call. Does this turn card help the opener, the caller, or neither?",
      "profile-read": "What does this stat support, by the rule your own pool section uses?",
    },
    profileStat: (made: number, chances: number, value: string) =>
      `An opponent folded to ${made} of ${chances} flop c-bets (${value}). These are a drill's numbers, not anyone's real statistics.`,
    buckets: {
      texture: {
        rainbow: "Rainbow (three suits)",
        "two-tone": "Two-tone",
        monotone: "Monotone",
        unpaired: "Unpaired",
        paired: "Paired",
        disconnected: "Disconnected",
        "semi-connected": "Semi-connected",
        connected: "Connected",
        ace: "Ace-high",
        broadway: "Broadway (T–K high)",
        middle: "Middling (7–9 high)",
        low: "Low (6 high or lower)",
      } as Record<string, string>,
      dynamism: { static: "Static", medium: "In between", dynamic: "Dynamic" } as Record<string, string>,
      "hand-class": {
        strong: "Two pair or better",
        top: "Top pair or an overpair",
        middle: "A lesser pair",
        draw: "A strong draw, no pair",
        air: "Air or a weak draw",
      } as Record<string, string>,
      "range-advantage": { raiser: "The opener is clearly ahead", close: "Close" } as Record<string, string>,
      "nut-advantage": { big: "Big lead", small: "Small lead" } as Record<string, string>,
      "turn-card": { raiser: "The opener", neutral: "Neither", caller: "The caller" } as Record<string, string>,
      "profile-read": {
        overfolds: "Folds more than a half-pot bluff needs",
        underfolds: "Folds less than a third-pot bluff needs",
        "no-read": "No read yet",
      } as Record<string, string>,
    },
    detail: {
      volatility: (value: string) => `Volatility ${value}: the share of next cards that change the board.`,
      straights: (count: number) => `${count} two-card straight holdings.`,
      equity: (value: string) => `The opener's range equity on this flop: ${value}.`,
      nuts: (raiser: string, caller: string) => `In the top 10% of hands: opener ${raiser}, caller ${caller}.`,
      shift: (before: string, after: string) => `The opener's range equity: ${before} on the flop, ${after} with this turn.`,
      made: (made: string) => `You have: ${made}.`,
      profile: (value: string, margin: string, above: string, below: string) =>
        `${value} ± ${margin} (the 95% interval). A half-pot bluff needs ${above} folds, a third-pot bluff ${below}. A read needs the whole interval past one of those lines, and at least 30 chances with an interval no wider than ± 10 points.`,
    },
    madeHand: {
      "straight-flush": "a straight flush",
      quads: "four of a kind",
      "full-house": "a full house",
      flush: "a flush",
      straight: "a straight",
      set: "a set",
      trips: "trips",
      "two-pair": "two pair",
      overpair: "an overpair",
      "top-pair": "top pair",
      "pocket-pair-below-top": "a pocket pair below the top card",
      "second-pair": "second pair",
      "weak-pair": "a weak pair",
      underpair: "an underpair",
      "ace-high": "ace high",
      "high-card": "no pair",
      board: "the board",
    } as Record<string, string>,
    illustrative: "Illustrative ranges from the concept library, written by hand for teaching.",
  },

  lab: {
    presets: {
      overfold: "Folds too much to river bets",
      station: "Calls river bets too much",
      passive: "Never raises a river bet",
      underbluff: "Rarely bluffs the river",
      maniac: "Bluffs the river a lot",
    } as Record<string, string>,
    lockLine: {
      "fold-to-bet": (shift: string) => `Locked: the opponent folds ${shift} points to your river bets compared with Rail's solve, at every size.`,
      "never-raise": () => "Locked: the opponent never raises your river bets.",
      "air-bets": (share: string) => `Locked: the opponent bets ${share} of its air (no pair, ace-high, missed draws) when first to act on the river.`,
    } as Record<string, (value: string) => string>,
    lockAt: (where: string, eq: string, locked: string) => `${where} — Rail's solve: ${eq}; locked: ${locked}.`,
    lockWhat: {
      "fold-to-bet": "folds",
      "never-raise": "raises",
      "air-bets": "air that bets",
    } as Record<string, string>,
    first: "First to act",
    action: (kind: string, sizePot: number) =>
      kind === "allin"
        ? "All-in"
        : kind === "bet"
          ? `Bet ${Math.round(sizePot * 100)}%`
          : kind === "raise"
            ? `Raise ${Math.round(sizePot * 100)}%`
            : (({ fold: "Fold", check: "Check", call: "Call" }) as Record<string, string>)[kind] ?? kind,
    preset: "The read",
    value: {
      "fold-to-bet": "Folds compared with the solve",
      "never-raise": "Raises",
      "air-bets": "Air that bets",
    } as Record<string, string>,
    run: "Lock and solve",
    another: "Another river",
    running: "Solving the river and the best response…",
    numbers: "What the read is worth, in bb per river from these ranges",
    gain: "Gain over Rail's baseline against this opponent",
    riskEq: "Cost if the opponent really plays like the solve",
    riskCounter: "Cost if the opponent sees it and counters",
    baselineRisk: "The baseline's own cost against its counter",
    ofPot: (bb: string, pct: string) => `${bb} (${pct} of the pot)`,
    viewTitle: (steps: string) => `Your decision: ${steps}`,
    category: "Your hands",
    baseline: "Rail's solve",
    response: "Best response",
    overall: "Whole range",
    question: (category: string) => `You hold this hand (${category}). Against this opponent, what does the best response do?`,
    railAnswer: (eq: string, best: string) => `Rail's solve plays it ${eq}; against the lock the best response plays it ${best}.`,
    evLine: "EV against the locked opponent, per action:",
    tolerance: (pct: string) => `An answer counts as right within ${pct} of the pot of the best action.`,
    note: (iterations: string, exploitability: string) =>
      `From a river solve on demand (the charts' ranges narrowed on the flop and turn by Rail's heuristic model; bets of 33%, 75% and 150% of the pot and all-in; ${iterations} iterations, within ${exploitability}% of the pot). The opponent keeps the solve's strategy everywhere except the lock; you best-respond everywhere. Values are your expectation over every deal of both ranges at the start of the river.`,
    none: "Rail found no river this read changes. Try another river or another read.",
  },

  pool: {
    title: "Your own pool",
    intro: "Your opponents' tendencies from your own hands, summed over the opponents panel, with how many chances each stat had and the 95% interval that sample allows.",
    signIn: "Sign in, and keep opponent statistics in Statistics → Opponents, to see your own pool here.",
    noDatabase: "This copy of Rail has no database, so it has no opponent statistics to show.",
    loading: "Reading your opponent statistics…",
    failed: (message: string) => `Could not read your opponent statistics: ${message}`,
    none: "No opponent statistics yet. Turn them on in Statistics → Opponents (rooms that hide names across sessions are left out), then come back.",
    opaque: (rows: string) => `${rows} opponent rows from rooms whose names do not survive a session are left out.`,
    summary: (players: string, hands: string) => `${players} opponents, ${hands} hands with them.`,
    capped: (players: string) => `Only your ${players} most-seen opponents are summed.`,
    stats: {
      vpip: "Put money in preflop",
      pfr: "Raised preflop",
      threeBet: "3-bet",
      foldToThreeBet: "Folded to a 3-bet",
      cbet: "C-bet the flop",
      foldToCbet: "Folded to a flop c-bet",
      wtsd: "Went to showdown",
      wsd: "Won at showdown",
      aggression: "Bet or raised (postflop decisions)",
    } as Record<string, string>,
    value: (value: string, margin: string, n: string) => `${value} ± ${margin} over ${n} chances`,
    levels: {
      thin: "not enough data",
      rough: "a rough read",
      settled: "settled",
    } as Record<string, string>,
    noChances: "no chances yet",
    needed: (n: string) => `About ${n} chances for ± 5 points.`,
    read: {
      above: (stat: string, size: string, needs: string) =>
        `Your pool's ${stat} interval sits wholly above the ${needs} folds a ${size}-pot bluff needs. Practise against it in the lab:`,
      below: (stat: string, size: string, needs: string) =>
        `Your pool's ${stat} interval sits wholly below the ${needs} folds a ${size}-pot bluff needs. Practise against it in the lab:`,
    } as Record<string, (stat: string, size: string, needs: string) => string>,
    noRead: "Nothing here clears its interval yet: play the baseline, and let the sample grow before you lean on a read.",
    lessonLink: (title: string) => `Lesson: ${title}`,
  },

  sampleSize: {
    stat: "The stat",
    chances: "Chances it was counted over",
    margin: "95% interval",
    range: "Plausible range",
    needed: "Chances for ± 5 points",
    count: (n: string) => `${n} chances`,
  },

  ownHands: {
    intro: "Your own analysed decisions in this spot, the costliest first. Decide before you see what you did and what Rail's reference says.",
    signIn: "Sign in to practise on your own hands.",
    none: "No analysed decisions of yours match this lesson yet. Upload and analyse hands, then come back.",
    loading: "Finding your hands…",
    question: "What would you do?",
    youPlayed: (move: string, grade: string) => `You played ${move} (${grade}).`,
    open: "Open the hand",
    reviewOnly: "Flagged, not graded: open it and look at the decision again.",
    approximate: "Practice, approximate: some of these grades are heuristic or rest on Rail's narrowing model.",
    done: (count: number) => (count === 1 ? "1 hand reviewed." : `${count} hands reviewed.`),
  },

  review: {
    heading: "Review",
    intro:
      "Quiz items you missed in lessons come back here on a spaced-repetition schedule (the same one the mistake drills use), mixed across lessons.",
    due: (count: number) => (count === 1 ? "1 card due now" : `${count} cards due now`),
    empty: "Nothing is due. Missed items from lessons appear here when they are due again.",
    done: "That was every card due. Well done.",
    backIn: (days: number) => (days === 1 ? "Back tomorrow." : `Back in ${days} days.`),
    backSoon: "Back in ten minutes.",
    fromLesson: (title: string) => `From: ${title}`,
    loading: "Loading your cards…",
    stale: "This card's item could not be rebuilt and was skipped.",
  },

  plan: {
    task: (title: string) => `Lesson: ${title}`,
    open: "Open the lesson",
  },

  mixed: {
    skip: "Skip",
    new: "New",
    review: "Review",
  },

  placement: {
    heading: "Placement test",
    intro:
      "Already play some of these spots well? Take a short mixed test on one track: a few items from each of its modules, dealt and graded exactly as the lessons deal and grade them. A module you pass is marked “tested out”: a status of its own, not “mastered”, so the lessons stay open for you whenever you want them.",
    pick: "Pick a track",
    track: (modules: number, items: number) => `${modules} modules, ${items} items`,
    rules: (perModule: number, share: string, min: number) =>
      `${perModule} items per module, mixed across the track. A module tests out at ${share} of its graded items right, with at least ${min} graded; an item that cannot be dealt can be skipped and does not count against you.`,
    start: (track: string) => `Take the test: ${track}`,
    resultTitle: "How it went",
    module: (code: string, name: string, correct: number, graded: number) => `${code} ${name}: ${correct} of ${graded} right`,
    testedOut: (lessons: number) => (lessons === 1 ? "tested out: 1 lesson marked" : `tested out: ${lessons} lessons marked`),
    already: "tested out — its lessons were already passed or tested out",
    notYet: "not tested out — start here:",
    tooFew: "too few graded items to judge",
    recorded: "Saved to your account.",
    recordedLocal: "Saved in this browser.",
    again: "Take another track",
    signedOut: "Signed out, your results are kept in this browser only.",
  },

  capstone: {
    heading: (code: string) => `Module ${code} review`,
    intro: (count: number) =>
      `${count} items mixed across this module's lessons: a spot from one lesson, a sum from another. Telling which idea a spot asks for is half of it. Missed items join your review cards; the score is not kept.`,
    start: "Start the review",
    result: (correct: number, graded: number) => `${correct} of ${graded} right.`,
    again: "Another review",
    empty: "No lesson of this module has practice Rail can deal here yet.",
  },

  dose: {
    heading: "Today's five minutes",
    intro: "A few review cards that are due and one new item from the lesson Rail points you to: the smallest useful daily habit.",
    plan: (reviews: number, lesson: string | null) =>
      `${reviews === 1 ? "1 review card" : `${reviews} review cards`}${lesson ? ` and 1 new item from “${lesson}”` : ""}.`,
    nothing: "Nothing is due and every lesson is done. Come back tomorrow.",
    start: "Start",
    loading: "Getting today's items…",
    done: (correct: number, graded: number) => `Done for today: ${correct} of ${graded} right.`,
    doneToday: "Done for today. Your next dose is ready tomorrow.",
    again: "Do another",
  },

  examples: {
    heading: "Example hands",
    intro: "Examples come from two places only: your own analysed hands in this lesson's spots, and a hand Rail deals and grades itself. Never a hand from outside Rail.",
    ownTitle: "From your own hands",
    signIn: "Sign in, with analysed hands, to see examples from your own play here.",
    find: "Find my examples",
    loading: "Looking through your analysed hands…",
    failed: (message: string) => `Could not read your hands: ${message}`,
    none: "No graded decision of yours in this lesson's spots yet.",
    costliest: "Your costliest decision here",
    perfect: "A clean Perfect of yours here",
    spot: (street: string, position: string | null) => (position ? `${street}, ${position}` : street),
    show: "Show why",
    open: "Replay it to this decision",
    whyMistake: (taken: string, reference: string, loss: string, pot: string | null, grade: string) =>
      `You played ${taken} (${grade}). Rail's reference prefers ${reference}; the difference cost ${loss}${pot ? `, ${pot} of the pot` : ""}.`,
    whyPerfect: (taken: string, freq: string, next: string, margin: string) =>
      `You played ${taken}, which Rail's reference plays ${freq} of the time here. The next best option, ${next}, gives up ${margin}: this is where getting it right paid.`,
    scriptedTitle: "A hand Rail deals",
    scriptedIntro: "Rail scripts this hand from the lesson's own practice, always the same one, and grades it with the analysis. Decide first, then read Rail's verdict.",
    deal: "Deal it",
  },
} as const;
