/**
 * The Analytics screen's words (docs/ANALYTICS.md), English
 * (`AnalyticsStrings`). `analytics.hr.ts` is the same shape. Step 2 adds the
 * spot names (`analytics/spot.ts`); later steps add the screen's.
 */

export const analyticsUiEn = {
  spot: {
    versus: (hero: string, opponent: string) => `${hero} vs ${opponent}`,
    multi: "2+",
    anySeat: "Any seat",
    separator: " · ",
    pots: {
      limped: "Limped pot",
      "single-raised": "Single-raised pot",
      "3bet": "3-bet pot",
      "4bet+": "4-bet+ pot",
      bomb: "Bomb pot",
    } as Record<string, string>,
    roles: {
      unopened: "First in",
      "vs-limp": "vs a limp",
      "bb-option": "Big blind option",
      "vs-open": "vs an open",
      squeeze: "Squeeze spot",
      "vs-3bet": "vs a 3-bet",
      "vs-3bet-cold": "vs a 3-bet, cold",
      "vs-4bet": "vs a 4-bet",
      pfr: "as the raiser",
      caller: "as the caller",
      limped: "in a limped pot",
    } as Record<string, string>,
  },
};
