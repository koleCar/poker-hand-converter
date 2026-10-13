/**
 * `npm run golden:emit`: rewrites `testdata/golden/` from today's TypeScript
 * pipeline. See `emit.ts` for what is emitted and `testdata/golden/README.md`
 * for the format.
 */

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical.js";
import { emitAll } from "./emit.js";

describe("golden oracle", () => {
  it("canonical JSON sorts keys by UTF-8 bytes and refuses floats", () => {
    // U+FF5E sorts before U+1F600 in UTF-8 bytes and after it in UTF-16 code units.
    expect(canonicalJson({ "\u{1F600}": 1, "～": 2, a: [], b: {} })).toBe(
      '{\n  "a": [],\n  "b": {},\n  "～": 2,\n  "\u{1F600}": 1\n}\n',
    );
    expect(() => canonicalJson({ amount: 0.5 })).toThrow(/not a safe integer/);
  });

  it("emits one golden per corpus file", async () => {
    const started = performance.now();
    const report = await emitAll();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `golden: ${report.files} files, ${report.hands} hands, ${report.refusals} refusals, ` +
        `testdata/golden ${(report.summaryBytes / 1e6).toFixed(1)} MB, ` +
        `testdata/golden-full ${(report.fullBytes / 1e6).toFixed(1)} MB, ` +
        `${report.removed} stale removed, ${seconds} s`,
    );
    console.log(
      `golden stats: ${report.statsRows} rows, ` +
        `testdata/golden-stats ${(report.statsSummaryBytes / 1e6).toFixed(1)} MB, ` +
        `testdata/golden-stats-full ${(report.statsFullBytes / 1e6).toFixed(1)} MB, ` +
        `${report.statsNegativeZeros} -0 written as 0`,
    );
    console.log(
      `golden ev: ${report.evRows} rows, ${report.evApplicable} applicable, ` +
        `${report.evMonteCarlo} Monte Carlo, ${report.evShortDeck} short deck, ${report.evHiLo} hi/lo declined, ` +
        `testdata/golden-ev ${(report.evSummaryBytes / 1e6).toFixed(1)} MB, ` +
        `testdata/golden-ev-full ${(report.evFullBytes / 1e6).toFixed(1)} MB, ` +
        `${report.evNegativeZeros} -0 written as 0`,
    );
    expect(report.files).toBeGreaterThan(500);
  });
});
