/**
 * Web/app analysis parity (docs/RAIL-PLAN.md R5.4, as R4.4 did it for the
 * stored hands): the same hand analysed on the web and in the desktop app
 * gets the same grades - every column the web stores, every decision.
 *
 * **The two paths**, each the product's own code:
 *
 * - **Web**: the hand as the web stores it (the TypeScript converter's PHF),
 *   read back as `hands_needing_analysis_recent` hands it to the worker
 *   (JSON, without `meta.rawText` and the actions' `rawLine` / `label` -
 *   re-implemented here from the SQL, not taken from the app), the web
 *   worker's steps (`loadChartLibrary`, `requiredChartSets` /
 *   `rareLineChartSets`, `FlopLibraryLoader.prefetch` over `fetch`), its
 *   `analyseStoredHands`, and the rows as `save_hand_analysis`' `numeric`
 *   columns store them (rounded here by `Intl.NumberFormat` over the decimal
 *   string, not by the app's function).
 * - **App**: the hand as the app stores it - the Rust core's PHF (the
 *   committed WebAssembly build of `rail-core`, the code the app runs
 *   natively; R4.4 holds the two byte for byte) - through the app's worker
 *   itself (`app/src/analysis/worker.ts`, driven through its message
 *   protocol, its flop library fetches answered as the window answers them)
 *   and its rows (`storeRow`).
 *
 * Both read the flop library from the same files: the committed pilot
 * (`tests/scripts/flop-library/pilot/`), served as the bucket would serve it
 * (a file it does not hold is a 404). The corpus seldom reaches a pilot
 * flop, so a few heads-up hands on the pilot's lines and flops are scripted
 * (the trainer's standard text, converted by each path's own converter).
 * The opponents' statistics: none, then one map handed to both.
 *
 * Also checked: the app offline (no flop library) grades exactly as the web
 * does when the chunks cannot be fetched (`flopLibrary` null), and marks its
 * rows to be analysed again.
 *
 * By default a sample of the corpus (every {@link STRIDE}th hand, counted
 * across the files the goldens cover) plus the scripted hands; `RAIL_APP_PARITY=all`
 * analyses every corpus hand (minutes).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type { PageResult } from "../../app/src/analysis/engine";
import type { StoreHandRow } from "../../app/src/analysis/rows";
import { createWorker, type FetchOutcome, type WorkerRequest, type WorkerResponse } from "../../app/src/analysis/worker";
import { analyzeHand, FLOP_PROFILE, FlopLibraryLoader, villainKey, type VillainStatsMap } from "../../frontend/src/lib/analysis/index";
import {
  ensureChartSets,
  loadChartLibrary,
  rareLineChartSets,
  requiredChartSets,
  type ChartLibrary,
} from "../../frontend/src/lib/charts/index";
import { analyseStoredHands, type HandAnalysisInsert } from "../../frontend/src/lib/db/analysisRows";
import { convertAny } from "../../frontend/src/lib/parsers/index";
import type { PhfHand } from "../../frontend/src/lib/phf/types";
import { scriptText, type ScriptAct } from "../../frontend/src/lib/training/handText";
import { lineActs } from "../../frontend/src/lib/training/preflop";
import type { RailCore } from "../../frontend/src/lib/wasm/core";
import { decodedText, loadWebCore, PINNED_PARSED_AT } from "./support/webConversion";

const ROOT = join(import.meta.dirname, "../..");
const GOLDEN = join(ROOT, "testdata/golden");
const PILOT = join(ROOT, "tests/scripts/flop-library/pilot");
const ALL = process.env.RAIL_APP_PARITY === "all";
/** Every this-many-th hand of the corpus, counted across files (`RAIL_APP_PARITY_STRIDE`). */
const STRIDE = Number(process.env.RAIL_APP_PARITY_STRIDE ?? 250);
/** Hands per page, as the web's worker jobs and the app's runner pages. */
const PAGE = 20;
const BUCKET = "https://bucket.test/storage/v1/object/public/flop-library";

interface Hand {
  /** The file and the index in it. */
  key: string;
  web: PhfHand;
  app: PhfHand;
}

/** Every corpus file the goldens cover (as `rail-store`'s tests list them). */
function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json")) out.push(join(ROOT, path.slice(GOLDEN.length + 1, -".json".length)));
    }
  };
  walk(GOLDEN);
  return out;
}

/** The pilot as the public bucket serves it. */
function pilotFile(path: string): Uint8Array | null {
  if (!/^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+){2,3}$/.test(path)) return null;
  try {
    return readFileSync(join(PILOT, path));
  } catch {
    return null;
  }
}

/** The web's worker's `fetch` against the bucket. */
const webFetch = async (url: string) => {
  const bytes = pilotFile(url.slice(BUCKET.length + 1));
  return {
    ok: bytes !== null,
    status: bytes ? 200 : 404,
    arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0)) as ArrayBuffer,
    json: async () => JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as unknown,
  };
};

/** `hands_needing_analysis_recent`'s `phf`: through JSON, `#- '{meta,rawText}'`, each action `- 'rawLine' - 'label'`. */
function webStored(phf: PhfHand): PhfHand {
  const json = JSON.parse(JSON.stringify(phf)) as Record<string, unknown> & { meta: Record<string, unknown>; actions: Record<string, unknown>[] };
  delete json.meta.rawText;
  json.actions = (json.actions ?? []).map((action) => {
    const rest = { ...action };
    delete rest.rawLine;
    delete rest.label;
    return rest;
  });
  return json as unknown as PhfHand;
}

/** A `numeric(p, scale)` column's value of a JSON number. */
function numeric(value: number | null, scale: number): number | null {
  if (value === null) return null;
  const format = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: scale,
    roundingMode: "halfExpand",
    useGrouping: false,
  } as Intl.NumberFormatOptions);
  const rounded = Number(format.format(String(value) as unknown as number));
  return rounded === 0 ? 0 : rounded;
}

/** A web row as the database holds it, in the comparison's shape. */
function webRow(row: HandAnalysisInsert): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      status: row.status,
      reason: row.reason,
      hero_seat: row.hero_seat,
      grade: row.grade,
      score: numeric(row.score, 2),
      ev_loss_bb: numeric(row.ev_loss_bb, 3),
      ev_loss_pot: numeric(row.ev_loss_pot, 4),
      approximations: row.approximations,
      pot_type: row.pot_type,
      analysis_version: row.analysis_version,
      decisions: row.decisions.map((d) => ({
        ...d,
        score: numeric(d.score, 2),
        ev_loss_bb: numeric(d.ev_loss_bb, 3),
        ev_loss_pot: numeric(d.ev_loss_pot, 4),
        freq_diff: numeric(d.freq_diff, 4),
        pot_bb: numeric(d.pot_bb, 2),
        pot_odds: numeric(d.pot_odds, 3),
        mdf: numeric(d.mdf, 3),
      })),
    }),
  ) as Record<string, unknown>;
}

/** An app row in the same shape: the store's own columns left out. */
function appRow(row: StoreHandRow): Record<string, unknown> {
  const decisions = row.decisions.map((d) => {
    const copy: Record<string, unknown> = { ...d };
    delete copy.spot_key;
    delete copy.chart_set;
    delete copy.best;
    delete copy.preflop;
    return copy;
  });
  return JSON.parse(
    JSON.stringify({
      status: row.status,
      reason: row.reason,
      hero_seat: row.hero_seat,
      grade: row.grade,
      score: row.score,
      ev_loss_bb: row.ev_loss_bb,
      ev_loss_pot: row.ev_loss_pot,
      approximations: row.approximations,
      pot_type: row.pot_type,
      analysis_version: row.analysis_version,
      decisions,
    }),
  ) as Record<string, unknown>;
}

/* ------------------------------------------------------------ the paths - */

let charts: ChartLibrary;
let webLoader: FlopLibraryLoader;

async function webAnalyse(hands: Hand[], villains: VillainStatsMap | null, library: boolean): Promise<Map<string, HandAnalysisInsert>> {
  const out = new Map<string, HandAnalysisInsert>();
  for (let i = 0; i < hands.length; i += PAGE) {
    const page = hands.slice(i, i + PAGE).map((hand) => ({ id: hand.key, phf: webStored(hand.web) }));
    const phfs = page.map((item) => item.phf);
    await ensureChartSets(charts, phfs.flatMap((hand) => requiredChartSets(hand, charts.specs)));
    await ensureChartSets(charts, phfs.flatMap((hand) => rareLineChartSets(hand, charts)));
    if (library) for (const hand of phfs) await webLoader.prefetch(hand, charts);
    const batch = analyseStoredHands(page, charts, undefined, library ? webLoader : null, villains);
    expect(batch.failed).toEqual([]);
    for (const row of batch.rows) out.set(row.hand_id, row);
  }
  return out;
}

/** The app's worker, driven through its messages; its fetches answered as the window answers them. */
function appWorker(): { analyse(hands: Hand[], villains: VillainStatsMap | null, library: boolean): Promise<Map<string, StoreHandRow>>; fetched: string[] } {
  const fetched: string[] = [];
  const jobs = new Map<number, (result: PageResult) => void>();
  const scope = {
    onmessage: null as ((event: MessageEvent<WorkerRequest>) => void) | null,
    postMessage(message: WorkerResponse) {
      if (message.type === "fetch") {
        fetched.push(message.path);
        const bytes = pilotFile(message.path);
        const outcome: FetchOutcome = bytes
          ? { kind: "bytes", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
          : { kind: "absent" };
        setTimeout(() => scope.onmessage?.({ data: { type: "fetched", reqId: message.reqId, outcome } } as MessageEvent<WorkerRequest>), 0);
      } else if (message.type === "analysed") {
        jobs.get(message.jobId)?.({ rows: message.rows, failed: message.failed });
      } else if (message.type === "error") {
        throw new Error(message.message);
      }
    },
  };
  createWorker(scope);
  let job = 0;
  return {
    fetched,
    async analyse(hands, villains, library) {
      const out = new Map<string, StoreHandRow>();
      for (let i = 0; i < hands.length; i += PAGE) {
        job += 1;
        const jobId = job;
        const page = hands.slice(i, i + PAGE).map((hand) => ({ handKey: hand.key, phf: hand.app }));
        const result = await new Promise<PageResult>((resolve) => {
          jobs.set(jobId, resolve);
          scope.onmessage?.({ data: { type: "analyse", jobId, page, villains, library } } as MessageEvent<WorkerRequest>);
        });
        expect(result.failed).toEqual([]);
        for (const row of result.rows) out.set(row.hand_key, row);
      }
      return out;
    },
  };
}

/* ------------------------------------------------------------- the hands - */

let core: RailCore;
const HANDS: Hand[] = [];
let phfDifferences = 0;
let corpusHands = 0;
/** Hands converted so far, across files: the sample takes every STRIDE-th. */
let seen = 0;

function convertBoth(name: string, text: string, bytes: Uint8Array, keyPrefix: string, all: boolean): void {
  // The web's converter (what the web stores) and the Rust core (what the app stores).
  const web = convertAnySync.get(keyPrefix) ?? [];
  const app = core.convert(bytes, name, { parsedAt: PINNED_PARSED_AT }).hands.map((hand) => hand.phf as unknown as PhfHand);
  expect(app.length, keyPrefix).toBe(web.length);
  app.forEach((phf, i) => {
    const pin = (hand: PhfHand) => canonical({ ...hand, meta: { ...hand.meta, parsedAt: PINNED_PARSED_AT } });
    if (pin(phf) !== pin(web[i])) {
      phfDifferences += 1;
      if (phfDifferences <= 3) console.log(`PHF differs: ${keyPrefix}#${i}\n${pin(web[i]).slice(0, 400)}\n${pin(phf).slice(0, 400)}`);
    }
    seen += 1;
    if (all || seen % STRIDE === 1) HANDS.push({ key: `${keyPrefix}#${i}`, web: web[i], app: phf });
  });
  void text;
}

const convertAnySync = new Map<string, PhfHand[]>();

/** JSON with every object's keys in order and nothing undefined: two PHFs compared as stored values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Heads-up hands on the pilot's lines and flops (exact, relabelled and mapped), as standard text. */
function scriptedTexts(): { name: string; text: string }[] {
  const texts: { name: string; text: string }[] = [];
  const boards: string[][] = [
    ["Ts", "7h", "4d", "2c", "9s"],
    ["Td", "7s", "4h", "Kc", "2d"],
    ["Ts", "7h", "3d", "Qc", "5h"],
    ["As", "Kh", "7d", "2s", "3c"],
  ];
  const holes: [string, string][] = [
    ["Ah", "Th"],
    ["Qc", "Jc"],
  ];
  let n = 0;
  for (const [line, hero] of [
    ["fffrfc", "BTN"],
    ["fffrfc", "BB"],
    ["fffrfrc", "BTN"],
  ] as const) {
    for (const board of boards) {
      for (const cards of holes) {
        if (cards.some((c) => board.includes(c))) continue;
        n += 1;
        // By default the hand ends on the flop (a bet and a fold: graded by
        // the library, no turn or river solve); the full run plays it out.
        const flop: ScriptAct[] = [
          { position: "BB", type: "check" },
          { position: "BTN", type: "bet", to: 2 },
          { position: "BB", type: ALL ? "call" : "fold" },
        ];
        const turn: ScriptAct[] = [
          { position: "BB", type: "check" },
          { position: "BTN", type: "check" },
        ];
        const river: ScriptAct[] = [
          { position: "BB", type: "bet", to: 3 },
          { position: "BTN", type: "call" },
        ];
        const script = {
          id: `PARITY${n}`,
          hero,
          heroCards: cards,
          stackBb: 100,
          preflop: lineActs(charts, line),
          board: ALL ? board : board.slice(0, 3),
          flop,
          ...(ALL ? { turn, river } : {}),
        } as Parameters<typeof scriptText>[0];
        try {
          texts.push({ name: `scripted-${n}.txt`, text: scriptText(script) });
        } catch {
          // A line the trainer cannot write (e.g. a bet the stacks forbid): left out.
        }
      }
    }
  }
  return texts;
}

beforeAll(async () => {
  core = await loadWebCore();
  charts = await loadChartLibrary();
  webLoader = new FlopLibraryLoader(BUCKET, webFetch, FLOP_PROFILE.tree, { sleep: () => Promise.resolve() });
  for (const path of corpusFiles()) {
    const text = decodedText(path);
    if (text === null) continue;
    const name = basename(path);
    const key = path.slice(ROOT.length + 1);
    convertAnySync.set(key, (await convertAny(text, { sourceFilename: name, validate: true })).hands);
    convertBoth(name, text, readFileSync(path), key, ALL);
  }
  corpusHands = HANDS.length;
  for (const { name, text } of scriptedTexts()) {
    convertAnySync.set(name, (await convertAny(text, { sourceFilename: name, validate: true })).hands);
    convertBoth(name, text, new TextEncoder().encode(text), name, true);
  }
}, 600_000);

describe("web/app analysis parity", () => {
  it("starts from the same hands", () => {
    expect(corpusHands).toBeGreaterThan(ALL ? 7_000 : Math.floor(7_000 / STRIDE));
    expect(HANDS.length - corpusHands).toBeGreaterThan(15);
    expect(phfDifferences).toBe(0);
  });

  it(
    "grades every hand the same, the flop library read from the same files",
    async () => {
      const app = appWorker();
      const t0 = performance.now();
      const web = await webAnalyse(HANDS, null, true);
      const t1 = performance.now();
      const mine = await app.analyse(HANDS, null, true);
      const t2 = performance.now();
      expect(mine.size).toBe(HANDS.length);
      let decisions = 0;
      let graded = 0;
      let fromLibrary = 0;
      for (const hand of HANDS) {
        const w = web.get(hand.key);
        const a = mine.get(hand.key);
        expect(w, hand.key).toBeDefined();
        expect(a, hand.key).toBeDefined();
        if (!w || !a) continue;
        expect(appRow(a), hand.key).toEqual(webRow(w));
        expect(a.flop_library, hand.key).toBe(true);
        decisions += a.decisions.length;
        graded += a.decisions.filter((d) => d.grade !== null).length;
        fromLibrary += a.decisions.filter((d) => d.street === "flop" && d.source === "solver").length;
      }
      // The comparison covered graded decisions on every street, the flop library's among them.
      expect(decisions).toBeGreaterThan(HANDS.length);
      expect(graded).toBeGreaterThan(HANDS.length / 2);
      expect(fromLibrary).toBeGreaterThan(5);
      expect(app.fetched.some((path) => path.endsWith("manifest.json"))).toBe(true);
      expect(app.fetched.some((path) => path.endsWith(".bin"))).toBe(true);
      console.log(
        `app/web analysis parity: ${HANDS.length} hands (${corpusHands} from the corpus${ALL ? ", all of it" : `, every ${STRIDE}th`}), ${decisions} decisions, ${graded} graded, ${fromLibrary} flop decisions from the library: identical; web path ${((t1 - t0) / 1000).toFixed(1)} s, app path ${((t2 - t1) / 1000).toFixed(1)} s`,
      );
    },
    ALL || STRIDE < 100 ? 12 * 3_600_000 : 600_000,
  );

  it(
    "grades the same with the opponents' statistics",
    async () => {
      // One map for both: every named opponent of the scripted and some corpus hands, a loose and a tight player.
      const villains: Record<string, { vpipOpp: number; vpip: number; pfr: number }> = {};
      const sample = HANDS.filter((_, i) => i % 4 === 0);
      sample.forEach((hand, i) => {
        for (const player of hand.web.players ?? []) {
          if (player.isHero || !player.name || !hand.web.meta?.siteId) continue;
          villains[villainKey(hand.web.meta.siteId, player.name)] =
            i % 2 === 0 ? { vpipOpp: 200, vpip: 120, pfr: 30 } : { vpipOpp: 200, vpip: 30, pfr: 24 };
        }
      });
      const map = villains as unknown as VillainStatsMap;
      const web = await webAnalyse(sample, map, true);
      const mine = await appWorker().analyse(sample, map, true);
      for (const hand of sample) expect(appRow(mine.get(hand.key)!), hand.key).toEqual(webRow(web.get(hand.key)!));
    },
    600_000,
  );

  it(
    "offline grades as the web does when the chunks cannot be fetched, and says so",
    async () => {
      const hands = HANDS.slice(-16);
      const web = await webAnalyse(hands, null, false);
      const app = appWorker();
      const mine = await app.analyse(hands, null, false);
      expect(app.fetched).toEqual([]);
      for (const hand of hands) {
        const a = mine.get(hand.key)!;
        expect(appRow(a), hand.key).toEqual(webRow(web.get(hand.key)!));
        expect(a.flop_library).toBe(false);
      }
      // And differently from online where the library answers a flop: why it is analysed again.
      const online = await appWorker().analyse(hands, null, true);
      expect(hands.some((hand) => JSON.stringify(appRow(online.get(hand.key)!)) !== JSON.stringify(appRow(mine.get(hand.key)!)))).toBe(true);
      // Sanity: the engine on the trimmed PHF is the same engine.
      expect(analyzeHand(webStored(hands[0].web), { charts }).version).toBe(web.get(hands[0].key)?.analysis_version);
    },
    600_000,
  );
});
