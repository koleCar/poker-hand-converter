/**
 * The release checklist's compliance item (docs/RAIL-PLAN.md §12, R3.10;
 * table tiling T0): `scripts/hud-policy/check.mjs` lists every allowance of
 * a HUD, the table manager (`tiling`) or the RNG (`rng`) with its policy
 * page and the date it was read, and fails a release when a date is older
 * than the limit. Made-up entries here; the real file is checked against
 * the release's own date by the workflow, not in CI (it would turn red by
 * itself 90 days after a check).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_AGE_DAYS, review, table } from "../scripts/hud-policy/check.mjs";

interface Policy {
  allowed: boolean | null;
  source: string | null;
  checkedAt: string | null;
}

interface Entry {
  id: string;
  name: string;
  kind: string;
  hud: Policy;
  tiling?: Policy;
  rng?: Policy;
}

function site(id: string, allowed: boolean | null, checkedAt: string | null, source: string | null = `https://example.invalid/${id}`, kind = "room"): Entry {
  return { id, name: id.toUpperCase(), kind, hud: { allowed, source, checkedAt } };
}

const unknown: Policy = { allowed: null, source: null, checkedAt: null };

describe("Room policy check before a release", () => {
  it("lists only the rooms whose HUD is allowed, with source and date", () => {
    const rows = review(
      { sites: [site("alpha", true, "2026-10-14"), site("beta", false, "2026-01-01"), site("gamma", null, null)] },
      "2026-10-19",
    );
    expect(rows).toEqual([
      { id: "alpha", name: "ALPHA", policy: "hud", source: "https://example.invalid/alpha", checkedAt: "2026-10-14", age: 5, problem: null },
    ]);
    expect(table(rows)).toContain("| ALPHA (`alpha`) | hud | https://example.invalid/alpha | 2026-10-14 | 5 | ok |");
  });

  it("lists tiling and RNG allowances on their own, whatever the HUD says", () => {
    const refused = site("delta", false, "2026-10-14");
    refused.tiling = { allowed: true, source: "https://example.invalid/tiling", checkedAt: "2026-11-11" };
    refused.rng = { allowed: true, source: "https://example.invalid/rng", checkedAt: "2026-07-01" };
    const quiet = site("epsilon", true, "2026-11-01");
    quiet.tiling = unknown;
    quiet.rng = { allowed: false, source: null, checkedAt: null };
    const rows = review({ sites: [refused, quiet] }, "2026-11-11");
    expect(rows.map((row) => [row.id, row.policy, row.problem])).toEqual([
      ["delta", "tiling", null],
      ["delta", "rng", "checked 133 days ago (limit 90)"],
      ["epsilon", "hud", null],
    ]);
  });

  it("fails a check older than the limit, a missing date or source, and a non-room", () => {
    const rows = review(
      {
        sites: [
          site("fresh", true, "2026-07-21"),
          site("stale", true, "2026-07-20"),
          site("undated", true, null),
          site("unsourced", true, "2026-10-01", "docs/research/HUD-POLICIES.md"),
          site("future", true, "2026-12-01"),
          site("network", true, "2026-10-01", "https://example.invalid/n", "network"),
        ],
      },
      "2026-10-19",
      MAX_AGE_DAYS,
    );
    const problems = Object.fromEntries(rows.map((row) => [row.id, row.problem]));
    expect(problems).toEqual({
      fresh: null,
      stale: "checked 91 days ago (limit 90)",
      undated: "no checkedAt",
      unsourced: "no https source",
      future: "checkedAt is in the future",
      network: "not a room",
    });
    expect(review({ sites: [site("stale", true, "2026-07-20")] }, "2026-10-19", 120)[0]?.problem).toBeNull();
  });

  it("reads the real file: the allowed rooms, each with an https page and a date", () => {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../config/sites.json"), "utf8"));
    const rows = review(config, "2026-11-11");
    expect(rows.map((row) => `${row.id} ${row.policy}`)).toEqual([
      "pokerstars hud",
      "pokerstars tiling",
      "winamax hud",
      "acr hud",
      "acr tiling",
      "coinpoker tiling",
      "wpt-global tiling",
    ]);
    for (const row of rows) {
      expect(row.source, row.id).toMatch(/^https:\/\//);
      expect(row.checkedAt, row.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
