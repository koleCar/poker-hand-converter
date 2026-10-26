/**
 * The desktop app's analysis rows (docs/RAIL-PLAN.md R5.4,
 * `app/src/analysis/rows.ts`): what the web's database does to a row on the
 * way in, done by the app before it stores one.
 *
 * - numbers as `numeric(p, s)` stores them: the JSON number's shortest
 *   spelling rounded half away from zero (held to `Intl.NumberFormat`'s
 *   `halfExpand` over the same decimal string - an independent decimal
 *   rounding - on thousands of values, and to known cases);
 * - `analysis_best_action`, `analysis_leak_spot_key` and
 *   `analysis_leak_chart_set` (R5.2's SQL) as the leak columns;
 * - the PHF as `hands_needing_analysis_recent` hands it to the worker;
 * - the row's fields exactly what `rail_store::HandAnalysisIn` reads.
 */
import { describe, expect, it } from "vitest";

import { bestAction, heroPositionOf, leakColumns, preflopFields, roundNumeric, storeRow, trimPhf } from "../../app/src/analysis/rows";
import { classIndex } from "../../packages/ui/charts/model";
import type { DecisionAnalysisInsert, HandAnalysisInsert } from "../../frontend/src/lib/db/analysisRows";
import type { PhfHand } from "../../frontend/src/lib/phf/types";

/** Postgres' numeric rounding of a JSON number, by another route: Intl over the decimal string. */
function postgres(value: number, scale: number): number {
  const format = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: scale,
    minimumFractionDigits: 0,
    roundingMode: "halfExpand",
    useGrouping: false,
  } as Intl.NumberFormatOptions);
  // A string is formatted as the exact decimal it spells (Intl.NumberFormat v3).
  const rounded = Number(format.format(String(value) as unknown as number));
  // A numeric has no negative zero.
  return rounded === 0 ? 0 : rounded;
}

describe("numbers as the web's numeric columns store them", () => {
  it("rounds the shortest spelling half away from zero", () => {
    // 1.0005 is 1.000499999... as a double: Postgres reads the text "1.0005".
    expect(roundNumeric(1.0005, 3)).toBe(1.001);
    expect((1.0005).toFixed(3)).toBe("1.000");
    expect(roundNumeric(2.675, 2)).toBe(2.68);
    expect(roundNumeric(0.125, 2)).toBe(0.13);
    expect(roundNumeric(-0.125, 2)).toBe(-0.13);
    expect(roundNumeric(9.9995, 3)).toBe(10);
    expect(roundNumeric(99.999, 2)).toBe(100);
    expect(roundNumeric(0.00049, 3)).toBe(0);
    expect(roundNumeric(0.0005, 3)).toBe(0.001);
    expect(roundNumeric(1e-7, 4)).toBe(0);
    expect(roundNumeric(5e-5, 4)).toBe(0.0001);
    expect(roundNumeric(1.5e21, 2)).toBe(1.5e21);
    expect(roundNumeric(12, 3)).toBe(12);
    expect(roundNumeric(0, 2)).toBe(0);
    expect(roundNumeric(null, 2)).toBeNull();
    expect(Object.is(roundNumeric(-0.0001, 3), -0)).toBe(false);
  });

  it("agrees with an independent decimal rounding on many values", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 20_000; i += 1) {
      const magnitude = 10 ** Math.floor(next() * 8 - 4);
      const value = (next() - 0.2) * magnitude;
      for (const scale of [2, 3, 4]) {
        expect(roundNumeric(value, scale), `${value} at ${scale}`).toBe(postgres(value, scale));
      }
    }
    // Exact halves at every scale.
    for (let n = 0; n < 2000; n += 1) {
      for (const scale of [2, 3, 4]) {
        const value = Number(`${n}.${"0".repeat(scale - 1)}5`) / 10 ** (n % 3);
        expect(roundNumeric(value, scale), `${value} at ${scale}`).toBe(postgres(value, scale));
      }
    }
  });
});

describe("the leak finder's columns", () => {
  const decision = (patch: Partial<DecisionAnalysisInsert>): DecisionAnalysisInsert =>
    ({
      ord: 0,
      action_index: 4,
      street: "preflop",
      action: "call",
      status: "analysed",
      reason: null,
      node: "x",
      scenario: "vs-open",
      source: "chart",
      grade: "mistake",
      score: 40,
      ev_loss_bb: 0.5,
      ev_loss_pot: 0.1,
      freq_diff: null,
      options: [
        { action: "fold", freq: 0.3, ev: 0 },
        { action: "raise", freq: 0.2, ev: 1.25 },
        { action: "call", freq: 0.5, ev: 1.25 },
      ],
      chosen: 2,
      flags: [],
      approximations: [],
      facing_bet: true,
      pot_bb: 4,
      pot_odds: 0.3,
      mdf: 0.6,
      facts: { scenario: "vs-open", position: "BB", chart: { line: "ffffr", set: "nlhe-cash-6max-100bb" } },
      ...patch,
    }) as DecisionAnalysisInsert;

  it("takes the best action as analysis_best_action does", () => {
    // Highest EV, ties to the higher frequency, then the first listed.
    expect(bestAction(decision({}).options)).toBe("call");
    expect(bestAction([{ action: "bet", freq: 0.5, ev: 1 }, { action: "check", freq: 0.5, ev: 1 }])).toBe("bet");
    expect(bestAction([{ action: "bet", freq: 0.5 }, { action: "check", freq: 0.1, ev: -3 }])).toBe("check");
    expect(bestAction([{ action: "allin", ev: 9 }, { action: "fold", ev: 0 }])).toBe("fold");
    expect(bestAction([{ action: "bet", freq: null, ev: null }, "x", null])).toBe("bet");
    expect(bestAction([])).toBeNull();
    expect(bestAction(null)).toBeNull();
  });

  it("keys the spot as analysis_leak_spot_key does", () => {
    expect(leakColumns(decision({}), "SB")).toEqual({
      spot_key: "preflop|vs-open|ffffr|BB|call|call",
      chart_set: "nlhe-cash-6max-100bb",
      best: "call",
    });
    // Off the charts: no line and no set; the seat falls back to the hand's.
    const flop = decision({ street: "flop", source: "solver", scenario: "ip-pfr", action: "bet", facts: { scenario: "ip-pfr", chart: { line: "ffffr", set: "nlhe-cash-6max-100bb" } } as never });
    expect(leakColumns(flop, "BTN")).toEqual({ spot_key: "flop|ip-pfr||BTN|bet|call", chart_set: "", best: "call" });
    // A line or a seat not of the shape is left empty, as the SQL's regular expressions leave it.
    const odd = decision({ facts: { scenario: "vs-open", position: "bb!", chart: { line: "ffxr", set: "Not A Set" } } as never });
    expect(leakColumns(odd, null)).toEqual({ spot_key: "preflop|vs-open|||call|call", chart_set: "", best: "call" });
    expect(leakColumns(decision({ options: [] }), null).spot_key).toBe("preflop|vs-open|ffffr|BB|call|");
  });

  it("files a preflop chart decision as preflop_decision_fields does (R5.3b)", () => {
    const facts = (patch: Record<string, unknown>) =>
      ({ scenario: "vs-open", position: "BB", handClass: "A9s", effStackBb: 104.5, chart: { line: "fffrf", set: "nlhe-cash-6max-100bb" }, ...patch }) as never;
    expect(preflopFields(decision({ facts: facts({}) }))).toEqual({
      chart_key: "vs-open:BB:BTN",
      chart_table: 6,
      hand_class: classIndex("A9s"),
      chart_action: "call",
      depth_band: 100,
    });
    // A bet is a raise; an all-in raise is `allin`; KAs reads as AKs; no stack is -1; a deep one stops at 990.
    expect(preflopFields(decision({ action: "bet", facts: facts({}) }))?.chart_action).toBe("raise");
    expect(preflopFields(decision({ action: "raise", facts: facts({ allIn: true }) }))?.chart_action).toBe("allin");
    expect(preflopFields(decision({ facts: facts({ handClass: "KAs" }) }))?.hand_class).toBe(classIndex("AKs"));
    expect(preflopFields(decision({ facts: facts({ effStackBb: null }) }))?.depth_band).toBe(-1);
    expect(preflopFields(decision({ facts: facts({ effStackBb: 4000 }) }))?.depth_band).toBe(990);
    expect(preflopFields(decision({ facts: facts({ chart: { line: "fffrf", set: "nlhe-cash-9max-150bb" } }) }))).toMatchObject({ chart_table: 9 });
    // A line the vocabulary does not name keeps an empty key.
    expect(preflopFields(decision({ facts: facts({ chart: { line: "rrr", set: "nlhe-cash-6max-100bb" } }) }))?.chart_key).toBe("");
    // Nothing for the straddle set, a bad line or class, another street or source.
    expect(preflopFields(decision({ facts: facts({ chart: { line: "fffrf", set: "nlhe-cash-6max-100bb-straddle" } }) }))).toBeNull();
    expect(preflopFields(decision({ facts: facts({ chart: { line: "fxr", set: "nlhe-cash-6max-100bb" } }) }))).toBeNull();
    expect(preflopFields(decision({ facts: facts({ handClass: "AA s" }) }))).toBeNull();
    expect(preflopFields(decision({ street: "flop", facts: facts({}) }))).toBeNull();
    expect(preflopFields(decision({ source: "heuristic", facts: facts({}) }))).toBeNull();
  });
});

describe("the hand the analysis reads", () => {
  it("is the stored PHF without the raw text and the actions' raw lines and labels", () => {
    const phf = {
      meta: { siteId: "pokerstars", rawText: "PokerStars Hand #1", parsedAt: "x" },
      players: [{ seat: 1, name: "Hero", isHero: true, position: "BTN" }],
      actions: [{ index: 0, type: "fold", rawLine: "Hero: folds", label: "folds", amount: 0 }],
    } as unknown as PhfHand;
    const trimmed = trimPhf(phf) as unknown as { meta: Record<string, unknown>; actions: Record<string, unknown>[] };
    expect(trimmed.meta).toEqual({ siteId: "pokerstars", parsedAt: "x" });
    expect(trimmed.actions).toEqual([{ index: 0, type: "fold", amount: 0 }]);
    expect((phf as unknown as { meta: Record<string, unknown> }).meta.rawText).toBe("PokerStars Hand #1");
    expect(heroPositionOf(phf)).toBe("BTN");
  });
});

describe("the row the store takes", () => {
  it("names exactly rail_store::HandAnalysisIn's and DecisionRowIn's fields", () => {
    const row: HandAnalysisInsert = {
      hand_id: "k1",
      analysis_version: "analysis/34",
      status: "full",
      reason: null,
      hero_seat: 2,
      grade: "good",
      score: 88.888,
      ev_loss_bb: 0.12345,
      ev_loss_pot: 0.012345,
      approximations: [],
      pot_type: "single-raised",
      decisions: [
        {
          ord: 0,
          action_index: 3,
          street: "flop",
          action: "bet",
          status: "analysed",
          reason: null,
          node: "n",
          scenario: "ip-pfr",
          source: "solver",
          grade: "good",
          score: 88.888,
          ev_loss_bb: 0.12345,
          ev_loss_pot: 0.012345,
          freq_diff: 0.33335,
          options: [],
          chosen: null,
          flags: [],
          approximations: [],
          facing_bet: false,
          pot_bb: 6.125,
          pot_odds: null,
          mdf: 0.6665,
          facts: { scenario: "ip-pfr" } as never,
        },
      ],
    };
    const stored = storeRow(row, "k1", "CO", true);
    expect(Object.keys(stored).sort()).toEqual(
      [
        "hand_key",
        "analysis_version",
        "status",
        "reason",
        "hero_seat",
        "grade",
        "score",
        "ev_loss_bb",
        "ev_loss_pot",
        "approximations",
        "pot_type",
        "hero_position",
        "flop_library",
        "decisions",
      ].sort(),
    );
    expect(Object.keys(stored.decisions[0]).sort()).toEqual(
      [
        "ord",
        "action_index",
        "street",
        "action",
        "status",
        "reason",
        "node",
        "scenario",
        "source",
        "grade",
        "score",
        "ev_loss_bb",
        "ev_loss_pot",
        "freq_diff",
        "options",
        "chosen",
        "flags",
        "approximations",
        "facing_bet",
        "pot_bb",
        "pot_odds",
        "mdf",
        "facts",
        "spot_key",
        "chart_set",
        "best",
        "preflop",
      ].sort(),
    );
    expect([stored.score, stored.ev_loss_bb, stored.ev_loss_pot]).toEqual([88.89, 0.123, 0.0123]);
    const d = stored.decisions[0];
    expect([d.score, d.ev_loss_bb, d.ev_loss_pot, d.freq_diff, d.pot_bb, d.mdf]).toEqual([88.89, 0.123, 0.0123, 0.3334, 6.13, 0.667]);
    expect(d.spot_key).toBe("flop|ip-pfr||CO|bet|");
    expect(stored.flop_library).toBe(true);
    // The library's own row is left as it was.
    expect(row.score).toBe(88.888);
  });
});
