/**
 * `config/sites.json` against `config/sites.schema.json` (docs/RAIL-PLAN.md
 * R0.12), with ajv's draft 2020-12 validator and format assertions.
 *
 * The checks a schema cannot make - unique ids, every parser of the Rust
 * registry named and no other, regular expressions that compile, the policy
 * merge rule - are `core/rail-config`'s, under `cargo test`. Here: the file
 * fits its schema, and the schema refuses what it promises to refuse.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// ajv-formats is CommonJS with `exports.default`; under ESM the namespace's
// default is the whole `module.exports`.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule) as typeof addFormatsModule;

// strictTypes off: the conditional subschemas (`if` / `then` / `else`) narrow
// properties without repeating `type: "object"`.
const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(read("config/sites.schema.json") as object);

type Json = Record<string, any>;
const shipped = (): Json => read("config/sites.json") as Json;
const site = (doc: Json, id: string): Json => {
  const found = doc.sites.find((s: Json) => s.id === id);
  if (!found) throw new Error(`no site ${id}`);
  return found;
};

describe("config/sites.json", () => {
  it("fits its schema", () => {
    const ok = validate(shipped());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  // R3.0 (docs/research/HUD-POLICIES.md), signed off by the owner; the same
  // list is pinned in core/rail-config/tests/sites.rs.
  it("carries the R3.0 HUD policies", () => {
    const policies = Object.fromEntries(shipped().sites.map((s: Json) => [s.id, s.hud.allowed]));
    expect(policies).toEqual({
      pokerstars: true,
      ggpoker: false,
      winamax: true,
      "888poker": null,
      partypoker: false,
      ipoker: null,
      acr: true,
      coinpoker: false,
      unibet: false,
      chico: null,
      ignition: false,
      weplay: null,
      pokerbros: false,
      microgaming: false,
      fulltilt: false,
      ongame: false,
      entraction: false,
      runitonce: false,
      standard: false,
      "wpt-global": false,
      bossmedia: false,
      merge: false,
    });
  });

  const refused: [string, (doc: Json) => void][] = [
    ["an unknown field", (d) => (site(d, "winamax").hudAllowed = true)],
    [
      "hud.allowed true without source and date",
      (d) => Object.assign(site(d, "888poker").hud, { allowed: true, source: null, checkedAt: null }),
    ],
    [
      "hud.allowed true with an http source",
      (d) => Object.assign(site(d, "winamax").hud, { allowed: true, source: "http://x", checkedAt: "2026-10-13" }),
    ],
    [
      "hud.allowed true on a network",
      (d) => Object.assign(site(d, "ipoker").hud, { allowed: true, source: "https://x", checkedAt: "2026-10-13" }),
    ],
    ["table data on a network", (d) => (site(d, "chico").tables.title = "^(?<table>.+)$")],
    ["a date that is not a date", (d) => (site(d, "winamax").hud.checkedAt = "2026-02-30")],
    ["a verified path without a date", (d) => (site(d, "pokerstars").paths.windows[0].verified = true)],
    ["a Windows path with no root", (d) => (site(d, "pokerstars").paths.windows[0].path = "PokerStars\\HandHistory")],
    ["a macOS path with no root", (d) => (site(d, "pokerstars").paths.macos[0].path = "Library/PokerStars")],
    ["a parsed site without anonymisation", (d) => (site(d, "winamax").anonymisation = null)],
    ["an unknown anonymisation", (d) => (site(d, "ggpoker").anonymisation = "hashed")],
    ["a seat layout for 11 seats", (d) => (site(d, "winamax").tables.seatLayouts = { "11": "x" })],
    ["another version", (d) => (d.version = 2)],
    ["an id with capitals", (d) => (site(d, "winamax").id = "Winamax")],
  ];
  for (const [name, edit] of refused) {
    it(`refuses ${name}`, () => {
      const doc = shipped();
      edit(doc);
      expect(validate(doc)).toBe(false);
    });
  }

  it("accepts a sourced, dated allowance on a room", () => {
    const doc = shipped();
    Object.assign(site(doc, "winamax").hud, {
      allowed: true,
      source: "https://example.org/terms",
      checkedAt: "2026-10-13",
    });
    Object.assign(site(doc, "winamax").tables, {
      process: { windows: ["Winamax.exe"], macos: null },
      title: "^(?<table>.+?) / ",
      seatLayouts: { "6": "winamax-6max" },
    });
    expect(validate(doc)).toBe(true);
  });
});
