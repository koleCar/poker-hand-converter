/**
 * Equity by runout: known answers, exact counts, side pots and the seeded
 * Monte Carlo.
 *
 * The preflop numbers are the ones every equity calculator agrees on. The flop
 * and turn spots are built so the answer can be counted by hand, which makes
 * them exact checks rather than tolerance checks.
 */

import { describe, expect, it } from "vitest";

import { EquityInputError, equity, plan } from "../../frontend/src/lib/equity/index.js";

const h = (cards: string) => cards.split(" ");

describe("hold'em equity", () => {
  it("gives AA about 81.9% against KK preflop, exactly", () => {
    // A class matchup is the average over its suit combinations. For AA vs KK
    // they come in three kinds - sharing two suits, one or none - weighted
    // 1 : 4 : 1 across the 36 combinations.
    const two = equity({ game: "holdem", hands: [h("Ah Ad"), h("Kh Kd")] });
    const one = equity({ game: "holdem", hands: [h("Ah Ad"), h("Kh Ks")] });
    const none = equity({ game: "holdem", hands: [h("Ah Ad"), h("Ks Kc")] });
    expect(two.method).toBe("exhaustive");
    expect(two.boards).toBe(1_712_304);
    const average = (two.equity[0] + 4 * one.equity[0] + none.equity[0]) / 6;
    expect(average).toBeCloseTo(0.8195, 3);
    // Suits matter, which is why there is no 169x169 table here.
    expect(two.equity[0]).toBeGreaterThan(none.equity[0]);
    expect(two.equity[0] + two.equity[1]).toBeCloseTo(1, 12);
  });

  it("gives AKs about 46% against QQ", () => {
    const result = equity({ game: "holdem", hands: [h("As Ks"), h("Qh Qd")] });
    expect(result.equity[0]).toBeCloseTo(0.462, 3);
    expect(result.equity[1]).toBeCloseTo(0.538, 3);
  });

  it("counts a flop spot exactly", () => {
    // Set over set. Kings win only when the case king comes without the case
    // ace: 44 of the C(45,2) = 990 turn-river pairs hold the Kc, one of those
    // also holds the Ac. Nothing else changes the winner - no flush or
    // straight is reachable and any board pair fills aces up first.
    const result = equity({
      game: "holdem",
      hands: [h("As Ah"), h("Ks Kh")],
      board: h("Ad Kd 2c"),
    });
    expect(result.boards).toBe(990);
    expect(result.equity[1]).toBe(43 / 990);
    expect(result.equity[0]).toBe(947 / 990);
  });

  it("counts a turn spot exactly", () => {
    // Nine hearts are left, but the 2h and 3h pair the board and fill the
    // queens up, so seven rivers of 44 win for the flush draw.
    const result = equity({
      game: "holdem",
      hands: [h("Ah Kh"), h("Qs Qd")],
      board: h("Qh 7h 2c 3s"),
    });
    expect(result.boards).toBe(44);
    expect(result.equity[0]).toBe(7 / 44);
  });

  it("splits a chopped board evenly", () => {
    const result = equity({
      game: "holdem",
      hands: [h("2c 3d"), h("2d 3c")],
      board: h("Ah Kh Qh Jh Th"),
    });
    expect(result.boards).toBe(1);
    expect(result.equity).toEqual([0.5, 0.5]);
  });

  it("takes dead cards out of the deck", () => {
    const live = equity({
      game: "holdem",
      hands: [h("Ah Kh"), h("Qs Qd")],
      board: h("Qh 7h 2c 3s"),
    });
    const dead = equity({
      game: "holdem",
      hands: [h("Ah Kh"), h("Qs Qd")],
      board: h("Qh 7h 2c 3s"),
      dead: h("4h 5h"),
    });
    expect(dead.boards).toBe(42);
    expect(dead.equity[0]).toBe(5 / 42);
    expect(dead.equity[0]).toBeLessThan(live.equity[0]);
  });

  it("enumerates multiway preflop exhaustively too", () => {
    // 1.37M boards x 3 players fits the default limit, so this is exact.
    const request = { game: "holdem" as const, hands: [h("As Ks"), h("Qh Qd"), h("7c 8c")] };
    expect(plan(request).method).toBe("exhaustive");
    const result = equity(request);
    expect(result.boards).toBe(1_370_754);
    expect(result.equity.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  });

  it("keeps the heads-up preflop enumeration fast", () => {
    // A smoke alarm, not a benchmark: the measured time is ~50ms on a laptop,
    // so a 40x margin only trips if the hot path loses its shape.
    const started = performance.now();
    equity({ game: "holdem", hands: [h("Ac Kd"), h("7h 7s")] });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("side pots", () => {
  it("scores each pot against its own eligible players only", () => {
    const hands = [h("Ah Ad"), h("Kh Kd"), h("Qs Qc")];
    const board = h("2c 7d 9h");
    const result = equity({
      game: "holdem",
      hands,
      board,
      pots: [
        [0, 1, 2],
        [1, 2],
      ],
    });
    const threeWay = equity({ game: "holdem", hands, board });
    const headsUp = equity({ game: "holdem", hands: [hands[1], hands[2]], board, dead: hands[0] });

    expect(result.pots[0]).toEqual(threeWay.equity);
    // The aces are dead cards to the side pot, not a player in it.
    expect(result.pots[1][0]).toBe(0);
    expect(result.pots[1][1]).toBe(headsUp.equity[0]);
    expect(result.pots[1][2]).toBe(headsUp.equity[1]);
  });
});

describe("short deck", () => {
  it("enumerates the 36-card deck", () => {
    const result = equity({ game: "shortdeck", hands: [h("Ah Ad"), h("Kh Kd")] });
    expect(result.boards).toBe(201_376); // C(32,5)
    expect(result.equity[0]).toBeGreaterThan(0.7);
    expect(result.equity[0]).toBeLessThan(0.8);
  });

  it("refuses a card the deck does not hold", () => {
    expect(() => equity({ game: "shortdeck", hands: [h("Ah Ad"), h("Kh 5d")] })).toThrow(
      EquityInputError,
    );
  });
});

describe("Omaha equity", () => {
  it("counts a PLO turn spot exactly", () => {
    // Hand one holds the nut flush draw with two hearts; hand two has top set.
    // Of the 40 unseen cards nine are hearts, and the 9h pairs the board and
    // fills the set, so eight rivers win for the draw. The 4c 5d are no help:
    // a straight would need both the 3 and the 6 on board.
    const result = equity({
      game: "omaha",
      hands: [h("Ah Kh 4c 5d"), h("Ks Kd 8s 8d")],
      board: h("Kc 7h 2h 9c"),
    });
    expect(result.boards).toBe(40);
    expect(result.equity[0]).toBe(8 / 40);
  });

  it("enumerates a PLO flop and samples PLO preflop with a fixed seed", () => {
    const flop = equity({
      game: "omaha",
      hands: [h("As Ks Qh Jh"), h("Ad Ac 7c 8d")],
      board: h("Th 9h 2c"),
    });
    expect(flop.method).toBe("exhaustive");
    expect(flop.boards).toBe(820); // C(41,2)

    const request = { game: "omaha" as const, hands: [h("As Ks Qh Jh"), h("Ad Ac 7c 8d")] };
    const sampled = equity(request);
    expect(sampled.method).toBe("monte-carlo");
    // Reproducible: the same request is the same answer, every time.
    expect(equity(request)).toEqual(sampled);
    expect(equity({ ...request, seed: 99 }).equity).not.toEqual(sampled.equity);

    // ...and close to the exact answer, which takes ~1.5s to enumerate.
    const exact = equity({ ...request, method: "exhaustive" });
    expect(exact.boards).toBe(1_086_008); // C(44,5)
    expect(Math.abs(sampled.equity[0] - exact.equity[0])).toBeLessThan(0.015);
  });

  it("samples hold'em to within tolerance of the exact answer", () => {
    const request = { game: "holdem" as const, hands: [h("As Ks"), h("Qh Qd"), h("7c 8c")] };
    const exact = equity(request);
    const sampled = equity({ ...request, method: "monte-carlo", trials: 50_000 });
    exact.equity.forEach((value, i) => {
      expect(Math.abs(sampled.equity[i] - value)).toBeLessThan(0.01);
    });
  });

  it("evaluates PLO5", () => {
    const result = equity({
      game: "omaha5",
      hands: [h("As Ks Qh Jh 3c"), h("Ad Ac 7c 8d 4s")],
      board: h("Th 9h 2c"),
    });
    expect(result.boards).toBe(741); // C(39,2)
    expect(result.equity[0] + result.equity[1]).toBeCloseTo(1, 12);
  });
});

describe("bad requests", () => {
  it("refuses duplicate cards, wrong hole-card counts and half-dealt boards", () => {
    expect(() => equity({ game: "holdem", hands: [h("Ah Ad"), h("Ah Kd")] })).toThrow(
      EquityInputError,
    );
    expect(() => equity({ game: "omaha", hands: [h("Ah Ad"), h("Kh Kd")] })).toThrow(
      EquityInputError,
    );
    expect(() =>
      equity({ game: "holdem", hands: [h("Ah Ad"), h("Kh Kd")], board: h("2c 3c") }),
    ).toThrow(EquityInputError);
    expect(() => equity({ game: "holdem", hands: [h("Ah Ad"), h("Kh Xx")] })).toThrow(
      EquityInputError,
    );
  });
});
