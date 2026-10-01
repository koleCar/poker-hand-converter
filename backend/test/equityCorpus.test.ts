/**
 * All-in EV over real hands.
 *
 * The property that needs no reference: evNet and net are two divisions of the
 * same money, so over the seats of a hand they must add up to the same total -
 * which is `houseIntoPot - fees`, the identity `stats/money.ts` is built on. A
 * dropped side pot, a folded seat's chips counted twice, a rake taken from the
 * wrong total or a rounding leak all break it.
 *
 * `fixtures/samples/` is run with the default options, the ones stored rows
 * will use, so every exhaustive preflop enumeration in it really happens (a few
 * seconds). The rest of the corpus runs with a tiny sample budget: the identity
 * does not depend on how equity was computed, and enumerating every preflop
 * all-in in it would cost another ten seconds for no extra coverage.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  analyzeAllIn,
  type AllInEvOptions,
  type AllInEvOutcome,
} from "../../frontend/src/lib/equity/index.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles, readTree, type CorpusFile } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");

async function handsOf(files: CorpusFile[]): Promise<PhfHand[]> {
  const parsed = await Promise.all(
    files.map(async (file) => {
      try {
        return (await convertAny(file.text, { sourceFilename: file.name })).hands;
      } catch {
        // A file no parser claims is the parser suites' problem, not this one.
        return [];
      }
    }),
  );
  return parsed.flat();
}

const SAMPLES = await handsOf(readTree(join(ROOT, "fixtures/samples"), "fixtures/samples"));
const REST = await handsOf([
  ...ggCorpusFiles(),
  ...weplayFiles(),
  ...readTree(join(import.meta.dirname, "fixtures"), "backend/test/fixtures"),
]);

interface Checked {
  hand: PhfHand;
  outcome: AllInEvOutcome;
}

function run(hands: PhfHand[], options: AllInEvOptions): Checked[] {
  return hands.map((hand) => ({ hand, outcome: analyzeAllIn(hand, options) }));
}

/** Every broken property of one hand's EV, as readable strings. */
function problems({ hand, outcome }: Checked): string[] {
  if (!outcome.applicable) {
    return [];
  }
  const { ev } = outcome;
  const id = `${hand.meta.siteId} ${hand.meta.handId}`;
  const out: string[] = [];

  const facts = handFacts(hand);
  const net = facts.seats.reduce((sum, seat) => sum + seat.money.net, 0);
  const evNet = ev.seats.reduce((sum, seat) => sum + seat.evNet, 0);
  if (net !== evNet) {
    out.push(`${id}: seats net ${net}, evNet ${evNet}`);
  }
  // One evNet for every stats row, and no others, so the two join by seat.
  const statSeats = facts.seats.map((seat) => seat.seat).join(",");
  const evSeats = ev.seats.map((seat) => seat.seat).join(",");
  if (statSeats !== evSeats) {
    out.push(`${id}: stats seats ${statSeats}, ev seats ${evSeats}`);
  }
  for (const pot of ev.pots) {
    const shares = pot.shares.reduce((sum, share) => sum + share, 0);
    if (shares !== pot.amount) {
      out.push(`${id}: pot of ${pot.amount} paid out ${shares}`);
    }
    const equity = pot.equity.reduce((sum, value) => sum + value, 0);
    if (Math.abs(equity - 1) > 1e-9) {
      out.push(`${id}: pot equity sums to ${equity}`);
    }
  }
  return out;
}

describe("all-in EV over fixtures/samples, default options", () => {
  const checked = run(SAMPLES, {});
  const applicable = checked.filter((entry) => entry.outcome.applicable);

  it("parses the samples and finds all-ins worth adjusting", () => {
    expect(SAMPLES.length).toBeGreaterThan(1500);
    // 137 of 1555 at the time of writing; a floor, so new samples do not
    // break it, but a walk that stopped finding all-ins would.
    expect(applicable.length).toBeGreaterThan(100);
  });

  it("splits exactly the money net splits, in every applicable hand", () => {
    expect(checked.flatMap(problems)).toEqual([]);
  });

  it("only skips for a stated reason", () => {
    const reasons = new Set(
      checked.flatMap((entry) => (entry.outcome.applicable ? [] : [entry.outcome.reason])),
    );
    expect([...reasons].every((reason) => typeof reason === "string")).toBe(true);
    expect(reasons.has("no-all-in")).toBe(true);
  });
});

describe("all-in EV over the rest of the corpus, sampled equity", () => {
  const checked = run(REST, { exhaustiveLimit: 50_000, trials: 200 });

  it("finds all-ins in the GG and WePlay exports too", () => {
    expect(REST.length).toBeGreaterThan(6000);
    expect(checked.filter((entry) => entry.outcome.applicable).length).toBeGreaterThan(300);
  });

  it("splits exactly the money net splits, in every applicable hand", () => {
    expect(checked.flatMap(problems)).toEqual([]);
  });
});
