/** The Analytics screen's words (docs/ANALYTICS.md), Croatian: `analytics.en.ts`'s shape. */

import type { AnalyticsStrings } from "../i18n";

export const analyticsUiHr: AnalyticsStrings = {
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
};
