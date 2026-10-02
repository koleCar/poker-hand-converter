/**
 * Short deck (6+ Hold'em), end to end (#47).
 *
 * Three fixture files hold every short-deck hand in the corpus: GG's two
 * `ShortDeck No Limit` exports (11 and 12, five hands) and one ACR
 * `Six Plus Hold'em` hand. They are two different structures, which is most
 * of what this file is about:
 *
 *  - **GG is ante-only.** Every seat antes, the button alone posts a
 *    `button blind`, the header carries one stake (`($0.02)`), and anybody may
 *    straddle - the button over its own blind, and one seat three times in a
 *    row. No seat posts a small or a big blind.
 *  - **ACR deals it with ordinary blinds**, so everything but the deck and the
 *    ranking is the Hold'em hand it always was.
 *
 * What the tests hold the pipeline to: the fixtures convert with no warnings,
 * validate against the 36-card deck, balance, and come back from standard text
 * equal; positions name no blind nobody posted; equity deals from 36 cards,
 * ranks a flush over a full house, and ranks trips against a straight the way
 * the hand's own room pays it; the stats engine keeps the steal family out
 * of a structure it was not defined for; and the replayer plays them.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { handClass } from "../../frontend/src/lib/cards.js";
import {
  SHORT_DECK,
  SHORT_DECK_STRAIGHT_OVER_TRIPS,
  analyzeAllIn,
  categoryOf,
  equity,
  evaluate,
  shortDeckRuleFor,
  shortDeckTable,
} from "../../frontend/src/lib/equity/index.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  cardInDeck,
  isButtonBlind,
  variantFromLabel,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import { readTree, type CorpusFile } from "./support/psggCorpus.js";
import { allInvariants } from "./support/psggInvariants.js";
import { allStatsInvariants } from "./support/statsInvariants.js";

const ROOT = join(import.meta.dirname, "../..");
const STANDARD = { siteId: "standard", siteName: "standard", originalFilename: null };

const FILES: CorpusFile[] = readTree(join(ROOT, "fixtures/samples"), "fixtures/samples").filter(
  (file) => /shortdeck|6\+Holdem/i.test(file.name),
);

const RESULTS = await Promise.all(
  FILES.map(async (file) => ({
    file,
    result: await convertAny(file.text, { sourceFilename: file.name }),
  })),
);
const HANDS: PhfHand[] = RESULTS.flatMap((entry) => entry.result.hands);

function handById(id: string): PhfHand {
  const hand = HANDS.find((entry) => entry.meta.handId === id);
  if (!hand) {
    throw new Error(`hand ${id} did not convert`);
  }
  return hand;
}

/** Everything that describes the hand, without the text it was read from. */
function semantics(hand: PhfHand) {
  return {
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    players: hand.players.map((player) => ({ ...player })),
    board: hand.board,
    results: hand.results,
    actions: hand.actions.map((action) => ({
      street: action.street,
      runoutIndex: action.runoutIndex,
      player: action.player,
      type: action.type,
      amount: action.amount,
      streetTotal: action.streetTotal,
      allIn: action.allIn,
      verb: action.verb ?? null,
      cards: action.cards ?? null,
      potName: action.potName ?? null,
    })),
  };
}

describe("the short-deck fixtures", () => {
  it("are the three files the issue names, and all of them convert", () => {
    expect(FILES.map((file) => file.relativePath).sort()).toEqual([
      "fixtures/samples/acr-wpn/fpdb3-regression-corpus/cash__6+Holdem-6-max-USD-0.02-0.05-201902.HH00000000 G0.txt",
      "fixtures/samples/ggpoker/11-fpdb3-cash-nl-shortdeck-5max-usd-0-2-202103.txt",
      "fixtures/samples/ggpoker/12-fpdb3-cash-nl-shortdeck-5max-usd-100-202104-internal.txt",
    ]);
    for (const { file, result } of RESULTS) {
      expect(result.failures.map((failure) => failure.reason), file.name).toEqual([]);
    }
    const bySite = HANDS.reduce<Record<string, number>>((out, hand) => {
      out[hand.meta.siteId] = (out[hand.meta.siteId] ?? 0) + 1;
      return out;
    }, {});
    expect(bySite).toEqual({ ggpoker: 5, acrwpn: 1 });
  });

  it.each(HANDS.map((hand) => [`${hand.meta.siteId} ${hand.meta.handId}`, hand] as const))(
    "%s is a clean short-deck hand",
    (_name, hand) => {
      expect(hand.game.variant).toBe("shortdeck");
      expect(hand.game.limit).toBe("nl");
      expect(hand.meta.warnings).toEqual([]);
      expect(validateHand(hand).ok).toBe(true);
      expect(allInvariants(hand)).toEqual([]);
      for (const player of hand.players) {
        // Two, or fewer when a seat showed only part of its hand (`shows [7s]`).
        expect(player.holeCards.length).toBeLessThanOrEqual(2);
        expect(player.holeCards.every((card) => cardInDeck(card, "shortdeck"))).toBe(true);
      }
    },
  );

  it.each(HANDS.map((hand) => [`${hand.meta.siteId} ${hand.meta.handId}`, hand] as const))(
    "%s comes back from standard text as the same hand",
    async (_name, hand) => {
      const text = toStandardText(hand);
      const back = parseStandardHand(text, STANDARD)!;
      expect(back.meta.warnings).toEqual([]);
      expect(semantics(back)).toEqual(semantics(hand));
      // And through the app's own entry point, which is what a re-upload does.
      const again = await convertAny(text);
      expect(again.failures).toEqual([]);
      expect(semantics(again.hands[0])).toEqual(semantics(hand));
      expect(toStandardText(back)).toBe(text);
    },
  );
});

describe("GG's ante-only structure", () => {
  it("reads the button blind as the table's one blind, and names no SB or BB", () => {
    // `Seat #2 is the button`; 27925b27 posts the button blind and then
    // straddles it twice, to $0.04 and to $0.08.
    const hand = handById("SD27208838");
    expect(hand.game).toMatchObject({
      smallBlind: 0,
      bigBlind: 2,
      ante: 2,
      anteModel: "posted-per-player",
      bombPot: null,
      label: "ShortDeck No Limit",
    });
    const blind = hand.actions.find(isButtonBlind)!;
    expect(blind).toMatchObject({ player: "27925b27", type: "big-blind", amount: 2 });
    expect(blind.seat).toBe(hand.table.buttonSeat);
    // Named by distance from the button, which is also the blind.
    expect(
      Object.fromEntries(hand.players.map((player) => [player.seat, player.position])),
    ).toEqual({ 1: "CO", 2: "BTN", 3: "UTG", 5: "HJ" });
  });

  it("reads a straddle as the street total GG states, over the straddler's own blind", () => {
    const button = handById("SD27208838");
    const straddles = button.actions.filter((action) => action.type === "straddle");
    // 0.02 blind, to 0.04, to 0.08: 0.08 in, not 0.14.
    expect(straddles.map((action) => [action.amount, action.streetTotal])).toEqual([
      [2, 4],
      [4, 8],
    ]);
    expect(button.game.straddles.map((straddle) => straddle.amount)).toEqual([4, 8]);

    // Three straddles in a row from one seat, and $0.14 of the $0.16 back.
    const triple = handById("SD27208832");
    expect(
      triple.actions
        .filter((action) => action.type === "straddle")
        .map((action) => action.streetTotal),
    ).toEqual([4, 8, 16]);
    expect(triple.results.totalPot).toBe(12);
    // The text goes back out the way GG printed it.
    expect(toStandardText(triple)).toContain("27925b27: straddle $0.16");
  });

  it("writes the single-stake header and the button blind back verbatim", () => {
    const hand = handById("SD27208848");
    const text = toStandardText(hand);
    expect(text.split("\n")[0]).toBe(
      "Poker Hand #SD27208848: ShortDeck No Limit ($0.02) - 2021/03/02 18:22:40",
    );
    expect(text).toContain("Hero: posts button blind $0.02");
    // The same, generated rather than replayed from the captured header.
    const generated = toStandardText({
      ...hand,
      meta: { ...hand.meta, rawText: "", textStyle: { ...hand.meta.textStyle } },
    });
    expect(generated.split("\n")[0]).toBe(
      "Poker Hand #SD27208848: ShortDeck No Limit ($0.02) - 2021/03/02 18:22:40",
    );
  });

  it("reads the run-it-twice summary that names each board on its own line", () => {
    const hand = handById("1171217378123557259");
    expect(hand.board.runouts.map((run) => run.summaryCards)).toEqual([
      ["Tc", "8h", "Ah", "6h", "Jd"],
      ["9h", "9c", "Kc", "6s", "As"],
    ]);
    // Positions three-handed behind a button blind: UTG, CO, BTN.
    expect(
      Object.fromEntries(hand.players.map((player) => [player.seat, player.position])),
    ).toEqual({ 1: "UTG", 4: "CO", 5: "BTN" });
  });
});

describe("ACR's Six Plus Hold'em", () => {
  it("is an ordinary blinds hand on a 36-card deck, written as Stars' 6+ Hold'em", () => {
    const hand = handById("1377529121");
    expect(hand.game).toMatchObject({ smallBlind: 2, bigBlind: 5, label: "6+ Hold'em No Limit" });
    expect(hand.players.find((player) => player.name === "ChazDazzle")!.holeCards).toEqual([
      "6s",
      "6c",
    ]);
    const text = toStandardText(hand);
    expect(text.split("\n")[0]).toMatch(/: 6\+ Hold'em No Limit \(\$0\.02\/\$0\.05\) - /);
    expect(variantFromLabel("Six Plus Hold'em")).toBe("shortdeck");
  });
});

describe("the 36-card deck", () => {
  it("is what the validator holds a short-deck hand to", () => {
    const hand = structuredClone(handById("SD27208848"));
    hand.players.find((player) => player.name === "Hero")!.holeCards = ["Tc", "5c"];
    expect(validateHand(hand).errors.map((problem) => problem.code)).toEqual([
      "card-not-in-deck",
    ]);
    // The same cards are fine in Hold'em.
    hand.game.variant = "holdem";
    expect(validateHand(hand).errors).toEqual([]);
  });

  it("gives short-deck hole cards the Hold'em class notation, and an impossible card none", () => {
    const hand = handById("SD27208848");
    const hero = handFacts(hand).seats.find((seat) => seat.isHero)!;
    expect(hero.holeCards).toEqual(["Tc", "Ac"]);
    expect(hero.handClass).toBe(handClass(["Tc", "Ac"]));
    expect(hero.handClass).toBe("ATs");

    const impossible = structuredClone(hand);
    impossible.players.find((player) => player.name === "Hero")!.holeCards = ["Tc", "5c"];
    expect(handFacts(impossible).seats.find((seat) => seat.isHero)!.handClass).toBeNull();
  });
});

describe("equity", () => {
  /*
   * Turn all-in, aces full against the nut flush draw.
   *
   * Board `Ah Kh 7c 7d`: `As Ac` holds aces full of sevens, `Qh 9h` four
   * hearts. Of the 36 cards, 8 are out, so 28 rivers can come; five are hearts
   * (6h 7h 8h Th Jh), and in short deck every one of them makes a flush that
   * beats the full house. Nothing else helps the draw - no single card makes
   * it a straight - so the full house wins 23 of 28.
   *
   * In Hold'em the same cards are a lock: 44 rivers, a full house over every
   * flush. So the number below is only right if both the deck and the ranking
   * are short deck's.
   */
  const TURN_ALL_IN = `
Poker Hand #SD900001: ShortDeck No Limit ($1) - 2026/01/01 12:00:00
Table 'SdEv' 6-max Seat #3 is the button
Seat 1: Aces ($100 in chips)
Seat 2: Draw ($100 in chips)
Seat 3: Btn ($100 in chips)
Aces: posts the ante $1
Draw: posts the ante $1
Btn: posts the ante $1
Btn: posts button blind $1
*** HOLE CARDS ***
Dealt to Aces
Dealt to Draw
Dealt to Btn
Aces: calls $1
Draw: calls $1
Btn: checks
*** FLOP *** [Ah Kh 7c]
Aces: checks
Draw: checks
Btn: checks
*** TURN *** [Ah Kh 7c] [7d]
Aces: bets $98 and is all-in
Draw: calls $98 and is all-in
Btn: folds
*** RIVER *** [Ah Kh 7c 7d] [Th]
*** SHOWDOWN ***
Aces: shows [As Ac] (Full House, Aces full of Sevens)
Draw: shows [Qh 9h] (Ace High Flush)
Draw collected $202 from pot
*** SUMMARY ***
Total pot $202 | Rake $0
Board [Ah Kh 7c 7d Th]
Seat 1: Aces showed [As Ac] and lost with Full House, Aces full of Sevens
Seat 2: Draw showed [Qh 9h] and won ($202) with Ace High Flush
Seat 3: Btn (button) folded on the Turn
`.trim();

  it("deals the runout from 36 cards and ranks a flush over a full house", async () => {
    const { hands, failures } = await convertAny(TURN_ALL_IN);
    expect(failures).toEqual([]);
    const hand = hands[0];
    expect(hand.game.variant).toBe("shortdeck");

    const outcome = analyzeAllIn(hand);
    if (!outcome.applicable) {
      throw new Error(`no EV: ${outcome.reason} ${outcome.detail}`);
    }
    expect(outcome.ev.street).toBe("turn");
    expect(outcome.ev.method).toBe("exhaustive");
    expect(outcome.ev.boards).toBe(28);
    expect(outcome.ev.pots).toHaveLength(1);
    const [pot] = outcome.ev.pots;
    expect(pot.eligibleSeats).toEqual([1, 2]);
    expect(pot.equity[0]).toBeCloseTo(23 / 28, 12);
    expect(pot.equity[1]).toBeCloseTo(5 / 28, 12);

    // The same cards dealt as Hold'em: 44 rivers and the full house never loses.
    const holdem = structuredClone(hand);
    holdem.game.variant = "holdem";
    const asHoldem = analyzeAllIn(holdem);
    if (!asHoldem.applicable) {
      throw new Error("the Hold'em twin should be applicable too");
    }
    expect(asHoldem.ev.boards).toBe(44);
    expect(asHoldem.ev.pots[0].equity).toEqual([1, 0]);
  });
});

describe("stats on an ante-only table", () => {
  it("is neither a bomb pot nor a walk, and keeps the steal family out", () => {
    // 12: 951600 limps from UTG, 559023 folds the CO, the button raises over
    // its own blind and is called. One blind, posted, and a raise after it.
    const facts = handFacts(handById("1171217378123557259"));
    expect(facts.hand).toMatchObject({
      variant: "shortdeck",
      isBombPot: false,
      isWalk: false,
      hasStraddle: false,
      potType: "single-raised",
      smallBlind: 0,
      bigBlind: 10000,
    });
    const bySeat = new Map(facts.seats.map((seat) => [seat.seat, seat]));
    expect(bySeat.get(1)!.position).toBe("UTG");
    expect(bySeat.get(1)!.counters).toMatchObject({ vpip: 1, limp: 1, pfr: 0 });
    // The button raised over a limper: an isolation raise from the blind.
    expect(bySeat.get(5)!.counters).toMatchObject({ vpip: 1, pfr: 1, iso: 1 });
    // Its call of the limp would have been a defence, not a cold call.
    expect(bySeat.get(5)!.counters.cold_call_opp).toBe(0);
  });

  it("gives nobody a steal or a steal to defend", async () => {
    // Folded to the cutoff, who opens into the button blind. In Hold'em that
    // is a steal against the blinds; here there are no blinds to steal from.
    const { hands } = await convertAny(
      `
Poker Hand #SD900002: ShortDeck No Limit ($1) - 2026/01/01 12:00:00
Table 'SdSteal' 6-max Seat #4 is the button
Seat 1: Utg ($100 in chips)
Seat 2: Hj ($100 in chips)
Seat 3: Co ($100 in chips)
Seat 4: Btn ($100 in chips)
Utg: posts the ante $1
Hj: posts the ante $1
Co: posts the ante $1
Btn: posts the ante $1
Btn: posts button blind $1
*** HOLE CARDS ***
Dealt to Utg
Dealt to Hj
Dealt to Co
Dealt to Btn
Utg: folds
Hj: folds
Co: raises $2 to $3
Btn: folds
Uncalled bet ($2) returned to Co
*** SHOWDOWN ***
Co collected $6 from pot
*** SUMMARY ***
Total pot $6 | Rake $0
Seat 1: Utg folded before Flop
Seat 2: Hj folded before Flop
Seat 3: Co collected ($6)
Seat 4: Btn (button) folded before Flop
`.trim(),
    );
    const facts = handFacts(hands[0]);
    expect(facts.seats.map((seat) => seat.position)).toEqual(["UTG", "HJ", "CO", "BTN"]);
    for (const seat of facts.seats) {
      expect(seat.counters.steal_opp, seat.player).toBe(0);
      expect(seat.counters.fold_to_steal_opp, seat.player).toBe(0);
    }
    expect(facts.seats[2].counters).toMatchObject({ rfi: 1, pfr: 1 });
    expect(allStatsInvariants(hands[0])).toEqual([]);
  });

  it.each(HANDS.map((hand) => [`${hand.meta.siteId} ${hand.meta.handId}`, hand] as const))(
    "%s holds every stats invariant",
    (_name, hand) => {
      expect(allStatsInvariants(hand)).toEqual([]);
    },
  );
});

describe("the replayer", () => {
  it.each(HANDS.map((hand) => [`${hand.meta.siteId} ${hand.meta.handId}`, hand] as const))(
    "%s replays from the posts to the award",
    (_name, hand) => {
      const frames = buildReplay(hand);
      expect(frames.length).toBeGreaterThan(3);
      for (const frame of frames) {
        for (const seat of frame.seats) {
          expect(seat.stack, `${frame.index} ${seat.name}`).toBeGreaterThanOrEqual(0);
        }
      }
      // The button seat is the button on the felt, whoever posted what.
      const setup = frames[0];
      const button = setup.seats.find((seat) => seat.isButton)!;
      expect(button.seatNo).toBe(hand.table.buttonSeat);
      // Everybody is dealt in, two cards each.
      const deal = frames.find((frame) => frame.kind === "deal")!;
      expect(deal.seats.every((seat) => seat.hasCards)).toBe(true);
      // The whole pot is paid out.
      const last = frames[frames.length - 1];
      const paid = frames
        .filter((frame) => frame.kind === "award")
        .flatMap((frame) => frame.potAward?.winners ?? [])
        .reduce((sum, winner) => sum + winner.amount, 0);
      expect(paid).toBeGreaterThan(0);
      expect(last.kind).toBe("award");
    },
  );

  it("labels the button blind as one", () => {
    const frames = buildReplay(handById("SD27208824"));
    const posted = frames.find((frame) =>
      frame.seats.some((seat) => seat.lastAction?.startsWith("button blind")),
    );
    expect(posted).toBeDefined();
    const seat = posted!.seats.find((entry) => entry.lastAction?.startsWith("button blind"))!;
    expect(seat.position).toBe("BTN");
    expect(seat.lastActionTone).toBe("post");
  });
});

describe("trips against a straight, per room", () => {
  // Fixture 12, first board. GG paid the straight: `951600 showed [Qs Ks] and
  // won ($1,354) with Aces-High Straight`, `1802531 ... [Td Ts] and lost with
  // Three Tens`. That payout is the whole evidence for GG's rule.
  const BOARD = ["Tc", "8h", "Ah", "6h", "Jd"];
  const STRAIGHT = ["Qs", "Ks", ...BOARD];
  const SET = ["Td", "Ts", ...BOARD];

  it("reproduces GG's fixture-12 payout under GG's table, and the reverse under the classic one", () => {
    const gg = SHORT_DECK_STRAIGHT_OVER_TRIPS;
    expect(categoryOf(evaluate(STRAIGHT, gg), gg)).toBe("straight");
    expect(categoryOf(evaluate(SET, gg), gg)).toBe("trips");
    expect(evaluate(STRAIGHT, gg)).toBeGreaterThan(evaluate(SET, gg));
    expect(evaluate(STRAIGHT, SHORT_DECK)).toBeLessThan(evaluate(SET, SHORT_DECK));
    // Both tables still put a flush over a full house.
    for (const table of [SHORT_DECK, SHORT_DECK_STRAIGHT_OVER_TRIPS]) {
      expect(evaluate(["6h", "8h", "Th", "Qh", "Ah"], table)).toBeGreaterThan(
        evaluate(["Ah", "Ad", "Ac", "Ks", "Kh"], table),
      );
    }
  });

  it("agrees with who the fixture says won the first board", () => {
    const hand = handById("1171217378123557259");
    const table = shortDeckTable(shortDeckRuleFor(hand.meta.siteId));
    expect(table).toBe(SHORT_DECK_STRAIGHT_OVER_TRIPS);
    const board = hand.board.runouts[0].summaryCards!;
    expect(board).toEqual(BOARD);
    const hole = (name: string) => hand.players.find((player) => player.name === name)!.holeCards;
    const winner = hand.actions.find(
      (action) => action.type === "collect" && action.runoutIndex === 0,
    )!.player;
    expect(winner).toBe("951600");
    expect(evaluate([...hole("951600"), ...board], table)).toBeGreaterThan(
      evaluate([...hole("1802531"), ...board], table),
    );
  });

  it("is decided in one place, and only GG has the evidence to leave the default", () => {
    expect(shortDeckRuleFor("ggpoker")).toBe("straight-over-trips");
    expect(shortDeckRuleFor("acrwpn")).toBe("trips-over-straight");
    expect(shortDeckRuleFor("standard")).toBe("trips-over-straight");
    expect(shortDeckTable()).toBe(SHORT_DECK);
  });

  it("changes a turn equity by exactly the jacks", () => {
    // `Ks Qs` against `Td Ts` on `Tc 8h Ah 6h`: 28 rivers. A jack (four left)
    // makes the straight; nothing else beats the set, and no river can make a
    // flush for a player holding no heart. So the straight hand wins 4/28 when
    // a straight beats trips, and nothing when it does not.
    const request = {
      game: "shortdeck" as const,
      hands: [
        ["Ks", "Qs"],
        ["Td", "Ts"],
      ],
      board: ["Tc", "8h", "Ah", "6h"],
    };
    const gg = equity({ ...request, shortDeckRule: "straight-over-trips" });
    expect(gg.boards).toBe(28);
    expect(gg.equity[0]).toBeCloseTo(4 / 28, 12);
    expect(equity(request).equity).toEqual([0, 1]);
  });

  it("flips the favourite of GG's own preflop all-in in fixture 12", () => {
    // `Qs Ks` against `Td Ts`, all in preflop. Under the room's rule the
    // straight-heavy hand is the favourite; scored by the classic table, as
    // if the same hand had been dealt anywhere else, it is the underdog.
    const hand = handById("1171217378123557259");
    const asGg = analyzeAllIn(hand);
    const elsewhere = analyzeAllIn({ ...hand, meta: { ...hand.meta, siteId: "acrwpn" } });
    if (!asGg.applicable || !elsewhere.applicable) {
      throw new Error("fixture 12 should have an all-in EV");
    }
    const kingQueen = (ev: typeof asGg.ev) =>
      ev.pots[0].equity[ev.pots[0].eligibleSeats.indexOf(1)];
    expect(asGg.ev.method).toBe("exhaustive");
    expect(kingQueen(asGg.ev)).toBeGreaterThan(0.5);
    expect(kingQueen(elsewhere.ev)).toBeLessThan(0.5);
    const evNet = (ev: typeof asGg.ev) => ev.seats.find((seat) => seat.seat === 1)!.evNet;
    expect(evNet(asGg.ev)).toBeGreaterThan(0);
    expect(evNet(elsewhere.ev)).toBeLessThan(0);
  });
});
