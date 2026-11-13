/**
 * A hand stored as its standard text (`20271114090000_text_storage.sql`,
 * `web/src/lib/phf/storedText.ts`): what a writer may send, and what a reader
 * gets back.
 *
 * The Rust twin (`core/rail-sync/src/stored_text.rs`) has the same tests over
 * the same folders; `SITE_NAMES` is held to both registries.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { ingestPhfOf, parserOf, storableText } from "../../web/src/lib/db/storedHand";
import { getParsers } from "../../web/src/lib/parsers";
import {
  COSMETIC_PATHS,
  SITE_NAMES,
  checkStandardText,
  handOfStoredRow,
  phfDiffs,
  restoreMeta,
  storedColumnsOf,
} from "../../web/src/lib/phf/storedText";
import type { PhfHand } from "../../web/src/lib/phf/types";
import { typescriptEngine, wasmEngine, type ConversionEngine } from "../../web/src/lib/wasm/engine";
import { decodedText, loadWebCore, plain } from "./support/webConversion";

const SAMPLES = fileURLToPath(new URL("../../fixtures/samples/", import.meta.url));

function files(folder: string): string[] {
  const dir = join(SAMPLES, folder);
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
}

async function corpus(engine: ConversionEngine, folder: string): Promise<PhfHand[]> {
  const hands: PhfHand[] = [];
  for (const path of files(folder)) {
    const text = decodedText(path);
    if (text === null) continue;
    const result = await engine.convert(text, { sourceFilename: "corpus.txt" });
    hands.push(...result.hands.map((hand) => plain(ingestPhfOf(hand))));
  }
  return hands;
}

let wasm: ConversionEngine;
beforeAll(async () => {
  wasm = wasmEngine(await loadWebCore());
});

describe("the site names", () => {
  it("are the registry's", () => {
    const registry = Object.fromEntries(getParsers().map((parser) => [parser.id, parser.name]));
    expect(SITE_NAMES).toEqual(registry);
  });
});

describe("restoreMeta", () => {
  const parsed = {
    meta: {
      siteId: "ggpoker",
      siteName: "GGPoker",
      handId: "HD1",
      handKey: "HD1",
      originalFilename: null,
      parserId: "standard",
      parserVersion: "1.0.0",
      warnings: [],
      rawText: "",
      parsedAt: "1970-01-01T00:00:00.000Z",
    },
  } as unknown as PhfHand;

  it("puts back the room, its parser and name, and the row's provenance", () => {
    const hand = restoreMeta(parsed, {
      hand_key: "weplay:HD1",
      site: "weplay",
      parser_version: "2.0.0",
      source_filename: "x.txt",
      source_text: "room text",
      created_at: "2026-11-13T10:00:00.123456+00:00",
    });
    expect(hand.meta).toMatchObject({
      siteId: "weplay",
      siteName: "WePlay",
      parserId: "weplay",
      handKey: "HD1",
      parserVersion: "2.0.0",
      originalFilename: "x.txt",
      rawText: "room text",
      parsedAt: "2026-11-13T10:00:00.123Z",
    });
    expect(parsed.meta.siteId).toBe("ggpoker");
  });

  it("keeps the parser and name of a text that reads as its own room", () => {
    const hand = restoreMeta(parsed, { hand_key: "ggpoker:HD1", site: "ggpoker" });
    expect(hand.meta).toMatchObject({ siteId: "ggpoker", siteName: "GGPoker", parserId: "standard", parserVersion: "" });
  });

  it("takes the hand key from the row when the text reads another", () => {
    expect(restoreMeta(parsed, { hand_key: "acrwpn:777", site: "acrwpn" }).meta.handKey).toBe("777");
  });
});

describe("phfDiffs", () => {
  it("leaves out only the cosmetic paths", () => {
    const a = { actions: [{ amount: 1, sourceLine: 3, rawLine: "x" }], meta: { parsedAt: "a", warnings: [] } };
    const b = { actions: [{ amount: 1, sourceLine: 9, rawLine: "y" }], meta: { parsedAt: "b", warnings: [{}] } };
    expect(phfDiffs(a, b)).toEqual(["$.meta.warnings.length"]);
    expect(phfDiffs({ x: undefined }, {})).toEqual([]);
    expect(phfDiffs({ x: null }, {})).toEqual(["$.x"]);
    expect(COSMETIC_PATHS).toContain("$.actions[].sourceLine");
  });
});

describe.each([
  ["the WebAssembly core", () => wasm],
  ["the TypeScript parsers", () => typescriptEngine()],
])("the round trip, read by %s", (_name, engineOf) => {
  it("verifies every WePlay and GG hand but the two whose warnings differ", async () => {
    const engine = engineOf();
    const parse = parserOf(engine);
    for (const folder of ["weplay", "ggpoker"]) {
      const hands = await corpus(engine, folder);
      expect(hands.length).toBeGreaterThan(0);
      let verified = 0;
      for (const hand of hands) {
        const text = await storableText(hand, parse);
        if (text === null) continue;
        verified += 1;
        const row = { ...storedColumnsOf(hand), phf: null, standard_text: text, created_at: "2026-11-13T10:00:00Z" };
        const read = await handOfStoredRow(row, parse);
        expect(read).not.toBeNull();
        expect(phfDiffs(hand, read)).toEqual([]);
        expect(read?.meta.siteId).toBe(hand.meta.siteId);
        // Stored analyses key on action indices.
        expect(read?.actions.map((action) => action.index)).toEqual(hand.actions.map((action) => action.index));
      }
      expect(verified + 2).toBeGreaterThanOrEqual(hands.length);
    }
  });

  it("keeps a room whose text loses something as PHF, and says what differs", async () => {
    const engine = engineOf();
    const parse = parserOf(engine);
    const hands = await corpus(engine, "coinpoker");
    expect(hands.length).toBeGreaterThan(0);
    for (const hand of hands) {
      expect(await storableText(hand, parse)).toBeNull();
    }
    const { toStandardText } = await import("../../web/src/lib/phf/serialize");
    const check = await checkStandardText(hands[0], toStandardText(hands[0]), parse);
    expect(check.text).toBeNull();
    expect(check.diffs.length).toBeGreaterThan(0);
  });
});

describe("handOfStoredRow", () => {
  it("is the row's PHF when it has one, and nothing for an unreadable text", async () => {
    const parse = parserOf(typescriptEngine());
    const phf = { meta: { siteId: "x" } } as unknown as PhfHand;
    expect(await handOfStoredRow({ hand_key: "x:1", site: "x", phf, standard_text: "nonsense" }, parse)).toBe(phf);
    expect(await handOfStoredRow({ hand_key: "x:1", site: "x", phf: null, standard_text: "nonsense" }, parse)).toBeNull();
    expect(await handOfStoredRow({ hand_key: "x:1", site: "x" }, parse)).toBeNull();
  });
});

describe("the backfill tool (tests/scripts/text-storage/backfill.mjs)", () => {
  it("verifies a row's stored text first, renders one otherwise, and keeps a lossy row as PHF", async () => {
    const { backfillRow, loadCore } = (await import("../scripts/text-storage/backfill.mjs")) as {
      backfillRow(row: unknown, core: unknown): Promise<{ id: string | null; ok: boolean; standard_text: string | null; source: string | null; diffs: string[] }>;
      loadCore(): Promise<unknown>;
    };
    const core = await loadCore();
    const [hand] = await corpus(wasm, "weplay");
    const columns = { site: hand.meta.siteId, parser_version: hand.meta.parserVersion, source_filename: hand.meta.originalFilename };

    const rendered = await backfillRow({ id: "a", phf: hand, ...columns }, core);
    expect(rendered).toMatchObject({ id: "a", ok: true, source: "serialized", diffs: [] });
    expect(rendered.standard_text?.startsWith("Poker Hand #")).toBe(true);

    const stored = await backfillRow({ id: "b", phf: hand, ...columns, standard_text: rendered.standard_text }, core);
    expect(stored).toMatchObject({ ok: true, source: "stored", standard_text: rendered.standard_text });

    // A row whose columns disagree with its PHF is not converted.
    const moved = await backfillRow({ id: "c", phf: hand, ...columns, site: "ggpoker" }, core);
    expect(moved.ok).toBe(false);

    const [lossy] = await corpus(wasm, "coinpoker");
    const kept = await backfillRow({ id: "d", phf: lossy, site: "coinpoker", parser_version: null, source_filename: null }, core);
    expect(kept).toMatchObject({ id: "d", ok: false, standard_text: null });
    expect(kept.diffs.length).toBeGreaterThan(0);

    expect(await backfillRow({ id: "e" }, core)).toMatchObject({ ok: false, diffs: ["no PHF"] });
  });
});
