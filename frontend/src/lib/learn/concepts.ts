/**
 * The concept library's catalogue (`docs/ANALYSIS-PLAN.md` §6.0 *Learn*, §7 A8).
 *
 * Language-free on purpose: ids, groups, which concepts relate, which
 * interactive example a page carries, and which heuristic flags a concept
 * explains. The words live in `lib/i18n` (titles and widget labels, which the
 * client needs for links) and in `content/` (the page bodies, which only the
 * server renders). An explanation links to a concept by id, so renaming a
 * page's title never breaks a link and a link never names a page that does
 * not exist — `ConceptId` is a closed union.
 *
 * Same import rule as `lib/analysis`: pure TypeScript, no React, no framework,
 * so `tests/test/` can import it under plain Node.
 */

import type { FlagCode } from "../analysis/types";

export const CONCEPT_IDS = [
  // Foundations
  "pot-odds",
  "equity-realisation",
  "ev-and-grading",
  "gto-vs-exploitative",
  "position",
  // Ranges and boards
  "ranges",
  "range-advantage",
  "nut-advantage",
  "board-texture",
  "dynamic-boards",
  "blockers",
  // Betting
  "spr",
  "mdf-alpha",
  "bet-sizing",
  "continuation-bet",
  "check-raise",
  "donk-bet",
  "bluff-catching",
  "thin-value",
  "multiway-pots",
  // Preflop
  "rfi",
  "three-bet",
  "squeeze",
  "blind-defence",
  "steal",
] as const;
export type ConceptId = (typeof CONCEPT_IDS)[number];

export const CONCEPT_GROUPS = ["foundations", "ranges", "betting", "preflop"] as const;
export type ConceptGroup = (typeof CONCEPT_GROUPS)[number];

/**
 * The interactive examples. Each is a client component in
 * `components/learn/`; a page names at most one, and passes it a preset so
 * the same calculator opens on the numbers its page talks about.
 */
export const WIDGET_IDS = [
  "bet-math",
  "spr",
  "board-texture",
  "equity",
  "range-vs-range",
  "combos",
  "grading",
  "bluff-catcher",
  "value-bet",
  "multiway",
  // Learn L2: the raiser's flop bets by board group, over Rail's flop library (`flopBets.ts`); `preset` is the line.
  "flop-bets",
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

/** Which outputs a bet-math calculator puts first, and in which units it is set. */
export type BetMathFocus = "pot-odds" | "mdf" | "alpha" | "polar" | "steal";

export interface WidgetPreset {
  id: WidgetId;
  /** `bet-math`: what to lead with. `board-texture`: `dynamism` leads with volatility. */
  focus?: BetMathFocus | "texture" | "dynamism" | "realisation" | "range" | "nuts";
  /**
   * Starting numbers, in big blinds. What `pot` and `bet` mean depends on the
   * focus: for `pot-odds` they are the pot *including* the bet faced and the
   * price of calling; for `mdf` / `polar` the pot *before* the bet and the bet;
   * for `alpha` / `steal` the pot before your bet or raise and the chips it
   * risks.
   */
  pot?: number;
  bet?: number;
  stack?: number;
  /** A third number some widgets start from: equity, bluff share, fold rate or call rate, 0–1. */
  share?: number;
  /** `multiway`: the number of opponents the bet goes into. */
  opponents?: number;
  /** Starting cards: the board, and the hero's hand. */
  board?: readonly string[];
  hand?: readonly string[];
  /** A `RANGE_TEXT` / `MATCHUP_PRESETS` / `COMBO_PRESETS` id from `presets.ts`. */
  preset?: string;
}

export interface ConceptMeta {
  id: ConceptId;
  group: ConceptGroup;
  /** Read next. Two to four, most useful first. */
  related: readonly ConceptId[];
  widget: WidgetPreset | null;
  /**
   * The heuristic flags this concept explains. A concept page links to the
   * reader's hands with each of these flags (the hands list filters by one
   * flag code); the overview's flag rows link back here.
   */
  flags: readonly FlagCode[];
  /** Server-rendered table of the common bet sizes (`bet-sizing`, `mdf-alpha`). */
  sizingTable?: boolean;
}

const meta = (
  id: ConceptId,
  group: ConceptGroup,
  related: ConceptId[],
  widget: WidgetPreset | null,
  flags: FlagCode[] = [],
  extra: Partial<ConceptMeta> = {},
): ConceptMeta => ({ id, group, related, widget, flags, ...extra });

export const CONCEPTS: Readonly<Record<ConceptId, ConceptMeta>> = {
  "pot-odds": meta("pot-odds", "foundations", ["equity-realisation", "mdf-alpha", "bluff-catching"], {
    id: "bet-math",
    focus: "pot-odds",
    pot: 18,
    bet: 6,
    share: 0.196,
  }, ["call-without-odds", "fold-with-odds"]),
  "equity-realisation": meta("equity-realisation", "foundations", ["pot-odds", "position", "blind-defence"], {
    id: "equity",
    focus: "realisation",
    hand: ["7h", "6h"],
    preset: "open-btn",
    share: 0.9,
  }),
  "ev-and-grading": meta("ev-and-grading", "foundations", ["gto-vs-exploitative", "pot-odds", "mdf-alpha"], {
    id: "grading",
  }, ["fold-nuts", "free-fold"]),
  "gto-vs-exploitative": meta("gto-vs-exploitative", "foundations", ["ev-and-grading", "bluff-catching", "mdf-alpha"], {
    id: "bluff-catcher",
    pot: 10,
    bet: 7.5,
    share: 0.3,
  }),
  position: meta("position", "foundations", ["equity-realisation", "rfi", "donk-bet"], {
    id: "equity",
    focus: "realisation",
    hand: ["Ks", "Td"],
    preset: "open-btn",
    share: 1.1,
  }),

  ranges: meta("ranges", "ranges", ["range-advantage", "blockers", "rfi"], {
    id: "equity",
    focus: "range",
    hand: ["Jh", "Jd"],
    preset: "3bet",
  }, [
    "call-beats-nothing",
  ]),
  "range-advantage": meta("range-advantage", "ranges", ["nut-advantage", "continuation-bet", "board-texture"], {
    id: "range-vs-range",
    focus: "range",
    preset: "btn-vs-bb",
    board: ["Kd", "7c", "2h"],
  }),
  "nut-advantage": meta("nut-advantage", "ranges", ["range-advantage", "bet-sizing", "check-raise"], {
    id: "range-vs-range",
    focus: "nuts",
    preset: "utg-vs-bb",
    board: ["As", "8d", "3c"],
  }),
  "board-texture": meta("board-texture", "ranges", ["dynamic-boards", "range-advantage", "continuation-bet"], {
    id: "board-texture",
    focus: "texture",
    board: ["Kd", "7c", "2h"],
  }),
  "dynamic-boards": meta("dynamic-boards", "ranges", ["board-texture", "bet-sizing", "continuation-bet"], {
    id: "board-texture",
    focus: "dynamism",
    board: ["8h", "7h", "6c"],
  }),
  blockers: meta("blockers", "ranges", ["bluff-catching", "three-bet", "ranges"], {
    id: "combos",
    hand: ["As", "5s"],
    preset: "premium",
  }),

  spr: meta("spr", "betting", ["bet-sizing", "pot-odds", "three-bet"], { id: "spr", pot: 21.5, stack: 90 }, [
    "thin-stack-behind",
    "committed-fold",
  ]),
  "mdf-alpha": meta("mdf-alpha", "betting", ["pot-odds", "bluff-catching", "bet-sizing"], {
    id: "bet-math",
    focus: "mdf",
    pot: 10,
    bet: 7.5,
  }, [], { sizingTable: true }),
  "bet-sizing": meta("bet-sizing", "betting", ["mdf-alpha", "nut-advantage", "thin-value"], {
    id: "bet-math",
    focus: "polar",
    pot: 10,
    bet: 10,
  }, ["check-back-nuts"], { sizingTable: true }),
  "continuation-bet": meta("continuation-bet", "betting", ["range-advantage", "board-texture", "check-raise"], {
    id: "bet-math",
    focus: "alpha",
    pot: 6,
    bet: 2,
    share: 0.4,
  }),
  "check-raise": meta("check-raise", "betting", ["continuation-bet", "nut-advantage", "position"], {
    id: "bet-math",
    focus: "alpha",
    pot: 8,
    bet: 7,
    share: 0.4,
  }),
  "donk-bet": meta("donk-bet", "betting", ["range-advantage", "position", "continuation-bet"], {
    id: "range-vs-range",
    focus: "range",
    preset: "btn-vs-bb",
    board: ["8h", "7h", "6c"],
  }),
  "bluff-catching": meta("bluff-catching", "betting", ["mdf-alpha", "blockers", "gto-vs-exploitative"], {
    id: "bluff-catcher",
    pot: 20,
    bet: 15,
    share: 0.25,
  }, ["call-beats-nothing", "fold-with-odds"]),
  "thin-value": meta("thin-value", "betting", ["bet-sizing", "bluff-catching", "position"], { id: "value-bet", pot: 20, bet: 7, share: 0.4 }, [
    "check-back-nuts",
  ]),
  "multiway-pots": meta("multiway-pots", "betting", ["mdf-alpha", "bluff-catching", "dynamic-boards"], {
    id: "multiway",
    pot: 12,
    bet: 8,
    share: 0.4,
    opponents: 2,
  }, ["multiway-bluff", "multiway-slowplay", "multiway-dominated-draw"]),

  rfi: meta("rfi", "preflop", ["steal", "position", "three-bet"], {
    id: "bet-math",
    focus: "steal",
    pot: 1.5,
    bet: 2.5,
    share: 0.6,
  }),
  "three-bet": meta("three-bet", "preflop", ["squeeze", "blockers", "spr"], {
    id: "combos",
    hand: ["Ah", "4h"],
    preset: "premium",
  }),
  squeeze: meta("squeeze", "preflop", ["three-bet", "steal", "position"], {
    id: "bet-math",
    focus: "steal",
    pot: 6.5,
    bet: 12,
    share: 0.72,
  }),
  "blind-defence": meta("blind-defence", "preflop", ["pot-odds", "equity-realisation", "steal"], {
    id: "bet-math",
    focus: "pot-odds",
    pot: 4,
    bet: 1.5,
    share: 0.234,
  }),
  steal: meta("steal", "preflop", ["rfi", "blind-defence", "three-bet"], {
    id: "bet-math",
    focus: "steal",
    pot: 1.5,
    bet: 2.5,
    share: 0.62,
  }),
};

export function isConceptId(value: unknown): value is ConceptId {
  return typeof value === "string" && (CONCEPT_IDS as readonly string[]).includes(value);
}

/** The concepts of one group, in catalogue order. */
export function conceptsIn(group: ConceptGroup): ConceptId[] {
  return CONCEPT_IDS.filter((id) => CONCEPTS[id].group === group);
}
