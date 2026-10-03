/**
 * The flop library's committed pilot (phase A5b): a handful of real solves
 * (`tests/scripts/flop-library/pilot/`, produced by the batch runner with
 * the library's own profile). Checked here: every chunk decodes and says
 * what it was solved from, the manifest lists exactly what is there, and -
 * while the chart set it was solved from is still the committed one - the
 * analysis grades real flop decisions from it and narrows the flop by it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeHand, FLOP_PROFILE, memoryLibrary } from "../../frontend/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../frontend/src/lib/charts/index.js";
import {
  chunkHeader,
  decodeChunk,
  FLOPLIB_VERSION,
  flopCards,
  mapFlop,
  SOLVER_VERSION,
  type FlopChunk,
  type FlopManifest,
} from "../../frontend/src/lib/solver/index.js";
import { scriptHand, type ScriptAct } from "../../frontend/src/lib/training/handText.js";
import { lineActs } from "../../frontend/src/lib/training/preflop.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../frontend/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const DIR = join(import.meta.dirname, "../scripts/flop-library/pilot", CHARTS.id, FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));

function load(): { manifest: FlopManifest; chunks: FlopChunk[] } {
  const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest;
  const chunks = manifest.entries.map((e) => decodeChunk(readFileSync(join(DIR, e.path))));
  return { manifest, chunks };
}

describe.runIf(PRESENT)("the committed pilot", () => {
  it("decodes, and says what it was solved from", () => {
    const { manifest, chunks } = load();
    expect(manifest.version).toBe(FLOPLIB_VERSION);
    expect(manifest.tree).toBe(FLOP_PROFILE.tree);
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    chunks.forEach((chunk, k) => {
      const entry = manifest.entries[k];
      expect(chunk.header).toMatchObject({ version: FLOPLIB_VERSION, solver: SOLVER_VERSION, tree: FLOP_PROFILE.tree, line: entry.line, flop: entry.flop });
      expect(chunk.header.charts.id).toBe(CHARTS.id);
      expect(chunk.result.board).toEqual(flopCards(entry.flop));
      expect(chunk.result.iterations).toBe(entry.iterations);
      // Converged to the profile's target, or stopped at its cap and says so.
      if (chunk.result.exploitabilityPct > FLOP_PROFILE.targetPct) expect(chunk.result.stoppedBy).toBe("max-iterations");
      expect(readFileSync(join(DIR, entry.path)).length).toBe(entry.bytes);
    });
  });

  it("lists exactly the chunks on disk", () => {
    const { manifest } = load();
    const onDisk: string[] = [];
    for (const line of readdirSync(DIR)) {
      if (line.endsWith(".json")) continue;
      for (const file of readdirSync(join(DIR, line))) if (file.endsWith(".bin")) onDisk.push(`${line}/${file}`);
    }
    expect(onDisk.sort()).toEqual(manifest.entries.map((e) => e.path).sort());
    for (const entry of manifest.entries) expect(() => chunkHeader(readFileSync(join(DIR, entry.path)))).not.toThrow();
  });

  const sameCharts = PRESENT && load().manifest.charts.hash === CHARTS.model.hash;

  it.runIf(sameCharts)("grades real flop decisions from it: exact, relabelled and mapped flops", () => {
    const { chunks } = load();
    const library = memoryLibrary(chunks);
    const chunk = chunks.find((c) => c.header.line === "btn-bb" && c.header.flop === "Ts7h4d");
    expect(chunk).toBeDefined();
    if (!chunk) return;
    // The big blind checks, the button c-bets a third of the pot.
    const root = chunk.result.nodes[0];
    expect(root.actions.map((a) => a.kind)).toEqual(["check", "bet", "bet"]);
    const bet = chunk.result.nodes.find((n) => n.path === "X")?.actions.find((a) => a.kind === "bet");
    expect(bet).toBeDefined();
    const hand = (board: string[], cards: [string, string]) => {
      const flop: ScriptAct[] = [
        { position: "BB", type: "check" },
        { position: "BTN", type: "bet", to: bet?.to ?? 1.82 },
      ];
      return scriptHand({ id: "PILOT", hero: "BTN", heroCards: cards, stackBb: 100, preflop: lineActs(CHARTS, "fffrfc"), board, flop });
    };
    const flopOf = (h: ReturnType<typeof hand>) =>
      analyzeHand(h, { charts: CHARTS, turn: false, flopLibrary: library }).decisions.find((d) => d.street === "flop");
    const exact = flopOf(hand(["Ts", "7h", "4d"], ["Ah", "Th"]));
    expect(exact?.source).toBe("solver");
    expect(exact?.facts.flop).toMatchObject({ mapped: false, flop: "Ts7h4d", path: "X" });
    const relabelled = flopOf(hand(["Td", "7s", "4h"], ["As", "Ts"]));
    expect(relabelled?.options).toEqual(exact?.options);
    // Ts 7h 3d is not solved; its representative is.
    expect(mapFlop(["Ts", "7h", "3d"]).representative).toBe("Ts7h4d");
    const mapped = flopOf(hand(["Ts", "7h", "3d"], ["Ah", "Th"]));
    expect(mapped?.source).toBe("solver");
    expect(mapped?.approximations).toEqual(expect.arrayContaining(["flop-mapped", "library-bucketed"]));
  });

  it.runIf(sameCharts)("narrows the flop for the turn solve: the turn grade no longer rests on the flop heuristic", () => {
    const { chunks } = load();
    const chunk = chunks.find((c) => c.header.line === "btn-bb-3bet" && c.header.flop === "Ts7h4d");
    expect(chunk).toBeDefined();
    if (!chunk) return;
    const root = chunk.result.nodes[0];
    const lead = root.actions.findIndex((a) => a.kind === "bet");
    const h = scriptHand({
      id: "PILOTT",
      hero: "BTN",
      heroCards: ["Ac", "Kc"],
      stackBb: 100,
      preflop: lineActs(CHARTS, "fffrfrc"),
      board: ["Ts", "7h", "4d", "2c"],
      flop: [
        { position: "BB", type: "bet", to: root.actions[lead].to },
        { position: "BTN", type: "call" },
      ],
      turn: [
        { position: "BB", type: "check" },
        { position: "BTN", type: "check" },
      ],
    });
    const analysis = analyzeHand(h, { charts: CHARTS, flopLibrary: memoryLibrary(chunks) });
    const turn = analysis.decisions.find((d) => d.street === "turn");
    expect(turn?.source).toBe("solver");
    expect(turn?.facts.turn?.model).toMatch(/^floplib:/);
    expect(turn?.approximations).not.toContain("narrowing-heuristic");
    // Without the library the same turn rests on the heuristic.
    const plain = analyzeHand(h, { charts: CHARTS }).decisions.find((d) => d.street === "turn");
    expect(plain?.approximations).toContain("narrowing-heuristic");
  });
});
