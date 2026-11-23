/**
 * The Analytics stat catalogue on the web (docs/ANALYTICS.md Step 1):
 *
 * - `config/stats/analytics.json` fits `analytics.schema.json` (ajv, draft
 *   2020-12), the schema refuses what it promises to, and the web's copy
 *   (`web/src/lib/stats/analytics.json`) is the same bytes. The checks a
 *   schema cannot make are the Rust loader's (`core/rail-stats/tests/
 *   analytics.rs`).
 * - Every rate's predicate parses in the TypeScript port (`predicate.ts`),
 *   and the port parses and refuses as the Rust grammar does.
 * - Every rate counts what `core/rail-stats/tests/data/analytics/
 *   expected.json` says on the pinned hands - the same golden per stat the
 *   Rust test reads - and the membership names exactly the counted
 *   decisions.
 * - The hand classes and action classes read as the Rust ones.
 *
 * The whole corpus is compared with the Rust twin through
 * `testdata/golden-analytics/` (`npm run golden:emit`,
 * `core/rail-stats/tests/analytics_corpus.rs`).
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import {
  ANALYTICS,
  ANALYTICS_MEMBERSHIP_VERSION,
  compileCatalogue,
  decisionMembership,
  membershipFingerprint,
  type CatalogueFile,
} from "../../web/src/lib/stats/analytics.js";
import { handEvents } from "../../web/src/lib/stats/events.js";
import { countSeat, FIELDS, parsePredicate, PredicateError, readsCards } from "../../web/src/lib/stats/predicate.js";

const ROOT = join(import.meta.dirname, "../..");
const text = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const read = (path: string): unknown => JSON.parse(text(path));
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

type Json = Record<string, any>;

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
const validate = ajv.compile(read("config/stats/analytics.schema.json") as object);
const shipped = (): Json => read("config/stats/analytics.json") as Json;
const stat = (doc: Json, id: string): Json => {
  const found = doc.stats.find((s: Json) => s.id === id);
  if (!found) throw new Error(`no stat ${id}`);
  return found;
};

describe("config/stats/analytics.json", () => {
  it("fits its schema", () => {
    const ok = validate(shipped());
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("is the web's copy, byte for byte", () => {
    expect(text("web/src/lib/stats/analytics.json")).toBe(text("config/stats/analytics.json"));
  });

  const refused: [string, (doc: Json) => void][] = [
    ["an unknown field", (d) => (stat(d, "vpip").colour = "red")],
    ["another version", (d) => (d.version = 2)],
    ["an id with capitals", (d) => (stat(d, "vpip").id = "VPIP")],
    ["an id too long for its counter", (d) => (stat(d, "vpip").id = "x".repeat(58))],
    ["a label without Croatian", (d) => delete stat(d, "vpip").label.hr],
    ["an unknown kind", (d) => (stat(d, "vpip").kind = "ratio")],
    ["an unknown class", (d) => (stat(d, "vpip").class = "limp")],
    ["a rate without a count", (d) => delete stat(d, "vpip").count],
    ["a rate with weak classes", (d) => (stat(d, "vpip").weak = ["nothing"])],
    ["a rate on the showdown", (d) => (stat(d, "vpip").street = "showdown")],
    ["a share with a count", (d) => (stat(d, "river_bet_weak").count = "each street = river")],
    ["a share without weak classes", (d) => delete stat(d, "river_bet_weak").weak],
    ["a coded stat with a class", (d) => (stat(d, "wtsd").class = "fold")],
    ["a zero sample minimum", (d) => (stat(d, "vpip").sample.min = 0)],
    ["a zero band floor", (d) => (stat(d, "vpip").band.floor = 0)],
    ["words without a low side", (d) => delete stat(d, "vpip").words.low],
    ["an unknown made class", (d) => (d.handClasses[0].made = ["monster"])],
    ["an unknown draw", (d) => (d.handClasses[4].draws = ["backdoor-gutshot"])],
    ["a missing action class", (d) => delete d.actionClasses.pfr],
    ["an action class with an all-in", (d) => (d.actionClasses.raise = ["raise", "allin"])],
  ];
  for (const [name, edit] of refused) {
    it(`refuses ${name}`, () => {
      const doc = shipped();
      edit(doc);
      expect(validate(doc)).toBe(false);
    });
  }

  it("pins the membership version to the rates (as the Rust test does)", () => {
    const hash = createHash("sha256").update(membershipFingerprint()).digest("hex");
    expect([ANALYTICS_MEMBERSHIP_VERSION, hash]).toEqual([
      "analytics/1",
      "7028ad973dfd9427342549616e247bf45e412625d2116c49cbfbd69172dc5119",
    ]);
    expect(text("core/rail-stats/src/analytics.rs")).toContain(
      `pub const MEMBERSHIP_VERSION: &str = "${ANALYTICS_MEMBERSHIP_VERSION}";`,
    );
  });

  it("compiles every rate's predicate, none reading cards", () => {
    const rates = ANALYTICS.stats.filter((s) => s.kind === "rate");
    expect(rates.length).toBe(16);
    ANALYTICS.predicates.forEach((predicate, index) => {
      expect(predicate === null).toBe(ANALYTICS.stats[index].kind !== "rate");
      if (predicate) expect(readsCards(predicate)).toBe(false);
    });
    const broken = shipped() as CatalogueFile;
    (stat(broken, "vpip") as Json).count = "any street = preflp";
    expect(() => compileCatalogue(broken)).toThrow(/vpip: street is one of preflop, flop, turn, river; not "preflp"/);
  });
});

describe("the predicate port", () => {
  const field = (name: string) => FIELDS.findIndex((def) => def.name === name);

  it("has the Rust fields, in their order", () => {
    const rust = [...text("core/rail-stats/src/custom.rs").matchAll(/^\s+[A-Z][A-Za-z]* => "([a-z_]+)": /gm)].map(
      (match) => match[1],
    );
    expect(rust.length).toBeGreaterThan(40);
    expect(FIELDS.map((def) => def.name)).toEqual(rust);
  });

  it("parses modes, precedence and values as the Rust grammar does", () => {
    const p = parsePredicate("first street = flop and (facing = bet or not first_on_street) => action in (raise, bet)");
    expect(p.mode).toBe("first");
    expect(p.opportunity.op).toBe("and");
    expect(p.action).toEqual({ op: "test", field: field("action"), test: { kind: "in", values: ["raise", "bet"] } });
    expect(parsePredicate("each size_pot <= 33.3").opportunity).toEqual({
      op: "test",
      field: field("size_pot"),
      test: { kind: "cmp", cmp: "<=", value: 33300 },
    });
    expect(parsePredicate("any saw_flop").action).toBeNull();
  });

  const errors: [string, RegExp][] = [
    ["", /empty/],
    ["street = flop", /start with first, any or each/],
    ["first", /expected the opportunity/],
    ["first stret = flop", /unknown field "stret"/],
    ["first street = flp", /one of preflop/],
    ["first street < flop", /compares numbers/],
    ["first size_pot <= 1.2345", /at most three digits/],
    ["first (street = flop", /expected "and", "or" or "\)"/],
    ["first street = flop =>", /expected the action/],
    ["first Street = flop", /names are lower case/],
    ["first hero in (true)", /yes or no/],
    ["first raise_level", /compare it/],
  ];
  for (const [source, message] of errors) {
    it(`refuses ${JSON.stringify(source)}`, () => {
      expect(() => parsePredicate(source)).toThrow(PredicateError);
      expect(() => parsePredicate(source)).toThrow(message);
    });
  }
});

describe("every rate on the pinned hands", () => {
  const expected = read("core/rail-stats/tests/data/analytics/expected.json") as Json;
  const covered = new Map<string, [number, number]>();

  for (const entry of expected.hands as Json[]) {
    it(entry.file.split("/").pop(), () => {
      const hand = parseStandardHand(text(entry.file), CTX);
      if (!hand) throw new Error(`${entry.file} did not parse`);
      const events = handEvents(hand);
      expect(Object.keys(entry.seats).length).toBe(events.seats.length);
      const members = decisionMembership(hand);
      for (const seat of events.seats) {
        const name = hand.players.find((player) => player.seat === seat.seat)!.name;
        const want = entry.seats[name] as Record<string, [number, number]>;
        const counts = ANALYTICS.counts(events, seat);
        ANALYTICS.stats.forEach((s, index) => {
          if (s.kind !== "rate") return;
          const got: [number, number] = [counts[index].made, counts[index].opp];
          expect([name, s.id, got]).toEqual([name, s.id, want[s.id] ?? [0, 0]]);
          const total = covered.get(s.id) ?? [0, 0];
          covered.set(s.id, [total[0] + got[0], total[1] + got[1]]);
          // The membership names the counted decisions.
          const mine = members
            .filter((member) => member.seat === seat.seat)
            .flatMap((member) => member.stats.filter(([i]) => i === index).map(([, taken]) => taken));
          expect([s.id, mine.filter(Boolean).length, mine.length]).toEqual([s.id, got[0], got[1]]);
          // And the compiled predicate counts as the catalogue does.
          expect(countSeat(ANALYTICS.predicates[index]!, events, seat)).toEqual(counts[index]);
        });
      }
    });
  }

  it("pins every rate both taken and not", () => {
    for (const s of ANALYTICS.stats) {
      if (s.kind !== "rate") continue;
      const [made, opp] = covered.get(s.id) ?? [0, 0];
      expect([s.id, made > 0 && made < opp]).toEqual([s.id, true]);
    }
  });
});

describe("hand classes and action classes", () => {
  const cls = (made: string | null, draws: string[]) => ANALYTICS.handClass(made, draws)?.id ?? null;

  it("reads facts.made and facts.draws as the Rust twin", () => {
    expect(cls(null, [])).toBeNull();
    expect(cls("set", ["flush-draw"])).toBe("top_pair_plus");
    expect(cls("top-pair", [])).toBe("top_pair_plus");
    expect(cls("second-pair", ["oesd"])).toBe("middle_pair");
    expect(cls("pocket-pair-below-top", [])).toBe("middle_pair");
    expect(cls("weak-pair", [])).toBe("weak_pair");
    expect(cls("underpair", [])).toBe("underpair");
    expect(cls("high-card", ["nut-flush-draw"])).toBe("strong_draw");
    expect(cls("ace-high", ["oesd", "backdoor-flush"])).toBe("strong_draw");
    expect(cls("high-card", ["gutshot", "overcards"])).toBe("gutshot");
    expect(cls("ace-high", ["backdoor-straight"])).toBe("ace_high_backdoor");
    expect(cls("high-card", ["backdoor-flush"])).toBe("nothing");
    expect(cls("high-card", ["overcards"])).toBe("overcards");
    expect(cls("ace-high", [])).toBe("nothing");
    expect(cls("board", [])).toBe("nothing");
  });

  it("puts each chosen action in its classes", () => {
    expect(ANALYTICS.inClass("fold", "fold")).toBe(true);
    expect(ANALYTICS.inClass("fold", "check")).toBe(false);
    expect(ANALYTICS.inClass("vpip", "call")).toBe(true);
    expect(ANALYTICS.inClass("vpip", "check")).toBe(false);
    expect(ANALYTICS.inClass("pfr", "raise")).toBe(true);
    expect(ANALYTICS.inClass("pfr", "call")).toBe(false);
  });
});
