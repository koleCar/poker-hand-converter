/**
 * Hand analysis over the whole corpus: properties, not numbers.
 *
 * Every real hand in the repository goes through `analyzeHand`, the function
 * the in-browser rebuild runs, and every result is held to what the database
 * will hold it to (the CHECK constraints of `20261228090000_analysis.sql`) and
 * to the rules of `docs/ANALYSIS-PLAN.md`: flags are never louder than
 * Inaccurate, nothing is graded without a reference, a skipped decision says
 * why, and the record agrees with the stats engine about which decisions there
 * were. `analysisSpots.test.ts` pins the numbers on hands small enough to read.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ANALYSIS_VERSION,
  APPROXIMATIONS,
  DECISION_SKIP_REASONS,
  FLAG_CODES,
  HAND_SKIP_REASONS,
  analyzeHand,
  type HandAnalysis,
} from "../../frontend/src/lib/analysis/index.js";
import { decisionFromStored, handAnalysisFromStored, handAnalysisRow } from "../../frontend/src/lib/db/analysisRows.js";
import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr } from "../../frontend/src/lib/i18n/hr.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../frontend/src/lib/stats/context.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles, readTree, type CorpusFile } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");

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
  analysis: analyzeHand(structuredClone(hand)),
}));

describe("the analysis corpus", () => {
  it("analyses thousands of real hands, most of them in full", () => {
    expect(RESULTS.length).toBeGreaterThan(5000);
    const full = RESULTS.filter((r) => r.analysis.status === "full").length;
    expect(full / RESULTS.length).toBeGreaterThan(0.6);
    expect(RESULTS.some((r) => r.analysis.status === "partial")).toBe(true);
  });

  it("stamps every record with the version", () => {
    expect(new Set(RESULTS.map((r) => r.analysis.version))).toEqual(new Set([ANALYSIS_VERSION]));
  });

  it("is deterministic", () => {
    for (const { hand, analysis } of RESULTS.slice(0, 400)) {
      expect(analyzeHand(structuredClone(hand))).toEqual(analysis);
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
      if (analysis.reason !== null) expect(HAND_SKIP_REASONS).toContain(analysis.reason);
      for (const approximation of analysis.approximations) expect(APPROXIMATIONS).toContain(approximation);
      for (const decision of analysis.decisions) {
        if (decision.reason !== null) expect(DECISION_SKIP_REASONS).toContain(decision.reason);
        expect(decision.status === "analysed").toBe(decision.reason === null);
        expect(decision.scenario ?? decision.facts.scenario).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
        expect(decision.node.length).toBeLessThanOrEqual(200);
        for (const flag of decision.flags) expect(FLAG_CODES).toContain(flag.code);
      }
    }
  });

  it("never flags louder than Inaccurate, and never grades without a reference (§3.6)", () => {
    for (const { analysis } of RESULTS) {
      expect(analysis.grade).toBeNull();
      for (const decision of analysis.decisions) {
        expect(decision.grade).toBeNull();
        expect(decision.source).toBe("heuristic");
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

  it("only ever skips a decision after the flop", () => {
    for (const { analysis } of RESULTS) {
      for (const decision of analysis.decisions) {
        if (decision.status === "not-analysed") expect(decision.street).not.toBe("preflop");
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
