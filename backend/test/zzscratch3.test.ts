import { describe, it } from "vitest";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { sampleFiles } from "./support/psggCorpus.js";
import { toStandardText, parseStandardHand } from "../../frontend/src/lib/phf/serialize.js";

describe("scratch rt", () => {
  it("diff", async () => {
    const file = sampleFiles("ignition").find((f) => f.name.includes("allin.ante"))!;
    const result = await convertAny(file.text, { sourceFilename: file.name });
    const hand = result.hands.find((h) => h.meta.handId === "2697696244")!;
    const text = toStandardText(hand);
    console.log(text);
    const back = parseStandardHand(text, { siteId: "s", siteName: "s", originalFilename: null })!;
    const proj = (h: typeof hand) => h.actions.filter((a) => a.amount !== 0 || a.type === "collect").map((a) => [a.street, a.type, a.amount, a.streetTotal, a.player].join("|"));
    const a = proj(hand); const b = proj(back);
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) console.log("DIFF", i, a[i], "  vs  ", b[i]);
  });
});
