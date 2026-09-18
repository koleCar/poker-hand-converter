import { describe, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";

const ROOT = join(import.meta.dirname, "../..");

async function run(site: string, dir: string) {
  let hands = 0, fails = 0;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".txt")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    const r = await convertAny(text, { sourceFilename: name });
    hands += r.hands.length; fails += r.failures.length;
    const codes = r.failures.map(f => `${f.reason}`);
    console.log(`${name}: ${r.hands.length} ok / ${r.failures.length} fail  ${[...new Set(codes)].join(",")}`);
    for (const f of r.failures.slice(0,2)) console.log(`    ! ${f.reason}: ${f.message.slice(0,220)}`);
    for (const h of r.hands) {
      if (h.meta.warnings.length) console.log(`    ~ ${h.meta.handId} warnings: ${h.meta.warnings.map(w=>w.code+": "+w.message.slice(0,90)).join(" | ")}`);
      const v = validateHand(h);
      if (v.errors.length) console.log(`    X ${h.meta.handId} ${v.errors.map(e=>e.code+": "+e.message).join("; ")}`);
      if (h.meta.siteId !== site) console.log(`    ? ${h.meta.handId} went to ${h.meta.siteId}`);
    }
  }
  console.log(`== ${site}: ${hands} hands, ${fails} failures`);
}

describe("smoke", () => {
  it("winamax", async () => { await run("winamax", join(ROOT, "fixtures/samples/winamax/hhsmithy-corpus")); });
  it("chico", async () => { await run("chico", join(ROOT, "fixtures/samples/chico/fpdb3-regression-corpus")); });
});
