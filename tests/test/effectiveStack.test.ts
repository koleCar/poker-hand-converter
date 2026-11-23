/**
 * The effective stack at the hero's first preflop action (docs/ANALYTICS.md
 * Step 11), the web's twin of `events.rs`' `effective_first_action_bb`:
 *
 * - the pinned hands give the values worked out by hand
 *   (`core/rail-stats/tests/data/effective-stack/expected.json`, which the
 *   Rust test reads too) and their Effective stack bucket;
 * - the builder facts carry it in tenths (`effStack`), what the web stores
 *   in `hand_facts.eff_stack_tenths` and the desktop in
 *   `hand_list.eff_stack_tenths`; the whole golden corpus is held equal to
 *   the Rust ones by `testdata/golden-facts/` and `testdata/golden-analytics/`
 *   (the events' hash);
 * - the shared filter offers the Effective stack chip and sends it to both
 *   surfaces' sources and to the checker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkerFiltersOf } from "../../packages/ui/analytics/view.js";
import { EMPTY_FILTER, toQuery } from "../../packages/ui/hands/filter.js";
import { BUILDER_GROUPS, HAND_GROUPS, LIST_GROUPS, PANES, filterGroups } from "../../packages/ui/hands/groups.js";
import { stackBucketOf } from "../../packages/ui/hands/stackBuckets.js";
import { libraryFilter } from "../../web/src/lib/db/handsSource.js";
import { handDerivation } from "../../web/src/lib/db/statsRows.js";
import { parseStandardHand } from "../../web/src/lib/phf/serialize.js";
import { FACTS_VERSION, builderFacts, keptRows } from "../../web/src/lib/stats/index.js";
import { effectiveFirstActionBb, handEvents } from "../../web/src/lib/stats/events.js";
import { handFacts } from "../../web/src/lib/stats/derive.js";
import { statsRows } from "../../web/src/lib/stats/mapping.js";

const ROOT = join(import.meta.dirname, "../..");
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const text = (path: string): string => readFileSync(join(ROOT, path), "utf8");

interface Case {
  file: string;
  hero: number;
  thousandths: number;
  bucket: string;
  why: string;
}

const cases = (JSON.parse(text("core/rail-stats/tests/data/effective-stack/expected.json")) as { cases: Case[] }).cases;

const hand = (file: string) => {
  const parsed = parseStandardHand(text(file), CTX);
  if (!parsed) throw new Error(`${file} did not parse`);
  return parsed;
};

describe("effective stack at the first preflop action", () => {
  it("the pinned hands give the worked values, in the events too", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      const h = hand(c.file);
      expect(effectiveFirstActionBb(h, c.hero), `${c.file}: ${c.why}`).toBe(c.thousandths);
      const seat = handEvents(h).seats.find((s) => s.seat === c.hero);
      expect(seat?.hero, c.file).toBe(true);
      expect(seat?.effectiveFirstActionBb, `${c.file}: events`).toBe(c.thousandths);
      expect(stackBucketOf("filter", Math.floor(c.thousandths / 100)), `${c.file}: bucket`).toBe(c.bucket);
    }
  });

  it("every seat measures against the stacks live at its turn", () => {
    const seats = handEvents(hand("core/rail-stats/tests/data/effective-stack/01-folded-deep-stack-left-out.txt")).seats.map(
      (s) => [s.seat, s.effectiveFirstActionBb],
    );
    expect(seats).toEqual([
      [1, 100_000],
      [2, 100_000],
      [3, 60_000],
      [4, 250_000],
      [5, 100_000],
      [6, 100_000],
    ]);
  });

  it("the builder facts carry the hero's in tenths, at facts/2, and the web writes it", () => {
    expect(FACTS_VERSION).toBe("facts/2");
    for (const c of cases) {
      const h = hand(c.file);
      const facts = builderFacts(h, keptRows(statsRows(handFacts(h)), false));
      expect(facts.effStack, c.file).toBe(Math.floor(c.thousandths / 100));
      expect(handDerivation(h, { includeVillains: false }).facts?.eff_stack_tenths, c.file).toBe(facts.effStack);
    }
  });
});

describe("the Effective stack chip", () => {
  it("is a list group of the common row, in the builder's Stacks pane, everywhere hands are filtered", () => {
    expect(LIST_GROUPS.effStack).toBe("effStacks");
    expect(HAND_GROUPS).toContain("effStack");
    expect(BUILDER_GROUPS).not.toContain("effStack");
    expect(PANES.flatMap((s) => s.panes).find((p) => p.id === "stacks")?.groups).toContain("effStack");
    const features = { annotations: true, search: true, sorts: [], more: [], builder: false };
    expect(filterGroups(features)).toContain("effStack");
    expect(filterGroups({ ...features, rollupsOnly: true })).not.toContain("effStack");
  });

  it("goes to the sources only when set, and the web's library filter carries it", () => {
    expect(toQuery(EMPTY_FILTER).effStacks).toBeUndefined();
    const query = toQuery({ ...EMPTY_FILTER, effStacks: ["40-80", "120+"] });
    expect(query.effStacks).toEqual(["40-80", "120+"]);
    expect(libraryFilter(query).effStacks).toEqual(["40-80", "120+"]);
    expect(libraryFilter(query).factsVersion).toBe("facts/2");
  });

  it("the checker follows it: the desktop's store by key, the web through the Hands filter", () => {
    const { filters, partial, hands } = checkerFiltersOf(toQuery({ ...EMPTY_FILTER, effStacks: ["80-120"] }));
    expect(filters.effStacks).toEqual(["80-120"]);
    expect(partial).toBe(false);
    expect(hands).toBe(true);
  });
});
