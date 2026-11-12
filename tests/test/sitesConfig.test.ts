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
/** A well-formed seat layout (R3.6) of `seats` seats, thousandths. */
const seatLayout = (seats: number): Json => ({
  seats: Array.from({ length: seats }, (_, i) => [100 + i * 80, 800]),
  plate: [150, 80],
  center: [500, 500],
  heroSlot: 0,
  graphics: [[300, 450, 400, 120]],
  seatNumbers: null,
});

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

  // R3.4: the restrictions the HUD's renderer enforces, pinned with the
  // policies (core/rail-config/tests/sites.rs holds the same).
  it("carries the R3.4 HUD restrictions", () => {
    const restrictions = Object.fromEntries(
      shipped()
        .sites.filter((s: Json) => s.hud.restrictions !== null)
        .map((s: Json) => [s.id, s.hud.restrictions]),
    );
    expect(Object.keys(restrictions)).toEqual(["pokerstars", "winamax", "acr"]);
    expect(restrictions.pokerstars).toMatchObject({ maxColourThresholds: 2, noCardSplitStats: true, noPlayerLabels: true });
    expect(restrictions.acr).toMatchObject({ noHandInPlay: true, noOverlapTableGraphics: true, ownHandsOnly: true });
  });

  // T0 (docs/research/TILING-POLICIES.md), proposed for the owner's
  // sign-off; core/rail-config/tests/sites.rs pins the same list.
  // T7 (docs/research/TILING-POLICIES.md): the Action Required slot is
  // unknown on every entry, with no turn signal; turning one on needs the
  // owner's signed verdict and the T6 signal capture.
  it("allows the Action Required slot nowhere yet", () => {
    for (const s of shipped().sites as Json[]) {
      expect([s.id, s.actionSlot.allowed, s.actionSlot.signal]).toEqual([s.id, null, null]);
      expect(s.actionSlot.notes).toMatch(/TILING-POLICIES\.md/);
    }
  });

  it("carries the T0 tiling and RNG policies, apart from the HUD's", () => {
    const policies = Object.fromEntries(
      shipped().sites.map((s: Json) => [s.id, [s.tiling.allowed, s.rng.allowed]]),
    );
    expect(policies).toEqual({
      pokerstars: [true, null],
      ggpoker: [false, false],
      winamax: [false, false],
      "888poker": [null, false],
      partypoker: [false, false],
      ipoker: [null, null],
      acr: [true, null],
      coinpoker: [true, false],
      unibet: [false, false],
      chico: [null, null],
      ignition: [null, null],
      weplay: [null, null],
      pokerbros: [false, false],
      microgaming: [false, false],
      fulltilt: [false, false],
      ongame: [false, false],
      entraction: [false, false],
      runitonce: [false, false],
      standard: [false, false],
      "wpt-global": [true, false],
      bossmedia: [false, false],
      merge: [false, false],
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
    // R3.4: a permitted room states its restrictions, in this shape.
    ["hud.allowed true without restrictions", (d) => (site(d, "pokerstars").hud.restrictions = null)],
    ["a restriction missing", (d) => delete site(d, "acr").hud.restrictions.noOverlapTableGraphics],
    ["an unknown restriction", (d) => (site(d, "acr").hud.restrictions.noColours = true)],
    ["a negative threshold count", (d) => (site(d, "pokerstars").hud.restrictions.maxColourThresholds = -1)],
    ["a restriction that is not a boolean", (d) => (site(d, "winamax").hud.restrictions.noGraphs = "yes")],
    ["table data on a network", (d) => (site(d, "chico").tables.title = "^(?<table>.+)$")],
    ["a date that is not a date", (d) => (site(d, "winamax").hud.checkedAt = "2026-02-30")],
    ["a verified path without a date", (d) => (site(d, "pokerstars").paths.windows[0].verified = true)],
    ["a Windows path with no root", (d) => (site(d, "pokerstars").paths.windows[0].path = "PokerStars\\HandHistory")],
    ["a macOS path with no root", (d) => (site(d, "pokerstars").paths.macos[0].path = "Library/PokerStars")],
    ["a parsed site without anonymisation", (d) => (site(d, "winamax").anonymisation = null)],
    ["an unknown anonymisation", (d) => (site(d, "ggpoker").anonymisation = "hashed")],
    ["a seat layout for 11 seats", (d) => (site(d, "winamax").tables.seatLayouts = { "11": seatLayout(11) })],
    // R3.6: a layout is geometry in thousandths of the client area.
    ["a seat layout by name", (d) => (site(d, "winamax").tables.seatLayouts = { "6": "winamax-6max" })],
    [
      "a seat point past the client area",
      (d) => {
        const layout = seatLayout(6);
        layout.seats[0] = [500, 1001];
        site(d, "winamax").tables.seatLayouts = { "6": layout };
      },
    ],
    [
      "a seat layout without its graphics",
      (d) => {
        const layout: Record<string, unknown> = seatLayout(6);
        delete layout.graphics;
        site(d, "winamax").tables.seatLayouts = { "6": layout };
      },
    ],
    [
      "repeated hand-history seat numbers",
      (d) => {
        const layout = seatLayout(6);
        layout.seatNumbers = [1, 1, 2, 3, 4, 5];
        site(d, "winamax").tables.seatLayouts = { "6": layout };
      },
    ],
    [
      "verified table titles without a date",
      (d) =>
        Object.assign(site(d, "winamax").tables, {
          verified: true,
          title: "^(?<table>.+?) - ",
          source: "Observed on a Windows install, 2026-10-20: Winamax 7",
        }),
    ],
    [
      "verified table titles without an observation",
      (d) =>
        Object.assign(site(d, "winamax").tables, {
          verified: true,
          title: "^(?<table>.+?) - ",
          checkedAt: "2026-10-20",
          source: "docs/research/hh-formats/winamax.md",
        }),
    ],
    ["another version", (d) => (d.version = 2)],
    ["an id with capitals", (d) => (site(d, "winamax").id = "Winamax")],
    // T0: tiling and the RNG, each its own block, under the HUD's rules.
    ["an entry without a tiling block", (d) => delete site(d, "acr").tiling],
    ["an entry without an rng block", (d) => delete site(d, "acr").rng],
    ["a field missing from a tiling block", (d) => delete site(d, "acr").tiling.notes],
    ["an unknown field in an rng block", (d) => (site(d, "acr").rng.restrictions = null)],
    ["tiling allowed without a date", (d) => (site(d, "acr").tiling.checkedAt = null)],
    ["tiling allowed with an http source", (d) => (site(d, "pokerstars").tiling.source = "http://x")],
    [
      "rng allowed without a source",
      (d) => Object.assign(site(d, "weplay").rng, { allowed: true, source: null, checkedAt: "2026-11-11" }),
    ],
    [
      "tiling allowed on a network",
      (d) => Object.assign(site(d, "ipoker").tiling, { allowed: true, source: "https://x", checkedAt: "2026-11-11" }),
    ],
    ["rng allowed as text", (d) => (site(d, "ggpoker").rng.allowed = "no")],
    // T7: the Action Required slot's block, with its turn signal.
    ["an entry without an actionSlot block", (d) => delete site(d, "acr").actionSlot],
    ["an actionSlot block without its signal", (d) => delete site(d, "acr").actionSlot.signal],
    ["a signal in a tiling block", (d) => (site(d, "acr").tiling.signal = { windows: "flash", macos: null })],
    ["a signal nobody knows", (d) => (site(d, "acr").actionSlot.signal = { windows: "blink", macos: null })],
    [
      "an actionSlot allowed without a signal",
      (d) => Object.assign(site(d, "pokerstars").actionSlot, { allowed: true, source: "https://x", checkedAt: "2026-11-12" }),
    ],
    [
      "an actionSlot allowed on a network",
      (d) =>
        Object.assign(site(d, "ipoker").actionSlot, {
          allowed: true,
          source: "https://x",
          checkedAt: "2026-11-12",
          signal: { windows: "flash", macos: null },
        }),
    ],
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
      seatLayouts: { "6": seatLayout(6) },
      preferredSeat: true,
      verified: true,
      checkedAt: "2026-10-20",
      source: "Observed on a Windows install, 2026-10-20: Winamax 7",
    });
    expect(validate(doc)).toBe(true);
  });

  it("accepts a sourced, dated Action Required slot with a turn signal (T7)", () => {
    const doc = shipped();
    Object.assign(site(doc, "pokerstars").actionSlot, {
      allowed: true,
      source: "https://example.org/tools",
      checkedAt: "2026-11-12",
      signal: { windows: "flash", macos: null },
    });
    expect(validate(doc)).toBe(true);
  });

  it("accepts tiling allowed on a room whose HUD is refused", () => {
    const doc = shipped();
    expect(site(doc, "ggpoker").hud.allowed).toBe(false);
    Object.assign(site(doc, "ggpoker").tiling, {
      allowed: true,
      source: "https://example.org/tools",
      checkedAt: "2026-11-11",
      notes: null,
    });
    expect(validate(doc)).toBe(true);
  });
});
