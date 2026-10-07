/**
 * Manual hand entry (`lib/manual/`): the betting engine, the settlement, and
 * the bridge into PHF.
 *
 * The engine is checked against the dealer's rules it claims to follow (who
 * acts when, minimum raises, pot limit, an all-in for less), and every built
 * hand is checked the way imported hands are: it validates, its money balances,
 * and its standard text reads back to the same hand.
 */

import { describe, expect, it } from "vitest";

import {
  buildManualDraft,
  buildManualHand,
  passUntil,
  replayManual,
  settleManual,
  type ManualAction,
  type ManualMeta,
  type ManualSetup,
} from "../../frontend/src/lib/manual/index.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { contributionsFromActions, totalFees, type PhfHand } from "../../frontend/src/lib/phf/types.js";

const bb = 50; // $0.50 in cents

function sixMax(overrides: Partial<ManualSetup> = {}): ManualSetup {
  return {
    variant: "holdem",
    limit: "nl",
    smallBlind: 25,
    bigBlind: bb,
    ante: 0,
    anteMode: "none",
    straddle: 0,
    maxSeats: 6,
    buttonSeat: 6,
    seats: [
      { seat: 1, name: "SBplayer", stack: 100 * bb, hero: false, cards: [] },
      { seat: 2, name: "BBplayer", stack: 100 * bb, hero: false, cards: ["Kd", "Qd"] },
      { seat: 3, name: "UTGplayer", stack: 100 * bb, hero: false, cards: [] },
      { seat: 4, name: "HJplayer", stack: 100 * bb, hero: false, cards: [] },
      { seat: 5, name: "COplayer", stack: 100 * bb, hero: false, cards: [] },
      { seat: 6, name: "Me", stack: 100 * bb, hero: true, cards: ["Ah", "Kh"] },
    ],
    ...overrides,
  };
}

const META: ManualMeta = {
  format: "cash",
  currency: "USD",
  tableName: "Test",
  playedAt: "2026-10-06T12:00:00.000Z",
  tournament: null,
  handId: "1000001",
};

function cardsOf(setup: ManualSetup): Map<number, string[]> {
  return new Map(setup.seats.map((seat) => [seat.seat, seat.cards]));
}

function build(setup: ManualSetup, actions: ManualAction[], board: string[], meta = META, rake = 0) {
  const state = replayManual(setup, actions, board);
  const settlement = settleManual(state, board, cardsOf(setup), rake, {});
  const draft = buildManualDraft(state, settlement, board, cardsOf(setup), meta);
  return { state, settlement, result: buildManualHand(draft, meta) };
}

function expectBalanced(hand: PhfHand) {
  const put = [...contributionsFromActions(hand).values()].reduce((a, b) => a + b, 0);
  const won = hand.results.players.reduce((sum, p) => sum + p.won, 0);
  expect(put).toBe(won + totalFees(hand.results.fees));
}

function expectRoundTrip(hand: PhfHand) {
  const text = toStandardText(hand);
  const back = parseStandardHand(text, {
    siteId: "manual",
    siteName: "Manual entry",
    originalFilename: null,
  });
  expect(back).not.toBeNull();
  expect(toStandardText(back!)).toBe(text);
}

describe("manual engine", () => {
  it("starts preflop left of the big blind and postflop left of the button", () => {
    const setup = sixMax();
    const state = replayManual(setup, [], []);
    expect(state.status.kind).toBe("betting");
    if (state.status.kind === "betting") expect(state.status.options.seat).toBe(3);

    const after = replayManual(
      setup,
      [
        { seat: 3, kind: "fold" },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "raise", to: 125 },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "call" },
      ],
      ["7c", "8d", "2s"],
    );
    expect(after.validCount).toBe(6);
    expect(after.street).toBe("flop");
    if (after.status.kind === "betting") expect(after.status.options.seat).toBe(2);
  });

  it("waits for the flop before anybody can act on it", () => {
    const state = replayManual(
      sixMax(),
      [
        { seat: 3, kind: "fold" },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "call" },
        { seat: 1, kind: "call" },
        { seat: 2, kind: "check" },
      ],
      [],
    );
    expect(state.status).toEqual({ kind: "needs-board", street: "flop", runout: false });
  });

  it("gives the big blind the option in a limped pot", () => {
    const state = replayManual(
      sixMax(),
      [
        { seat: 3, kind: "call" },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "fold" },
        { seat: 1, kind: "call" },
      ],
      [],
    );
    expect(state.status.kind).toBe("betting");
    if (state.status.kind === "betting") {
      expect(state.status.options.seat).toBe(2);
      expect(state.status.options.canCheck).toBe(true);
      expect(state.status.options.aggressive).toBe("raise");
    }
  });

  it("refuses a raise smaller than the last one", () => {
    const state = replayManual(
      sixMax(),
      [
        { seat: 3, kind: "raise", to: 150 }, // raise by 100
        { seat: 4, kind: "raise", to: 200 }, // only 50 more: too small
      ],
      [],
    );
    expect(state.validCount).toBe(1);
    expect(state.rejected).toBe("size");
    if (state.status.kind === "betting") expect(state.status.options.minTo).toBe(250);
  });

  it("does not reopen the action after an all-in for less", () => {
    const setup = sixMax({
      seats: sixMax().seats.map((seat) => (seat.seat === 4 ? { ...seat, stack: 175 } : seat)),
    });
    const state = replayManual(
      setup,
      [
        { seat: 3, kind: "raise", to: 125 },
        { seat: 4, kind: "raise", to: 175 }, // all-in, +50 over a 75 raise: incomplete
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "fold" },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "fold" },
      ],
      [],
    );
    expect(state.validCount).toBe(6);
    expect(state.status.kind).toBe("betting");
    if (state.status.kind === "betting") {
      expect(state.status.options.seat).toBe(3);
      expect(state.status.options.aggressive).toBeNull();
      expect(state.status.options.callAmount).toBe(50);
    }
  });

  it("caps a pot-limit raise at the pot", () => {
    const state = replayManual(sixMax({ variant: "omaha", limit: "pl" }), [], []);
    if (state.status.kind !== "betting") throw new Error("expected betting");
    // Blinds 25/50: pot 75, call 50, so the pot raise is to 50 + 125 = 175.
    expect(state.status.options.maxTo).toBe(175);
  });

  it("acts the button first preflop heads-up", () => {
    const setup = sixMax({
      maxSeats: 2,
      buttonSeat: 1,
      seats: [
        { seat: 1, name: "Me", stack: 5000, hero: true, cards: ["As", "Ad"] },
        { seat: 2, name: "Villain", stack: 5000, hero: false, cards: [] },
      ],
    });
    const state = replayManual(setup, [], []);
    if (state.status.kind !== "betting") throw new Error("expected betting");
    expect(state.status.options.seat).toBe(1);
    expect(state.log.map((entry) => [entry.seat, entry.kind])).toEqual([
      [1, "small-blind"],
      [2, "big-blind"],
    ]);
  });
});

describe("skipping ahead to a seat", () => {
  it("folds everyone before the seat preflop", () => {
    const jump = passUntil(sixMax(), [], [])(6);
    expect(jump?.actions).toEqual([
      { seat: 3, kind: "fold" },
      { seat: 4, kind: "fold" },
      { seat: 5, kind: "fold" },
    ]);
    if (jump?.state.status.kind !== "betting") throw new Error("expected betting");
    expect(jump.state.status.options.seat).toBe(6);
  });

  it("checks the skipped seats when there is nothing to call", () => {
    const actions: ManualAction[] = [
      { seat: 3, kind: "call" },
      { seat: 4, kind: "fold" },
      { seat: 5, kind: "fold" },
      { seat: 6, kind: "fold" },
      { seat: 1, kind: "call" },
      { seat: 2, kind: "check" },
    ];
    const jump = passUntil(sixMax(), actions, ["7c", "8d", "2s"])(3);
    expect(jump?.actions.slice(actions.length)).toEqual([
      { seat: 1, kind: "check" },
      { seat: 2, kind: "check" },
    ]);
  });

  it("refuses a seat that will not act again on this street", () => {
    const actions: ManualAction[] = [{ seat: 3, kind: "fold" }];
    expect(passUntil(sixMax(), actions, [])(3)).toBeNull();
  });
});

describe("manual settlement and build", () => {
  it("builds a single-raised pot to showdown that validates and round-trips", () => {
    const setup = sixMax();
    const { settlement, result } = build(
      setup,
      [
        { seat: 3, kind: "fold" },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "raise", to: 125 },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "call" },
        { seat: 2, kind: "check" },
        { seat: 6, kind: "bet", to: 150 },
        { seat: 2, kind: "call" },
        { seat: 2, kind: "check" },
        { seat: 6, kind: "check" },
        { seat: 2, kind: "bet", to: 400 },
        { seat: 6, kind: "call" },
      ],
      ["Kc", "7h", "2d", "9s", "3c"],
      META,
      30,
    );
    expect(settlement.resolved).toBe(true);
    // AK on K-7-2-9-3 beats KQ.
    expect(settlement.pots[0].winners).toEqual([6]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const hand = result.hand;
    expect(hand.meta.siteId).toBe("manual");
    expect(hand.players.find((p) => p.isHero)?.name).toBe("Me");
    expect(hand.results.fees.rake).toBe(30);
    expect(hand.results.heroNet).toBe(25 + 125 + 150 + 400 - 30);
    expectBalanced(hand);
    expectRoundTrip(hand);
  });

  it("returns the uncalled bet when everybody folds", () => {
    const { settlement, result } = build(
      sixMax(),
      [
        { seat: 3, kind: "raise", to: 150 },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "fold" },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "fold" },
      ],
      [],
    );
    expect(settlement.uncalled).toMatchObject({ seat: 3, amount: 100 });
    expect(settlement.payouts).toEqual([{ seat: 3, name: "UTGplayer", amount: 125, potName: "pot" }]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expectBalanced(result.hand);
    expectRoundTrip(result.hand);
  });

  it("splits main and side pots between three all-ins", () => {
    const setup = sixMax({
      seats: [
        { seat: 1, name: "Short", stack: 1000, hero: false, cards: ["As", "Ac"] },
        { seat: 2, name: "Mid", stack: 2000, hero: false, cards: ["Ks", "Kc"] },
        { seat: 3, name: "Me", stack: 5000, hero: true, cards: ["Qs", "Qc"] },
      ],
      maxSeats: 3,
      buttonSeat: 3,
    });
    const { settlement, result } = build(
      setup,
      [
        { seat: 3, kind: "raise", to: 5000 },
        { seat: 1, kind: "call" },
        { seat: 2, kind: "call" },
      ],
      ["2d", "5h", "8c", "9d", "Jh"],
    );
    expect(settlement.uncalled).toMatchObject({ seat: 3, amount: 3000 });
    expect(settlement.pots.map((pot) => [pot.name, pot.amount, pot.winners])).toEqual([
      ["main pot", 3000, [1]],
      ["side pot-1", 2000, [2]],
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expectBalanced(result.hand);
    expectRoundTrip(result.hand);
  });

  it("splits a tied pot and needs a pick when cards are unknown", () => {
    const setup = sixMax({
      maxSeats: 2,
      buttonSeat: 1,
      seats: [
        { seat: 1, name: "Me", stack: 5000, hero: true, cards: ["As", "2c"] },
        { seat: 2, name: "Villain", stack: 5000, hero: false, cards: [] },
      ],
    });
    const actions: ManualAction[] = [
      { seat: 1, kind: "call" },
      { seat: 2, kind: "check" },
      { seat: 2, kind: "check" },
      { seat: 1, kind: "check" },
      { seat: 2, kind: "check" },
      { seat: 1, kind: "check" },
      { seat: 2, kind: "check" },
      { seat: 1, kind: "check" },
    ];
    const board = ["Th", "Jh", "Qh", "Kh", "9h"];
    const state = replayManual(setup, actions, board);
    expect(state.status).toEqual({ kind: "complete", ending: "showdown" });
    const unknown = settleManual(state, board, cardsOf(setup), 0, {});
    expect(unknown.resolved).toBe(false);

    const picked = settleManual(state, board, cardsOf(setup), 0, { 0: [1, 2] });
    expect(picked.resolved).toBe(true);
    expect(picked.payouts.map((p) => p.amount)).toEqual([50, 50]);
  });

  it("writes a tournament header with antes that reads back as a tournament", () => {
    const setup = sixMax({ smallBlind: 100, bigBlind: 200, ante: 25, anteMode: "each" });
    setup.seats = setup.seats.map((seat) => ({ ...seat, stack: 10000 }));
    const meta: ManualMeta = {
      ...META,
      format: "tournament",
      tournament: { id: "777", name: "Sunday Special", buyIn: 1000, fee: 100, buyInCurrency: "USD", level: 7 },
    };
    const { result } = build(
      setup,
      [
        { seat: 3, kind: "fold" },
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "raise", to: 500 },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "fold" },
      ],
      [],
      meta,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const hand = result.hand;
    expect(hand.game.format).toBe("tournament");
    expect(hand.tournament).toMatchObject({ id: "777", name: "Sunday Special", levelNumber: 7, buyIn: 1000, fee: 100 });
    expect(hand.game.ante).toBe(25);
    expectBalanced(hand);
    expectRoundTrip(hand);
  });

  it("records a straddle as a straddle", () => {
    const setup = sixMax({ straddle: 100 });
    const { state, result } = build(
      setup,
      [
        { seat: 4, kind: "fold" },
        { seat: 5, kind: "fold" },
        { seat: 6, kind: "fold" },
        { seat: 1, kind: "fold" },
        { seat: 2, kind: "fold" },
      ],
      [],
    );
    expect(state.status).toEqual({ kind: "complete", ending: "fold" });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.hand.game.straddles.map((s) => [s.seat, s.amount])).toEqual([[3, 100]]);
    expectBalanced(result.hand);
  });

  it("runs out the board when everybody is all-in before the river", () => {
    const setup = sixMax({
      maxSeats: 2,
      buttonSeat: 1,
      variant: "omaha",
      limit: "pl",
      seats: [
        { seat: 1, name: "Me", stack: 300, hero: true, cards: ["As", "Ad", "Kc", "Qh"] },
        { seat: 2, name: "Villain", stack: 300, hero: false, cards: ["7s", "8s", "9d", "Th"] },
      ],
    });
    const actions: ManualAction[] = [
      { seat: 1, kind: "raise", to: 150 },
      { seat: 2, kind: "raise", to: 300 },
      { seat: 1, kind: "call" },
    ];
    const partial = replayManual(setup, actions, []);
    expect(partial.status).toEqual({ kind: "needs-board", street: "flop", runout: true });
    const { settlement, result } = build(setup, actions, ["2c", "3d", "4h", "5c", "Js"]);
    expect(settlement.pots[0].winners).toEqual([1]);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.hand.game.variant).toBe("omaha");
    expect(result.hand.game.limit).toBe("pl");
    expectBalanced(result.hand);
    expectRoundTrip(result.hand);
  });
});
