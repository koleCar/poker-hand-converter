// Prints the report tables for chart sets (default: every committed one).
//     CHARTS_FILE=path npm run charts:report
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { CHART_SET_VERSIONS, loadCharts } from "../../../frontend/src/lib/charts/format.js";
import { report } from "./report.js";
import { SET_CONFIGS } from "./sets.js";

it("reports", () => {
  const data = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
  const files = process.env.CHARTS_FILE
    ? [process.env.CHARTS_FILE]
    : SET_CONFIGS.map((c) => join(data, `${c.id}.json`)).filter((file) => existsSync(file));
  for (const file of files) {
    const json = JSON.parse(readFileSync(file, "utf8"));
    // Older sets (charts/1) carry a version the loader refuses; the tables only read the nodes.
    const readable = CHART_SET_VERSIONS.includes(json.version) ? json : { ...json, version: "charts/3" };
    console.log(`${report(loadCharts(readable))}\n`);
  }
});
