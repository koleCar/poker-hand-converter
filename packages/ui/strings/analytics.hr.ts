/** The Analytics screen's words (docs/ANALYTICS.md), Croatian: `analytics.en.ts`'s shape. */

import type { AnalyticsStrings } from "../i18n";
import type { AnalyticsWhyWords } from "./analytics.en";
import { plural } from "./plural";

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
  screen: {
    tabsLabel: "Analitika",
    tabs: {
      overview: "Pregled",
      streets: "Ulice",
      stats: "Sve statistike",
      pool: "Pool",
      breakdown: "Raščlamba",
    } as Record<string, string>,
    later: {
      streets: "Od preflopa do rivera, blok po blok: još nije izrađeno.",
      pool: "Kako protivnici igraju prema tvojim ciljevima: još nije izrađeno.",
    } as Record<string, string>,
    figures: {
      label: "Rezultati na 100 ruku",
      hands: (count: number) => plural(count, "ruka", "ruke", "ruku"),
      won: "Dobiveno",
      allInEv: "All-in EV",
      showdown: "Showdown",
      nonShowdown: "Bez showdowna",
      per100: (unit: string) => `${unit}/100`,
      bb: "bb",
      unit: "Prikaži u",
    },
    graph: "Zarada kroz ruke",
    stats: {
      order: "Redoslijed",
      byStreet: "Po ulici",
      byCost: "Po cijeni",
      show: "Prikaži",
      all: "Sve statistike",
      off: "Izvan cilja",
      heads: {
        stat: "Statistika",
        you: "Ti",
        track: "Ciljni raspon · točka = ti",
        target: "Cilj",
        gap: "Razlika",
        times: "Puta",
      },
      range: (low: string, high: string) => `${low}–${high}`,
      analysed: (share: string) => `${share} analizirano`,
      loading: "Provjeravam tvoje statistike…",
      error: (reason: string) => `Statistike se nisu učitale: ${reason}`,
      pending: "Ciljevi se popunjavaju kako se ruke analiziraju.",
      partial: "Sve statistike prate datume, igru, jednu poziciju i jedan tip pota; ostali filteri ovdje se ne primjenjuju.",
      empty: "Još nema statistika uz ove filtere.",
      noneOff: "Uz ove filtere ništa nije jasno izvan cilja.",
      noSpots: "Još nema situacija za prikaz.",
      spots: {
        spot: "Situacija",
        you: "Ti · fold / call / raise",
        target: "Cilj",
      },
      key: "Gornja traka ti · donja cilj",
      bars: {
        fold: "Fold",
        call: "Call",
        raise: "Raise",
        bet: "Bet",
        play: "Igra",
        check: "Check",
        other: "Ostalo",
      },
      spotGap: (action: string, you: string, target: string) => `${action} ${you} prema ${target}`,
      barLabel: (who: string, parts: string) => `${who}: ${parts}`,
      you: "Ti",
      target: "Cilj",
      counts: {
        vpip: "VPIP: svaki preflop u kojem si svojevoljno uložio/la novac: call, bet ili raise.",
        pfr: "PFR: svaki preflop u kojem si raiseao/la.",
        rfi: "Open raise: svaki put kad su svi prije tebe foldali, a ti si prvi/a raiseao/la.",
        three_bet: "3-bet: svaki put kad si bio/la protiv jednog opena i ponovno raiseao/la.",
        bb_fold_vs_steal: "BB fold na steal: svaki steal protiv tvog big blinda na koji si foldao/la.",
        fold_to_three_bet: "Fold na 3-bet: svaki put kad je tvoj raise 3-betan, a ti si foldao/la.",
        four_bet: "4-bet: svaki put kad si bio/la protiv 3-beta i ponovno raiseao/la.",
        flop_fold_vs_bet: "Flop fold na bet: svaki flop na kojem si bio/la protiv beta i foldao/la, što god se dogodilo prije.",
        flop_raise_vs_bet: "Flop raise na bet: svaki flop na kojem si bio/la protiv beta i raiseao/la.",
        flop_raise_weak: "Flop raise · udio slabih: od tvojih raiseova na flopu, koliko ih je srednji par ili slabije.",
        cbet_flop: "Cbet: svaki flop nakon tvog preflop raisea na kojem je checkano do tebe, a ti si betao/la.",
        turn_fold_vs_bet: "Turn fold na bet: svaki turn na kojem si bio/la protiv beta i foldao/la.",
        turn_fold_vs_probe: "Turn fold na probe: raiseao/la si preflop, flop je checkan, a na bet na turnu si foldao/la.",
        turn_barrel: "Barrel: svaki turn nakon tvog cbeta na flopu na kojem si opet betao/la.",
        river_bet: "River bet: svaki river na kojem nitko nije betao, a ti si betao/la.",
        river_bet_weak: "River bet · udio slabih: od tvojih betova na riveru, koliko ih je treći par ili slabije.",
        river_fold_vs_bet: "River fold na bet: svaki river na kojem si bio/la protiv beta i foldao/la.",
        river_raise_vs_bet: "River raise na bet: svaki river na kojem si bio/la protiv beta i raiseao/la.",
        river_raise_weak: "River raise · udio slabih: od tvojih raiseova na riveru, koliko ih je srednji par ili slabije.",
        wtsd: "Došao/la do showdowna: od ruku u kojima si vidio/la flop, koliko ih je stiglo do showdowna.",
        wsd: "Dobio/la na showdownu: od ruku koje su stigle do showdowna, koliko si ih dobio/la.",
        wwsf: "Dobio/la nakon viđenog flopa: od ruku u kojima si vidio/la flop, koliko si ih dobio/la.",
      } as Record<string, string>,
      targetFrom: {
        charts: "Cilj: što chartovi rade s rukama koje si imao/la u istim situacijama.",
        solver: "Cilj: što Railov solver radi s rukama koje si imao/la, u istim situacijama i veličinama beta.",
        share: "Cilj: solverov vlastiti udio s rukama koje si imao/la.",
        none: "Nema cilja: ovo ovisi o kartama protivnika jednako kao o tvojima.",
      } as Record<string, string>,
    },
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
