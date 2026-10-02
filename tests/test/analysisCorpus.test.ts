/**
 * Hand analysis over the whole corpus: properties, not numbers.
 *
 * Every real hand in the repository goes through `analyzeHand` with the
 * committed chart set, exactly as the in-browser rebuild runs it, and every
 * result is held to what the database will hold it to (the CHECK constraints
 * of `20261228090000_analysis.sql`) and to the rules of
 * `docs/ANALYSIS-PLAN.md`: flags are never louder than Inaccurate, a grade
 * comes only from the charts and only preflop, a skipped decision says why,
 * and the record agrees with the stats engine about which decisions there
 * were. `analysisSpots.test.ts` and `analysisPreflop.test.ts` pin numbers on
 * hands small enough to read.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ANALYSIS_VERSION,
  APPROXIMATIONS,
  CHART_SKIP_REASONS,
  DECISION_SKIP_REASONS,
  FLAG_CODES,
  HAND_SKIP_REASONS,
  RIVER_SKIP_REASONS,
  analyzeHand,
  riverStudy,
  grade,
  gradeRank,
  worstGrade,
  type HandAnalysis,
} from "../../frontend/src/lib/analysis/index.js";
import { loadCharts } from "../../frontend/src/lib/charts/index.js";
import { decisionFromStored, handAnalysisFromStored, handAnalysisRow } from "../../frontend/src/lib/db/analysisRows.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles, readTree, type CorpusFile } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");
const CHARTS = loadCharts(
  JSON.parse(readFileSync(join(ROOT, "frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);

const FILES: CorpusFile[] = [
  ...ggCorpusFiles(),
  ...weplayFiles(),
  ...readTree(join(ROOT, "fixtures/samples"), "fixtures/samples"),
  ...readTree(join(import.meta.dirname, "fixtures"), "tests/test/fixtures"),
];

const HANDS: PhfHand[] = (
  await Promise.all(
    FILES.map(async (file) => {
      try {
        return (await convertAny(file.text, { sourceFilename: file.name })).hands;
      } catch {
        return [];
      }
    }),
  )
).flat();

const RESULTS: Array<{ hand: PhfHand; analysis: HandAnalysis }> = HANDS.map((hand) => ({
  hand,
  analysis: analyzeHand(structuredClone(hand), { charts: CHARTS }),
}));

describe("the analysis corpus", () => {
  it("analyses thousands of real hands, and grades a good share of their preflop decisions", () => {
    expect(RESULTS.length).toBeGreaterThan(5000);
    // Most of the corpus is 9-max or deeper than 120bb (§10, A1), which the
    // 6-max 100bb charts refuse by name; what they cover, they grade.
    const analysed = RESULTS.filter((r) => r.analysis.status !== "not-analysed").length;
    expect(analysed / RESULTS.length).toBeGreaterThan(0.3);
    expect(RESULTS.some((r) => r.analysis.status === "full")).toBe(true);
    expect(RESULTS.some((r) => r.analysis.status === "partial")).toBe(true);
    const preflop = RESULTS.flatMap((r) => r.analysis.decisions).filter((d) => d.street === "preflop");
    expect(preflop.filter((d) => d.grade !== null).length).toBeGreaterThan(500);
  });

  it("grades heads-up river decisions with the solver, and says why it skips the others (A4)", () => {
    const rivers = RESULTS.flatMap((r) => r.analysis.decisions).filter((d) => d.street === "river");
    const solved = rivers.filter((d) => d.source === "solver");
    expect(solved.length).toBeGreaterThan(100);
    for (const d of rivers) {
      if (d.source !== "solver") expect(d.grade).toBeNull();
      if (d.status === "not-analysed") expect(["multiway", ...RIVER_SKIP_REASONS]).toContain(d.reason);
    }
  });

  it("re-solves a river for the study view to exactly the stored numbers", () => {
    const sample = RESULTS.filter((r) => r.analysis.decisions.some((d) => d.source === "solver")).slice(0, 8);
    expect(sample.length).toBe(8);
    for (const { hand, analysis } of sample) {
      for (const d of analysis.decisions.filter((x) => x.source === "solver")) {
        const study = riverStudy(structuredClone(hand), d.actionIndex, { charts: CHARTS });
        if (!study || !("options" in study)) throw new Error("no study for a graded river");
        expect(study.hero.freq).toEqual(d.options.map((o) => o.freq));
        expect(study.hero.ev).toEqual(d.options.map((o) => o.ev));
      }
    }
  });

  it("stamps every record with the version", () => {
    expect(new Set(RESULTS.map((r) => r.analysis.version))).toEqual(new Set([ANALYSIS_VERSION]));
  });

  it("is deterministic", () => {
    for (const { hand, analysis } of RESULTS.slice(0, 400)) {
      expect(analyzeHand(structuredClone(hand), { charts: CHARTS })).toEqual(analysis);
    }
  });
});

describe("every record satisfies the database's own constraints", () => {
  it("status agrees with the counts", () => {
    const problems: string[] = [];
    for (const { hand, analysis } of RESULTS) {
      const analysed = analysis.decisions.filter((d) => d.status === "analysed").length;
      const ok =
        analysis.status === "full"
          ? analysis.decisions.length > 0 && analysed === analysis.decisions.length && analysis.reason === null
          : analysis.status === "partial"
            ? analysed > 0 && analysed < analysis.decisions.length && analysis.reason === null
            : analysed === 0 && analysis.reason !== null;
      if (!ok) problems.push(`${hand.meta.siteId}:${hand.meta.handId} ${analysis.status}`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("names every reason, flag and approximation from the closed lists", () => {
    for (const { analysis } of RESULTS) {
      if (analysis.reason !== null) expect([...HAND_SKIP_REASONS, ...DECISION_SKIP_REASONS]).toContain(analysis.reason);
      for (const approximation of analysis.approximations) expect(APPROXIMATIONS).toContain(approximation);
      // The database holds at most 16 per row.
      expect(analysis.approximations.length).toBeLessThanOrEqual(16);
      for (const decision of analysis.decisions) {
        if (decision.reason !== null) expect(DECISION_SKIP_REASONS).toContain(decision.reason);
        expect(decision.status === "analysed").toBe(decision.reason === null);
        expect(decision.scenario ?? decision.facts.scenario).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
        expect(decision.node.length).toBeLessThanOrEqual(200);
        for (const flag of decision.flags) expect(FLAG_CODES).toContain(flag.code);
      }
    }
  });

  it("never flags louder than Inaccurate, and grades only from the charts preflop and the solver on the river (§3.6)", () => {
    for (const { analysis } of RESULTS) {
      for (const decision of analysis.decisions) {
        expect(decision.grade !== null).toBe(decision.source === "chart" || decision.source === "solver");
        if (decision.source === "chart") expect(decision.street).toBe("preflop");
        if (decision.source === "solver") expect(decision.street).toBe("river");
        for (const flag of decision.flags) expect(["note", "inaccurate"]).toContain(flag.severity);
        // Anything resting on a placeholder range is a note.
        for (const flag of decision.flags) {
          if (flag.code === "call-without-odds" || flag.code === "fold-with-odds") expect(flag.severity).toBe("note");
        }
      }
    }
  });

  it("keeps every fact in range", () => {
    for (const { analysis } of RESULTS) {
      for (const { facts } of analysis.decisions) {
        if (facts.potOdds !== null) expect(facts.potOdds).toBeGreaterThan(0);
        if (facts.potOdds !== null) expect(facts.potOdds).toBeLessThan(1);
        if (facts.mdf !== null) expect(facts.mdf).toBeGreaterThanOrEqual(0);
        if (facts.mdf !== null) expect(facts.mdf).toBeLessThanOrEqual(1);
        if (facts.mdf !== null) expect(facts.street).not.toBe("preflop");
        expect(facts.potBb).toBeGreaterThanOrEqual(0);
        expect(facts.toCallBb).toBeGreaterThanOrEqual(0);
        if (facts.equity) {
          expect(facts.equity.value).toBeGreaterThanOrEqual(0);
          expect(facts.equity.value).toBeLessThanOrEqual(1);
          if (facts.equity.strong !== null) expect(facts.equity.strong).toBeLessThanOrEqual(facts.equity.value + 1e-9);
        }
        expect(facts.street === "preflop").toBe(facts.texture === null);
        expect(JSON.stringify(facts).length).toBeLessThan(8000);
      }
    }
  });

  it("skips a preflop decision only with the charts' reason, a river one with a river reason, and the flop and turn only when multiway", () => {
    for (const { analysis } of RESULTS) {
      for (const decision of analysis.decisions) {
        if (decision.status !== "not-analysed") continue;
        if (decision.street === "preflop") expect(CHART_SKIP_REASONS).toContain(decision.reason);
        else if (decision.street === "river") expect(["multiway", ...RIVER_SKIP_REASONS]).toContain(decision.reason);
        else expect(decision.reason).toBe("multiway");
        expect(decision.reason).not.toBe("chart-unavailable");
      }
    }
  });

  it("grades every chart and solver decision by §2 from its own options, and the hand by its decisions", () => {
    for (const { analysis } of RESULTS) {
      let evLoss = 0;
      let graded = 0;
      for (const decision of analysis.decisions) {
        if (decision.source !== "chart" && decision.source !== "solver") continue;
        graded += 1;
        expect(decision.chosen).not.toBeNull();
        const chosen = decision.chosen as number;
        expect(chosen).toBeGreaterThanOrEqual(0);
        expect(chosen).toBeLessThan(decision.options.length);
        // The reference's frequencies sum to one (a fold the tree lacks is
        // added at zero frequency, so it does not change the sum).
        expect(decision.options.reduce((sum, option) => sum + option.freq, 0)).toBeCloseTo(1, 2);
        for (const option of decision.options) {
          expect(option.freq).toBeGreaterThanOrEqual(0);
          expect(option.freq).toBeLessThanOrEqual(1);
          expect(Number.isFinite(option.ev)).toBe(true);
        }
        const again = grade({
          options: decision.options,
          chosen,
          pot: decision.facts.potBb,
          capAtInaccurate: decision.approximations.includes("off-tree-size"),
          capAtMistake: decision.approximations.includes("range-cap"),
        });
        expect(decision.grade).toBe(again.grade);
        expect(decision.evLoss).toBeCloseTo(again.evLoss, 2);
        expect(decision.evLossPot).toBeGreaterThanOrEqual(0);
        expect(decision.freqDiff).toBeGreaterThanOrEqual(0);
        expect(decision.freqDiff).toBeLessThanOrEqual(1);
        expect(decision.score).toBeGreaterThanOrEqual(0);
        expect(decision.score).toBeLessThanOrEqual(100);
        if (decision.source === "chart") {
          expect(decision.facts.chart?.set).toBe(CHARTS.id);
          expect(CHARTS.nodes.has(decision.facts.chart?.line ?? "?")).toBe(true);
        } else {
          // A river grade names its solve, and always admits to the narrowing.
          const river = decision.facts.river!;
          expect(river.tree).toBe("river-m1");
          expect(river.iterations).toBeGreaterThan(0);
          expect(river.exploitabilityPct).toBeGreaterThanOrEqual(0);
          expect(river.converged).toBe(river.exploitabilityPct <= 0.5);
          expect(river.reach.hero).toBeGreaterThanOrEqual(0.02);
          expect(river.reach.villain).toBeGreaterThanOrEqual(0.02);
          expect(decision.approximations).toEqual(expect.arrayContaining(["narrowing-heuristic", "rake-profile"]));
          // A Blunder on the river only for a move that loses to anything (§3.5, §9).
          if (decision.grade === "blunder") {
            expect(["fold", "call"]).toContain(decision.action);
            if (decision.action === "fold") expect(decision.flags.map((f) => f.code)).toContain("fold-nuts");
          }
          if (decision.approximations.includes("range-sensitive")) {
            // The milder of two narrowings, kept only when they were more than a class apart.
            expect(river.sensitivity).toBeTruthy();
            expect(gradeRank(river.sensitivity!.grade) - gradeRank(river.capped ?? decision.grade!)).toBeGreaterThan(1);
          }
          if (decision.approximations.includes("range-cap")) {
            expect(decision.grade).toBe("mistake");
            expect(river.capped).toBe("blunder");
          }
        }
        evLoss += decision.evLoss ?? 0;
      }
      expect(analysis.grade).toBe(worstGrade(analysis.decisions.map((d) => d.grade)));
      if (graded === 0) {
        expect(analysis.evLoss).toBeNull();
        expect(analysis.score).toBeNull();
      } else {
        expect(analysis.evLoss).toBeCloseTo(evLoss, 2);
        expect(analysis.evLossPot).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("the record agrees with the stats engine", () => {
  it("has exactly the hero's decisions, by the stats engine's order, pointing at the hero's own actions", () => {
    for (const { hand, analysis } of RESULTS) {
      if (analysis.decisions.length === 0) continue;
      const context = buildContext(structuredClone(hand));
      const hero = analysis.heroSeat;
      const expected = context.decisions.filter((d) => d.seat === hero).map((d) => d.order);
      expect(analysis.decisions.map((d) => d.order)).toEqual(expected);
      for (const decision of analysis.decisions) {
        const action = hand.actions.find((a) => a.index === decision.actionIndex);
        expect(action?.seat).toBe(hero);
        expect(action?.type).toBe(decision.action);
      }
    }
  });
});

describe("the wire", () => {
  it("round-trips a record through the writer's shape and the reader's", () => {
    const sample = RESULTS.find((r) => r.analysis.decisions.some((d) => d.facts.equity))!.analysis;
    const row = handAnalysisRow("00000000-0000-0000-0000-000000000001", sample);
    expect(row.analysis_version).toBe(ANALYSIS_VERSION);
    // Aggregates are the server's to compute; the writer does not send them.
    expect(row).not.toHaveProperty("flag_count");
    expect(row).not.toHaveProperty("decisions_count");
    const stored = {
      analysisVersion: row.analysis_version,
      status: row.status,
      reason: row.reason,
      heroSeat: row.hero_seat,
      potType: row.pot_type,
      grade: row.grade,
      score: row.score,
      evLossBb: row.ev_loss_bb,
      evLossPot: row.ev_loss_pot,
      flagCount: sample.flagCount,
      worstFlag: sample.worstFlag,
      approximations: row.approximations,
      decisions: row.decisions.map((d, i) => ({
        ...d,
        actionIndex: d.action_index,
        evLossBb: d.ev_loss_bb,
        evLossPot: d.ev_loss_pot,
        freqDiff: d.freq_diff,
        worstFlag: sample.decisions[i].worstFlag,
      })),
    };
    expect(JSON.parse(JSON.stringify(handAnalysisFromStored(stored)))).toEqual(JSON.parse(JSON.stringify(sample)));
    expect(decisionFromStored(stored.decisions[0]).facts).toEqual(sample.decisions[0].facts);
  });
});

describe("the explanation layer (§4)", () => {
  const decisions = RESULTS.flatMap((r) => r.analysis.decisions);

  it("has a title for every flag, reason and approximation in both languages", () => {
    for (const dict of [en, hr]) {
      for (const code of FLAG_CODES) expect(dict.analysis.flags[code]).toBeTruthy();
      for (const reason of [...HAND_SKIP_REASONS, ...DECISION_SKIP_REASONS]) expect(dict.analysis.reasons[reason]).toBeTruthy();
      for (const approximation of APPROXIMATIONS) expect(dict.analysis.approximations[approximation]).toBeTruthy();
    }
  });

  it("explains every decision in both languages, from the record alone", () => {
    for (const decision of decisions) {
      for (const dict of [en, hr]) {
        const sentences = dict.analysis.explain(decision);
        expect(sentences.length).toBeGreaterThan(0);
        for (const sentence of sentences) expect(sentence).not.toMatch(/undefined|NaN|null|\[object/);
      }
    }
  });

  it("never quotes MDF preflop (§4), and names a chart grade in the first sentences", () => {
    for (const decision of decisions) {
      if (decision.street !== "preflop") continue;
      expect(en.analysis.explain(decision).join(" ")).not.toMatch(/minimum defence|MDF/);
      expect(hr.analysis.explain(decision).join(" ")).not.toMatch(/Minimalna obrana|MDF/);
      if (decision.grade) {
        expect(en.analysis.explain(decision).join(" ")).toContain(en.analysis.grades[decision.grade]);
        expect(hr.analysis.explain(decision).join(" ")).toContain(hr.analysis.grades[decision.grade]);
      }
    }
  });

  it("gives every flag its own sentence, quoting the flag's own numbers", () => {
    const flagged = decisions.filter((d) => d.flags.length > 0);
    expect(flagged.length).toBeGreaterThan(0);
    for (const decision of flagged) {
      const sentences = en.analysis.explain(decision);
      for (const flag of decision.flags) {
        for (const value of Object.values(flag.params)) {
          if (typeof value === "number") expect(sentences.join(" ")).toContain(String(value));
        }
      }
    }
  });
});

describe("the module stays importable from a worker and a test", () => {
  // Same rule as lib/stats and lib/equity: no framework, no Supabase, no globals.
  const ALLOWED = new Set([
    "../charts",
    "../solver",
    "../phf/types",
    "../cards",
    "../stats/context",
    "../stats/derive",
    "../equity/range",
    "../equity/evaluator",
  ]);
  const dir = join(import.meta.dirname, "../../frontend/src/lib/analysis");
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts"));

  it.each(sources)("%s imports nothing it may not", (name) => {
    const text = readFileSync(join(dir, name), "utf8");
    const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.filter((s) => !s.startsWith("./") && !ALLOWED.has(s))).toEqual([]);
  });

  it("names no browser or server global", () => {
    for (const name of sources) {
      const code = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/\b(?:window|document|localStorage|sessionStorage|navigator|fetch|process)\b/);
    }
  });
});
