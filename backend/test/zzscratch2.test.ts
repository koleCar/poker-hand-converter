import { describe, it } from "vitest";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { sampleFiles } from "./support/psggCorpus.js";
import { allInvariants } from "./support/psggInvariants.js";

describe("scratch invariants", () => {
  it("ignition corpus", async () => {
    const problems: string[] = [];
    let n = 0;
    for (const file of sampleFiles("ignition")) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        n += 1;
        problems.push(...allInvariants(hand).map((p) => `${file.name} ${p}`));
      }
      for (const f of result.failures) {
        if (f.reason !== "unsupported-variant" && f.reason !== "corrupt-hand") {
          problems.push(`SKIP ${file.name}: ${f.reason} ${f.message.slice(0, 160)}`);
        }
      }
    }
    console.log("hands:", n, "\nproblems:\n" + problems.join("\n"));
  });
});
