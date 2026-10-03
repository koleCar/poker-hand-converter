/**
 * Strings for the Analysis tab and the replayer's Analysis sheet, English.
 * Spread into `en.ts` as `analysis`; `analysis.hr.ts` is the same shape.
 *
 * ## The explanations are templates, not prose
 *
 * `docs/ANALYSIS-PLAN.md` §4: every decision gets a short *why*, built only
 * from facts the engine computed (`SpotFacts`, the flags and their params).
 * `explain()` below turns one decision into sentences, keyed by flag, street
 * and reason. Templates rather than free text because they are testable, they
 * translate, and they cannot invent a reason the numbers do not support: every
 * number in a sentence is a number in the record.
 *
 * The engine's vocabulary (`top-pair`, `two-tone`, `vs-3bet`) is mapped to
 * words here and nowhere else, so the stored record stays language-free.
 */

import { betterAlternative, modelCaveat, outOfRange, referenceMix } from "../../analysis/reference";
import type { DecisionAnalysis, Flag, OptionAnalysis, SpotFacts } from "../../analysis/types";
import { reportsEn } from "./analysisReports.en";
import { leaksEn, progressEn, summaryEn } from "./analysisLeaks.en";
import { trainEn } from "./analysisTrain.en";
import { shareEn } from "./analysisShare.en";
import { planEn } from "./analysisPlan.en";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;
const decisions = (count: number) => `${num(count)} ${count === 1 ? "decision" : "decisions"}`;
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
/** A share to one decimal under 10%, whole above: "4.5%", "52%". */
const pct1 = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}%` : `${num(Math.round(p))}%`;
};
/** An EV, signed, to two decimals: "+1.25 bb", "−0.40 bb", "0.00 bb". */
const signedBb = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${num(Math.abs(rounded), 2)} bb`;
};
/** Big blinds, to one decimal when there is one: "2.5 bb", "37 bb", "152.5 bb". */
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};

const streets = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>;
const streetsLower = { preflop: "preflop", flop: "on the flop", turn: "on the turn", river: "on the river" } as Record<
  string,
  string
>;

const made = {
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
  board: "the board (you play it)",
} as Record<string, string>;

const kicker = { top: "top kicker", good: "a good kicker", weak: "a weak kicker" } as Record<string, string>;

const draws = {
  "flush-draw": "a flush draw",
  "nut-flush-draw": "the nut flush draw",
  oesd: "an open-ended straight draw",
  gutshot: "a gutshot",
  "backdoor-flush": "a backdoor flush draw",
  "backdoor-straight": "a backdoor straight draw",
  overcards: "two overcards",
} as Record<string, string>;

const blockers = {
  "nut-flush": "the nut flush",
  "second-nut-flush": "the second-nut flush",
  "nut-straight": "the nut straight",
  "top-pair": "top pair",
  set: "sets",
} as Record<string, string>;

const preflopScenarios = {
  unopened: "Unopened pot",
  "vs-limp": "Facing limpers",
  "bb-option": "Big blind option",
  "vs-open": "Facing an open",
  squeeze: "Squeeze spot",
  "vs-3bet": "Facing a 3-bet after opening",
  "vs-3bet-cold": "Facing a 3-bet, cold",
  "vs-4bet": "Facing a 4-bet or more",
} as Record<string, string>;

const roles = { pfr: "Preflop raiser", caller: "Preflop caller", limped: "Limped pot" } as Record<string, string>;
const facing = { first: "first to bet", "vs-bet": "facing a bet", "vs-raise": "facing a raise" } as Record<string, string>;

/** "Preflop raiser, in position, facing a bet" / "Facing an open". */
function scenarioLabel(facts: Pick<SpotFacts, "preflopScenario" | "role" | "facing" | "inPosition" | "scenario">): string {
  if (facts.preflopScenario) return preflopScenarios[facts.preflopScenario] ?? facts.scenario;
  const where = facts.inPosition === null ? "" : facts.inPosition ? ", in position" : ", out of position";
  return `${roles[facts.role ?? ""] ?? facts.scenario}${where}, ${facing[facts.facing ?? ""] ?? ""}`.replace(/, $/, "");
}

/** "open:BTN" → "a BTN open". */
const lines = {
  open: (pos: string) => `a ${pos} open`,
  iso: (pos: string) => `an isolation raise from ${pos}`,
  limp: (pos: string) => `a ${pos} limp`,
  call: (pos: string) => `a ${pos} call`,
  "3bet": (pos: string) => `a ${pos} 3-bet`,
  "call-3bet": (pos: string) => `a ${pos} call of a 3-bet`,
  "4bet": (pos: string) => `a ${pos} 4-bet`,
  "call-4bet": (pos: string) => `a ${pos} call of a 4-bet`,
  check: (pos: string) => `a ${pos} check`,
  unknown: () => "any two cards",
} as Record<string, (pos: string) => string>;

function rangeLabel(key: string): string {
  const [line, position] = key.split(":");
  const label = lines[line] ?? lines.unknown;
  return label(position && position !== "?" ? position : "seat");
}

const gradeWords = {
  perfect: "Perfect",
  good: "Good",
  inaccurate: "Inaccurate",
  mistake: "Mistake",
  blunder: "Blunder",
} as Record<string, string>;

/** "raise to 2.5 bb", "bet 3.1 bb (33%)", "call", "all-in": one option as a player says it. */
function optionLabel(option: OptionAnalysis): string {
  if (option.allIn) return "all-in";
  // A preflop call to one big blind is a limp (charts/4 has them from every seat).
  if (option.action === "call" && option.sizeBb === 1) return "limp";
  if (option.action === "bet" && option.sizeBb !== undefined && option.sizePot !== undefined) {
    return `bet ${bb(option.sizeBb)} (${pct(option.sizePot)})`;
  }
  if (option.action === "raise" || option.action === "bet") {
    return option.sizeBb !== undefined ? `${option.action} to ${bb(option.sizeBb)}` : option.action;
  }
  return option.action;
}

/** "raise to 2.5 bb 60% and call 40%". */
function mixLabel(decision: DecisionAnalysis): string {
  return list(referenceMix(decision).map(({ option }) => `${optionLabel(option)} ${pct(option.freq)}`));
}

/**
 * Why a preflop decision has no chart grade, as the end of "Not graded: …".
 * Keyed by the lookup's reason (`CHART_SKIP_REASONS`).
 */
const chartReasons = {
  "chart-straddle": "a straddle changes every price, and no chart covers it",
  "chart-ante": "antes are in the pot, and the cash charts have none",
  "chart-players": "the charts cover three to nine players (a smaller table is read with the earliest seats folded); heads-up is not covered",
  "chart-stack-depth": "the effective stack is more than 20% from every chart set's depth (6-max: 40, 60, 100, 150, 200 bb; 9-max: 100, 150, 200 bb)",
  "chart-limp": "someone open-limped, and the charts have no open limp except the small blind's",
  "chart-multiway": "this would be a fifth player in the pot, beyond what the charts model",
  "chart-cold-call": "a cold call of a re-raise is not in the charts' tree",
  "chart-off-tree": "the line left the charts' betting tree",
  "chart-rare-line": "the line is too rare at equilibrium to be in the chart set",
  "chart-action-not-modelled": "your action is not one of the charts' options here",
  "chart-bad-input": "the hand could not be read onto a chart",
  "chart-game": "the charts cover No-Limit Hold'em cash games only",
  "chart-bomb-pot": "a bomb pot has no preflop betting",
  "chart-no-positions": "the button is unknown, so the positions are too",
  "chart-no-hero": "the hero's seat has no position",
  "chart-no-decision": "the decision could not be found on the charts' reading of the hand",
  "chart-unavailable": "the charts were not loaded",
} as Record<string, string>;

/** The grade, said against the reference's options (§4, keyed by grade and source). */
function chartSentences(decision: DecisionAnalysis): string[] {
  if ((decision.source !== "chart" && decision.source !== "solver") || decision.chosen === null || !decision.grade) return [];
  const out: string[] = [];
  const chosen = decision.options[decision.chosen];
  if (!chosen) return out;
  const word = gradeWords[decision.grade] ?? decision.grade;
  const mix = referenceMix(decision);
  const solver = decision.source === "solver";
  const who = solver ? "the solver" : "the reference";
  if (outOfRange(decision)) {
    out.push(
      solver
        ? `Your hand is not in your own range as narrowed to this point; the solver plays it as ${mixLabel(decision)}.`
        : `Your hand is outside the reference range at this node; the reference plays it as ${mixLabel(decision)}.`,
    );
  }
  const plays = mix.length > 1 ? `mixes ${mixLabel(decision)}` : `plays ${mixLabel(decision)}`;
  const better = betterAlternative(decision);
  if (decision.grade === "perfect") {
    out.push(`${word}: you played ${optionLabel(chosen)}; ${who} ${plays} here.`);
  } else if (decision.grade === "good") {
    out.push(`${word}: ${who} plays ${optionLabel(chosen)} ${pct(chosen.freq)} of the time here, and ${plays} overall.`);
  } else {
    const loss = decision.evLoss ?? 0;
    const lossPot = decision.evLossPot ?? 0;
    out.push(
      `${word}: ${who} ${plays}. ${capitalise(optionLabel(chosen))} costs ${bb(loss)} (${pct(lossPot)} of the pot)${
        better ? ` against ${optionLabel(better)}` : ""
      }.`,
    );
  }
  if (decision.approximations.includes("off-tree-size")) {
    out.push(
      solver
        ? `A bet in this ${decision.street === "turn" ? "turn" : "river"} line was far from the solver's sizes, so the grade is capped at Inaccurate.`
        : "A raise in this line was far from the charts' size, so the grade is capped at Inaccurate.",
    );
  }
  if (modelCaveat(decision)) {
    out.push(
      "These charts still under-rate a few hands that win through implied odds — the small pairs, small suited connectors and A5s — and the button's flat of a cutoff open, so read a grade against playing one as a hint, not a verdict.",
    );
  }
  return out;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why a river decision has no solver grade: the end of "Not graded: …". Keyed by `RIVER_SKIP_REASONS`. */
const riverReasons = {
  "river-multiway-flop": "three or more players saw the flop, so there are no two ranges to narrow to the river",
  "river-range-unknown": "a player has no preflop line to start a range from",
  "river-range-empty": "a range was left empty by the cards on the board",
  "river-off-tree": "the river line left the solver's betting tree (more raises than it models)",
  "river-unreached": "the solved strategies almost never take this line with these ranges, so the strategy here is noise",
  "river-solve-failed": "the solver could not take this spot",
} as Record<string, string>;

/** Why a turn decision has no solver grade (A5a). Keyed by `TURN_SKIP_REASONS`. */
const turnReasons = {
  "turn-multiway-flop": "three or more players saw the flop, so there are no two ranges to narrow to the turn",
  "turn-range-unknown": "a player has no preflop line to start a range from",
  "turn-range-empty": "a range was left empty by the cards on the board",
  "turn-off-tree": "the turn line left the solver's betting tree (more raises than it models)",
  "turn-unreached": "the solved strategies almost never take this line with these ranges, so the strategy here is noise",
  "turn-solve-failed": "the solver could not take this spot",
} as Record<string, string>;

/**
 * The turn solve's *why* (A5a): the hand's role against the range it faces
 * (value, a hand that wants protection, a draw, a bluff-catcher, a middling
 * hand, air), equity realisation out of position, the river cards that change
 * the board, the range's shape, and what the solve rests on. Only numbers
 * from `facts.turn` and `facts.texture`.
 */
function turnSentences(decision: DecisionAnalysis): string[] {
  const turn = decision.facts.turn;
  if (decision.source !== "solver" || !turn) return [];
  const out: string[] = [];
  const beats = pct(turn.heroBeats);
  const equity = pct(turn.equity);
  const v = turn.villain;
  switch (turn.role) {
    case "value":
      out.push(`Your hand beats ${beats} of the opponent's range here and stays ahead on most rivers (${equity} equity): a hand that wants the pot to grow.`);
      break;
    case "vulnerable":
      out.push(
        `Your hand is ahead now — it beats ${beats} of the opponent's range — but ${pct(turn.rivers.weak)} of the river cards turn it into a loser. A bet charges the hands that can outdraw you and denies them their equity (protection).`,
      );
      break;
    case "draw":
      out.push(
        `You are behind now — your hand beats ${beats} of the opponent's range — but ${pct(turn.rivers.strong)} of the river cards make it strong: ${equity} equity in all. A draw can bet as a semi-bluff, or call when the price is right.`,
      );
      break;
    case "bluff-catcher":
      out.push(`Facing this bet your hand beats ${beats} of the opponent's range, ${equity} equity with the river to come: ahead of the bluffs and the draws, behind the value.`);
      break;
    case "medium":
      out.push(`A middling hand: it beats ${beats} of the opponent's range, ${equity} equity with the river to come. It wants a cheap showdown more than a big pot.`);
      break;
    case "air":
      out.push(`Your hand has ${equity} equity against the opponent's range here and few rivers help it: it wins mostly by making better hands fold.`);
      break;
  }
  if (decision.facts.inPosition === false && (turn.role === "draw" || turn.role === "medium" || turn.role === "bluff-catcher")) {
    out.push("Out of position you realise less of that equity: you act first on the river, before you see what your opponent does.");
  }
  const texture = decision.facts.texture;
  if (texture && texture.volatility !== null && texture.volatility >= 0.25) {
    out.push(
      `${pct(texture.volatility)} of the river cards change this board — a flush or a straight comes in, or an overcard falls. Those are the cards a bet now sets up a second barrel on, for whichever range holds them.`,
    );
  }
  if (v.shape === "polar") {
    out.push(`The opponent's range here is polarised: ${pct(v.strong)} strong hands and ${pct(v.weak)} weak ones, little in between.`);
  } else if (v.shape === "merged") {
    out.push(`The opponent's range here is merged: ${pct(v.medium)} of it is medium-strength hands.`);
  }
  if (decision.approximations.includes("size-translated")) {
    out.push("A bet size in this turn line was read as the nearest of the solver's sizes (75% of the pot and all-in, raises 75% and all-in, plus the sizes this hand used).");
  }
  if (turn.capped) {
    out.push(
      `On the solver's numbers alone this would be a ${gradeWords[turn.capped] ?? turn.capped}. Ranges narrowed by a heuristic model on the flop cannot carry that verdict, so the grade is capped at Mistake — only a move that loses whatever the opponent holds is called a Blunder.`,
    );
  }
  if (decision.approximations.includes("range-sensitive") && turn.sensitivity) {
    out.push(
      `With the flop's narrowing at full strength the solver grades this ${gradeWords[turn.sensitivity.grade] ?? turn.sensitivity.grade}; at half strength, ${gradeWords[decision.grade ?? ""] ?? decision.grade}. The grade rests on the narrowing more than on your hand, so the milder one is shown.`,
    );
  }
  out.push(
    turn.converged
      ? `Both ranges were narrowed on the flop by a heuristic model; the turn was solved through the river — with one river bet size and all-in below it — to within ${num(turn.exploitabilityPct, 1)}% of the pot.`
      : `Both ranges were narrowed on the flop by a heuristic model, and the turn solve stopped at ${num(turn.iterations)} iterations, ${num(turn.exploitabilityPct, 1)}% of the pot from equilibrium: read close calls loosely.`,
  );
  return out;
}

/**
 * The river solve's *why* (A4): what the hero's hand is against the range it
 * faces, the shape of that range, blockers, and what the solve rests on. Only
 * numbers from `facts.river`.
 */
function riverSentences(decision: DecisionAnalysis): string[] {
  const river = decision.facts.river;
  if (decision.source !== "solver" || !river) return [];
  const out: string[] = [];
  const beats = pct(river.heroBeats);
  const v = river.villain;
  switch (river.role) {
    case "bluff-catcher":
      out.push(
        v.shape === "polar"
          ? `Facing a polar range — ${pct(v.strong)} strong, ${pct(v.weak)} weak, little between — your hand is a bluff-catcher: it beats ${beats} of what gets here.`
          : `Your hand is a bluff-catcher here: it beats ${beats} of the opponent's range at this point, of which ${pct(v.strong)} is strong.`,
      );
      break;
    case "weak":
      out.push(`Your hand beats only ${beats} of the opponent's range at this point — not even most of its bluffs.`);
      break;
    case "value":
      out.push(
        decision.facts.toCallBb > 0
          ? `Your hand beats ${beats} of the opponent's range at this point: ahead of most of what bets.`
          : v.shape === "merged"
            ? `Your hand beats ${beats} of the opponent's range here, and that range is merged (${pct(v.medium)} medium hands): a value bet gets called by worse.`
            : `Your hand beats ${beats} of the opponent's range here: a hand to bet for value.`,
      );
      break;
    case "thin-value":
      out.push(`Your hand beats ${beats} of the opponent's range here: thin value at best — worse hands have to call for a bet to pay.`);
      break;
    case "showdown":
      out.push(`Your hand beats ${beats} of the opponent's range here: enough to want a showdown, rarely enough to bet.`);
      break;
    case "air":
      out.push(`Your hand beats ${beats} of the opponent's range here: it wins only by making better hands fold.`);
      break;
  }
  if (Math.abs(river.blocks.strong - river.blocks.weak) >= 0.05) {
    out.push(`Your cards remove ${pct(river.blocks.strong)} of the opponent's strong combos and ${pct(river.blocks.weak)} of its weak ones.`);
  }
  if (decision.approximations.includes("size-translated")) {
    out.push("Bet sizes in this river line were read as the nearest of the solver's sizes (33%, 75%, 150% of the pot, all-in).");
  }
  if (river.capped) {
    out.push(
      `On the solver's numbers alone this would be a ${gradeWords[river.capped] ?? river.capped}. Ranges narrowed by a heuristic model cannot carry that verdict, so the grade is capped at Mistake — only a move that loses whatever the opponent holds is called a Blunder.`,
    );
  }
  if (decision.approximations.includes("range-sensitive") && river.sensitivity) {
    out.push(
      `With the ranges narrowed at full strength the solver grades this ${gradeWords[river.sensitivity.grade] ?? river.sensitivity.grade}; at half strength, ${gradeWords[decision.grade ?? ""] ?? decision.grade}. The grade rests on the narrowing more than on your hand, so the milder one is shown.`,
    );
  }
  const narrowed =
    river.narrowing === "turn-solver"
      ? "Both ranges were narrowed on the flop by a heuristic model and on the turn by the solved turn strategy"
      : "Both ranges were narrowed on the flop and turn by a heuristic model";
  out.push(
    river.converged
      ? `${narrowed}, and the river was solved to within ${num(river.exploitabilityPct, 1)}% of the pot.`
      : `${narrowed}, and the solve stopped at ${num(river.iterations)} iterations, ${num(river.exploitabilityPct, 1)}% of the pot from equilibrium: read close calls loosely.`,
  );
  return out;
}

function handPhrase(facts: SpotFacts): string {
  if (!facts.made) return facts.handClass ?? facts.holeCards.join("");
  const base = made[facts.made.class] ?? facts.made.class;
  return facts.made.kicker ? `${base} with ${kicker[facts.made.kicker]}` : base;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const textureWords = {
  suits: { rainbow: "rainbow", "two-tone": "two-tone", monotone: "monotone" } as Record<string, string>,
  connectedness: {
    disconnected: "disconnected",
    "semi-connected": "semi-connected",
    connected: "connected",
  } as Record<string, string>,
  dynamism: { static: "static", medium: "medium", dynamic: "dynamic" } as Record<string, string>,
  highCard: { ace: "ace-high", broadway: "broadway", middle: "middling", low: "low" } as Record<string, string>,
};

function textureLabel(facts: SpotFacts): string | null {
  const texture = facts.texture;
  if (!texture) return null;
  const words = [
    textureWords.highCard[texture.highCard],
    texture.trips ? "trips" : texture.paired ? "paired" : null,
    textureWords.suits[texture.suits],
    textureWords.connectedness[texture.connectedness],
    texture.dynamism ? textureWords.dynamism[texture.dynamism] : null,
  ].filter((word): word is string => Boolean(word));
  return words.join(", ");
}

/** One flag as a sentence. Keyed by code; the street picks the variant where it matters. */
function flagSentence(flag: Flag, facts: SpotFacts): string {
  const p = flag.params;
  switch (flag.code) {
    case "fold-nuts":
      return facts.street === "river"
        ? "You folded the nuts: no hand the opponent could hold beats yours on this board."
        : "You folded a hand that cannot lose: no holding and no card to come beats it.";
    case "free-fold":
      return "You folded when checking was free. Folding gave up the pot for nothing; a check keeps every option.";
    case "call-beats-nothing":
      return flag.severity === "inaccurate"
        ? "This call beats nothing: no hand the opponent could hold is worse than yours."
        : `This call beats nothing in ${rangeLabel(String(p.range))} range — its preflop range, before any narrowing.`;
    case "call-without-odds":
      return `The call needed ${num(Number(p.needed))}% equity and your hand had about ${num(Number(p.equity))}% against ${rangeLabel(String(p.range))} range, with no cards to come.`;
    case "fold-with-odds":
      return facts.street === "river"
        ? `The call needed ${num(Number(p.needed))}% and your hand had about ${num(Number(p.equity))}% even against the strongest quarter of ${rangeLabel(String(p.range))} range.`
        : `The call needed ${num(Number(p.needed))}% and your hand had about ${num(Number(p.equity))}% against ${rangeLabel(String(p.range))} range, with nothing left to decide.`;
    case "check-back-nuts":
      return "You checked back the nuts on the river. There can be a reason — a blocker, a merged range — but it is worth a look: nothing here beats a bet.";
    case "thin-stack-behind":
      return `Your bet left ${bb(Number(p.behind))} behind against a ${bb(Number(p.pot))} pot if called: committed in all but name. All-in usually plays the same and gives away less.`;
    case "committed-fold":
      return `You folded with ${num(Number(p.invested))}% of your stack already in, to a price that needed only ${num(Number(p.needed))}% equity.`;
    default:
      return "";
  }
}

/**
 * The *why* for one decision, as sentences: the spot, the price, the equity,
 * the geometry, then each flag. Built only from the record — nothing here
 * computes a number the engine did not.
 */
function explain(decision: DecisionAnalysis): string[] {
  const facts = decision.facts;
  const out: string[] = [];
  if (decision.status === "not-analysed") {
    const chartReason = decision.reason
      ? (chartReasons[decision.reason] ?? riverReasons[decision.reason] ?? turnReasons[decision.reason])
      : undefined;
    out.push(
      decision.reason === "multiway"
        ? "Not analysed: three or more players were still in after the flop, and nothing here models three ranges at once. Saying nothing beats saying something wrong."
        : chartReason
          ? `Not graded: ${chartReason}. Saying nothing beats saying something wrong.`
          : "Not analysed.",
    );
  }

  const spot = scenarioLabel(facts);
  if (facts.street === "preflop") {
    out.push(`${spot} in ${facts.position ?? "your seat"} with ${facts.handClass ?? facts.holeCards.join("")}, ${bb(facts.effStackBb)} effective.`);
  } else {
    const texture = textureLabel(facts);
    const drawText = facts.draws.length > 0 ? `, plus ${list(facts.draws.map((d) => draws[d] ?? d))}` : "";
    out.push(`${streets[facts.street]}: ${spot}. You hold ${handPhrase(facts)}${drawText}${texture ? ` on a ${texture} board` : ""}.`);
  }

  out.push(...chartSentences(decision));
  out.push(...turnSentences(decision));
  out.push(...riverSentences(decision));

  if (facts.potOdds !== null) {
    // MDF is a postflop idea (§4): preflop, folding most hands to an open is
    // simply correct, so it is never quoted there — even from an older row.
    const mdf = facts.mdf !== null && facts.street !== "preflop" ? ` Against this bet the minimum defence is ${pct(facts.mdf)}.` : "";
    out.push(`Calling ${bb(facts.toCallBb)} into ${bb(facts.potBb)} needs ${pct(facts.potOdds)} equity.${mdf}`);
  }
  if (facts.equity) {
    const strong =
      facts.equity.strong !== null && facts.equity.strong !== undefined
        ? ` (${pct(facts.equity.strong)} against its stronger quarter)`
        : "";
    const source = facts.equity.source;
    out.push(
      source === "solver"
        ? `Against ${rangeLabel(facts.equity.range)} range as the solver plays this line to here, your hand wins ${pct(facts.equity.value)} at showdown${strong}.`
        : source === "narrowed"
          ? `Against ${rangeLabel(facts.equity.range)} range, narrowed by the betting so far (a heuristic model), your hand has about ${pct(facts.equity.value)}${strong}.`
          : source === "chart"
            ? `Against ${rangeLabel(facts.equity.range)} range as the charts play it — not narrowed by later betting — your hand has about ${pct(facts.equity.value)}${strong}.`
            : `Against ${rangeLabel(facts.equity.range)} range — a placeholder, not narrowed by later betting — your hand has about ${pct(facts.equity.value)}${strong}.`,
    );
  }
  if (facts.betPot !== null && (decision.action === "bet" || decision.action === "raise")) {
    out.push(`You ${decision.action === "bet" ? "bet" : "raised"} ${pct(facts.betPot)} of the pot${facts.allIn ? ", all in" : ""}.`);
  }
  if (facts.spr !== null && facts.spr <= 3 && facts.street !== "river") {
    out.push(`SPR ${num(facts.spr, 1)}: the stacks are short next to the pot, so the next bet commits them.`);
  }
  if (facts.blockers.length > 0) {
    out.push(`Your cards block ${list(facts.blockers.map((b) => blockers[b] ?? b))}.`);
  }
  for (const flag of decision.flags) {
    out.push(flagSentence(flag, facts));
  }
  return out.filter(Boolean);
}

export const analysisEn = {
  tab: {
    heading: "Analysis",
    /** Next to the heading: "1,234 hands · analysis/1". */
    sample: (count: number, version: string) => `${hands(count)} · ${version}`,
    signInHeading: "Sign in to analyse your hands",
    signInBody:
      "The analysis reads the hands in your library, so it needs an account to belong to. It is private to you.",
    signIn: "Sign in",
    notInstalledHeading: "Analysis is not set up on this database yet",
    /** Around the migration file name, shown in `<code>`. */
    notInstalledBefore: "Your hands are safe — this screen reads its own tables, which arrive with ",
    notInstalledAfter: ". Apply it and reload.",
    loading: "Reading your analysis…",
    tryAgain: "Try again",
    emptyHeading: "Nothing analysed yet",
    emptyBody:
      "The analysis walks every decision you made in your saved hands: the board, your hand, the price, and the checks that hold whatever the strategy. It runs in this browser tab.",
    updatedHeading: "The analysis has a new version",
    updatedBody:
      "Your hands were analysed by an earlier version. This one also grades your turn decisions in heads-up pots with our own solver, and narrows the ranges into the river by the solved turn — on top of the river and preflop grades. Bring your hands up to date to see them; it runs in this tab, and a turn solve takes a second or two per hand, so a large library takes a while. You can start with your most recent hands.",
    noHandsHeading: "No hands in your library yet",
    noHandsBody: "Upload a hand history first; the analysis reads the hands you have saved.",
  },

  /** The line above everything about what the analysis can and cannot say. */
  reference: {
    title: "Preflop is graded against our charts, the turn and river against our solver",
    body:
      "Preflop decisions get a grade, Perfect to Blunder, against Rail's own preflop charts (6-max at 40–200 bb, full ring at 100–200 bb) wherever a chart covers the spot. Turn and river decisions in heads-up pots are graded by our own solver, on ranges narrowed on the flop by a heuristic model and into the river by the solved turn. The flop shows its facts and the checks that hold whatever the strategy — a flag is a note, never a grade.",
    model:
      "The charts (charts/2) value a flop with the flop checked, so they still under-rate a few hands that win through implied odds: UTG folds 22–55, 54s–87s and A5s, and the button almost never flats a cutoff open. Grades against playing those lean harsh.",
    browse: "Browse the charts",
  },

  run: {
    button: "Run analysis",
    again: "Analyse new hands",
    update: "Bring it up to date",
    stop: "Stop",
    running: (done: number, target: number) =>
      target > 0 ? `Analysing… ${num(Math.min(done, target))} of ${hands(target)}` : `Analysing… ${hands(done)}`,
    finished: (count: number) => `Analysed ${hands(count)}.`,
    /** After "Analysing… 120 of 900 hands": the time left at the pace so far. */
    eta: (seconds: number) =>
      seconds < 60 ? "— under a minute left" : `— about ${num(Math.round(seconds / 60))} min left`,
    scopeLabel: "Analyse",
    scopeAll: (count: number) => `all ${hands(count)}`,
    scopeRecent: (count: number) => `the most recent ${num(count)} first`,
    stopped: "Stopped. Run it again to carry on where it left off.",
    failed: (message: string) => `The analysis stopped: ${message}`,
    unreadable: (count: number) => `${num(count)} could not be read — a converter bug, not your file.`,
    missing: (count: number, total: number) => `${num(count)} of ${hands(total)} are not analysed yet.`,
    versionChanged: (count: number, version: string) =>
      `The analysis has changed since ${hands(count)} were analysed (now ${version}). Run it again to bring them up to date.`,
    note: "Runs in this tab. Your hands are read from your library and the results saved back to it, as you.",
  },

  overview: {
    coverage: "Coverage",
    full: { label: "Fully analysed", hint: "Every decision has its facts and checks" },
    partial: { label: "Partly analysed", hint: "Some decisions were skipped — see below" },
    notAnalysed: { label: "Not analysed", hint: "Outside what the analysis covers" },
    hands,
    decisions,
    analysedDecisions: (analysed: number, total: number) => `${num(analysed)} of ${decisions(total)} analysed`,
    reasonsHeading: "Why hands were not analysed",
    skippedHeading: "Why decisions were skipped",
    flagsHeading: "Flags",
    flagsNote: "Checks that hold whatever the strategy. Notes, not grades — read them with the hand open.",
    noFlags: "Nothing flagged in this sample.",
    flaggedHands: (count: number) => `${hands(count)} with a flag`,
    streetsHeading: "By street",
    defenceNote:
      "Defended: how often you continued (called or raised) when facing a bet, against the mean MDF of those bets. One sample of your own hands — a direction, not a verdict.",
    approximationsHeading: "Approximations",
    gradesHeading: "Grades",
    score: "Score",
    scoreHint: "Mean over graded moves, 0–100",
    evLoss100: "EV loss / 100 hands",
    evLoss100Hint: (count: number) => `over ${hands(count)} with a graded move`,
    moves: "Moves graded",
    movesHint: (total: number) => `of ${decisions(total)}`,
    badHands: (count: number) => `${hands(count)} with a Mistake or a Blunder`,
    showBad: "Show them",
    noGrades:
      "Nothing graded in this sample yet. Preflop decisions are graded where the charts cover the spot (three to nine players, 40–200 bb, no open limpers), turn and river decisions in heads-up pots by the solver.",
    byStreet: "By street",
    /** Big blinds to two decimals: "1.25 bb". */
    bb2: (value: number) => `${num(value, 2)} bb`,
    /** The distribution bar's accessible name: "Perfect 80%, Good 10%, …". */
    distribution: (parts: string[]) => parts.join(", "),
    share: (word: string, share: number) => `${word} ${pct1(share)}`,
  },

  reasons: {
    "no-hero": "No hero seat (an observed table)",
    variant: "Not Hold'em",
    "hi-lo": "Hi/Lo split pot",
    limit: "Not No-Limit",
    tournament: "Tournament (ICM not modelled)",
    "bomb-pot": "Bomb pot",
    "hero-cards-unknown": "Your cards are unknown",
    "no-decisions": "You had no decision",
    multiway: "Multiway after the flop",
    "chart-straddle": "Preflop charts: straddle",
    "chart-ante": "Preflop charts: antes",
    "chart-players": "Preflop charts: heads-up or 10+ players",
    "chart-stack-depth": "Preflop charts: no set at this stack depth",
    "chart-limp": "Preflop charts: open limp",
    "chart-multiway": "Preflop charts: fifth player in",
    "chart-cold-call": "Preflop charts: cold call of a re-raise",
    "chart-off-tree": "Preflop charts: off the betting tree",
    "chart-rare-line": "Preflop charts: line too rare",
    "chart-action-not-modelled": "Preflop charts: action not modelled",
    "chart-bad-input": "Preflop charts: unreadable line",
    "chart-game": "Preflop charts: not NLHE cash",
    "chart-bomb-pot": "Preflop charts: bomb pot",
    "chart-no-positions": "Preflop charts: positions unknown",
    "chart-no-hero": "Preflop charts: no hero position",
    "chart-no-decision": "Preflop charts: decision not found",
    "chart-unavailable": "Preflop charts: not loaded",
    "river-multiway-flop": "River: three or more saw the flop",
    "river-range-unknown": "River: a range has no preflop line",
    "river-range-empty": "River: a range is empty",
    "river-off-tree": "River: off the solver's tree",
    "river-unreached": "River: a line the solve never takes",
    "river-solve-failed": "River: the solver refused the spot",
    "turn-multiway-flop": "Turn: three or more saw the flop",
    "turn-range-unknown": "Turn: a range has no preflop line",
    "turn-range-empty": "Turn: a range is empty",
    "turn-off-tree": "Turn: off the solver's tree",
    "turn-unreached": "Turn: a line the solve never takes",
    "turn-solve-failed": "Turn: the solver refused the spot",
  } as Record<string, string>,

  approximations: {
    heuristic: "Postflop: heuristic checks only, no reference strategy",
    "placeholder-range": "Equities against default placeholder ranges (no chart node for the opponent's line)",
    "preflop-range": "Equities against the charts' preflop ranges, not narrowed by later betting",
    antes: "Antes in the pot",
    straddle: "A straddle moved the blinds",
    "stack-depth": "Stacks outside 100 bb ±20%",
    "table-size": "Not a six-handed table",
    model: "Preflop charts (charts/2 to charts/4) still under-rate a few implied-odds hands (UTG's small pairs and suited connectors) and the button's flat of a cutoff open",
    "short-handed": "Fewer players than the chart set's seats, read with the earliest seats folded",
    "stack-depth-near": "Stacks within 20% of the chart set's depth, but not at it",
    "off-tree-size": "A raise far from the charts' size: grade capped at Inaccurate",
    "out-of-range": "Your hand is outside the reference range at this node",
    "narrowing-heuristic": "Ranges narrowed by a heuristic model on the flop (and on the turn where the turn was not solved), not a solver",
    "rake-profile": "Solved with the charts' rake (5%, capped at 3 bb), not this room's",
    "size-translated": "Bet sizes read as the nearest of the solver's sizes",
    "solver-unconverged": "Solve stopped above its target (0.5% of the pot on the river, 1% on the turn) from equilibrium",
    "range-cap": "Solver grade capped at Mistake: heuristically narrowed ranges cannot support a Blunder",
    "range-sensitive": "Solver grade depends on how hard the ranges are narrowed: the milder of two is shown",
    "coarse-river": "Turn solved with a coarse river below it: one bet size and all-in",
    "flop-mapped": "Flop read from the nearest solved flop of the same texture, not solved itself",
    "library-bucketed": "Your hand read by its category (made hand and draw) in the flop library, not combo for combo",
    "limp-tremble": "A limped pot: the charts barely limp there themselves, so they assume the limper may hold any hand",
  } as Record<string, string>,

  severity: { note: "Note", inaccurate: "Inaccurate" } as Record<string, string>,

  flags: {
    "fold-nuts": "Folded the nuts",
    "free-fold": "Folded when a check was free",
    "call-beats-nothing": "Called with a hand that beats nothing",
    "call-without-odds": "Called without the odds",
    "fold-with-odds": "Folded with the odds",
    "check-back-nuts": "Checked back the nuts",
    "thin-stack-behind": "Bet left too little behind",
    "committed-fold": "Folded when committed",
  } as Record<string, string>,

  grades: {
    perfect: "Perfect",
    good: "Good",
    inaccurate: "Inaccurate",
    mistake: "Mistake",
    blunder: "Blunder",
  } as Record<string, string>,

  streets,
  actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>,
  /** One letter per action, for the coloured action strips. */
  letters: { fold: "F", check: "X", call: "C", bet: "B", raise: "R" } as Record<string, string>,

  table: {
    street: "Street",
    decisions: "Decisions",
    analysed: "Analysed",
    flagged: "Flagged",
    facingBet: "Facing a bet",
    defended: "Defended",
    mdf: "MDF",
    hands: "Hands",
    count: "Count",
    flag: "Flag",
    graded: "Graded",
    evLoss: "EV loss",
    score: "Score",
    distribution: "Perfect → Blunder",
  },

  breakdown: {
    heading: "Breakdown",
    splitBy: "Split by",
    groups: {
      street: "Street",
      position: "Position",
      pot_type: "Pot type",
      preflop_scenario: "Preflop spot",
      scenario: "Spot",
    } as Record<string, string>,
    gradesTitle: "Grades",
    flagsTitle: "Flags and defence",
    unknown: "Unknown",
    scenario: (key: string) => {
      if (preflopScenarios[key]) return preflopScenarios[key];
      const [role, where, ...rest] = key.split("-");
      const facingKey = rest.join("-");
      return `${roles[role] ?? role}, ${where === "ip" ? "IP" : "OOP"}, ${facing[facingKey] ?? facingKey}`;
    },
  },

  filters: {
    ariaLabel: "Filter the analysed hands",
    format: "Game",
    street: "Street",
    anyStreet: "Any street",
    flag: "Flag",
    anyFlag: "Any",
    flaggedOnly: "Any flag",
    status: "Coverage",
    anyStatus: "Any",
    position: "Position",
    anyPosition: "Any",
    potType: "Pot",
    anyPot: "Any",
    grade: "Grade",
    anyGrade: "Any",
    badGrades: "Mistake or worse",
    sort: "Sort",
    sorts: {
      recent: "Newest first",
      oldest: "Oldest first",
      flags: "Most flagged",
      ev_loss: "Most EV lost (bb)",
      ev_loss_pot: "Most EV lost (% of pot)",
      score: "Lowest score",
      result: "Biggest loss",
    } as Record<string, string>,
    clear: "Clear filters",
  },

  list: {
    heading: "Hands",
    total: (count: number) => hands(count),
    when: "Played",
    hand: "Hand",
    position: "Pos",
    pot: "Pot",
    actions: "Decisions",
    flags: "Flags",
    result: "Result",
    grade: "Grade",
    score: "Score",
    evLoss: "EV loss",
    evLossPot: "% pot",
    open: (cards: string) => `Open the analysis of ${cards}`,
    empty: "No analysed hands match these filters.",
    previous: "Previous",
    next: "Next",
    page: (from: number, to: number, total: number) => `${num(from)}–${num(to)} of ${num(total)}`,
    noDate: "—",
    /** The coloured strip's accessible name: "Preflop raise, flop bet — note". */
    stripLabel: (parts: string[]) => parts.join(", "),
    decisionLabel: (street: string, action: string, mark: string | null) =>
      `${street} ${action.toLowerCase()}${mark ? ` — ${mark.toLowerCase()}` : ""}`,
    notAnalysed: "not analysed",
  },

  sheet: {
    title: "Analysis",
    toggle: "Analysis",
    toggleTitle: "Show the analysis of this hand",
    notGraded: "Not graded",
    notGradedHint:
      "Nothing in this hand was graded: the preflop charts did not cover this line, the flop is notes only, and the turn and river had no heads-up decision the solver could take.",
    evLoss: "EV loss",
    evLossPot: (value: number) => `${pct(value)} of pot`,
    score: "Score",
    optionsHeading: "The reference here",
    colAction: "Action",
    colFreq: "Frequency",
    colEv: "EV",
    yourMove: "Your move",
    best: "Best",
    /** Under a bad move's chip: the better option. The arrow is decoration. */
    better: (label: string) => `Better: ${label}`,
    option: (action: string, sizeBb: number | undefined, allIn: boolean | undefined, sizePot?: number) =>
      allIn
        ? "All-in"
        : action === "raise" || action === "bet"
          ? sizeBb !== undefined
            ? `${action === "bet" ? "Bet" : "Raise to"} ${bb(sizeBb)}${action === "bet" && sizePot !== undefined ? ` (${pct(sizePot)})` : ""}`
            : action === "bet"
              ? "Bet"
              : "Raise"
          : ({ fold: "Fold", check: "Check", call: "Call" } as Record<string, string>)[action] ?? action,
    signedBb,
    freq: pct1,
    source: {
      chart: "Graded against the preflop charts",
      heuristic: "Heuristic checks only — no grade",
      solver: "Graded against the solver",
    } as Record<string, string>,
    study: "Study the chart",
    hideStudy: "Hide the chart",
    openBrowser: "Open in the chart browser",
    approximate: "Approximate",
    decisionsHeading: "Your decisions",
    noDecisions: "You made no decision in this hand.",
    factsHeading: "The spot",
    flagsHeading: "Flags",
    whyHeading: "Why",
    noFlags: "Nothing flagged: every check that holds whatever the strategy passed.",
    skipped: "Skipped",
    /** The pip on the replayer rail. */
    mark: (street: string, action: string, note: string | null) =>
      `${street} ${action.toLowerCase()}${note ? `: ${note.toLowerCase()}` : ""}`,
    chip: (street: string, action: string) => `${street}: ${action}`,
    facts: {
      pot: "Pot",
      toCall: "To call",
      potOdds: "Equity needed",
      mdf: "MDF",
      spr: "SPR",
      betPot: "Bet size",
      effStack: "Effective stack",
      hand: "Your hand",
      board: "Board",
      draws: "Draws",
      blockers: "Blocks",
      equity: "Equity (estimate)",
      position: "Position",
      spot: "Spot",
    },
    bb,
    pct,
    /** A ratio such as SPR, to one decimal in the reader's notation. */
    ratio: (value: number) => num(value, 1),
    ofPot: (value: number) => `${pct(value)} of pot`,
    equityValue: (value: number, range: string) => `${pct(value)} vs ${rangeLabel(range)}`,
    handValue: (facts: SpotFacts) => handPhrase(facts),
    drawsValue: (facts: SpotFacts) => list(facts.draws.map((d) => draws[d] ?? d)),
    blockersValue: (facts: SpotFacts) => list(facts.blockers.map((b) => blockers[b] ?? b)),
    textureValue: (facts: SpotFacts) => textureLabel(facts) ?? "",
    spotValue: (facts: SpotFacts) => scenarioLabel(facts),
    streetLower: (street: string) => streetsLower[street] ?? street,
  },

  hand: {
    back: "Back to analysis",
    loading: "Loading the hand…",
    notFound: "This hand is not in your library.",
    fresh:
      "This hand has not been analysed at the current version yet, so this is a fresh analysis computed in your browser. Run the analysis to save it.",
  },

  /** The river study (A4): the hero's range at a solved river node. */
  river: {
    study: "Study the river",
    hideStudy: "Hide the study",
    loading: "Solving the river…",
    failed: (message: string) => `The river study did not load: ${message}`,
    unavailable: "The solver could not rebuild this spot.",
    heading: "Your range here, as solved",
    note: "The solve behind the grade, re-run in your browser: every hand of your range at this decision, and what the solver does with it.",
    gridLabel: (spot: string) => `${spot}: the solver's mix for your range, by hand`,
    spot: (path: string) => (path ? `River after ${path.split("-").join(", ")}` : "River, first decision"),
    cellLabel: (hand: string, combos: number, parts: string[]) =>
      combos > 0 ? `${hand}, ${num(combos, combos < 10 ? 1 : 0)} combos: ${parts.join(", ")}` : `${hand}: not in your range here`,
    part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
    totals: (label: string, share: number, combos: number) =>
      `${label} ${pct1(share)} · ${num(Math.round(combos * 10) / 10, combos < 10 ? 1 : 0)} combos`,
    detailEmpty: "Hover or focus a hand to see its mix and what each action is worth.",
    detailCombos: (combos: number) => `${num(combos, combos < 10 ? 1 : 0)} weighted combos in your range here.`,
    notInRange: "Not in your range at this point.",
    yourHand: "Your hand",
    yourCombo: (combo: string) => `Your hand (${combo})`,
    categoriesTitle: "By hand",
    strengthTitle: "By strength against the opponent's range here",
    colHand: "Hands",
    colCombos: "Combos",
    colMix: "Solver's mix",
    groups: { made: "Made hands", missed: "Missed draws", nothing: "No made hand" } as Record<string, string>,
    categories: {
      "full-house-plus": "Full house or better",
      flush: "Flush",
      straight: "Straight",
      "set-trips": "Set or trips",
      "two-pair": "Two pair",
      "top-pair": "Top pair or overpair",
      "middle-pair": "Second pair, or a pocket pair below the top card",
      "weak-pair": "Weak pair or underpair",
      "missed-flush-draw": "Missed flush draw",
      "missed-straight-draw": "Missed straight draw",
      "ace-high": "Ace high",
      "no-pair": "No pair",
    } as Record<string, string>,
    strength: {
      strong: "Value: beats 75% or more",
      medium: "Bluff-catchers: beat 25–75%",
      weak: "Air: beats under 25%",
    } as Record<string, string>,
    villainTitle: "The opponent's range here",
    villainSummary: (combos: number, strong: number, medium: number, weak: number) =>
      `${num(Math.round(combos * 10) / 10, combos < 10 ? 1 : 0)} weighted combos, your cards removed: ${pct(strong)} beat most of your range, ${pct(medium)} sit in the middle, ${pct(weak)} beat little of it.`,
    share: pct1,
    combos: (value: number) => num(Math.round(value * 10) / 10, value < 10 ? 1 : 0),
    mixLabel: (parts: string[]) => parts.join(", "),
    solved: (iterations: number, exploitability: number) =>
      `Solved in ${num(iterations)} iterations to within ${num(exploitability, 2)}% of the pot. Ranges narrowed by a heuristic model before the river; sizes 33 / 75 / 150% of the pot and all-in.`,
    evNote: "EV in big blinds, net from the start of the river, with the pot counted as winnable.",
    signedBb,
    freq: pct1,
  },

  /**
   * The turn study (A5a): what differs from `river` above, which supplies
   * everything else (the grid, the legend, the tables' columns).
   */
  turn: {
    study: "Study the turn",
    loading: "Solving the turn…",
    failed: (message: string) => `The turn study did not load: ${message}`,
    gridLabel: (spot: string) => `${spot}: the solver's mix for your range, by hand`,
    spot: (path: string) => (path ? `Turn after ${path.split("-").join(", ")}` : "Turn, first decision"),
    groups: { made: "Made hands", draws: "Draws", nothing: "No made hand, no draw" } as Record<string, string>,
    categories: {
      "full-house-plus": "Full house or better",
      flush: "Flush",
      straight: "Straight",
      "set-trips": "Set or trips",
      "two-pair": "Two pair",
      "top-pair": "Top pair or overpair",
      "middle-pair": "Second pair, or a pocket pair below the top card",
      "weak-pair": "Weak pair or underpair",
      "combo-draw": "Flush draw with a straight draw",
      "flush-draw": "Flush draw",
      "straight-draw": "Open-ended straight draw",
      gutshot: "Gutshot",
      "ace-high": "Ace high",
      "no-pair": "No pair",
    } as Record<string, string>,
    strengthTitle: "By strength now, against the opponent's range here",
    strength: {
      strong: "Ahead: beats 75% or more now",
      medium: "Middling: beats 25–75% now",
      weak: "Behind: beats under 25% now",
    } as Record<string, string>,
    solved: (iterations: number, exploitability: number) =>
      `Solved through the river in ${num(iterations)} iterations to within ${num(exploitability, 2)}% of the pot. Ranges narrowed by a heuristic model on the flop; turn sizes 75% of the pot and all-in (raises 75% and all-in) plus any size this hand used; below it a coarse river, 75% and all-in.`,
    evNote: "EV in big blinds, net from the start of the turn, with the pot counted as winnable.",
  },

  /** The 13×13 chart viewer and the chart browser at `/analysis/charts`. */
  charts: {
    heading: "Preflop charts",
    intro:
      "Rail's own reference for No-Limit Hold'em cash — six-handed from 40 to 200 big blinds deep, full ring from 100 to 200 — computed by our solver, never copied from anyone's charts. Pick a table and a spot: every hand shows how often the reference takes each action, and hovering or focusing a hand shows what each action is worth.",
    caveatTitle: "A model, with a known weakness",
    caveat:
      "These charts (charts/4) value a flop with an equity-realisation model fitted to our own postflop solver. The measurement checks the flop, so hands that win through implied odds are still a little under-rated: UTG folds 55–22, 87s–54s and A5s, and the button almost never flats a cutoff open. Grades against playing those hands lean harsh. Limped pots are in: the reference rarely limps itself outside the small blind, so behind a limp it assumes the limper may hold any hand.",
    loading: "Loading the charts…",
    failed: (message: string) => `The charts did not load: ${message}`,
    table: "Table and depth",
    /** A chart set: "6-max, 100bb". */
    setOption: (players: number, stackBb: number) => `${players}-max, ${stackBb}bb`,
    category: "Scenario",
    spot: "Spot",
    categories: {
      rfi: "Open (RFI)",
      "vs-open": "Facing an open",
      "vs-3bet": "Facing a 3-bet",
      "vs-4bet": "Facing a 4-bet or shove",
      squeeze: "Squeeze",
      bvb: "Blind vs blind",
      "vs-limp": "Limped pots",
    } as Record<string, string>,
    verbs: {
      open: "opens",
      iso: "isolates",
      limp: "limps",
      call: "calls",
      "3bet": "3-bets",
      "4bet": "4-bets",
      "5bet": "5-bets",
      allin: "shoves",
      check: "checks",
    } as Record<string, string>,
    /** "BTN, after CO opens and BTN 3-bets" / "UTG, first in". */
    spotLabel: (actor: string, steps: Array<{ position: string; verb: string }>) =>
      steps.length === 0 ? `${actor}, first in` : `${actor}, after ${list(steps.map((s) => `${s.position} ${s.verb}`))}`,
    action: (action: string, toBb: number) =>
      action === "raise"
        ? `Raise to ${bb(toBb)}`
        : action === "call" && toBb === 1
          ? "Limp"
          : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[action] ?? action,
    legend: "Actions",
    totals: "Whole range",
    total: (label: string, share: number, combos: number) => `${label} ${pct1(share)} · ${num(Math.round(combos))} combos`,
    gridLabel: (spot: string) => `${spot}: the reference's mix for all 169 hands`,
    cellLabel: (hand: string, parts: string[], offRange: boolean) =>
      `${hand}: ${parts.join(", ")}${offRange ? " (never reaches this spot)" : ""}`,
    part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
    detailEmpty: "Hover or focus a hand to see its mix and what each action is worth.",
    reaches: (share: number) => `Reaches this spot with ${pct1(share)} of its combos.`,
    offRange: "The reference never gets here with this hand; shown is its best response.",
    yourHand: "Your hand",
    pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)}, ${bb(toCall)} to call` : `Pot ${bb(pot)}`),
    evNote: "EV in big blinds, net from the start of the hand: a fold is worth minus what is already in.",
    set: (id: string, version: string) => `${id} · ${version}`,
    signedBb,
    freq: pct1,
  },

  /** `/analysis/reports` (phase A3): its own file, `analysisReports.en.ts`. */
  reports: reportsEn,

  /** Leaks, progress and the overview's "what changed" card (phase A6): `analysisLeaks.en.ts`. */
  leaks: leaksEn,
  progress: progressEn,
  summary: summaryEn,

  /** The trainer (phase A7): `analysisTrain.en.ts`. */
  train: trainEn,

  /** Sharing a hand's analysis (A7.1): `analysisShare.en.ts`. */
  share: shareEn,

  /** The study plan (phase A8b): `analysisPlan.en.ts`. */
  plan: planEn,

  explain,
} as const;
