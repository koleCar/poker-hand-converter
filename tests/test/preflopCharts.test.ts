/**
 * The user's own preflop charts (R5.3, `packages/ui/charts/`): the pure core.
 *
 * - The model: classes, keys, plausibility per table, the stored shape and
 *   its checks (the database holds the same: pgTAP `preflop_charts`).
 * - Range text in and out: shorthand, weights, GTO+ brackets, combos, lists,
 *   malformed input; round trips.
 * - Rail JSON in and out, a situation's text import, over-100 refused.
 * - Situation keys of the shipped trees: every node of every plain shipped
 *   set keyed consistently with its own scenario facts, and the cases pgTAP
 *   checks the database's `preflop_chart_node_key` against are the
 *   TypeScript's answers.
 * - The comparison and the session review's own-chart deviation source.
 *
 * The screens are `preflopChartsScreen.test.ts`'s; the 375 px pass is
 * `responsive.mjs`'s.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { chartBest, chartPercent, compareChart, OFF_CHART_BELOW_PERCENT, type PlayedCell } from "@rail/ui/charts/compare";
import { exportRailJson, exportRailJsonText, importNodeText, importRailJson, overHundred } from "@rail/ui/charts/exchange";
import {
  CLASS_COUNT,
  CLASS_NAMES,
  LIMITS,
  TABLE_POSITIONS,
  actionsOf,
  classAt,
  classIndex,
  comboShare,
  combosOf,
  emptyNode,
  formatNodeKey,
  fromBase64,
  fromStored,
  isPlausible,
  newChartSet,
  nodeFromMix,
  nodeKeysFor,
  parseNodeKey,
  percentOf,
  restActionOf,
  toBase64,
  toStored,
  validateChartSet,
  type ChartSet,
  type TableSize,
} from "@rail/ui/charts/model";
import { nodeKeyOfLine, seatsOfShippedSet, shippedNodeKey } from "@rail/ui/charts/nodeKey";
import { comboClass, expandToken, formatBrackets, formatCombos, formatRange, parseRange, shorthand } from "@rail/ui/charts/ranges";
import { inChartScope, ownChartDecisions, ownChartDeviations, type SessionPreflopDecision } from "@rail/ui/charts/sessionSource";
import type { ReviewHand, SessionReview } from "@rail/ui/review/model";

import { CHART_SETS, handClassOf } from "../../web/src/lib/charts/index.js";
import { chartSet } from "./charts/support.js";

const percents = (text: string): Uint8Array => {
  const parsed = parseRange(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.percents;
};
const at = (p: Uint8Array, name: string) => p[classIndex(name)];

/* ---------------------------------------------------------------- model - */

describe("the model", () => {
  it("names the 169 classes in the shipped charts' order", () => {
    expect(CLASS_NAMES).toHaveLength(169);
    expect(new Set(CLASS_NAMES).size).toBe(169);
    expect(classAt(0, 0)).toBe("AA");
    expect(classAt(0, 1)).toBe("AKs");
    expect(classAt(1, 0)).toBe("AKo");
    expect(classAt(12, 12)).toBe("22");
    for (const name of CLASS_NAMES) expect(classIndex(name)).toBe(handClassOf(name));
    expect(classIndex("KAs")).toBe(classIndex("AKs"));
    expect(classIndex("AA2")).toBe(-1);
    expect(CLASS_NAMES.reduce((sum, _, i) => sum + combosOf(i), 0)).toBe(1326);
  });

  it("keys situations in the shipped vocabulary, only where a table can have them", () => {
    expect(formatNodeKey({ scenario: "rfi", hero: "CO", vs: null })).toBe("rfi:CO");
    expect(parseNodeKey("vs-open:BB:BTN", 6)).toEqual({ scenario: "vs-open", hero: "BB", vs: "BTN" });
    expect(parseNodeKey("vs-open:BTN:BB", 6)).toBeNull(); // the big blind does not open
    expect(parseNodeKey("rfi:BB", 6)).toBeNull();
    expect(parseNodeKey("rfi:LJ", 6)).toBeNull(); // a 9-max seat
    expect(parseNodeKey("rfi:LJ", 9)).not.toBeNull();
    expect(parseNodeKey("squeeze:SB:BTN", 6)).toBeNull(); // nobody between to call
    expect(parseNodeKey("squeeze:BB:CO", 6)).not.toBeNull();
    expect(parseNodeKey("vs-3bet:CO:BTN", 6)).not.toBeNull();
    expect(parseNodeKey("vs-3bet:BTN:CO", 6)).toBeNull(); // the 3-bettor acts after the opener
    expect(parseNodeKey("vs-4bet:BTN:CO", 6)).not.toBeNull();
    expect(parseNodeKey("vs-iso:SB:BB", 2)).not.toBeNull();
    expect(parseNodeKey("bogus:CO", 6)).toBeNull();
    expect(nodeKeysFor(6)).toHaveLength(105);
    expect(nodeKeysFor(9)).toHaveLength(252);
    expect(nodeKeysFor(2).map(formatNodeKey)).toEqual([
      "rfi:SB",
      "vs-limp:BB:SB",
      "vs-open:BB:SB",
      "vs-iso:SB:BB",
      "vs-3bet:SB:BB",
      "vs-4bet:BB:SB",
      "vs-allin:SB:BB",
    ]);
    for (const size of [2, 6, 9] as TableSize[]) {
      for (const key of nodeKeysFor(size)) expect(parseNodeKey(formatNodeKey(key), size)).toEqual(key);
    }
  });

  it("knows the rest action and what each situation can store", () => {
    const bbLimp = parseNodeKey("vs-limp:BB:SB", 6)!;
    expect(restActionOf(bbLimp)).toBe("check");
    expect(actionsOf(bbLimp)).toEqual(["raise", "allin"]);
    expect(restActionOf(parseNodeKey("vs-limp:BTN:CO", 6)!)).toBe("fold");
    expect(actionsOf(parseNodeKey("rfi:SB", 6)!)).toEqual(["raise", "call", "allin"]);
  });

  it("encodes 169 percents as Postgres-readable base64 and back", () => {
    const bytes = new Uint8Array(169).map((_, i) => i % 101);
    const text = toBase64(bytes);
    expect(text).toHaveLength(228);
    expect(text.endsWith("==")).toBe(true);
    expect(text).toMatch(/^[A-Za-z0-9+/]{226}==$/);
    expect(fromBase64(text, 169)).toEqual(bytes);
    expect(Buffer.from(text, "base64")).toEqual(Buffer.from(bytes));
    expect(fromBase64(text, 168)).toBeNull();
    expect(fromBase64(`${text.slice(0, -3)}!==`, 169)).toBeNull();
  });

  it("round-trips the stored shape and refuses what the database refuses", () => {
    const set = newChartSet({ name: "  Mine  ", tableSize: 6 });
    const node = emptyNode();
    node.freq.raise.set(percents("22+,A2s+,KTs+,AJo+:0.5"));
    node.raiseBb = 2.5;
    set.nodes.set("rfi:CO", node);
    const stored = toStored(set);
    expect(stored.name).toBe("Mine");
    expect(Object.keys(stored.nodes["rfi:CO"])).toEqual(["raise", "raiseBb"]); // all-zero actions left out
    const back = fromStored({ ...stored, id: "x", updated_at: "2026-10-01T00:00:00Z" });
    expect(back.nodes.get("rfi:CO")!.freq.raise).toEqual(node.freq.raise);
    expect(back.nodes.get("rfi:CO")!.raiseBb).toBe(2.5);
    expect(() => fromStored({ ...stored, format_version: 2 })).toThrow(/version/);
    expect(() => fromStored({ ...stored, nodes: { "rfi:LJ": {} } })).toThrow(/node-key/);
    expect(() => fromStored({ ...stored, nodes: { "rfi:CO": { raise: "AAAA" } } })).toThrow(/node-data/);

    expect(validateChartSet(set)).toEqual([]);
    const bad = newChartSet({ name: "", stackMinBb: 200, stackMaxBb: 100 });
    const over = emptyNode();
    over.freq.raise[0] = 70;
    over.freq.call[0] = 40;
    bad.nodes.set("rfi:CO", over);
    const limp = emptyNode();
    limp.freq.call[3] = 10;
    bad.nodes.set("vs-limp:BB:SB", limp);
    expect(validateChartSet(bad).map((p) => p.code)).toEqual(["name", "stack-range", "over-100", "action-not-allowed"]);
    expect(LIMITS.nodes).toBeGreaterThanOrEqual(nodeKeysFor(9).length);
  });

  it("reads percents per action, the rest being fold or check, and the combo share", () => {
    const node = emptyNode();
    node.freq.raise[classIndex("AA")] = 100;
    node.freq.raise[classIndex("AKo")] = 25;
    node.freq.call[classIndex("AKo")] = 25;
    expect(percentOf(node, "fold", classIndex("AKo"))).toBe(50);
    expect(percentOf(node, "raise", classIndex("AA"))).toBe(100);
    expect(comboShare(node, "raise")).toBeCloseTo((6 + 3) / 1326, 10);
  });

  it("turns a shipped mix into whole percents that never pass 100", () => {
    const freq = new Float64Array(3 * CLASS_COUNT);
    for (let c = 0; c < CLASS_COUNT; c += 1) {
      freq[c] = 1 / 3; // fold
      freq[CLASS_COUNT + c] = 1 / 3; // call
      freq[2 * CLASS_COUNT + c] = 1 / 3; // raise
    }
    const node = nodeFromMix(["fold", "call", "raise"], freq);
    expect(node.freq.call[0] + node.freq.raise[0]).toBeLessThanOrEqual(100);
    expect(node.freq.call[0]).toBe(33);
    expect(overHundred(node)).toBe(-1);
  });
});

/* --------------------------------------------------------------- ranges - */

describe("range text", () => {
  it("expands the usual shorthand", () => {
    expect(expandToken("QQ+")).toEqual(["AA", "KK", "QQ"]);
    expect(expandToken("55-22")).toEqual(["55", "44", "33", "22"]);
    expect(expandToken("22-55")).toEqual(["55", "44", "33", "22"]);
    expect(expandToken("ATs+")).toEqual(["AKs", "AQs", "AJs", "ATs"]);
    expect(expandToken("A5s-A2s")).toEqual(["A5s", "A4s", "A3s", "A2s"]);
    expect(expandToken("K9o+")).toEqual(["KQo", "KJo", "KTo", "K9o"]);
    expect(expandToken("KT+")).toEqual(["KQs", "KQo", "KJs", "KJo", "KTs", "KTo"]);
    expect(expandToken("TA")).toEqual(["ATs", "ATo"]);
    expect(expandToken("AA-KQ")).toBeNull();
    expect(expandToken("A5s-K2s")).toBeNull();
    expect(expandToken("XYZ")).toBeNull();
  });

  it("reads weights: PIO fractions, percents, GTO+ brackets and lists", () => {
    const p = percents("AA,KK:0.5,QQ:75,JJ:25%,[40]TT,99[/40],[50]88:0.5[/50]");
    expect(at(p, "AA")).toBe(100);
    expect(at(p, "KK")).toBe(50);
    expect(at(p, "QQ")).toBe(75);
    expect(at(p, "JJ")).toBe(25);
    expect(at(p, "TT")).toBe(40);
    expect(at(p, "99")).toBe(40);
    expect(at(p, "88")).toBe(25);
    const list = percents("AKs 0.5\nAQs\t50%\nAJs 1\nKQo");
    expect([at(list, "AKs"), at(list, "AQs"), at(list, "AJs"), at(list, "KQo")]).toEqual([50, 50, 100, 100]);
    expect(at(percents("AKs:0.333"), "AKs")).toBe(33);
    expect(at(percents("AKs:0.335"), "AKs")).toBe(34);
  });

  it("collapses combo weights into class weights", () => {
    expect(comboClass("AhKh")).toBe(classIndex("AKs"));
    expect(comboClass("KdAc")).toBe(classIndex("AKo"));
    expect(comboClass("AhAh")).toBe(-1);
    const p = percents("AhKh,AsKs:0.5,AcAd,AhAs,QhJd:0.6");
    expect(at(p, "AKs")).toBe(38); // (1 + 0.5) / 4
    expect(at(p, "AA")).toBe(33); // 2 of 6
    expect(at(p, "QJo")).toBe(5); // 0.6 / 12
    const all = percents(formatCombos(percents("AKs,77:0.5")));
    expect(at(all, "AKs")).toBe(100);
    expect(at(all, "77")).toBe(50);
  });

  it("names the token that cannot be read", () => {
    const bad = parseRange("AA, KK, AXs, QQ:2.5x, JJ:0.5:1, [50]TT");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.map((p) => p.token)).toEqual(expect.arrayContaining(["AXs", "QQ:2.5x", "JJ:0.5:1"]));
      expect(bad.problems.some((p) => p.code === "bracket")).toBe(true);
    }
    expect(parseRange("AA:150").ok).toBe(false);
    expect(parseRange("").ok).toBe(true);
  });

  it("writes the shorthand back, and every format round-trips", () => {
    const members = new Set(["AA", "KK", "QQ", "99", "88", "AKs", "AQs", "AJs", "A5s", "A4s", "KQo"].map(classIndex));
    expect(shorthand(members)).toEqual(["QQ+", "99-88", "AJs+", "A5s-A4s", "KQo"]);
    const range = percents("22+,A2s+,K9s+,QTs+,J9s+,T9s,98s:0.5,87s:0.25,ATo+,KJo+,AhKh");
    expect(formatRange(range)).toBe("22+,A2s+,K9s+,QTs+,J9s+,T9s,ATo+,KJo+,98s:0.5,87s:0.25");
    expect(formatBrackets(range)).toBe("22+,A2s+,K9s+,QTs+,J9s+,T9s,ATo+,KJo+,[50]98s[/50],[25]87s[/25]");
    for (const text of [formatRange(range), formatBrackets(range), formatCombos(range)]) {
      expect(percents(text)).toEqual(range);
    }
    // Any percent pattern survives the text form.
    const random = new Uint8Array(169).map((_, i) => (i * 37) % 101);
    expect(percents(formatRange(random))).toEqual(random);
    expect(percents(formatBrackets(random))).toEqual(random);
    expect(percents(formatCombos(random))).toEqual(random);
    expect(formatRange(new Uint8Array(169))).toBe("");
  });
});

/* ------------------------------------------------------------- exchange - */

describe("Rail JSON and a situation's text", () => {
  const sample = (): ChartSet => {
    const set = newChartSet({ name: "6-max 100bb", tableSize: 6, stackMinBb: 80, stackMaxBb: 130 });
    const rfi = emptyNode();
    rfi.freq.raise.set(percents("22+,A2s+,K9s+,ATo+:0.5"));
    rfi.raiseBb = 2.5;
    set.nodes.set("rfi:CO", rfi);
    const vs = emptyNode();
    vs.freq.raise.set(percents("QQ+,AKs,A5s:0.5"));
    vs.freq.call.set(percents("JJ-22,AQs-A6s,KQs,A5s:0.5"));
    vs.freq.allin.set(percents("AKo:0.1"));
    set.nodes.set("vs-open:BB:BTN", vs);
    return set;
  };

  it("round-trips a set", () => {
    const set = sample();
    const json = exportRailJson(set);
    expect(json.format).toBe("rail-preflop-charts");
    expect(json.nodes[0]).toEqual({ key: "rfi:CO", raise: "22+,A2s+,K9s+,ATo+:0.5", call: "", allin: "", raiseBb: 2.5 });
    const back = importRailJson(exportRailJsonText(set));
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.value.name).toBe(set.name);
      expect(back.value.tableSize).toBe(6);
      expect([back.value.stackMinBb, back.value.stackMaxBb]).toEqual([80, 130]);
      for (const [key, node] of set.nodes) expect(back.value.nodes.get(key)!.freq).toEqual(node.freq);
      expect(back.value.id).toBeNull();
    }
  });

  it("refuses a malformed file with the reason and the place", () => {
    const fail = (text: string) => {
      const r = importRailJson(text);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.problems;
    };
    expect(fail("{nope")[0].code).toBe("json");
    expect(fail('{"format":"other"}')[0].code).toBe("format");
    expect(fail('{"format":"rail-preflop-charts","version":2}')[0].code).toBe("version");
    expect(fail('{"format":"rail-preflop-charts","version":1,"game":{"format":"cash","tableSize":7,"stackBb":[1,2]}}')[0].code).toBe("game");
    const base = { format: "rail-preflop-charts", version: 1, name: "x", game: { format: "cash", tableSize: 6, stackBb: [80, 120] } };
    const problems = fail(
      JSON.stringify({
        ...base,
        nodes: [
          { key: "rfi:LJ", raise: "AA" },
          { key: "rfi:CO", raise: "AA,ZZ" },
          { key: "rfi:HJ", raise: "AA", call: "AA" },
          { key: "vs-limp:BB:SB", call: "AA" },
        ],
      }),
    );
    expect(problems.map((p) => [p.code, p.where])).toEqual([
      ["node-key", "rfi:LJ"],
      ["range", "rfi:CO raise"],
      ["over-100", "rfi:HJ"],
      ["node-key", "vs-limp:BB:SB call"],
    ]);
    expect(fail(JSON.stringify({ ...base, nodes: [{ key: "rfi:CO" }, { key: "rfi:CO" }] }))[0].code).toBe("duplicate");
  });

  it("imports one situation from range text per action", () => {
    const key = parseNodeKey("vs-open:BB:BTN", 6)!;
    const ok = importNodeText(key, { raise: "[50]AA[/50]", call: "AA:0.5,KK" });
    expect(ok.ok).toBe(true);
    const over = importNodeText(key, { raise: "AA", call: "AA:0.01" });
    expect(over.ok ? null : over.problems[0]).toEqual({ code: "over-100", where: "vs-open:BB:BTN", detail: "AA" });
  });
});

/* --------------------------------------------------------- situation keys - */

const PLAIN_SETS = CHART_SETS.map((s) => s.id).filter((id) => seatsOfShippedSet(id) !== null);

describe("situation keys of the shipped trees", () => {
  it("reads the plain sets and not the straddle set", () => {
    expect(PLAIN_SETS).toHaveLength(CHART_SETS.length - 1);
    expect(seatsOfShippedSet("nlhe-cash-6max-100bb-straddle")).toBeNull();
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "fffrf")).toBe("vs-open:BB:BTN");
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "")).toBe("rfi:UTG");
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "ffffc")).toBe("vs-limp:BB:SB");
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "rffffr")).toBe("vs-3bet:UTG:BB");
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "rcf")).toBe("squeeze:BTN:UTG");
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "rcffffr")).toBeNull(); // the opener facing a squeeze
    expect(shippedNodeKey("nlhe-cash-6max-100bb", "rfr")).toBeNull(); // a cold 4-bet
    expect(shippedNodeKey("nlhe-cash-6max-100bb-straddle", "")).toBeNull();
    expect(shippedNodeKey("nlhe-cash-hu-100bb", "crrra")).toBeNull(); // a limped pot after the iso
    expect(shippedNodeKey("nlhe-cash-hu-100bb", "rrra")).toBe("vs-allin:SB:BB");
  });

  it.each(PLAIN_SETS)("keys every node of %s by its own scenario, actor and villain", (id) => {
    const set = chartSet(id);
    const table = seatsOfShippedSet(id)!;
    let keyed = 0;
    for (const node of set.nodes.values()) {
      const key = nodeKeyOfLine(node.line, table.seats);
      if (!key) {
        // Unnamed: a cold re-raise, a raise over limpers faced by a non-limper,
        // or a re-raised pot with a limper or a caller in it.
        const named =
          node.scenario === "rfi" ||
          node.scenario === "vs-limp" ||
          node.scenario === "vs-iso" ||
          ((node.scenario === "vs-open" || node.scenario === "squeeze") && node.limpers.length === 0);
        expect(named, `${id} ${node.line}`).toBe(false);
        continue;
      }
      keyed += 1;
      expect(key.scenario, `${id} ${node.line}`).toBe(node.scenario);
      expect(key.hero).toBe(node.actor);
      expect(key.vs).toBe(node.scenario === "rfi" ? null : node.scenario === "vs-limp" ? node.limpers[0] : node.facing!.position);
      expect(node.cold, `${id} ${node.line}`).toBe(false);
      expect(isPlausible(key, table.tableSize), `${id} ${node.line}`).toBe(true);
    }
    expect(keyed).toBeGreaterThan(5);
  });

  it("covers every RFI, vs-open and 3-bet key of the 6-max and 9-max tables at 100bb", () => {
    for (const id of ["nlhe-cash-6max-100bb", "nlhe-cash-9max-100bb"]) {
      const table = seatsOfShippedSet(id)!;
      const keys = new Set([...chartSet(id).nodes.values()].map((n) => nodeKeyOfLine(n.line, table.seats)).filter(Boolean).map((k) => formatNodeKey(k!)));
      for (const key of nodeKeysFor(table.tableSize)) {
        if (key.scenario === "rfi" || key.scenario === "vs-open") expect(keys.has(formatNodeKey(key)), `${id} ${formatNodeKey(key)}`).toBe(true);
      }
    }
  });

  it("gives the answers the database is held to (pgTAP preflop_charts_compare's cases)", () => {
    const sql = readFileSync(join(import.meta.dirname, "../../supabase/tests/database/preflop_charts_compare.test.sql"), "utf8");
    const block = sql.slice(sql.indexOf("-- KEY CASES BEGIN"), sql.indexOf("-- KEY CASES END"));
    const cases = [...block.matchAll(/\('([a-z0-9-]+)', '([fkcra]*)', (null|'[^']*')\)/g)];
    expect(cases.length).toBeGreaterThan(900);
    for (const [, set, line, key] of cases) {
      expect(shippedNodeKey(set, line), `${set} ${line}`).toBe(key === "null" ? null : key.slice(1, -1));
    }
    // Every keyed node of the 6-max 100bb and heads-up sets is among them.
    const listed = new Set(cases.map(([, set, line]) => `${set}|${line}`));
    for (const id of ["nlhe-cash-6max-100bb", "nlhe-cash-hu-100bb"]) {
      for (const node of chartSet(id).nodes.values()) expect(listed.has(`${id}|${node.line}`), `${id} ${node.line}`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------- compare - */

function chart(): ChartSet {
  const set = newChartSet({ id: "c1", name: "Mine", tableSize: 6, stackMinBb: 80, stackMaxBb: 120 });
  const rfi = emptyNode();
  rfi.freq.raise.set(percents("22+,ATs+,KQs,AJo+"));
  set.nodes.set("rfi:CO", rfi);
  const bb = emptyNode();
  bb.freq.raise.set(percents("QQ+,AKs"));
  bb.freq.call.set(percents("JJ-22,AQs-A2s,AKo:0.5"));
  set.nodes.set("vs-open:BB:BTN", bb);
  const fiveBet = emptyNode();
  fiveBet.freq.raise.set(percents("KK+")); // "raise" standing for the shove
  set.nodes.set("vs-4bet:BTN:CO", fiveBet);
  return set;
}

const cell = (key: string, name: string, action: PlayedCell["action"], decisions: number, evLossBb = 0): PlayedCell => ({
  key,
  cls: classIndex(name),
  action,
  decisions,
  evLossBb,
});

describe("the comparison", () => {
  it("reads the chart's percent for the hero's action, raise and all-in standing for each other", () => {
    const c = chart();
    const bb = c.nodes.get("vs-open:BB:BTN")!;
    expect(chartPercent(bb, "vs-open:BB:BTN", "call", classIndex("AKo"))).toBe(50);
    expect(chartPercent(bb, "vs-open:BB:BTN", "fold", classIndex("AKo"))).toBe(50);
    expect(chartPercent(bb, "vs-open:BB:BTN", "check", classIndex("AKo"))).toBe(0);
    expect(chartPercent(c.nodes.get("vs-4bet:BTN:CO")!, "vs-4bet:BTN:CO", "allin", classIndex("AA"))).toBe(100);
    expect(chartBest(bb, "vs-open:BB:BTN", classIndex("72o"))).toBe("fold");
    expect(chartBest(bb, "vs-open:BB:BTN", classIndex("AA"))).toBe("raise");
    expect(OFF_CHART_BELOW_PERCENT).toBe(3.5);
  });

  it("counts the share played by the chart, the deviations, the mix, the missing and unnamed situations", () => {
    const report = compareChart(chart(), [
      cell("rfi:CO", "AA", "raise", 10),
      cell("rfi:CO", "72o", "fold", 30),
      cell("rfi:CO", "K9o", "raise", 4, 1.2), // off: the chart folds K9o
      cell("rfi:CO", "AJo", "fold", 2, 0.4), // off: the chart raises AJo always
      cell("vs-open:BB:BTN", "AKo", "call", 3),
      cell("vs-open:BB:BTN", "AKo", "fold", 1, 0.5), // on: a 50 % fold
      cell("vs-open:BB:BTN", "72o", "call", 5, 3), // off
      cell("vs-4bet:BTN:CO", "AA", "allin", 2),
      cell("rfi:UTG", "AA", "raise", 7), // the chart has no UTG
      cell("", "AA", "raise", 4), // unnamed
    ]);
    expect(report.decisions).toBe(57);
    expect(report.onChart).toBe(46);
    expect(report.offEvLossBb).toBeCloseTo(4.6);
    expect(report.missing).toEqual([{ key: "rfi:UTG", decisions: 7 }]);
    expect(report.unnamed).toBe(4);
    expect(report.deviations.map((d) => `${d.key} ${d.className} ${d.action} ${d.decisions} ${d.chartAction}`)).toEqual([
      "vs-open:BB:BTN 72o call 5 fold",
      "rfi:CO K9o raise 4 fold",
      "rfi:CO AJo fold 2 raise",
    ]);
    const rfi = report.nodes.find((n) => n.key === "rfi:CO")!;
    expect(rfi.decisions).toBe(46);
    expect(rfi.classes[classIndex("K9o")]).toEqual({ decisions: 4, off: 4 });
    const raise = rfi.mix.find((m) => m.action === "raise")!;
    expect(raise.played).toBe(14);
    expect(raise.expected).toBe(12); // AA 10 + AJo 2 the chart raises
    expect(rfi.mix.map((m) => m.action)).toEqual(["fold", "call", "raise", "allin"]);
  });
});

/* ------------------------------------------------- the session review source - */

const decision = (extra: Partial<SessionPreflopDecision>): SessionPreflopDecision => ({
  handId: "h1",
  ord: 0,
  actionIndex: 4,
  playedAt: "2026-09-01T10:00:00Z",
  key: "rfi:CO",
  cls: classIndex("K9o"),
  action: "raise",
  scenario: "unopened",
  position: "CO",
  gameFormat: "cash",
  tableSize: 6,
  depthBandBb: 100,
  evLossBb: 0.4,
  ...extra,
});

describe("the session review's own-chart deviations", () => {
  it("lists only covered decisions the chart plays under 3.5 %", () => {
    const c = chart();
    const out = ownChartDecisions(c, [
      decision({}),
      decision({ handId: "h2", cls: classIndex("AA") }), // on chart
      decision({ handId: "h3", key: "rfi:UTG" }), // not in the chart
      decision({ handId: "h4", tableSize: 9 }), // another table
      decision({ handId: "h5", depthBandBb: 40 }), // too shallow
      decision({ handId: "h6", gameFormat: "tournament" }),
      decision({ handId: "h7", depthBandBb: 120 }), // 120-130 overlaps 80-120
      decision({ handId: "h8", depthBandBb: 70 }), // 70-80 does not
    ]);
    expect(out.map((d) => d.handId)).toEqual(["h1", "h7"]);
    expect(out[0]).toMatchObject({ street: "preflop", action: "raise", best: "fold", source: "own-chart", grade: null, chosenFreq: 0 });
    expect(inChartScope(c, { gameFormat: null, tableSize: null, depthBandBb: null })).toBe(true);
  });

  it("ranks by EV, one per hand, and fetches the rows of the hands the review lacks", async () => {
    const c = chart();
    const hands = vi.fn((ids: string[]) =>
      Promise.resolve(Object.fromEntries(ids.map((id) => [id, { handId: id } as unknown as ReviewHand]))),
    );
    const sessionDecisions = vi.fn(() =>
      Promise.resolve([
        decision({ handId: "a", evLossBb: 0.2 }),
        decision({ handId: "b", evLossBb: 1.5 }),
        decision({ handId: "b", ord: 1, evLossBb: 0.1 }),
        decision({ handId: "c", evLossBb: 0.9 }),
      ]),
    );
    const source = ownChartDeviations({ sessionDecisions, hands }, c, 2);
    expect(source.kind).toBe("own");
    expect(source.label).toBe("Mine");
    const review = {
      session: { startedAt: "2026-09-01T09:00:00Z", endedAt: "2026-09-01T11:00:00Z" },
      hands: { c: { handId: "c" } },
    } as unknown as SessionReview;
    const query = { at: null, gapMinutes: 30, filter: {} };
    const list = await source.deviations(review, query);
    expect(list.decisions.map((d) => `${d.handId}:${d.ord}`)).toEqual(["b:0", "c:0"]);
    expect(sessionDecisions).toHaveBeenCalledWith({ startedAt: "2026-09-01T09:00:00Z", endedAt: "2026-09-01T11:00:00Z" }, query);
    expect(hands).toHaveBeenCalledWith(["b"], query);
    expect(Object.keys(list.hands ?? {})).toEqual(["b"]);
    expect((await source.deviations({ ...review, session: null }, query)).decisions).toEqual([]);
  });
});

/* A sanity check of the positions table against the shipped sets' own. */
describe("seats", () => {
  it("are the shipped sets' preflop order", () => {
    expect(chartSet("nlhe-cash-6max-100bb").game.positions).toEqual(TABLE_POSITIONS[6]);
    expect(chartSet("nlhe-cash-9max-100bb").game.positions).toEqual(TABLE_POSITIONS[9]);
    expect(chartSet("nlhe-cash-hu-100bb").game.positions).toEqual(TABLE_POSITIONS[2]);
  });
});
