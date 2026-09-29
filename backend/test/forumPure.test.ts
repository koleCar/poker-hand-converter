import { describe, expect, it } from "vitest";

import { anchorLabel } from "../../frontend/src/lib/forum/anchor.js";
import { jsonLdScript } from "../../frontend/src/lib/forum/jsonLd.js";
import { excerpt, linkify, toParagraphs } from "../../frontend/src/lib/forum/text.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";

const hand = {
  actions: [
    { index: 0, street: "preflop", player: "SB", label: "small blind $1" },
    { index: 5, street: "flop", player: "BB", label: "checks" },
    { index: 9, street: "turn", player: "BB", label: "raises to $12" },
  ],
} as unknown as PhfHand;

describe("anchorLabel", () => {
  it("names the street and the action", () => {
    expect(anchorLabel(hand, { actionIndex: 9, street: "turn" })).toBe("turn, after BB raises to $12");
  });
  it("lands on the next action when the index no longer exists (lossy-tolerant)", () => {
    expect(anchorLabel(hand, { actionIndex: 6, street: "flop" })).toBe("turn, after BB raises to $12");
  });
  it("falls back to the street", () => {
    expect(anchorLabel(hand, { actionIndex: 99, street: "river" })).toBe("river");
    expect(anchorLabel(null, { actionIndex: 3, street: "flop" })).toBe("flop");
  });
  it("is null without an anchor", () => {
    expect(anchorLabel(hand, null)).toBeNull();
  });
});

describe("post text", () => {
  it("linkifies http(s) only, leaving trailing punctuation outside", () => {
    expect(linkify("see https://example.com/x). and javascript:alert(1)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/x", text: "https://example.com/x" },
      { kind: "text", text: "). and javascript:alert(1)" },
    ]);
  });
  it("splits paragraphs on blank lines and keeps line breaks", () => {
    expect(toParagraphs("a\nb\n\n\nc").map((p) => p.length)).toEqual([2, 1]);
  });
  it("excerpts", () => {
    expect(excerpt("word ".repeat(100), 20)).toHaveLength(20);
  });
});

describe("jsonLdScript", () => {
  it("cannot be closed from inside a string", () => {
    const out = jsonLdScript({ text: "</script><script>alert(1)</script>" });
    expect(out).not.toContain("</script");
    expect(JSON.parse(out)).toEqual({ text: "</script><script>alert(1)</script>" });
  });
});

describe("mentions", () => {
  it("turns @username into a mention segment", () => {
    expect(linkify("thanks @bob_s!")).toEqual([
      { kind: "text", text: "thanks " },
      { kind: "mention", username: "bob_s", text: "@bob_s" },
      { kind: "text", text: "!" },
    ]);
  });
  it("ignores emails, @@ and too-short names", () => {
    expect(linkify("mail me@example.com or @@bob or @ab").every((s) => s.kind === "text")).toBe(true);
  });
  it("keeps URLs whole", () => {
    expect(linkify("https://x.com/@bob").map((s) => s.kind)).toEqual(["link"]);
  });
});
