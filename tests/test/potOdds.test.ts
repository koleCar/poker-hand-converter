import { describe, expect, it } from "vitest";

import { potOddsAt } from "../../frontend/src/components/replayer/potOdds.js";
import { parseStandardHand, splitStandardHands } from "../../frontend/src/lib/phf/serialize.js";
import { buildReplay, type ReplayFrame } from "../../frontend/src/lib/replay.js";
import { ggFiles } from "./support/corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

// Hero opens from the SB, check-calls a flop bet, folds to a river shove.
const HAND = `Poker Hand #HD2736007538: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 06:42:39
Table 'NLHPurple12' 6-max Seat #2 is the button
Seat 2: 39138885 ($50 in chips)
Seat 3: Hero ($58.09 in chips)
Seat 4: c4f5c8d3 ($15.81 in chips)
Seat 5: 89155860 ($50 in chips)
Seat 6: 224e079d ($25 in chips)
Hero: posts small blind $0.25
c4f5c8d3: posts big blind $0.5
*** HOLE CARDS ***
Dealt to 39138885 
Dealt to Hero [8d Td]
Dealt to c4f5c8d3 
Dealt to 89155860 
Dealt to 224e079d 
89155860: folds
224e079d: folds
39138885: folds
Hero: raises $1 to $1.5
c4f5c8d3: calls $1
*** FLOP *** [4d 9s 8c]
Hero: checks
c4f5c8d3: bets $3
Hero: calls $3
*** TURN *** [4d 9s 8c] [4h]
Hero: checks
c4f5c8d3: checks
*** RIVER *** [4d 9s 8c 4h] [6c]
Hero: checks
c4f5c8d3: bets $11.31 and is all-in
Hero: folds
Uncalled bet ($11.31) returned to c4f5c8d3
*** SHOWDOWN ***
c4f5c8d3 collected $8.55 from pot
*** SUMMARY ***
Total pot $9 | Rake $0.45 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [4d 9s 8c 4h 6c]
Seat 2: 39138885 (button) folded before Flop (didn't bet)
Seat 3: Hero (small blind) folded on the River
Seat 4: c4f5c8d3 (big blind) won ($8.55)
Seat 5: 89155860 folded before Flop (didn't bet)
Seat 6: 224e079d folded before Flop (didn't bet)`;

function frames(): ReplayFrame[] {
  return buildReplay(parseStandardHand(HAND, CTX)!);
}

function at(all: ReplayFrame[], caption: string): number {
  const index = all.findIndex((frame) => frame.description.includes(caption));
  expect(index, caption).toBeGreaterThanOrEqual(0);
  return index;
}

describe("potOddsAt", () => {
  it("says nothing while hero only faces the blind", () => {
    const all = frames();
    expect(potOddsAt(all, at(all, "89155860 folds"))).toBeNull();
  });

  it("prices hero's open for the caller and as a bluff", () => {
    const all = frames();
    const odds = potOddsAt(all, at(all, "Hero raises"));
    expect(odds?.kind).toBe("betting");
    if (odds?.kind !== "betting") return;
    expect(odds.raise).toBe(true);
    expect(odds.bet).toBeCloseTo(1.5);
    expect(odds.risk).toBeCloseTo(1.25);
    // BB calls $1 into $2 -> 1 / 3.
    expect(odds.callerEquity).toBeCloseTo(1 / 3);
    expect(odds.foldEquity).toBeCloseTo(1.25 / 2);
  });

  it("prices a flop bet hero faces, and drops it once hero calls", () => {
    const all = frames();
    const bet = at(all, "c4f5c8d3 bets $3");
    const odds = potOddsAt(all, bet);
    expect(odds).toMatchObject({ kind: "facing" });
    if (odds?.kind !== "facing") return;
    expect(odds.toCall).toBeCloseTo(3);
    expect(odds.pot).toBeCloseTo(6);
    expect(odds.equity).toBeCloseTo(1 / 3);
    expect(potOddsAt(all, at(all, "Hero calls $3"))).toBeNull();
  });

  it("prices the river shove and stops once hero has folded", () => {
    const all = frames();
    const odds = potOddsAt(all, at(all, "bets $11.31"));
    expect(odds?.kind).toBe("facing");
    if (odds?.kind !== "facing") return;
    expect(odds.toCall).toBeCloseTo(11.31);
    expect(odds.equity).toBeCloseTo(11.31 / (9 + 11.31 * 2));
    expect(potOddsAt(all, at(all, "Hero folds"))).toBeNull();
  });

  it("never throws or returns a nonsense share across the corpus", () => {
    for (const file of ggFiles()) {
      for (const chunk of splitStandardHands(file.text)) {
        const all = buildReplay(parseStandardHand(chunk, CTX)!);
        for (let index = 0; index < all.length; index += 1) {
          const odds = potOddsAt(all, index);
          const shares =
            odds?.kind === "facing"
              ? [odds.equity]
              : odds
                ? [odds.foldEquity, ...(odds.callerEquity === null ? [] : [odds.callerEquity])]
                : [];
          for (const share of shares) {
            expect(share).toBeGreaterThan(0);
            expect(share).toBeLessThan(1);
          }
        }
      }
    }
  });
});
