/**
 * The committed flop-bet data (Learn L2, `frontend/src/lib/learn/data/flop-bets.json`):
 * written from the full flop library by `npm run floplib:bets`, it may only
 * hold Rail's own numbers. Checked here: it names the committed chart set and
 * the library's tree, covers the library's flops for each line, every row the
 * pilot also holds is recomputed from the pilot's chunk (the pilot's chunks
 * are copies of the run's), and the groups the widget shows are averages of
 * those rows.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FLOP_PROFILE } from "../../frontend/src/lib/analysis/index.js";
import { loadCharts } from "../../frontend/src/lib/charts/index.js";
import { FLOP_BET_SPOTS, FLOP_GROUPS, flopBetRow, flopGroup, groupRows, type FlopBetData } from "../../frontend/src/lib/learn/flopBets.js";
import { decodeChunk, FLOP_REPRESENTATIVES, type FlopManifest } from "../../frontend/src/lib/solver/index.js";

const CHARTS = loadCharts(JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")));
const DATA = JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/learn/data/flop-bets.json"), "utf8")) as FlopBetData;
const PILOT = join(import.meta.dirname, "../scripts/flop-library/pilot", CHARTS.id, FLOP_PROFILE.tree);

describe("the raiser's flop bets by board group (L2)", () => {
  it("come from the committed charts' library, on its own flops", () => {
    expect(DATA.set).toBe(CHARTS.id);
    expect(DATA.hash).toBe(CHARTS.model.hash);
    expect(DATA.tree).toBe(FLOP_PROFILE.tree);
    expect(Object.keys(DATA.lines).sort()).toEqual(FLOP_BET_SPOTS.map((s) => s.line).sort());
    for (const rows of Object.values(DATA.lines)) {
      expect(rows.length).toBe(FLOP_REPRESENTATIVES.length);
      for (const row of rows) {
        expect(FLOP_REPRESENTATIVES).toContain(row.flop);
        expect(row.bet).toBeGreaterThanOrEqual(0);
        expect(row.bet).toBeLessThanOrEqual(1);
        expect(row.big).toBeLessThanOrEqual(row.bet + 1e-9);
      }
    }
  });

  it.runIf(existsSync(join(PILOT, "manifest.json")))("hold exactly what the pilot's chunks say, where the pilot has the flop", () => {
    const manifest = JSON.parse(readFileSync(join(PILOT, "manifest.json"), "utf8")) as FlopManifest;
    let checked = 0;
    for (const entry of manifest.entries) {
      const spot = FLOP_BET_SPOTS.find((s) => s.line === entry.line);
      if (!spot) continue;
      const row = flopBetRow(decodeChunk(readFileSync(join(PILOT, entry.path))), spot.path);
      expect(row).not.toBeNull();
      expect(DATA.lines[spot.line].find((r) => r.flop === entry.flop)).toEqual(row);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("group every flop once, and average each group's rows", () => {
    expect(flopGroup("AsKh7d")).toBe("ace-high");
    expect(flopGroup("Ks6s3s")).toBe("monotone");
    expect(flopGroup("KhKs9d")).toBe("paired");
    expect(flopGroup("4d4h4s")).toBe("trips");
    expect(flopGroup("7s5h3d")).toBe("low");
    expect(flopGroup("Ts7h4d")).toBe("middle");
    expect(flopGroup("Qs8s4h")).toBe("king-queen-high");
    for (const rows of Object.values(DATA.lines)) {
      const groups = groupRows(rows);
      expect(groups.reduce((n, g) => n + g.flops, 0)).toBe(rows.length);
      expect(groups.map((g) => g.group)).toEqual(FLOP_GROUPS.filter((g) => groups.some((x) => x.group === g)));
      for (const g of groups) {
        const inGroup = rows.filter((r) => flopGroup(r.flop) === g.group);
        expect(g.bet).toBeCloseTo(inGroup.reduce((s, r) => s + r.bet, 0) / inGroup.length, 4);
      }
    }
  });
});
