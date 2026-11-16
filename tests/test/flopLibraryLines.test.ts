/**
 * The flop library's lines on the GTO Wizard sets (`analysis/43`):
 *
 * - **Extra lines** (`libraryLine`): any heads-up line the charts play to
 *   the flop is a library line - a fixed one of the table where it is one,
 *   else `x-<key>` with the seats still to act folded out, so a hand, the
 *   Solver's preflop walk and the nightly runner name it alike.
 * - **The line's hash** (`chartLineHash`, `chunkFromCharts`): a chunk is read
 *   while the chart nodes of its own line are unchanged, even after the set
 *   is re-transcribed elsewhere (a `model.missing` subtree filled in).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { chartLineHash, chunkFromCharts, libraryLine, libraryLineById } from "../../web/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../web/src/lib/charts/index.js";
import { preflopState } from "../../web/src/components/solver/preflop.js";
import { flopLinesFor } from "../../web/src/lib/analysis/index.js";
import { fileOf as chartFile } from "./charts/support.js";

const SET = "nlhe-cash-6max-100bb";
const raw = () => JSON.parse(readFileSync(chartFile(SET), "utf8")) as { model: { hash: string }; nodes: { line: string; freq: string }[] };
const charts: ChartSet = loadCharts(raw());

describe("extra library lines", () => {
  it("keeps the fixed lines, folds out the seats still to act, and names the pot", () => {
    expect(libraryLine(charts, "fffrfc")?.id).toBe("btn-bb");
    // The big blind's fold behind the button-small-blind pot is the same fixed line.
    expect(libraryLine(charts, "fffrc")?.id).toBe("btn-sb");
    // The cutoff's open flatted by the button: the blinds fold after the call.
    expect(libraryLine(charts, "ffrc")).toEqual({ id: "x-ffrcff", pot: "srp", key: "ffrcff", players: 6 });
    // The small blind's 3-bet of an under-the-gun open, called: a 3-bet pot.
    expect(libraryLine(charts, "rfffrfc")).toMatchObject({ id: "x-rfffrfc", pot: "3bp" });
    // Read back by id, and nothing for an id that is not its key's line.
    expect(libraryLineById(charts, "x-ffrcff")?.key).toBe("ffrcff");
    expect(libraryLineById(charts, "btn-bb")?.key).toBe("fffrfc");
    expect(libraryLineById(charts, "x-ffrc")).toBeNull();
    expect(libraryLineById(charts, "nope")).toBeNull();
  });

  it("gives the Solver's preflop walk the same line a hand gets", () => {
    const state = preflopState(charts, "ffrcff", flopLinesFor(6));
    expect(state.end).toMatchObject({ kind: "flop", line: { id: "x-ffrcff" } });
    expect(preflopState(charts, "fffrfc", flopLinesFor(6)).end).toMatchObject({ kind: "flop", line: { id: "btn-bb" } });
  });
});

describe("a chunk read by its line's chart nodes", () => {
  const header = (lineKey: string, hash = charts.model.hash) => ({
    charts: { id: charts.id, version: charts.version, hash },
    lineKey,
    lineHash: chartLineHash(charts, lineKey) ?? undefined,
  });

  it("is deterministic and differs between lines", () => {
    const btn = chartLineHash(charts, "fffrfc");
    expect(btn).toMatch(/^[0-9a-f]{8}$/);
    expect(chartLineHash(loadCharts(raw()), "fffrfc")).toBe(btn);
    expect(chartLineHash(charts, "ffrffc")).not.toBe(btn);
  });

  it("survives a change elsewhere in the set, not one on its own line", () => {
    // Another set hash (a subtree filled in): the chunk still reads while its line's nodes are the same.
    const elsewhere = raw();
    elsewhere.model.hash = "00000000";
    // (Frequencies swapped in from a node of the same shape keep the set valid.)
    const swap = (json: ReturnType<typeof raw>, line: string, from: string) => {
      const node = json.nodes.find((n) => n.line === line)!;
      const donor = json.nodes.find((n) => n.line === from)!;
      expect(donor.freq.length).toBe(node.freq.length);
      expect(donor.freq).not.toBe(node.freq);
      node.freq = donor.freq;
    };
    swap(elsewhere, "rff", "rfff");
    const refilled = loadCharts(elsewhere);
    expect(chunkFromCharts(header("fffrfc"), refilled)).toBe(true);

    // A node the button-big-blind line passes through changes: the chunk is not read.
    const touched = raw();
    touched.model.hash = "00000000";
    swap(touched, "fff", "ff");
    expect(chunkFromCharts(header("fffrfc"), loadCharts(touched))).toBe(false);

    // A chunk without a line hash reads only on the same set hash; another set id never.
    expect(chunkFromCharts({ ...header("fffrfc"), lineHash: undefined }, charts)).toBe(true);
    expect(chunkFromCharts({ ...header("fffrfc"), lineHash: undefined }, refilled)).toBe(false);
    expect(chunkFromCharts({ ...header("fffrfc"), charts: { id: "nlhe-cash-6max-100bb-ante", version: "", hash: charts.model.hash } }, charts)).toBe(false);
  });
});
