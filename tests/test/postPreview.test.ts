/**
 * The post preview's copy of a hand (`lib/forum/postPreview.ts`): what the
 * author sees before posting must match what `scrub_phf` and `poll_phf` will
 * publish — no screen name left in a pseudonym preview, no future street or
 * villain card in a poll preview. Display only, but a preview that shows a
 * name the post will not (or hides one it will) misleads the author.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { pollSpots } from "../../web/src/lib/forum/poll.js";
import { previewPoll, previewScrub } from "../../web/src/lib/forum/postPreview.js";
import { convertAny } from "../../web/src/lib/parsers/index.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import { readTree } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");
const FILES = readTree(join(ROOT, "fixtures/samples"), "fixtures/samples");
const HANDS: PhfHand[] = (
  await Promise.all(
    FILES.map(async (file) => {
      try {
        return (await convertAny(file.text, { sourceFilename: file.name })).hands;
      } catch {
        return [];
      }
    }),
  )
).flat();

/** Whole-name occurrence, as `phf_replace_names` matches it. */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(text);
}

describe("previewScrub", () => {
  it("has hands to check", () => {
    expect(HANDS.length).toBeGreaterThan(50);
  });

  it("pseudonyms: Hero and Villain1..n, and no original name anywhere a reader sees", () => {
    for (const hand of HANDS) {
      const out = previewScrub(hand, "pseudonyms");
      const originals = hand.players.map((player) => player.name).filter((name) => name.length >= 3);
      const renamed = new Set(out.players.map((player) => player.name));
      for (const player of out.players) {
        expect(player.isHero ? player.name.startsWith("Hero") : /^Villain\d+(_\d+)?$/.test(player.name)).toBe(true);
      }
      for (const action of out.actions) {
        expect(renamed.has(action.player) || action.player === "").toBe(true);
        for (const name of originals) {
          if (renamed.has(name)) continue;
          expect(mentions(action.label, name), `${hand.meta.siteId}: "${name}" in "${action.label}"`).toBe(false);
        }
      }
      for (const winner of out.results.winners) expect(renamed.has(winner.player)).toBe(true);
      expect(out.meta.rawText).toBe("");
      expect(out.table.name).toBeNull();
      expect(out.playedAt).toBeNull();
    }
  });

  it("positions: opponents by position, the hero as Hero", () => {
    for (const hand of HANDS.slice(0, 200)) {
      const out = previewScrub(hand, "positions");
      hand.players.forEach((player, index) => {
        const name = out.players[index]!.name;
        if (player.isHero) expect(name.startsWith("Hero")).toBe(true);
        else expect(name.startsWith(player.position ?? `Seat${player.seat}`)).toBe(true);
      });
    }
  });

  it("as imported: names kept, provenance still removed", () => {
    for (const hand of HANDS.slice(0, 50)) {
      const out = previewScrub(hand, "as-imported");
      expect(out.players.map((player) => player.name)).toEqual(hand.players.map((player) => player.name));
      expect(out.meta.rawText).toBe("");
    }
  });

  it("copes with names that are regex syntax", () => {
    const hand = HANDS[0]!;
    const odd = {
      ...hand,
      players: hand.players.map((player, index) => (index === 0 ? { ...player, name: "Stas1-1 (x)+" } : player)),
    };
    expect(() => previewScrub(odd, "pseudonyms")).not.toThrow();
  });
});

describe("previewPoll", () => {
  it("stops before the decision, keeps only the hero's cards, shows no result", () => {
    let checked = 0;
    for (const hand of HANDS) {
      for (const spot of pollSpots(hand)) {
        const out = previewPoll(hand, spot.action, false);
        expect(out.actions.every((action) => action.index < spot.action.index)).toBe(true);
        for (const player of out.players) {
          if (!player.isHero) expect(player.holeCards).toEqual([]);
        }
        expect(out.results.winners).toEqual([]);
        const run = out.board.runouts[0]!;
        if (spot.action.street === "preflop") expect(run.flop).toBeNull();
        if (spot.action.street !== "river") expect(run.river).toBeNull();
        const hidden = previewPoll(hand, spot.action, true);
        expect(hidden.players.every((player) => player.holeCards.length === 0)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});
