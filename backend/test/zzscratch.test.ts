import { describe, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { sampleFiles } from "./support/psggCorpus.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";

describe("scratch ignition", () => {
  it("runs the corpus", async () => {
    let ok = 0;
    const failures: string[] = [];
    const warns = new Map<string, number>();
    for (const file of sampleFiles("ignition")) {
      const result = await convertAny(file.text, { sourceFilename: file.name, validate: false });
      for (const hand of result.hands) {
        const report = validateHand(hand);
        if (report.errors.length > 0) {
          failures.push(`${file.name} ${hand.meta.handId}: ${report.errors.map((e) => e.code + " " + e.message).join("; ")}`);
        } else {
          ok += 1;
        }
        for (const w of hand.meta.warnings) {
          warns.set(w.code, (warns.get(w.code) ?? 0) + 1);
          if (w.code === "unknown-line" || w.code === "unknown-summary-line") {
            failures.push(`${file.name} ${hand.meta.handId}: ${w.code} ${w.message}`);
          }
        }
      }
      for (const f of result.failures) {
        failures.push(`SKIP ${file.name}: ${f.reason} :: ${f.message.slice(0, 180)}`);
      }
    }
    console.log("OK hands:", ok);
    console.log("warnings:", [...warns.entries()].sort((a, b) => b[1] - a[1]));
    console.log("problems:\n" + failures.join("\n"));
  });
});
