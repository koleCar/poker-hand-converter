/**
 * Tournament words (R5.5), English: the push/fold game's reasons,
 * approximations and sentences, and the ICM panel's labels. Spread into
 * `analysis.en.ts`; `analysisIcm.hr.ts` is the same shape.
 */
import type { DecisionAnalysis, IcmFacts, OptionAnalysis } from "../../analysis/types";

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
const pct1 = (value: number) => `${num(value * 100, 1)}%`;
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;

/** Why a tournament decision is not graded: the end of "Not graded: …". Keyed by `TOURNAMENT_SKIP_REASONS`. */
export const tournamentReasonsEn = {
  "tournament-deep":
    "the effective stack is over 20 bb, deeper than the push/fold game - and a tournament's chips are not money, so the cash charts do not apply",
  "tournament-not-push-fold":
    "only going all in or folding (calling or folding facing an all-in) is graded in a tournament, and this line or action is neither",
  "tournament-postflop": "tournament decisions after the flop are not graded yet",
  "tournament-posted-all-in": "a player was all in from the blinds or antes",
  "tournament-players": "more than ten players were dealt in",
  "tournament-side-pot":
    "a player who could call has less than half of the all-in behind, so their call would leave a side pot the others contest, which the push/fold game does not model",
} as Record<string, string>;

/** Short labels for the reasons (`analysis.reasons`). */
export const tournamentReasonLabelsEn = {
  tournament: "Tournament: not analysed",
  "tournament-deep": "Tournament: deeper than push/fold (over 20 bb)",
  "tournament-not-push-fold": "Tournament: not an all-in or fold",
  "tournament-postflop": "Tournament: after the flop",
  "tournament-posted-all-in": "Tournament: all in from the blinds",
  "tournament-players": "Tournament: more than ten players",
  "tournament-side-pot": "Tournament: a short stack's side pot",
} as Record<string, string>;

export const icmApproximationsEn = {
  "push-fold":
    "Push/fold game: going all in or folding (calling or folding an all-in) is compared, not a smaller raise or a limp - so a fold's loss is the least it could be",
  "one-caller": "More than one player could call: the first caller plays it heads-up, the rest fold",
  "icm-chip-ev":
    "Graded in chips, not prize money: the hand does not say how many are left or how the prizes are paid (set them for this tournament to grade it by ICM)",
  "icm-payouts-assumed": "Standard payouts assumed for this kind of tournament, not the room's own (you can set them)",
  "icm-players-left": "Players left as you set them at a time at or before this hand",
  "icm-field-average": "The players at other tables taken at an average stack",
  "icm-monte-carlo": "Prize equities sampled (a big field), within the error shown",
} as Record<string, string>;

const chipsReasons = {
  "players-left-unknown": "the hand does not say how many players are left",
  "payouts-unknown": "neither the payouts nor the field size are known",
  "far-field": "more than 30 players are left, where prize equity is close to chips",
} as Record<string, string>;

const kinds = { sng: "sit-and-go", spin: "spin", mtt: "multi-table tournament" } as Record<string, string>;
const gradeWords = { perfect: "Perfect", good: "Good", inaccurate: "Inaccurate", mistake: "Mistake", blunder: "Blunder" } as Record<string, string>;

function optionLabel(option: OptionAnalysis): string {
  if (option.allIn) return "going all in";
  return option.action === "call" ? "calling" : "folding";
}

/** The ICM grade in sentences (§4): what the push/fold game does with the hand, what the move cost, on what model. */
export function icmSentencesEn(decision: DecisionAnalysis): string[] {
  const icm = decision.facts.icm;
  if (decision.source !== "icm" || !icm || decision.chosen === null || !decision.grade) return [];
  const out: string[] = [];
  const word = gradeWords[decision.grade] ?? decision.grade;
  const act = decision.options[1];
  const chosen = decision.options[decision.chosen];
  const verb = icm.scenario === "push" ? "goes all in" : "calls";
  const hand = decision.facts.handClass ?? "this hand";
  out.push(
    decision.grade === "perfect" || decision.grade === "good"
      ? `${word}: you chose ${optionLabel(chosen)}; at equilibrium the push/fold game ${verb} with ${hand} ${pct(act.freq)} of the time.`
      : `${word}: at equilibrium the push/fold game ${verb} with ${hand} ${pct(act.freq)} of the time. ${optionLabel(chosen).replace(/^./, (c) => c.toUpperCase())} costs ${bb(decision.evLoss ?? 0)} (${pct(decision.evLossPot ?? 0)} of the pot).`,
  );
  out.push(modelSentenceEn(icm));
  return out;
}

/** What the grade was measured in. */
export function modelSentenceEn(icm: IcmFacts): string {
  if (icm.model === "chips") {
    return `Measured in chips: ${chipsReasons[icm.chipsReason ?? ""] ?? "the prizes are not known"}.`;
  }
  const payouts = (icm.payouts ?? []).slice(0, 6).map((p) => `${num(p, p % 1 === 0 ? 0 : 1)}`).join(" / ");
  const more = (icm.payouts?.length ?? 0) > 6 ? " …" : "";
  return `Measured in prize equity (ICM): ${icm.playersLeft} left of a ${kinds[icm.kind] ?? icm.kind}, paying ${payouts}${more}% (${
    icm.payoutsSource === "user" ? "your payouts" : "standard payouts"
  }); a big blind is worth ${pct1(icm.bbValue)} of the prize pool on average.`;
}

/** The ICM panel on a hand (R5.5c). */
export const icmEn = {
  heading: "Tournament (push/fold)",
  modelIcm: "Prize equity (ICM)",
  modelChips: "Chip EV",
  chipsReasons,
  kinds,
  kindSources: { phf: "from the hand", name: "from the name", assumed: "assumed", user: "you set it" } as Record<string, string>,
  sources: { standard: "standard", user: "yours", table: "everyone at this table", phf: "from the hand", "buy-ins": "buy-ins × entrants", field: "field × starting stack" } as Record<
    string,
    string
  >,
  stacks: "Stacks",
  payouts: "Payouts",
  playersLeft: "Players left",
  others: (count: number, stack: string) => `${num(count)} more at other tables, ${stack} each`,
  prizePool: "Prize pool",
  options: "Your options",
  equity: "Prize equity",
  equityChips: "Share of the chips",
  evBb: "EV (bb)",
  start: "At the start of the hand",
  push: "Push",
  call: "Call",
  fold: "Fold",
  pushRange: (who: string, share: number) => `${who} pushes ${pct(share)} of hands`,
  callRange: (who: string, share: number) => `${who} calls ${pct(share)}`,
  you: "You",
  bubbleFactor: "Bubble factor",
  riskPremium: "Risk premium",
  bfHint: "What losing an all-in against this player costs, over what winning it gains: 1 in chips",
  rpHint: "The equity over 50% an even all-in against this player needs",
  error: (value: number) => `sampled, error under ${pct1(value)} of the pool`,
  gap: (value: string) => `Equilibrium within ${value}`,
  player: "Player",
  edit: "Payouts and players left",
  bbs: (value: string) => `${value} bb`,
  bbValue: (value: number) => `1 bb ≈ ${pct1(value)} of the pool`,
};

/** The tournament settings form under the ICM panel (R5.5c). */
export const icmFormEn = {
  intro:
    "What the hand history does not say. Leave a field empty to keep the assumption. Saving sends this tournament's hands back to the analysis, so its next run grades them with your settings.",
  kind: "Kind",
  kindAuto: "As the hand reads",
  payouts: "Payouts, % of the prize pool per place",
  payoutsExample: "50, 30, 20",
  entrants: "Entrants",
  startingStack: "Starting stack (chips)",
  playersLeft: "Players left at this hand",
  save: "Save",
  resetButton: "Back to the assumptions",
  saved: "Saved. The tournament's hands are analysed again on the next run.",
  reset: "Your settings are gone; the hands are analysed again on the assumptions.",
  problems: {
    kind: "Pick a kind.",
    payouts: "Payouts are percents, each above 0 and at most 100.",
    "payouts-order": "Payouts go from first place down: each at most the one before.",
    "payouts-sum": "Payouts add up to at most 100%.",
    "payouts-places": "More places paid than entrants.",
    entrants: "Entrants: a whole number, at least 2.",
    "starting-stack": "Starting stack: a whole number of chips.",
    "players-left": "Players left: a whole number from 2 to the entrants.",
  } as Record<string, string>,
};
