/**
 * The minimal XML reader iPoker needs.
 *
 * `parseXml` picks `DOMParser` when the host has one and the hand-rolled
 * scanner otherwise. Node has no `DOMParser`, so these tests exercise the
 * scanner directly and, where a `DOMParser` is available, assert that the two
 * agree - which is the only thing keeping the browser path honest.
 */

import { describe, expect, it } from "vitest";

import {
  children,
  childText,
  decodeEntities,
  parseXml,
  scanXml,
} from "../../frontend/src/lib/parsers/shared/p2-xml.js";
import { sampleFiles } from "./support/p2Corpus.js";

describe("scanXml", () => {
  it("reads attributes, text and self-closing elements", () => {
    const root = scanXml(
      `<session sessioncode="0"><general><mode>real</mode></general>` +
        `<game gamecode="1"><action no="1" player="a" type="3" sum="$1" /></game></session>`,
    )!;
    expect(root.tag).toBe("session");
    expect(root.attrs.sessioncode).toBe("0");
    expect(childText(children(root, "general")[0], "mode")).toBe("real");
    const action = children(children(root, "game")[0], "action")[0];
    expect(action.attrs).toEqual({ no: "1", player: "a", type: "3", sum: "$1" });
  });

  it("survives the shapes iPoker actually emits", () => {
    // Single-quoted attributes, an XML declaration, a comment, a `>` inside an
    // attribute value, and no whitespace anywhere.
    const root = scanXml(
      `<?xml version="1.0"?><!-- note --><session sessioncode='0'>` +
        `<general><nickname>a &gt; b</nickname></general></session>`,
    )!;
    expect(root.attrs.sessioncode).toBe("0");
    expect(childText(children(root, "general")[0], "nickname")).toBe("a > b");
  });

  it("returns null for a document that does not close", () => {
    expect(scanXml("<session><game></session>")).toBeNull();
    expect(scanXml("<session")).toBeNull();
  });

  it("decodes the five entities and numeric references", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;")).toBe(`&<>"'`);
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    // An entity we do not know is left alone rather than silently dropped.
    expect(decodeEntities("&nbsp;")).toBe("&nbsp;");
  });

  it("reads every hand in the iPoker corpus", () => {
    const files = sampleFiles("ipoker");
    // The corpus is curated upstream and can shrink; the bar only has to catch
    // the directory having gone missing entirely.
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      for (const session of file.text.split(/(?=<session\b)/i)) {
        if (!/<session\b/i.test(session)) {
          continue;
        }
        const root = scanXml(session);
        expect(root, file.relativePath).not.toBeNull();
        expect(root!.tag).toBe("session");
        expect(children(root!, "game").length, file.relativePath).toBeGreaterThan(0);
      }
    }
  });
});

describe("parseXml", () => {
  it("never throws on junk", () => {
    for (const junk of ["", "not xml at all", "<", "</a>", "<a><b></a></b>"]) {
      expect(() => parseXml(junk)).not.toThrow();
    }
  });

  it("uses the scanner when the host has no DOMParser", () => {
    // Node is that host, so this is the branch the rest of the suite exercises.
    // The parity test below only runs somewhere that has both, which is why it
    // reports as skipped here rather than as a gap nobody noticed.
    const hasDom = typeof (globalThis as { DOMParser?: unknown }).DOMParser !== "undefined";
    const sample = `<session sessioncode="0"><general><mode>real</mode></general></session>`;
    expect(parseXml(sample)).toEqual(hasDom ? parseXml(sample) : scanXml(sample));
  });

  it.runIf(typeof (globalThis as { DOMParser?: unknown }).DOMParser !== "undefined")(
    "agrees with DOMParser on the whole corpus",
    () => {
      for (const file of sampleFiles("ipoker")) {
        for (const session of file.text.split(/(?=<session\b)/i)) {
          if (!/<session\b/i.test(session)) {
            continue;
          }
          expect(parseXml(session), file.relativePath).toEqual(scanXml(session));
        }
      }
    },
  );
});
