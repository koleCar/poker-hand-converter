/**
 * Ongame, Entraction and MicroGaming, over their whole fixture corpora.
 *
 * Three dead networks whose exports still turn up in old archives. They are
 * covered because the fixtures already existed, and they are tested exactly as
 * hard as the live rooms: a hand imported into a tracker is a hand imported into
 * a tracker whether or not anybody still plays on the site it came from.
 *
 * Table driven over the directories, and - as in `p2Parsers.test.ts` - which
 * site a file belongs to is decided **from its text**, never from the folder it
 * sits in. That is what caught mislabelled fixtures in the PartyGaming corpus.
 *
 * Two of the five networks in this batch are deliberately *not* implemented; the
 * last describe block pins that decision so it cannot rot into "somebody forgot".
 */

import { describe, expect, it } from "vitest";

import { convertAny, detectSite } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  contributionsFromActions,
  houseIntoPot,
  seatOutOfPot,
  totalFees,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import { otherSampleSites, sampleFiles, type CorpusFile } from "./support/p4Corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/**
 * The dialect of each room, as a signature over the text itself.
 *
 * Deliberately not the parsers' own `detect`, so that a detector bug cannot make
 * the attribution checks below pass.
 */
const SITES = [
  {
    id: "ongame",
    dir: "ongame",
    name: "Ongame Network",
    prefix: "OG-",
    dialect: /^\*{5}\s*History for hand\s/m,
  },
  {
    id: "entraction",
    dir: "entraction",
    name: "Entraction",
    prefix: "ENT-",
    dialect: /^Game\s#\s*\d+\s+-\s.*-\s+Table\s+"/m,
  },
  {
    id: "microgaming",
    dir: "microgaming",
    name: "MicroGaming Network",
    prefix: "MG-",
    dialect: /<Game\s+hhversion="\d+"\s+id="\d+"/i,
  },
] as const;

const OWN_DIRS = SITES.map((site) => site.dir);

/**
 * Reasons these parsers are allowed to refuse a hand with.
 *
 * Deliberately closed: a refusal with an unplanned reason is a silent failure
 * just as much as a wrong hand is.
 */
const ALLOWED_REASONS = new Set([
  // Round one is Hold'em; all three corpora are heavily Omaha.
  "unsupported-variant",
  // A tournament whose buy-in the hand never states.
  "tournament-unsupported",
  "play-money",
  // Source text that stops before the hand is settled, or contradicts itself.
  "no-winner",
  "no-header",
  "no-players",
  "inconsistent-pot",
  "unseated-actor",
  "board-size",
  "too-few-players",
  "malformed-xml",
  "lossy-encoding",
]);

/** The projection two semantically equal hands must agree on. */
function semantics(hand: PhfHand) {
  return {
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    players: hand.players,
    board: hand.board,
    results: hand.results,
    textStyle: hand.meta.textStyle,
    actions: hand.actions.map((action) => ({
      street: action.street,
      player: action.player,
      type: action.type,
      amount: action.amount,
      streetTotal: action.streetTotal,
      allIn: action.allIn,
      cards: action.cards ?? null,
      potName: action.potName ?? null,
    })),
  };
}

/** Every sample in any of the three directories, whatever room it turns out to be. */
const ALL_FILES: CorpusFile[] = OWN_DIRS.flatMap((dir) => sampleFiles(dir));

function dialectOf(file: CorpusFile): string | null {
  return SITES.find((site) => site.dialect.test(file.text))?.id ?? null;
}

/** The samples that belong to `site`, wherever in the fixture tree they live. */
function siteFiles(site: (typeof SITES)[number]): CorpusFile[] {
  return ALL_FILES.filter((file) => dialectOf(file) === site.id);
}

async function handsOf(dir: string, name: string): Promise<PhfHand[]> {
  const file = sampleFiles(dir).find((entry) => entry.name.includes(name));
  if (!file) {
    throw new Error(`No ${dir} fixture matching "${name}"`);
  }
  return (await convertAny(file.text, { sourceFilename: file.name })).hands;
}

for (const site of SITES) {
  const files = siteFiles(site).map((file) => [file.relativePath, file] as const);

  describe(`${site.name} corpus`, () => {
    it("finds the corpus", () => {
      // The corpora are curated upstream and can shrink; the bar only has to
      // catch a directory that has gone missing entirely.
      expect(files.length).toBeGreaterThan(8);
    });

    it.each(files)("%s is attributed to its own parser", (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id, file.relativePath).toBe(site.id);
      expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
      // Detection is a shared namespace: nobody else may even be a candidate.
      expect(ranked.map((candidate) => candidate.parser.id)).toEqual([site.id]);
    });

    it.each(files)("%s converts or refuses with a reason", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      expect(result.stats.total).toBeGreaterThan(0);
      expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);

      for (const failure of result.failures) {
        expect(ALLOWED_REASONS, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
        expect(failure.detectedSite).toBe(site.id);
        expect(failure.message.length).toBeGreaterThan(10);
        expect(failure.rawText.length).toBeGreaterThan(0);
      }

      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        // An unrecognised source line becomes a warning rather than a silent
        // drop, so an empty warning list is what proves full line coverage.
        expect(hand.meta.warnings, where).toEqual([]);
        expect(validateHand(hand).errors, where).toEqual([]);
        expect(hand.meta.siteId).toBe(site.id);
        expect(hand.game.variant).toBe("holdem");
        // `meta.rawText` must be the room's own text, not our normalized form.
        expect(hand.meta.rawText).not.toContain("Poker Hand #");
        expect(hand.meta.handKey).toBe(hand.meta.handId);
        expect(hand.meta.handId.startsWith(site.prefix), hand.meta.handId).toBe(true);
      }
    });

    it.each(files)("%s conserves chips in every hand", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        const contributed = [...contributionsFromActions(hand).values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        expect(contributed, `${where} in`).toBe(hand.results.totalPot);

        const paid = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
        expect(paid + totalFees(hand.results.fees), `${where} out`).toBe(hand.results.totalPot);
        expect(hand.results.fees.rake, `${where} rake`).toBeGreaterThanOrEqual(0);

        const stacks = new Map(hand.players.map((player) => [player.name, player.startingStack]));
        for (const action of hand.actions) {
          if (action.type === "collect" || action.amount === 0) {
            continue;
          }
          const next = (stacks.get(action.player) ?? 0) - action.amount;
          stacks.set(action.player, next);
          expect(next, `${where} ${action.player} after "${action.rawLine}"`).toBeGreaterThanOrEqual(
            0,
          );
        }
      }
    });

    it.each(files)("%s round-trips through standard text", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const text = toStandardText(hand);
        const reparsed = parseStandardHand(text, CTX)!;
        expect(reparsed, text.split("\n")[0]).not.toBeNull();
        expect(reparsed.meta.warnings, text.split("\n")[0]).toEqual([]);
        expect(toStandardText(reparsed)).toBe(text);
        expect(semantics(reparsed), hand.meta.handId).toEqual(semantics(hand));
      }
    });

    it.each(files)("%s replays without a negative stack", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const frames = buildReplay(hand);
        expect(frames.length, hand.meta.handId).toBeGreaterThan(0);
        for (const frame of frames) {
          for (const seat of frame.seats) {
            expect(seat.stack, `${hand.meta.handId} ${seat.name}`).toBeGreaterThan(-0.005);
          }
        }
        if (hand.results.winners.length > 0) {
          const final = frames[frames.length - 1];
          expect(final.kind, hand.meta.handId).toBe("award");
          expect(final.pot, hand.meta.handId).toBe(0);
        }
      }
    });
  });
}

describe("Ongame specifics", () => {
  it("reads `raises $X to $Y` as chips-pushed then street total", async () => {
    // `kliketiklok raises $10.00 to $10.50` is a player who had already posted a
    // $0.50 small blind: the first number is what he pushed, not the amount over
    // the current bet. Reading it as the total puts him at $10.00.
    const [hand] = await handsOf("ongame", "06-allin-showdown");
    const raise = hand.actions.find(
      (action) => action.player === "kliketiklok" && action.type === "raise",
    )!;
    expect(raise.streetTotal).toBe(1050);
    expect(raise.amount).toBe(1000);
  });

  it("treats `Main pot:` as already net of the uncalled bet", async () => {
    const [hand] = await handsOf("ongame", "06-allin-showdown");
    expect(hand.results.totalPot).toBe(22982);
    expect(hand.results.fees.rake).toBe(300);
    const returned = hand.actions.find((action) => action.type === "uncalled")!;
    expect(returned.player).toBe("fyabcf");
    expect(returned.amount).toBe(-12324);
    // The summary's `net:` column is an independent statement of the same thing.
    expect(hand.results.players.find((result) => result.player === "fyabcf")?.net).toBe(11391);
  });

  it("puts the hand on the UTC line from its stated timezone", async () => {
    // `Start hand: Mon Jan 06 01:08:00 CET 2014` is 00:08 UTC. An hour's error
    // puts a hand in the wrong session.
    const [hand] = await handsOf("ongame", "06-allin-showdown");
    expect(hand.playedAt).toBe("2014-01-06T00:08:00.000Z");
  });

  it("reads a name that looks like a street separator", async () => {
    // `---Cockatrice--- folds` against a format whose street separator is `---`.
    const [hand] = await handsOf("ongame", "07-name-with-dashes");
    expect(hand.players.map((player) => player.name)).toContain("---Cockatrice---");
    expect(hand.meta.warnings).toEqual([]);
  });

  it("splits a concatenated session into every hand it holds", async () => {
    const hands = await handsOf("ongame", "12-multiple-hands-concatenated");
    expect(hands).toHaveLength(10);
    expect(new Set(hands.map((hand) => hand.meta.handId)).size).toBe(10);
  });
});

describe("Entraction specifics", () => {
  it("reads every amount as an increment", async () => {
    // River: `Pinokio1 Bet (2.50)`, `pauli1 Raise (7.75)`, `Pinokio1 Raise
    // (10.50)`, `pauli1 Call (5.25)` all settle at €13 each.
    const [hand] = await handsOf("entraction", "01-basic-hand-nlhe");
    const river = hand.actions.filter((action) => action.street === "river");
    expect(river.at(-1)?.streetTotal).toBe(1300);
    expect(hand.results.totalPot).toBe(2800);
    expect(hand.results.fees.rake).toBe(75);
  });

  it("agrees with the `Payback` line on the uncalled bet", async () => {
    // `TreeTurtle Payback (15.00)` is the room stating the return itself; the
    // builder derives it independently and the two are cross-checked.
    const [hand] = await handsOf("entraction", "09-heads-up");
    const returned = hand.actions.find((action) => action.type === "uncalled")!;
    expect(returned.player).toBe("TreeTurtle");
    expect(returned.amount).toBe(-1500);
    expect(hand.meta.warnings).toEqual([]);
  });

  it("takes only the new cards off a cumulative board line", async () => {
    // `River  Ah - 6c - Jd - 3c - 9s` is the whole board, not the river card.
    const [hand] = await handsOf("entraction", "01-basic-hand-nlhe");
    expect(hand.board.runouts[0].flop).toEqual(["Ah", "6c", "Jd"]);
    expect(hand.board.runouts[0].turn).toBe("3c");
    expect(hand.board.runouts[0].river).toBe("9s");
  });

  it("applies the stated GMT offset", async () => {
    // `Game ended 2012-05-31 08:56:27 GMT+01:00` is 07:56:27 UTC.
    const [hand] = await handsOf("entraction", "01-basic-hand-nlhe");
    expect(hand.playedAt).toBe("2012-05-31T07:56:27.000Z");
  });

  it("puts the button on the small blind heads-up", async () => {
    // The heads-up fixture also prints its big blind line before its small
    // blind one, which must not move the ring.
    const [hand] = await handsOf("entraction", "09-heads-up");
    expect(hand.table.buttonSeat).toBe(2);
    const button = hand.players.find((player) => player.seat === 2)!;
    expect(button.position).toBe("SB");
  });
});

describe("MicroGaming specifics", () => {
  it("settles an all-in return out of the winnings, not into the rake", async () => {
    // The regression this file exists for. MicroGaming prints `MoneyReturned`
    // only after an all-in, and there the money is already out of the winner's
    // `Win` amount. Reading it the other way put the whole €1.60 return into the
    // rake, which the summary's own end balances contradict.
    const [hand] = await handsOf("microgaming", "05-allin-showdown");
    expect(hand.results.totalPot).toBe(112);
    expect(hand.results.fees.rake).toBe(10);
    const returned = hand.actions.find((action) => action.type === "uncalled")!;
    expect(returned.player).toBe("MrJohnCarter");
    expect(returned.amount).toBe(-160);
    expect(hand.results.winners).toEqual([
      { player: "jugins", seat: 3, amount: 102, runoutIndex: 0 },
    ]);
  });

  it("leaves an uncalled bet in the pot when the room prints no return", async () => {
    // The other reading, on a plain fold-to-a-bet: `_joker_` bets €0.12 into a
    // €0.04 pot and gets it back inside `Win`.
    const [hand] = await handsOf("microgaming", "01-basic-hand-nlhe");
    expect(hand.results.totalPot).toBe(4);
    expect(hand.results.fees.rake).toBe(0);
    expect(hand.actions.find((action) => action.type === "uncalled")?.amount).toBe(-12);
  });

  it("records the badbeat jackpot drop as chips leaving the table, not as a fee", async () => {
    // `BadBeatContribution value="0.02"` leaves the player's stack and goes to
    // the jackpot fund without ever entering the pot. `PhfFees` are deductions
    // *from* the pot, so it is a `PhfChipMovement` with `toPot: false` - the
    // same shape Run It Once's Splash the Pot uses from the other end.
    const [hand] = await handsOf("microgaming", "07-disconnected-badbeat-jackpot");
    expect(hand.results.totalPot).toBe(4700);
    expect(hand.results.fees.rake).toBe(0);

    const drop = (hand.chipMovements ?? []).find(
      (movement) => movement.kind === "bad-beat-drop",
    )!;
    expect(drop).toBeDefined();
    expect(drop.toPot).toBe(false);
    expect(drop.fromSeat).toBe(8);
    expect(drop.fromPlayer).toBe("tuffgong");
    expect(drop.amount).toBe(2);
    // It must not be counted into the pot, and the replayer takes it off the
    // contributor's stack so that stack stops reading two cents high.
    expect(seatOutOfPot(hand, 8)).toBe(2);
    expect(houseIntoPot(hand)).toBe(0);
  });

  it("reads a Disconnect value as a timeout, not as chips", async () => {
    // `Disconnect value="30000"` is milliseconds; read as money it would add
    // €300 to the hand.
    const [hand] = await handsOf("microgaming", "07-disconnected-badbeat-jackpot");
    expect(hand.actions.some((action) => action.amount >= 30000)).toBe(false);
  });

  it("recovers names and the currency from their Base64 UTF-16 copies", async () => {
    // `currencysymbol="rCA="` is the only place the file states a currency, and
    // `unicodealias` is a byte-exact copy of the name that survives whatever the
    // file's own encoding did to the plain `alias`.
    const [hand] = await handsOf("microgaming", "01-basic-hand-nlhe");
    expect(hand.game.unit.code).toBe("EUR");
    expect(hand.players.map((player) => player.name)).toContain("DuckGhoul");
    expect(hand.table.name).toBe("Turbo: Micro NLHE 22 - €2 Max");
  });

  it("drops a seat that was sitting out rather than shifting the ring", async () => {
    const [hand] = await handsOf("microgaming", "10-sitting-out");
    for (const player of hand.players) {
      expect(player.position, player.name).not.toBeNull();
    }
  });
});

describe("detection is a shared namespace", () => {
  const mine = SITES.map((site) => site.id);

  it.each(otherSampleSites(OWN_DIRS).map((name) => [name] as const))(
    "no legacy-network parser claims a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          if (mine.includes(candidate.parser.id as (typeof mine)[number])) {
            claims.push(`${candidate.parser.id} claims ${file.relativePath}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it("goes by the text when a sample is filed under the wrong room", () => {
    for (const file of ALL_FILES) {
      const dialect = dialectOf(file);
      expect(dialect, `${file.relativePath} matches no known dialect`).not.toBeNull();
      expect(detectSite(file.text)[0]?.parser.id, file.relativePath).toBe(dialect);
    }
  });

  it("keeps Entraction and Unibet apart, though both open with `Game #`", () => {
    // Entraction: `Game # 2646539198 - Texas Hold'em ... - Table "Burguillos"`.
    // Unibet 2021: `Game #1463192545: Table €1 NL - 0.05/0.10 - ...`.
    // A space and a colon are the whole difference.
    const entraction =
      'Game # 2646539198 - Texas Hold\'em No Limit EUR 0.25/0.50 - Table "Burguillos"';
    const unibet =
      "Game #1463192545: Table €1 NL - 0.05/0.10 - No Limit Hold'Em Banzai - 13:22:50 2021/04/04";
    expect(detectSite(entraction).map((c) => c.parser.id)).toEqual(["entraction"]);
    expect(detectSite(unibet).map((c) => c.parser.id)).toEqual(["unibet"]);
  });

  it("keeps the XML rooms apart by their root element", () => {
    // MicroGaming opens `<Game hhversion=`, BossMedia `<HISTORY `, Merge
    // `<description`, iPoker `<session`. Claiming on "it is XML" would be wrong
    // for all four.
    for (const dir of ["bossmedia", "merge", "ipoker"]) {
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          expect(candidate.parser.id, file.relativePath).not.toBe("microgaming");
        }
      }
    }
  });
});

describe("networks deliberately left unimplemented", () => {
  /**
   * BossMedia and Merge are in the fixture tree but have no parser, and that is
   * a decision rather than an omission. Pinned here so that "no parser claims
   * these" stays true on purpose, and so the reasoning is somewhere a reader of
   * the test suite will find it.
   *
   * **BossMedia** encodes every card as an opaque integer (`<CARD LINK="29"/>`).
   * The rank half of that mapping is recoverable - the localisation keys in
   * `HAND="$(STR_G_WIN_TWOPAIR) $(STR_G_CARDS_KINGS) ..."` pin `index % 13` with
   * `0` = Ace across three independent showdowns - but nothing in the corpus
   * constrains the *suit* order, because not one sample contains a flush or any
   * other suit-dependent hand description. A guessed suit order is a bijection,
   * so every hand would still balance, every duplicate-card check would still
   * pass, and every flush in the database would silently be the wrong four
   * cards. That is precisely the failure this project refuses to ship. Eight of
   * the ten fixtures are Omaha and would be skipped anyway, so the whole payoff
   * is two Hold'em hands.
   *
   * **Merge** is tractable - plain `cards="5c,8d,4d"` and an explicit
   * `<winner uncalled="false">` - and was left out for budget, not for risk. It
   * is the one of the five worth picking up next.
   */
  for (const dir of ["bossmedia", "merge"]) {
    it(`leaves ${dir} samples unclaimed rather than half-parsed`, () => {
      const files = sampleFiles(dir);
      expect(files.length).toBeGreaterThan(5);
      for (const file of files) {
        expect(detectSite(file.text), file.relativePath).toEqual([]);
      }
    });
  }
});
