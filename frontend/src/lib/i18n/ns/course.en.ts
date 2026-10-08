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
  "facing-river-raises": "River raises and leads",
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
    statusLabel: "Status",
    status: {
      "not-started": "Not started",
      "in-progress": "In progress",
      mastered: "Mastered",
    } as Record<string, string>,
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
    conceptual: "Conceptual: Rail does not analyse this spot yet, so this lesson teaches the idea without a graded drill.",
    "straddle-not-analysed": "Rail does not analyse straddled pots yet: there are no straddle charts, so this is taught in words.",
  } as Record<string, string>,

  exerciseKinds: {
    "chart-quiz": "Preflop spots dealt from Rail's charts, graded as the analysis grades your hands",
    "solver-spot": "Postflop spots solved on the spot by Rail's solver",
    calc: "Numbers to work out before the calculator shows them",
    classify: "Boards and hands to sort, graded by Rail's board and hand reader",
    "own-hands": "Your own analysed hands in this spot",
    "range-split": "Sorting a whole range's hand classes into actions, graded by Rail's solve per class",
    "depth-split": "Sorting hand classes at 200bb against 100bb (planned)",
    "range-paint": "Painting a range on the 13×13 grid (planned)",
    "range-walk": "Guessing a range street by street on your own hand (planned)",
    "pot-tracking": "Keeping track of the pot in a live-style hand (planned)",
    "profile-quiz": "Naming player types from their stats (planned)",
    "node-lock": "Locking an opponent's strategy in the solver and reading the best response (planned)",
    placement: "A placement test (planned)",
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
      "range-paint": "Planned: paint a 13×13 range and be scored against Rail's chart.",
      "range-walk": "Planned: replay one of your hands and guess the opponent's range on each street, then compare with Rail's narrowing.",
      "pot-tracking": "Planned: a live-style hand where you keep track of the pot.",
      "profile-quiz": "Planned: name your opponents' types from their stats.",
      "node-lock": "Planned: lock an opponent's frequency at one decision, re-solve it with Rail's solver, and compare the best response with the baseline.",
      placement: "Planned: a short placement test that suggests where to start.",
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
      street === "turn"
        ? "Your whole range is here on the turn. Put each hand class where you think Rail's solve mostly plays it."
        : "Your whole range is here on the flop. Put each hand class where you think Rail's solve mostly plays it.",
    groups: { check: "Check", small: "Small bet", big: "Big bet", fold: "Fold", call: "Call", raise: "Raise" } as Record<string, string>,
    you: "You",
    first: (street: string) => (street === "turn" ? "You are first to act on the turn." : "You are first to act on the flop."),
    step: (who: string, kind: string, sizePot: number) =>
      kind === "check"
        ? `${who} checks.`
        : kind === "call"
          ? `${who} calls.`
          : kind === "allin"
            ? `${who} goes all-in.`
            : `${who} ${kind === "raise" ? "raises" : "bets"} ${Math.round(sizePot * 100)}% of the pot.`,
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
    },
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
    },
    detail: {
      volatility: (value: string) => `Volatility ${value}: the share of next cards that change the board.`,
      straights: (count: number) => `${count} two-card straight holdings.`,
      equity: (value: string) => `The opener's range equity on this flop: ${value}.`,
      nuts: (raiser: string, caller: string) => `In the top 10% of hands: opener ${raiser}, caller ${caller}.`,
      shift: (before: string, after: string) => `The opener's range equity: ${before} on the flop, ${after} with this turn.`,
      made: (made: string) => `You have: ${made}.`,
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
} as const;
