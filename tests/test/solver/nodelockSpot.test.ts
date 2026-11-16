/**
 * A nodelock re-solves the library's own game (`docs/NODELOCK.md` §2.3):
 * `nodelockSpot(set, line, flop)` is the spot of the job the batch runner
 * builds for that line and flop - the same ranges, pot, stack, rake and
 * profile - for a sample of lines and flops of a real chart set. The job is
 * built here the way the runner built it before the code moved to
 * `web/src/lib/analysis/flopJob.ts`, so the move is checked too.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chartLineHash, FLOP_LINES } from "../../../web/src/lib/analysis/flopLibrary.js";
import { jobOf, jobSpot, libraryJob, lineSpot, nodelockSpot, type Job } from "../../../web/src/lib/analysis/flopJob.js";
import { rakeOf } from "../../../web/src/lib/analysis/river.js";
import { loadCharts } from "../../../web/src/lib/charts/index.js";
import { FLOP_REPRESENTATIVES } from "../../../web/src/lib/solver/index.js";

const SET = "nlhe-cash-6max-100bb";
const charts = loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, "../../../web/src/lib/charts/data", `${SET}.json`), "utf8")));

/** The runner's job, spelled as `run.ts` spelled it. */
function runnerJob(lineId: string, flop: string): Job {
  const line = FLOP_LINES.find((l) => l.id === lineId);
  if (!line) throw new Error(lineId);
  const spot = lineSpot(charts, line);
  const rake = rakeOf(charts);
  return {
    id: `${line.id}/${flop}`,
    line: line.id,
    lineKey: line.key,
    flop,
    players: spot.players,
    ranges: [Array.from(spot.ranges[0]), Array.from(spot.ranges[1])],
    pot: spot.pot,
    stack: spot.stack,
    charts: { id: charts.id, version: charts.version, hash: charts.model.hash },
    lineHash: chartLineHash(charts, line.key) ?? undefined,
    rake: { name: rake.name, percent: rake.percent, cap: rake.cap },
  };
}

describe("nodelockSpot", () => {
  const lines = ["btn-bb", "utg-bb", "co-btn-3bet", "btn-sb-3bet"].filter((id) => FLOP_LINES.some((l) => l.id === id));
  const flops = [FLOP_REPRESENTATIVES[0], FLOP_REPRESENTATIVES[37], FLOP_REPRESENTATIVES[99], "Ks5h3s"];

  it("samples real lines", () => {
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  for (const line of lines) {
    it(`is the library job's spot on ${line}`, () => {
      for (const flop of flops) {
        const job = runnerJob(line, flop);
        expect(libraryJob(charts, line, flop)).toEqual(job);
        expect(nodelockSpot(charts, line, flop)).toEqual(jobSpot(job));
        const known = FLOP_LINES.find((l) => l.id === line);
        if (known) expect(jobOf(charts, known, lineSpot(charts, known), flop)).toEqual(job);
      }
    });
  }

  it("refuses a line the set does not have", () => {
    expect(() => nodelockSpot(charts, "no-such-line", "Ks5h3s")).toThrow(/unknown line/);
  });
});
