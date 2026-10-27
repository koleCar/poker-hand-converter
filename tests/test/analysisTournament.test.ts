/**
 * R5.5b: tournament hands graded by the push/fold game (`pushFoldGrade.ts`,
 * `analyzeTournament` in `analyze.ts`).
 *
 * Hands written in the standard text at a 50/100 level, read by the PHF
 * parser, so the analysis sees what a room's hand gives it: the stacks, the
 * posts, the line, a tournament header - and nothing about the payouts or
 * the field. The corpus's 574 tournament hands are swept for the rules that
 * must always hold.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  analyzeHand,
  grade,
  TOURNAMENT_SKIP_REASONS,
  type DecisionAnalysis,
  type HandAnalysis,
  type TournamentSettings,
} from "../../web/src/lib/analysis/index.js";
import { en } from "../../web/src/lib/i18n/en.js";
import { hr } from "../../web/src/lib/i18n/hr.js";
import { convertAny } from "../../web/src/lib/parsers/index.js";
import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import { shippedNodeKey } from "../../packages/ui/charts/nodeKey.js";
import { preflopFields } from "../../app/src/analysis/rows";
import { decisionRow } from "../../web/src/lib/db/analysisRows.js";
import { fullLibrary } from "./charts/support.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles, readTree, type CorpusFile } from "./support/psggCorpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const CHARTS = fullLibrary();

let n = 0;
/**
 * A tournament hand at 50/100 with a 10 ante; `seats` are `[seat, name, stack]`, the button on seat 1,
 * the blinds the next two seats. `lines` are the preflop actions after the posts.
 */
function hand(opts: {
  name?: string;
  id?: string;
  seats: Array<[number, string, number]>;
  hero: string;
  cards: string;
  lines: string[];
  maxSeats?: number;
  ante?: number;
  at?: string;
}): PhfHand {
  n += 1;
  const ante = opts.ante ?? 10;
  const [sb, bb] = [opts.seats[1][1], opts.seats[2 % opts.seats.length][1]];
  const headsUp = opts.seats.length === 2;
  const small = headsUp ? opts.seats[0][1] : sb;
  const big = headsUp ? opts.seats[1][1] : bb;
  const pot = opts.seats.length * ante + 150;
  const text = [
    `Poker Hand #TT${n}: Tournament (${opts.name ?? "$5 Regular 9-Max"})#${opts.id ?? "777"}, $5+$0.50 Hold'em No Limit - Level V (50/100) - ${opts.at ?? "2026/02/10 17:01:27"}`,
    `Table '777 1' ${opts.maxSeats ?? 9}-max Seat #1 is the button`,
    ...opts.seats.map(([seat, name, stack]) => `Seat ${seat}: ${name} (${stack} in chips)`),
    ...(ante > 0 ? opts.seats.map(([, name]) => `${name}: posts the ante ${ante}`) : []),
    `${small}: posts small blind 50`,
    `${big}: posts big blind 100`,
    "*** HOLE CARDS ***",
    `Dealt to ${opts.hero} [${opts.cards}]`,
    ...opts.lines,
    "*** SUMMARY ***",
    `Total pot ${pot} | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0`,
  ].join("\n");
  const parsed = parseStandardHand(text, CTX);
  if (!parsed) throw new Error(`fixture did not parse:\n${text}`);
  return parsed;
}

const analyse = (h: PhfHand, tournaments: ReadonlyMap<string, TournamentSettings> | null = null): HandAnalysis =>
  analyzeHand(structuredClone(h), { charts: CHARTS, tournaments });
const first = (a: HandAnalysis): DecisionAnalysis => a.decisions[0];

/** Four left of a nine-seat sit-and-go: the button (hero), the blinds and the cutoff. */
const BUBBLE: Array<[number, string, number]> = [
  [1, "Hero", 1000],
  [2, "Sb", 1500],
  [3, "Bb", 1200],
  [9, "Co", 800],
];

describe("a sit-and-go push", () => {
  const pushed = hand({
    seats: BUBBLE,
    hero: "Hero",
    cards: "Ah Td",
    lines: ["Co: folds", "Hero: raises 890 to 990 and is all-in", "Sb: folds", "Bb: folds", "Uncalled bet (890) returned to Hero", "Hero collected 370 from pot"],
  });
  const a = analyse(pushed);
  const d = first(a);

  it("is graded by ICM on the standard sit-and-go payouts, everyone left at the table", () => {
    expect(a.status).toBe("full");
    expect(d.source).toBe("icm");
    expect(d.status).toBe("analysed");
    expect(d.facts.scenario).toBe("push-fold");
    expect(d.facts.preflopScenario).toBe("unopened");
    const icm = d.facts.icm!;
    expect(icm).toMatchObject({
      model: "icm",
      kind: "sng",
      kindSource: "name",
      payouts: [50, 30, 20],
      payoutsSource: "standard",
      playersLeft: 4,
      playersLeftSource: "table",
      method: "exact",
      scenario: "push",
      pusher: null,
      key: "standard:777",
    });
    expect(icm.stacks.map((s) => [s.seat, s.stackBb, s.hero])).toEqual([
      [1, 10, true],
      [2, 15, false],
      [3, 12, false],
      [9, 8, false],
    ]);
    expect(icm.players.map((p) => p.position)).toEqual(["SB", "BB"]);
    for (const p of icm.players) {
      expect(p.bubbleFactor).toBeGreaterThan(1);
      expect(p.riskPremium).toBeGreaterThan(0);
      expect(p.callShare).toBeGreaterThan(0);
      expect(p.callShare).toBeLessThan(1);
    }
    expect(d.approximations).toEqual(["icm-payouts-assumed", "one-caller", "push-fold"]);
  });

  it("offers fold or all in, its EVs the prize equity at the average price of a big blind", () => {
    expect(d.options.map((o) => [o.action, o.allIn ?? false])).toEqual([
      ["fold", false],
      ["raise", true],
    ]);
    expect(d.chosen).toBe(1);
    const icm = d.facts.icm!;
    d.options.forEach((o, i) => expect(o.ev).toBeCloseTo((icm.equity.options[i] - icm.equity.start) / icm.bbValue, 1));
    // The button posted only its ante: folding costs its share of the pot it is not in, a little.
    expect(d.options[0].sizeBb).toBe(0);
    expect(d.options[1].sizeBb).toBe(9.9);
    // §2's grade from its own options, on the pot before the decision, no floor.
    const again = grade({ options: d.options, chosen: d.chosen!, pot: d.facts.potBb });
    expect(d.grade).toBe(again.grade);
    expect(d.evLoss).toBeCloseTo(again.evLoss, 3);
  });

  it("calls the same fold a blunder with aces, and is deterministic", () => {
    const folded = hand({
      seats: BUBBLE,
      hero: "Hero",
      cards: "Ah As",
      lines: ["Co: folds", "Hero: folds", "Sb: folds", "Bb: collected 190 from pot"],
    });
    const f = first(analyse(folded));
    expect(f.options[1].freq).toBe(1);
    expect(f.grade).toBe("blunder");
    expect(analyse(pushed)).toEqual(a);
  });
});

describe("a sit-and-go call off", () => {
  const call = (cards: string, action: "calls 790 and is all-in" | "folds") =>
    hand({
      seats: [
        [1, "Btn", 2000],
        [2, "Sb", 900],
        [3, "Hero", 1000],
        [9, "Co", 1100],
      ],
      hero: "Hero",
      cards,
      lines: ["Co: folds", "Btn: folds", "Sb: raises 790 to 890 and is all-in", `Hero: ${action}`],
    });

  it("is call or fold facing the small blind's push, with the matchup's price", () => {
    const d = first(analyse(call("Kd Qs", "calls 790 and is all-in")));
    expect(d.source).toBe("icm");
    expect(d.facts.scenario).toBe("push-fold-call");
    expect(d.options.map((o) => o.action)).toEqual(["fold", "call"]);
    expect(d.options[1].sizeBb).toBe(8.9);
    const icm = d.facts.icm!;
    expect(icm.scenario).toBe("call");
    expect(icm.pusher).toBe("SB");
    expect(icm.players).toHaveLength(1);
    expect(icm.players[0].seat).toBe(3);
    expect(icm.players[0].bubbleFactor).toBeGreaterThan(1);
    // The last to act: nobody behind, so no one-caller approximation.
    expect(d.approximations).not.toContain("one-caller");
  });

  it("folds trash and calls aces, as the equilibrium does", () => {
    expect(first(analyse(call("7d 2s", "folds"))).grade).toBe("perfect");
    expect(first(analyse(call("Ad As", "folds"))).grade).toBe("blunder");
    expect(first(analyse(call("Ad As", "calls 790 and is all-in"))).grade).toBe("perfect");
  });
});

describe("a multi-table tournament", () => {
  const seats: Array<[number, string, number]> = [
    [1, "Btn", 3000],
    [2, "Sb", 2500],
    [3, "Bb", 4000],
    [4, "Utg", 2000],
    [5, "Mp", 5000],
    [6, "Hero", 1200],
  ];
  const mtt = (cards: string) =>
    hand({
      name: "ILWP series - Main Event",
      id: "4242",
      seats,
      hero: "Hero",
      cards,
      maxSeats: 6,
      lines: ["Utg: folds", "Mp: folds", "Hero: raises 1090 to 1190 and is all-in", "Btn: folds", "Sb: folds", "Bb: folds"],
    });

  it("is graded in chips when nothing says how many are left, and says why", () => {
    const d = first(analyse(mtt("Kd Js")));
    const icm = d.facts.icm!;
    expect(icm).toMatchObject({ model: "chips", chipsReason: "players-left-unknown", kind: "mtt", kindSource: "assumed", payouts: null, method: "chips" });
    expect(d.approximations).toContain("icm-chip-ev");
    expect(d.approximations).not.toContain("icm-payouts-assumed");
    // In chips the big blind's price is the chips' own: a fold loses exactly the ante.
    expect(d.options[0].ev).toBeCloseTo(-0.1, 3);
    expect(icm.players.every((p) => p.bubbleFactor === 1 && p.riskPremium === 0)).toBe(true);
  });

  it("reads the user's settings: players left at the table, their payouts", () => {
    const settings: TournamentSettings = { payouts: [40, 25, 15, 10, 6, 4], playersLeft: [{ at: "2026-02-10T16:00:00Z", left: 6 }] };
    const key = "standard:4242";
    const d = first(analyse(mtt("Kd Js"), new Map([[key, settings]])));
    const icm = d.facts.icm!;
    expect(icm).toMatchObject({ model: "icm", payoutsSource: "user", playersLeft: 6, playersLeftSource: "user", payouts: [40, 25, 15, 10, 6, 4], others: null });
    expect(d.approximations).toContain("icm-players-left");
    expect(d.approximations).not.toContain("icm-chip-ev");
    // ICM is not chips: the fold is worth more than the ante's loss, the push less than in chips.
    const chips = first(analyse(mtt("Kd Js")));
    expect(d.options[1].ev - d.options[0].ev).toBeLessThan(chips.options[1].ev - chips.options[0].ev);
    // A point after the hand is not read.
    const later: TournamentSettings = { ...settings, playersLeft: [{ at: "2026-02-10T18:00:00Z", left: 6 }] };
    expect(first(analyse(mtt("Kd Js"), new Map([[key, later]]))).facts.icm!.model).toBe("chips");
    // Players away from the table at the average stack.
    const away = first(analyse(mtt("Kd Js"), new Map([[key, { ...settings, playersLeft: [{ at: "2026-02-10T16:00:00Z", left: 9 }] }]])));
    expect(away.facts.icm!.others).toEqual({ count: 3, stackBb: 29.5, source: "table" });
    expect(away.approximations).toContain("icm-field-average");
  });
});

describe("what is not push/fold", () => {
  const base = (lines: string[], stacks: [number, number, number, number] = [1000, 1500, 1200, 800], cards = "Ah Td") =>
    first(
      analyse(
        hand({
          seats: [
            [1, "Hero", stacks[0]],
            [2, "Sb", stacks[1]],
            [3, "Bb", stacks[2]],
            [9, "Co", stacks[3]],
          ],
          hero: "Hero",
          cards,
          lines,
        }),
      ),
    );

  it("names the reason, and grades nothing", () => {
    const minRaise = base(["Co: folds", "Hero: raises 100 to 200", "Sb: folds", "Bb: folds"]);
    expect([minRaise.status, minRaise.reason, minRaise.grade, minRaise.source]).toEqual(["not-analysed", "tournament-not-push-fold", null, "heuristic"]);
    const limp = base(["Co: folds", "Hero: calls 100", "Sb: folds", "Bb: checks"]);
    expect(limp.reason).toBe("tournament-not-push-fold");
    const facingOpen = base(["Co: raises 100 to 200", "Hero: folds", "Sb: folds", "Bb: folds"]);
    expect(facingOpen.reason).toBe("tournament-not-push-fold");
    const deep = base(["Co: folds", "Hero: raises 3890 to 3990 and is all-in", "Sb: folds", "Bb: folds"], [4000, 3000, 5000, 800]);
    expect(deep.reason).toBe("tournament-deep");
    // The cutoff (0.4bb behind its ante) could call before the blinds: a side pot the one-caller game cannot read.
    const sidePot = first(
      analyse(
        hand({
          seats: [
            [1, "Btn", 1500],
            [2, "Sb", 1500],
            [3, "Bb", 1200],
            [8, "Hero", 1000],
            [9, "Co", 50],
          ],
          hero: "Hero",
          cards: "Ah Td",
          lines: ["Hero: raises 890 to 990 and is all-in", "Co: folds", "Btn: folds", "Sb: folds", "Bb: folds"],
        }),
      ),
    );
    expect(sidePot.reason).toBe("tournament-side-pot");
  });

  it("leaves every postflop decision ungraded", () => {
    const h = hand({
      seats: BUBBLE,
      hero: "Hero",
      cards: "Ah Td",
      lines: ["Co: folds", "Hero: raises 100 to 200", "Sb: folds", "Bb: calls 100", "*** FLOP *** [2c 7d 9h]", "Bb: checks", "Hero: bets 200", "Bb: folds"],
    });
    const a = analyse(h);
    expect(a.status).toBe("not-analysed");
    expect(a.decisions.map((d) => d.reason)).toEqual(["tournament-not-push-fold", "tournament-postflop"]);
  });
});

describe("the user's own charts read push/fold decisions (R5.3)", () => {
  it("files a push as the table's open and a call as facing the pusher's open", () => {
    const push = first(analyse(hand({ seats: BUBBLE, hero: "Hero", cards: "Ah Td", lines: ["Co: folds", "Hero: raises 890 to 990 and is all-in", "Sb: folds", "Bb: folds"] })));
    // Four players read on six seats, the two earliest folded: UTG, HJ fold, the cutoff folds, the button opens.
    expect(push.facts.icm!.chart).toEqual({ set: "icm-pushfold-6max", line: "fff" });
    expect(shippedNodeKey(push.facts.icm!.chart!.set, push.facts.icm!.chart!.line)).toBe("rfi:BTN");
    const call = first(
      analyse(
        hand({
          seats: [
            [1, "Btn", 2000],
            [2, "Sb", 900],
            [3, "Hero", 1000],
            [9, "Co", 1100],
          ],
          hero: "Hero",
          cards: "Kd Qs",
          lines: ["Co: folds", "Btn: folds", "Sb: raises 790 to 890 and is all-in", "Hero: folds"],
        }),
      ),
    );
    expect(call.facts.icm!.chart).toEqual({ set: "icm-pushfold-6max", line: "ffffa" });
    expect(shippedNodeKey(call.facts.icm!.chart!.set, call.facts.icm!.chart!.line)).toBe("vs-open:BB:SB");
    // The app files them as the web's `preflop_decision_fields` does (pgTAP `tournament_icm`).
    // ATo is cell 4 x 13 + 0 of the grid (offsuit below the diagonal).
    expect(preflopFields(decisionRow(push))).toMatchObject({ chart_key: "rfi:BTN", chart_table: 6, hand_class: 52, chart_action: "allin" });
    expect(preflopFields(decisionRow(call))).toMatchObject({ chart_key: "vs-open:BB:SB", chart_table: 6, chart_action: "fold" });
  });
});

/* ------------------------------------------------------------- the corpus - */

const ROOT = join(import.meta.dirname, "../..");
const FILES: CorpusFile[] = [
  ...ggCorpusFiles(),
  ...weplayFiles(),
  ...readTree(join(ROOT, "fixtures/samples"), "fixtures/samples"),
  ...readTree(join(import.meta.dirname, "fixtures"), "tests/test/fixtures"),
];
const TOURNAMENTS: PhfHand[] = (
  await Promise.all(
    FILES.map(async (file) => {
      try {
        return (await convertAny(file.text, { sourceFilename: file.name })).hands;
      } catch {
        return [];
      }
    }),
  )
)
  .flat()
  .filter((h) => h.game.format !== "cash");

describe("the corpus's tournament hands", { timeout: 120_000 }, () => {
  const results = TOURNAMENTS.map((h) => ({ h, a: analyse(h) }));

  it("are read: the No-Limit Hold'em ones graded where push/fold reaches, every other decision with a reason", () => {
    expect(results.length).toBeGreaterThan(500);
    const decisions = results.flatMap((r) => r.a.decisions);
    const graded = decisions.filter((d) => d.grade !== null);
    expect(graded.length).toBeGreaterThan(50);
    for (const d of decisions) {
      if (d.grade !== null) {
        expect(d.source).toBe("icm");
        expect(d.street).toBe("preflop");
        expect(d.facts.icm).toBeTruthy();
        expect(d.approximations).toContain("push-fold");
        const again = grade({ options: d.options, chosen: d.chosen!, pot: d.facts.potBb });
        expect(d.grade).toBe(again.grade);
        expect(["fold", "raise", "call"]).toContain(d.action);
      } else {
        expect(d.status).toBe("not-analysed");
        expect(TOURNAMENT_SKIP_REASONS as readonly string[]).toContain(d.reason);
      }
    }
    // Nothing is left with the old blanket reason.
    for (const { h, a } of results) {
      if (h.game.variant === "holdem" && h.game.limit === "nl" && !h.game.hiLo && a.decisions.length > 0) expect(a.reason).not.toBe("tournament");
    }
  });

  it("are explained in both languages, the grade and the model named", () => {
    for (const d of results.flatMap((r) => r.a.decisions)) {
      for (const dict of [en, hr]) {
        const text = dict.analysis.explain(d).join(" ");
        expect(text).not.toMatch(/undefined|NaN|null|\[object/);
        if (d.grade) {
          expect(text).toContain(dict.analysis.grades[d.grade]);
          expect(text).toMatch(d.facts.icm!.model === "chips" ? /chips|žeton/ : /ICM/);
        } else {
          expect(dict.analysis.reasons[d.reason!]).toBeTruthy();
        }
      }
    }
  });

  it("are graded in chips where the hand gives no payouts or players left, by ICM at a sit-and-go", () => {
    const icm = results.flatMap((r) => r.a.decisions).filter((d) => d.facts.icm);
    expect(icm.some((d) => d.facts.icm!.model === "chips" && d.facts.icm!.chipsReason === "players-left-unknown")).toBe(true);
    expect(icm.some((d) => d.facts.icm!.model === "icm" && d.facts.icm!.kind === "sng")).toBe(true);
    for (const d of icm) {
      expect(d.facts.icm!.gapBb).toBeLessThan(0.5);
      expect(JSON.stringify(d.facts).length).toBeLessThan(16_384);
    }
  });
});
