import { describe, expect, it } from "vitest";

import {
  convertAny,
  detectSite,
  fingerprint,
  fingerprintSync,
  getParser,
  getParsers,
  registerParser,
  unregisterParser,
  type SiteParser,
} from "../../frontend/src/lib/parsers/index.js";
import { normalizeForFingerprint } from "../../frontend/src/lib/phf/detect.js";
import { toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { ggFiles, weplayFiles } from "./support/corpus.js";

describe("registry", () => {
  it("ships the two parsers the format architect owns", () => {
    // Site parsers are added over time; these two are the ones the format owns
    // and every other suite in here depends on, so they have to stay registered.
    expect(getParsers().map((parser) => parser.id)).toEqual(
      expect.arrayContaining(["standard", "weplay"]),
    );
    expect(getParser("weplay")?.name).toBe("WePlay");
  });

  it("lets a new site register itself without touching the pipeline", async () => {
    const fake: SiteParser = {
      id: "test-site",
      name: "Test Site",
      version: "0.0.1",
      detect: (text) => (text.startsWith("TESTSITE") ? 1 : 0),
      splitHands: (text) => [text],
      parseHand: () => {
        throw new Error("not implemented");
      },
    };
    registerParser(fake);
    try {
      const ranked = detectSite("TESTSITE Hand #1");
      expect(ranked[0]?.parser.id).toBe("test-site");
      const result = await convertAny("TESTSITE Hand #1");
      expect(result.failures[0]?.detectedSite).toBe("test-site");
      expect(result.failures[0]?.stage).toBe("parse");
      expect(result.failures[0]?.parserVersion).toBe("0.0.1");
    } finally {
      // Leave the registry as we found it for the other suites.
      unregisterParser("test-site");
    }
  });
});

describe("detection", () => {
  it.each(ggFiles().map((file) => [file.relativePath, file] as const))(
    "%s is detected as our standard format",
    (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe("standard");
      expect(ranked[0]?.confidence).toBeGreaterThan(0.5);
    },
  );

  it.each(weplayFiles().map((file) => [file.relativePath, file] as const))(
    "%s is detected as WePlay",
    (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe("weplay");
    },
  );

  it("re-detects our own output as the standard format", async () => {
    const file = weplayFiles()[0];
    const result = await convertAny(file.text, { sourceFilename: file.name });
    const text = result.hands.map((hand) => toStandardText(hand)).join("\n\n");
    expect(detectSite(text)[0]?.parser.id).toBe("standard");

    const again = await convertAny(text, { sourceFilename: "roundtrip.txt" });
    expect(again.stats.converted).toBe(result.stats.converted);
    expect(again.stats.bySite).toEqual({ standard: result.stats.converted });
  });

  it("returns nothing for text that is not a hand history", () => {
    expect(detectSite("hello world")).toEqual([]);
  });
});

describe("convertAny", () => {
  it("reports an unrecognised upload as a failure rather than throwing", async () => {
    const result = await convertAny("hello world", { sourceFilename: "notes.txt" });
    expect(result.hands).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      detectedSite: null,
      detectionConfidence: null,
      stage: "detect",
      reason: "unknown-site",
      sourceFilename: "notes.txt",
    });
    expect(result.failures[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stats).toEqual({ total: 1, converted: 0, failed: 1, bySite: {} });
  });

  it("counts hands per site", async () => {
    const file = weplayFiles()[0];
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.stats.converted).toBe(result.hands.length);
    expect(result.stats.bySite.weplay).toBe(result.hands.length);
    expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);
  });

  it("honours an explicit site id", async () => {
    const result = await convertAny("hello", { siteId: "does-not-exist" });
    expect(result.failures[0]?.reason).toBe("unknown-site");
  });

  it("can be told to skip tournaments and bomb pots", async () => {
    const tournament = weplayFiles().find((file) => file.text.includes("Tournament"))!;
    const open = await convertAny(tournament.text, { sourceFilename: tournament.name });
    const cashOnly = await convertAny(tournament.text, {
      sourceFilename: tournament.name,
      cashOnly: true,
    });
    expect(open.stats.converted).toBeGreaterThan(0);
    expect(cashOnly.stats.converted).toBe(0);
    expect(cashOnly.failures.every((f) => f.reason === "tournament-in-cash-mode")).toBe(true);
  });
});

describe("fingerprint", () => {
  it("is a sha-256 hex digest", async () => {
    expect(await fingerprint("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("ignores whitespace differences so a re-saved file dedupes", async () => {
    const a = "Poker Hand #1:\nSeat 1: x ($1 in chips)";
    const b = "Poker Hand #1:\r\n  Seat 1: x ($1 in chips)\n";
    expect(normalizeForFingerprint(a)).toBe(normalizeForFingerprint(b));
    expect(await fingerprint(a)).toBe(await fingerprint(b));
  });

  it("has a deterministic synchronous fallback", () => {
    expect(fingerprintSync("abc")).toBe(fingerprintSync("abc"));
    expect(fingerprintSync("abc")).not.toBe(fingerprintSync("abd"));
    expect(fingerprintSync("abc")).toMatch(/^fnv1a128-[0-9a-f]{32}$/);
  });
});
