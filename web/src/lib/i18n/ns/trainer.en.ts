/**
 * Strings for the Trainer (`components/trainer`), English. Spread into
 * `en.ts` as `trainer`; `trainer.hr.ts` is the same shape.
 *
 * Plain data and functions, like `solver.en.ts`: the desktop app takes this
 * file in place through its trainer door (`app/src/trainer/door.ts`), so it
 * may import only other plain word files. `words` are the analysis' own
 * (the grades, the option labels, the *why* sentences, the leak names), so a
 * trainer answer reads exactly like the same decision in a real hand.
 */

import { analysisEn } from "./analysis.en";
import { leaksEn } from "./analysisLeaks.en";
import { courseEn } from "./course.en";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Big blinds, to one decimal when there is one. */
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};
const pct = (value: number) => `${num(Math.round(value * 100))}%`;

export const trainerEn = {
  modesLabel: "What to practise",
  modes: {
    focus: "For you",
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
  } as Record<string, string>,
  modeHints: {
    focus: "Spots picked from your own leaks, costliest first",
    preflop: "Charts: open, defend, 3-bet, 4-bet",
    flop: "Heads-up flops from Rail's flop library",
    turn: "A turn solved on the spot",
    river: "A river solved on the spot",
  } as Record<string, string>,

  settings: "Settings",
  settingsTitle: "Trainer settings",
  close: "Close",
  reset: "Reset",
  sections: { spot: "Spot", play: "Training", show: "Show" },
  table: "Table",
  tableValue: (players: number, stack: number, straddle = false, ante = false) =>
    `${players === 2 ? "Heads-up" : `${players}-max`} ${num(stack)}bb${straddle ? " straddle" : ante ? " ante" : ""}`,
  family: "Situation",
  families: {
    random: "Any",
    rfi: "First in",
    "vs-open": "vs open",
    "vs-3bet": "vs 3-bet",
    squeeze: "Squeeze",
    bvb: "Blind vs blind",
    "vs-limp": "vs limp",
    "vs-4bet": "vs 4-bet",
  } as Record<string, string>,
  hero: "You",
  vs: "Against",
  any: "Any",
  pot: "Pot",
  pots: { any: "Any", srp: "Single-raised", "3bp": "3-bet", limped: "Limped" } as Record<string, string>,
  side: "Position",
  sides: { any: "Any", ip: "In position", oop: "Out of position" } as Record<string, string>,
  role: "Preflop",
  roles: { any: "Any", pfr: "You raised", caller: "You called" } as Record<string, string>,
  facing: "Facing",
  facings: { any: "Any", check: "Check", bet: "Bet", raise: "Raise" } as Record<string, string>,
  line: "Line",
  deal: "Hands",
  deals: { range: "As the range holds them", borderline: "Mostly close decisions" } as Record<string, string>,
  pause: "After an answer",
  pauses: { always: "Always wait", mistakes: "Wait only after a mistake" } as Record<string, string>,
  strategy: "Strategy for your hand",
  facts: "Hand facts",
  on: "On",
  off: "Off",

  rangePanel: "Range while answering",
  ranges: { range: "Range only", strategy: "Range and strategy" } as Record<string, string>,
  rangeHeading: "Your range here",
  rangeLoading: "Reading the range…",
  rangeNone: "No range for this spot.",
  timebankLabel: "Time to answer",
  timebanks: { "0": "No clock", "7": "7 s", "15": "15 s", "25": "25 s" } as Record<string, string>,
  timeLeft: (seconds: number) => `${num(seconds)} s`,
  timeUp: "Out of time",
  buttonsLabel: "Buttons",
  buttonsValues: { all: "Every size", simple: "One per action" } as Record<string, string>,
  simpleBet: "Bet",
  simpleRaise: "Raise",
  inputLabel: "Answer with",
  inputs: { action: "One action", frequency: "A mix of actions" } as Record<string, string>,
  mixSubmit: "Answer",
  mixHint: "Split 100% across the actions: how often you would take each.",
  mixAccuracy: (share: number) => `Accuracy ${pct(share)}`,
  mixYours: "You",
  mixRef: "Solver",
  tablesLabel: "Tables",
  tablesNote: "One spot each; keys go to the first table waiting for an answer.",
  drills: {
    heading: "My drills",
    none: "No saved drills yet.",
    name: "Name",
    placeholder: "e.g. BB vs BTN, flop, facing a bet",
    save: "Save these settings",
    remove: (name: string) => `Delete ${name}`,
    open: (name: string) => `Open ${name}`,
  },
  history: {
    heading: "Recent answers",
    none: "Answers you give are kept here, on this computer.",
  },
  dealing: "Dealing…",
  solving: "Solving…",
  loadingFlop: "Loading the flop…",
  grading: "Grading…",
  noSpot: "No spot matches these settings. Loosen one and try again.",
  unavailable: {
    flop: "Flop spots need a flop library solved on the GTO Wizard ranges; there is none yet.",
    set: "This table is not transcribed from GTO Wizard yet: nothing to deal from it. Pick another table in the settings.",
  },
  failed: (message: string) => `Something went wrong: ${message}`,
  retry: "Try again",

  potOf: (value: number) => `Pot ${bb(value)}`,
  /** Lost EV, signed: "−4.20 bb", "0.00 bb". */
  lostBb: (value: number) => `${value > 0 ? "−" : ""}${num(value, 2)} bb`,
  toCall: (value: number) => `${bb(value)} to call`,
  stack: (value: number) => `${bb(value)} behind`,
  yourMove: "Your move",
  board: { flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,

  next: "Next hand",
  autoNext: "Next hand in a moment…",
  stay: "Stay",
  you: (label: string) => `You: ${label}`,
  best: (label: string) => `Best: ${label}`,
  evLost: (value: number) => `−${num(value, 2)} bb`,
  noLoss: "No EV lost",
  inStrategy: (share: number) => `played ${pct(share)} of the time`,
  notInStrategy: "never played here",
  strategyHeading: "What the solver does with this hand",
  evHeading: "EV",
  whyHeading: "Why",
  factsHeading: "Your hand here",
  fact: {
    equity: "Equity vs range",
    potOdds: "Pot odds",
    mdf: "Must defend",
    spr: "SPR",
    made: "Made hand",
    draws: "Draws",
    blockers: "Blockers",
  },
  ruleOfThumb: "Rule of thumb",
  principles: {
    rfi: "First in, the fewer players left behind you, the wider you open: from the early seats only hands that stay strong against several ranges, from the button and the small blind far more. Suited, connected hands and pairs open before offsuit hands of the same rank, because they make strong hands and play well after the flop.",
    "vs-open": "Facing an open, the reference mostly 3-bets or folds and calls with a narrower band: hands that play well after the flop, more of them in position. Every seat still behind you can squeeze, and a flat call leaves you with a capped range.",
    "vs-open-sb": "The small blind plays close to 3-bet or fold: a call is out of position for the whole hand, invites the big blind to squeeze, and closes nothing. 3-bet the hands that want a pot and the ones that block the opener's best hands; let the rest go.",
    "vs-open-bb": "The big blind already has a blind in and closes the action: the price is good and no one can squeeze behind, so it defends wide, mostly by calling. Fold only what cannot realise its equity out of position; 3-bet the top and some suited blockers.",
    "vs-3bet": "Against a 3-bet, continue with hands that beat the 3-bettor's value or play well as a call (pairs, suited broadways, suited connectors in position). 4-bet the strongest and a few hands with an ace or king blocker; fold the offsuit hands that are dominated.",
    squeeze: "With an open and a caller in front, squeeze tighter than a plain 3-bet but polarised: strong hands for value and a few blockers as bluffs. The caller's range is capped and the opener is squeezed between two players, so the pot is often yours right away.",
    bvb: "Blind against blind the ranges are the widest of the game: nobody is left behind, so the small blind attacks with many hands and the big blind, in position, defends a lot. Hand strength matters less than position and playability here.",
    "vs-limp": "Against limpers, raise to isolate with hands that do well heads-up and in position; overlimp suited and connected hands that like a multiway pot; fold the offsuit hands that need fold equity you do not have.",
    "vs-4bet": "Facing a 4-bet, only the top of your range continues: jam the premium pairs and ace-king, call with the few hands that play well deep, and fold the rest, including most hands you 3-bet as bluffs.",
    "flop-cbet": "As the preflop raiser you usually hold the stronger range: on dry, high boards a small bet with most of your range wins a lot; on low, connected boards that hit the caller, check more and bet bigger with a polarised range.",
    "flop-check-to-raiser": "Out of position against the preflop raiser, check almost your whole range: the raiser has more strong hands on most flops. Leading out only makes sense on boards that clearly favour your range.",
    "flop-vs-bet": "Against a flop bet, defend enough that bluffs do not profit automatically (see minimum defence), with hands that can keep going on the turn: pairs, draws and good backdoors. Raise your strongest hands and your best draws; fold the hands with nothing to improve to.",
    "flop-vs-raise": "A flop raise is strong and polarised: continue with strong made hands and draws that can win big, and fold the one-pair hands that only beat bluffs.",
    "turn-barrel": "On the turn, keep betting on cards that improve your range (overcards, cards that complete draws you represent) and with hands that have equity; give up with air that missed. Value hands keep betting.",
    "turn-first": "As the caller on the turn, check most of your range to the raiser; bet out when the turn card shifts the advantage to you (it completes draws you call with, pairs low cards you hold).",
    "turn-vs-bet": "Facing a turn bet, the price and your equity still matter, but a draw has one card left: call with made hands that are ahead of enough bluffs and draws that get there often or get paid when they do.",
    "river-first": "On the river there is no more equity to fight for: bet for value with hands that worse hands call, bluff with hands that cannot win at showdown (best if they block the hands that call), and check the middle.",
    "river-vs-bet": "Facing a river bet you are a bluff-catcher: call when your hand beats enough of the bettor's bluffs to cover the pot odds. The best bluff-catchers block the bettor's value and do not block the bluffs.",
    "river-vs-raise": "River raises are rarely bluffs in practice and in theory are very polarised: continue with the hands near the top of your range and fold the rest.",
  } as Record<string, string>,
  notGraded: (reason: string) => `This answer could not be graded: ${reason}.`,
  learnMore: "Read more",

  play: {
    label: "How much of the hand",
    spot: "One spot",
    hand: "Whole hand",
    continue: "Continue",
    thinking: "The opponent is thinking…",
    starting: "Dealing a hand…",
    noHand: "No hand matches these settings. Loosen one and try again.",
    won: (bb: number) => `You won ${num(bb, 1)} bb`,
    lost: (bb: number) => `You lost ${num(bb, 1)} bb`,
    even: "You broke even",
    split: "Split pot",
    villainFolded: "The opponent folded",
    heroFolded: "You folded",
    showdown: "Showdown",
    noReference: "Rail has no reference for your next decision here, so the hand stops.",
    approximate: "Somewhere the opponent had no reference and checked or called instead.",
    summary: "This hand",
    evLostTotal: (bb: number) => `EV lost over the hand: ${num(bb, 2)} bb`,
    vs: (hero: string, villain: string) => `${hero} vs ${villain}`,
  },
  focus: {
    working: "Working on",
    costs: (per100: number) => `costs you ${num(per100, 2)} bb/100`,
    yourMistake: (taken: string, best: string) => `you ${taken} where ${best} is right`,
    nextArea: "Next leak",
    none: "No leaks in your analysed hands yet that the trainer can deal. Practising the spots most players misplay.",
    signIn: "Sign in and analyse your hands: the trainer then deals the spots where you lose the most.",
    loading: "Reading your leaks…",
    general: "Spots most players misplay",
  },

  session: {
    label: "This session",
    answers: "Hands",
    accuracy: "Correct",
    streak: "Streak",
    best: "Best",
    evLost: "EV lost",
    reset: "Reset",
  },
  keys: "Keys: 1–6 answer · F fold · C call / check · A all-in · N next · S settings",

  /** The analysis' own words, so a trainer answer reads like a graded decision of a real hand. */
  words: {
    grades: analysisEn.grades,
    option: analysisEn.sheet.option,
    chartAction: analysisEn.charts.action,
    explain: analysisEn.explain,
    reasons: analysisEn.reasons,
    handFacts: analysisEn.handFacts,
    lineName: courseEn.spot.lineName,
    leakTitle: leaksEn.title,
    leakContext: leaksEn.fullContext,
    leakActions: leaksEn.actions,
  },
};
