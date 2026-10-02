// Prints the report tables for a chart set (default: the committed one).
//     CHARTS_FILE=path npx vitest run --config scripts/preflop-charts/vitest.config.ts report
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { loadCharts } from "../../../frontend/src/lib/charts/format.js";
import { report } from "./report.js";

it("reports", () => {
  const file = process.env.CHARTS_FILE ?? join(import.meta.dirname, "../../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  // Older sets carry their own version; the tables only read the nodes.
  console.log(report(loadCharts({ ...json, version: "charts/2" })));
});
