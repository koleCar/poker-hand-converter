/**
 * The flop range study (`docs/ANALYSIS-PLAN.md` §10, 2026-10-29): a flop
 * decision graded from the flop library shows the hero's whole range at the
 * node, read from the chunk the grade read (`flopStudy` / `flopStudyAt`), in
 * the real board's combos. Nothing is solved and nothing is stored.
 *
 * On the committed pilot (`tests/scripts/flop-library/pilot/`), while the
 * charts it was solved from are the committed ones:
 *
 * 1. **The real board**: an exact flop, the same flop with its suits
 *    permuted (the same chunk, combo for combo, read through the
 *    permutation) and a flop mapped to its representative (read by
 *    category) each give a study on their own board: the hero's row equals
 *    the graded options, no combo holds a board card, and the permuted flop's
 *    grid, totals and categories equal the exact one's.
 * 2. **One chunk, one fetch**: the worker's loader (`FlopLibraryLoader`)
 *    fetches the chunk once for the grade and the study, in the analysis
 *    worker's path (`prefetch`) and in the trainer's (`prepareFlopLibrary`,
 *    where the answer comes back with its study).
 * 3. **The fallback**: no study (the sheet says the spot could not be
 *    rebuilt) for a multiway flop, a flop the library has no chunk for, no
 *    library, or a decision that is not on the flop.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyzeHand, flopStudy, FLOP_PROFILE, FlopLibraryLoader, memoryLibrary, type RiverStudy } from "../../web/src/lib/analysis/index.js";
import { loadCharts, type ChartSet } from "../../web/src/lib/charts/index.js";
import { cardIndex } from "../../web/src/lib/equity/evaluator.js";
import { COMBO_CLASS, comboHi, comboLo, decodeChunk, HAND_CLASSES, mapFlop, NUM_COMBOS, type FlopChunk, type FlopManifest } from "../../web/src/lib/solver/index.js";
import { scriptHand, type ScriptAct } from "../../web/src/lib/training/handText.js";
import { prepareFlopLibrary, runTrainingJob, type TrainingRequest } from "../../web/src/lib/training/jobs.js";
import { lineActs } from "../../web/src/lib/training/preflop.js";
import type { DecisionAnalysis } from "../../web/src/lib/analysis/types.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";

const CHARTS: ChartSet = loadCharts(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../web/src/lib/charts/data/nlhe-cash-6max-100bb.json"), "utf8")),
);
const ROOT = join(import.meta.dirname, "../scripts/flop-library/pilot");
const DIR = join(ROOT, CHARTS.id, FLOP_PROFILE.tree);
const PRESENT = existsSync(join(DIR, "manifest.json"));
const manifest = PRESENT ? (JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FlopManifest) : null;
const sameCharts = manifest !== null && manifest.charts.hash === CHARTS.model.hash;

function chunks(): FlopChunk[] {
  return manifest!.entries.map((e) => decodeChunk(readFileSync(join(DIR, e.path))));
}

/** A loader over the pilot on disk, counting what it fetches (the bucket's paths). */
function diskLoader() {
  const fetched: string[] = [];
  const loader = new FlopLibraryLoader("disk:", async (url) => {
    const path = url.slice("disk:/".length);
    fetched.push(path);
    const file = join(ROOT, path);
    if (!existsSync(file)) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = readFileSync(file);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(bytes.toString("utf8")),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
  return { loader, fetched, chunkFetches: () => fetched.filter((p) => p.endsWith(".bin")) };
}

/** The pilot's btn-bb hand: the big blind checks, the button (the hero) bets. */
function btnHand(board: string[], cards: [string, string], betTo: number): PhfHand {
  const flop: ScriptAct[] = [
    { position: "BB", type: "check" },
    { position: "BTN", type: "bet", to: betTo },
  ];
  return scriptHand({ id: "STUDY", hero: "BTN", heroCards: cards, stackBb: 100, preflop: lineActs(CHARTS, "fffrfc"), board, flop });
}

const flopDecision = (hand: PhfHand, library: ReturnType<typeof memoryLibrary> | FlopLibraryLoader | null) =>
  analyzeHand(structuredClone(hand), { charts: CHARTS, turn: false, flopLibrary: library }).decisions.find((d) => d.street === "flop");

/** Unblocked combos per hand class on a board: what a cell can hold at most. */
function classRoom(board: readonly string[]): number[] {
  const cards = board.map(cardIndex);
  const room = new Array(HAND_CLASSES.length).fill(0);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (cards.includes(comboHi(c)) || cards.includes(comboLo(c))) continue;
    room[COMBO_CLASS[c]] += 1;
  }
  return room;
}

/** The study's own row for the hero equals the graded options, action for action. */
function expectHeroRow(study: RiverStudy, decision: DecisionAnalysis) {
  expect(study.options.map((o) => o.action)).toEqual(decision.options.map((o) => o.action));
  study.hero.freq.forEach((freq, a) => expect(freq).toBeCloseTo(decision.options[a].freq, 3));
  study.hero.ev.forEach((ev, a) => expect(ev).toBeCloseTo(decision.options[a].ev, 2));
}

/** Every cell within the combos the real board leaves, and the board's own pair classes reduced. */
function expectRealBoard(study: RiverStudy, board: readonly string[]) {
  const room = classRoom(board);
  study.cells.forEach((cell, i) => expect(cell.combos).toBeLessThanOrEqual(room[i] + 1e-6));
}

describe.runIf(sameCharts)("the flop study from the library (pilot)", () => {
  const library = memoryLibrary(chunks());
  const chunk = chunks().find((c) => c.header.line === "btn-bb" && c.header.flop === "Ts7h4d")!;
  const betTo = chunk.result.nodes.find((n) => n.path === "X")!.actions.find((a) => a.kind === "bet")!.to;

  it("reads the exact flop's chunk at the graded node, in the hand's combos", () => {
    const hand = btnHand(["Ts", "7h", "4d"], ["Ah", "Th"], betTo);
    const decision = flopDecision(hand, library)!;
    expect(decision.source).toBe("solver");
    expect(decision.facts.flop).toMatchObject({ source: "library", mapped: false, path: "X" });
    const study = flopStudy(structuredClone(hand), decision.actionIndex, { charts: CHARTS, flopLibrary: library });
    expect(study).not.toBeNull();
    expect(study!).toMatchObject({ street: "flop", path: "X", board: ["Ts", "7h", "4d"], heroClass: "ATs", heroCombo: "AhTh" });
    expectHeroRow(study!, decision);
    expectRealBoard(study!, study!.board);
    // The node's mix over the whole range sums to one, and the range holds hands.
    expect(study!.options.reduce((sum, o) => sum + o.share, 0)).toBeCloseTo(1, 3);
    expect(study!.categories.length).toBeGreaterThan(0);
    expect(study!.categories.every((row) => ["made", "draws", "nothing"].includes(row.group))).toBe(true);
    expect(study!.villain.combos).toBeGreaterThan(0);
    expect(study!.iterations).toBe(chunk.result.iterations);
  });

  it("reads a suit-permuted flop through the same chunk, on its own board", () => {
    const exactHand = btnHand(["Ts", "7h", "4d"], ["Ah", "Th"], betTo);
    const permutedHand = btnHand(["Td", "7s", "4h"], ["As", "Ts"], betTo);
    const exact = flopStudy(structuredClone(exactHand), flopDecision(exactHand, library)!.actionIndex, { charts: CHARTS, flopLibrary: library })!;
    const decision = flopDecision(permutedHand, library)!;
    expect(decision.facts.flop).toMatchObject({ source: "library", mapped: false, flop: "Ts7h4d" });
    const permuted = flopStudy(structuredClone(permutedHand), decision.actionIndex, { charts: CHARTS, flopLibrary: library })!;
    expect(permuted).not.toBeNull();
    // The real board and the real hero combo, not the chunk's.
    expect(permuted.board).toEqual(["Td", "7s", "4h"]);
    expect(permuted.heroCombo).toBe("AsTs");
    expectHeroRow(permuted, decision);
    expectRealBoard(permuted, permuted.board);
    // Hand classes, categories and totals do not see suits: the same study.
    expect(permuted.cells).toEqual(exact.cells);
    expect(permuted.options).toEqual(exact.options);
    expect(permuted.categories).toEqual(exact.categories);
    expect(permuted.hero).toEqual(exact.hero);
  });

  it("reads a mapped flop by category, on the real board", () => {
    expect(mapFlop(["Ts", "7h", "3d"]).representative).toBe("Ts7h4d");
    const hand = btnHand(["Ts", "7h", "3d"], ["Ah", "Th"], betTo);
    const decision = flopDecision(hand, library)!;
    expect(decision.source).toBe("solver");
    expect(decision.facts.flop).toMatchObject({ source: "library", mapped: true, flop: "Ts7h4d" });
    const study = flopStudy(structuredClone(hand), decision.actionIndex, { charts: CHARTS, flopLibrary: library })!;
    expect(study).not.toBeNull();
    expect(study.board).toEqual(["Ts", "7h", "3d"]);
    expectHeroRow(study, decision);
    expectRealBoard(study, study.board);
    // The representative's 4 is not on this board: fours are unblocked here, threes are.
    const cell = (name: string) => study.cells[HAND_CLASSES.findIndex((cls) => cls.name === name)];
    expect(cell("33").combos).toBeLessThanOrEqual(3);
    expect(cell("44").combos).toBeGreaterThan(3);
  });

  it("is null where the grade did not read the library: multiway, no chunk, no library, another street", () => {
    // Multiway: the small blind also calls the button's open.
    const multi = scriptHand({
      id: "STUDY3",
      hero: "BTN",
      heroCards: ["Ah", "Th"],
      stackBb: 100,
      preflop: [...lineActs(CHARTS, "fffr"), { position: "SB", type: "call" }, { position: "BB", type: "call" }],
      board: ["Ts", "7h", "4d"],
      flop: [
        { position: "SB", type: "check" },
        { position: "BB", type: "check" },
        { position: "BTN", type: "bet", to: 2 },
      ],
    });
    const multiDecision = flopDecision(multi, library)!;
    expect(multiDecision.facts.flop?.source).not.toBe("library");
    expect(flopStudy(structuredClone(multi), multiDecision.actionIndex, { charts: CHARTS, flopLibrary: library })).toBeNull();

    // A flop whose representative the pilot does not hold.
    const far = btnHand(["Ah", "Kd", "2c"], ["Qh", "Qd"], betTo);
    expect(library.has(CHARTS.id, "btn-bb", mapFlop(["Ah", "Kd", "2c"]).representative)).toBe(false);
    const farDecision = flopDecision(far, library)!;
    expect(farDecision.facts.flop?.source).not.toBe("library");
    expect(flopStudy(structuredClone(far), farDecision.actionIndex, { charts: CHARTS, flopLibrary: library })).toBeNull();

    // No library (the main-thread fallback), and a decision that is not on the flop.
    const hand = btnHand(["Ts", "7h", "4d"], ["Ah", "Th"], betTo);
    const decision = flopDecision(hand, library)!;
    expect(flopStudy(structuredClone(hand), decision.actionIndex, { charts: CHARTS, flopLibrary: null })).toBeNull();
    const preflop = analyzeHand(structuredClone(hand), { charts: CHARTS, turn: false }).decisions.find((d) => d.street === "preflop")!;
    expect(flopStudy(structuredClone(hand), preflop.actionIndex, { charts: CHARTS, flopLibrary: library })).toBeNull();
  });

  it("fetches the chunk once for the grade and the study (the analysis worker's path)", async () => {
    const { loader, chunkFetches } = diskLoader();
    const hand = btnHand(["Td", "7s", "4h"], ["As", "Ts"], betTo);
    // The worker prefetches for the grade, and again for the study request.
    await loader.prefetch(hand, CHARTS);
    const decision = flopDecision(hand, loader)!;
    await loader.prefetch(hand, CHARTS);
    const study = flopStudy(structuredClone(hand), decision.actionIndex, { charts: CHARTS, flopLibrary: loader });
    expect(study).not.toBeNull();
    expectHeroRow(study!, decision);
    expect(chunkFetches()).toEqual([`${CHARTS.id}/${FLOP_PROFILE.tree}/btn-bb/Ts7h4d.bin`]);
  });

  it("comes back with a trainer flop answer, read from the chunk the answer was graded from", async () => {
    const { loader, chunkFetches } = diskLoader();
    let shown = 0;
    for (const seed of [11, 222, 3333, 44444]) {
      const deal: TrainingRequest = { type: "flop", jobId: 1, options: { pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed };
      const dealt = runTrainingJob(deal, CHARTS, await prepareFlopLibrary(deal, CHARTS, loader));
      if (dealt.type !== "spot" || !dealt.spot || dealt.spot.kind !== "flop") continue;
      const answer: TrainingRequest = { type: "answer", jobId: 2, spot: dealt.spot, menuIndex: 0 };
      const graded = runTrainingJob(answer, CHARTS, await prepareFlopLibrary(answer, CHARTS, loader));
      if (graded.type !== "graded" || !graded.decision) throw new Error(`seed ${seed}: not graded`);
      expect(graded.decision.facts.flop?.source).toBe("library");
      expect(graded.study).toBeTruthy();
      expect(graded.study!.street).toBe("flop");
      expect(graded.study!.board).toEqual(dealt.spot.board);
      expectHeroRow(graded.study!, graded.decision);
      shown += 1;
    }
    expect(shown).toBeGreaterThan(0);
    // Each chunk fetched once, however many deals and answers read it.
    expect(new Set(chunkFetches()).size).toBe(chunkFetches().length);
  });

  it("is not added to an answer that is not a library flop", async () => {
    const { loader } = diskLoader();
    const deal: TrainingRequest = { type: "flop", jobId: 1, options: { pot: "srp", role: "pfr", seat: "ip", facing: "check" }, seed: 11 };
    const dealt = runTrainingJob(deal, CHARTS, await prepareFlopLibrary(deal, CHARTS, loader));
    if (dealt.type !== "spot" || !dealt.spot || dealt.spot.kind !== "flop") return;
    // The same answer graded without the library: the heuristic, and no study.
    const answer: TrainingRequest = { type: "answer", jobId: 2, spot: dealt.spot, menuIndex: 0 };
    const graded = runTrainingJob(answer, CHARTS, null);
    expect(graded.type === "graded" && graded.study).toBeFalsy();
  });
});
