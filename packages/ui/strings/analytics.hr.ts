/** The Analytics screen's words (docs/ANALYTICS.md), Croatian: `analytics.en.ts`'s shape. */

import type { AnalyticsStrings } from "../i18n";
import type { AnalyticsWhyWords } from "./analytics.en";

type Why = (w: AnalyticsWhyWords) => string;

const sentences = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(" ");
const spotLine = (w: AnalyticsWhyWords) =>
  w.spot && `Najveća razlika: ${w.spot} (ti ${w.spotPlayer}, ${w.ref} ${w.spotTarget}).`;
/** "Srednji par: foldaš 62 % tih ruku, solver 18 %." / "samo 4 %". */
const classLine = (w: AnalyticsWhyWords, only: boolean) => {
  if (!w.cls) return null;
  const o = only ? "samo " : "";
  return w.share
    ? `${w.cls} čini ${o}${w.classPlayer} tvojih ${w.noun}, kod ${w.refOf} ${w.classTarget}.`
    : `${w.cls}: ${w.verb} ${o}${w.classPlayer} tih ruku, ${w.ref} ${w.classTarget}.`;
};
const eachLine = (w: AnalyticsWhyWords) => w.worth && `Svaki od njih košta ${w.worth} bb.`;
const preflop: { loose: Why; tight: Why } = { loose: (w) => sentences(spotLine(w)), tight: (w) => sentences(spotLine(w)) };
const postflop: { loose: Why; tight: Why } = {
  loose: (w) => sentences(classLine(w, false), eachLine(w), spotLine(w)),
  tight: (w) => sentences(classLine(w, true), spotLine(w)),
};

export const analyticsUiHr: AnalyticsStrings = {
  lang: "hr",
  spot: {
    versus: (hero: string, opponent: string) => `${hero} protiv ${opponent}`,
    multi: "2+",
    anySeat: "Bilo koja pozicija",
    separator: " · ",
    pots: {
      limped: "Limpani pot",
      "single-raised": "Pot s jednim raiseom",
      "3bet": "3-bet pot",
      "4bet+": "4-bet+ pot",
      bomb: "Bomb pot",
    } as Record<string, string>,
    roles: {
      unopened: "Prvi u pot",
      "vs-limp": "protiv limpa",
      "bb-option": "Opcija velikog blinda",
      "vs-open": "protiv otvaranja",
      squeeze: "Squeeze situacija",
      "vs-3bet": "protiv 3-beta",
      "vs-3bet-cold": "protiv 3-beta, hladno",
      "vs-4bet": "protiv 4-beta",
      pfr: "kao raiser",
      caller: "kao caller",
      limped: "u limpanom potu",
    } as Record<string, string>,
  },
  checker: {
    streets: { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", showdown: "Showdown" } as Record<string, string>,
    percent: (value: string) => `${value} %`,
    points: (value: string) => `${value} p. b.`,
    gap: (words: string, points: string) => `${words} · ${points}`,
    inRange: "U rasponu",
    notSure: "Još nije sigurno",
    noTarget: "Nema cilja",
    source: { charts: "Chartovi", solver: "Solver" } as Record<string, string>,
  },
  findings: {
    ref: { charts: "chartovi", solver: "solver" } as Record<string, string>,
    refOf: { charts: "chartova", solver: "solvera" } as Record<string, string>,
    verbs: {
      fold: { verb: "foldaš", noun: "foldova" },
      call: { verb: "callaš", noun: "callova" },
      raise: { verb: "raiseaš", noun: "raiseova" },
      bet: { verb: "betaš", noun: "betova" },
      vpip: { verb: "igraš", noun: "odigranih ruku" },
      pfr: { verb: "raiseaš", noun: "raiseova" },
    } as Record<string, { verb: string; noun: string }>,
    headline: {
      range: { loose: "Preflop igraš prelabavo", tight: "Preflop igraš pretijesno" },
      vs_open: { loose: "Previše se boriš protiv opena", tight: "Prelako puštaš openove" },
      vs_three_bet: { loose: "Previše se boriš protiv 3-betova", tight: "Prečesto odustaješ protiv 3-beta" },
      gives_up: { loose: "Nakon flopa previše plaćaš", tight: "Nakon flopa odustaješ od previše potova" },
      flop_raise: { loose: "Previše raiseaš na flopu", tight: "Rijetko raiseaš na flopu" },
      cbet: { loose: "Previše cbetaš i barrelaš", tight: "Kao preflop raiser prečesto odustaješ" },
      river_aggression: { loose: "Na riveru igraš preagresivno", tight: "Rijetko betaš ili raiseaš na riveru" },
    } as Record<string, { loose: string; tight: string }>,
    headlineByStat: {
      flop_raise_weak: {
        loose: "Previše tvojih raiseova na flopu su blefovi",
        tight: "Tvoji raiseovi na flopu gotovo su uvijek value",
      },
      river_bet_weak: { loose: "Previše tvojih betova na riveru su blefovi", tight: "Rijetko blefiraš na riveru" },
      river_raise_weak: {
        loose: "Previše tvojih raiseova na riveru su blefovi",
        tight: "Tvoji raiseovi na riveru gotovo su uvijek value",
      },
    } as Record<string, { loose: string; tight: string }>,
    fallbackHeadline: (stat: string, words: string) => `${stat}: ${words}`,
    why: {
      range: preflop,
      vs_open: preflop,
      vs_three_bet: preflop,
      gives_up: {
        loose: postflop.tight,
        tight: (w) => sentences(classLine(w, false), w.worth && `Call tamo vrijedi ${w.worth} bb po ruci.`, spotLine(w)),
      },
      flop_raise: postflop,
      cbet: postflop,
      river_aggression: postflop,
    } as Record<string, { loose: Why; tight: Why }>,
    fallbackWhy: ((w) => sentences(classLine(w, false), spotLine(w))) as Why,
  },
};
