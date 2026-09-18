/**
 * Ignition / Bodog / Bovada (PaiWangLuo network) parser.
 *
 * Six brand strings, one platform: `Bovada`, `Bodog`, `Bodog.com`, `Bodog.eu`,
 * `Bodog UK` and `Ignition`, spanning 2012 to 2022 in the sample corpus.
 *
 * ## The thing that makes this room different from every other one
 *
 * **There are no player names.** Every seat is printed as its position relative
 * to the button - `Dealer`, `Small Blind`, `Big Blind`, `UTG`, `UTG+1` ... - and
 * the hero carries a `[ME]` tag. The button rotates every hand, so the same real
 * villain is called something different in every successive hand and there is no
 * persistent identity anywhere in the text. Those pseudonyms are what this
 * parser stores as `PhfPlayer.name`, because they are the only thing the source
 * offers and they are at least unique within a hand; the hero is renamed to
 * `Hero`, which is the one identity that *is* stable.
 *
 * Nothing here derives a *position* from a pseudonym. `table.buttonSeat` is
 * taken from the seat whose pseudonym is `Dealer` and the rest is left to
 * `assignPositions`, which anchors on the posted blinds. That matters: our ring
 * names the middle seats `LJ`/`HJ`/`CO` where Ignition names them `UTG+N`, and
 * the two disagree by design rather than by mistake.
 *
 * ## Everything else that bites
 *
 * - **`Set dealer [n]` is not a seat number.** In 21 of 87 hold'em hands in the
 *   corpus it is a 1-based index into the printed seat order instead, and in 7
 *   more it is neither. The seat named `Dealer` is the only reliable button.
 * - **A `Showdown [...]` line lists the best five cards, not hole cards.** A
 *   parser that reads them as hole cards produces duplicate-card errors on every
 *   showdown. Hole cards come from `Card dealt to a spot`, from `Does not show`/
 *   `Mucks`, or from the part of the summary's `[hole-best]` pair before the
 *   dash.
 * - **`Draw for dealer [Xx]` cards come from a different shuffle** and really do
 *   collide with the hole cards dealt afterwards (`partial.hand` fixture deals
 *   `7s` twice). They are dropped.
 * - **Raise amounts are stated two different ways in the same era.**
 *   `Raises 300` is a street total; `Raises 300 to 450` is an increment plus the
 *   total. `Calls`, `Bets` and `All-in` are increments.
 * - **Rake is usually not printed**; only the 2012-2015 era prints
 *   `Total Pot($1.60) | Rake ($0.08)`. Everywhere else it is the pot minus what
 *   was collected.
 * - **The 2021 Zone Poker export writes an empty `*** SUMMARY ***`**, so the pot
 *   has to come from the action stream.
 * - **An all-in run-out prints no street markers at all**, only a `Board` line
 *   in the summary, and the 2012 fixed-limit era prints no markers even with
 *   real post-flop betting. Street boundaries are then inferred from betting
 *   closure and cross-checked against the board size; a hand where the two
 *   disagree is refused rather than guessed at.
 *
 * Round one is Hold'em only: Omaha, Omaha Hi/Lo and seven-card stud all appear
 * in the corpus and are deliberately refused.
 */

import { ParseSkip, type SiteParser, type SiteParserContext } from "../phf/detect";
import {
  CHIPS,
  parseAmount,
  unitForSymbol,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
  type PhfWarning,
} from "../phf/types";
import {
  p5BuildHand,
  type P5Action,
  type P5Draft,
  type P5Seat,
  type P5Street,
} from "./shared/p5-handdraft";

const VERSION = "1.0.0";

/** Every brand string this network has ever printed, longest alternative first. */
const BRANDS = String.raw`Ignition|Bovada|Bodog\.com|Bodog\.eu|Bodog UK|Bodog Canada|Bodog88|Bodog`;
const HEADER_RE = new RegExp(String.raw`^(?:${BRANDS})\s+Hand\s+#(\S+?):?\s+(.*)$`);
const SPLIT_RE = new RegExp(String.raw`(?=^(?:${BRANDS})\s+Hand\s+#)`, "m");
const ANY_HEADER_RE = new RegExp(String.raw`(?:${BRANDS})\s+Hand\s+#\d`);

/** `2016-08-09 12:41:32` or `2021-03-11 22:58:57 UTC`, always at the end. */
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+UTC)?\s*$/;

/** Lines that carry no pot or card information and are dropped on purpose. */
const NOISE_VERB_RE =
  /^(?:Leave\(Auto\)|Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Sit out|Sitout \(wait for bb\)|Re-join|Stand|Ranking\b|Prize Cash\b|Rebuyin\b|BOUNTY PRIZE\b|Draw for dealer\b)/i;
const NOISE_LINE_RE =
  /^(?:Enter\(Auto\)|Table enter user|Table leave user|Table deposit\b|Seat sit out|Seat sit down|Seat re-join|Seat stand|Seating Info:)/i;

/* ------------------------------------------------------------------ header - */

interface IgnitionHeader {
  handId: string;
  variant: "holdem" | "other";
  variantLabel: string;
  limit: "No Limit" | "Pot Limit" | "Fixed Limit";
  limitStated: boolean;
  zonePoker: boolean;
  mvs: boolean;
  tableId: string | null;
  tournamentId: string | null;
  /** `Turbo`, `Normal`, ... - the speed word glued to the level clause. */
  speed: string | null;
  levelLabel: string | null;
  levelSmallBlind: Amount;
  levelBigBlind: Amount;
  playedAt: string | null;
}

/** `HOLDEM`, `HOLDEMZonePoker`, `OMAHA HiLo`, `7CARD` ... */
const GAME_RE = /^(HOLDEM|OMAHA|7CARD|NCARD)(ZonePoker)?(\s+HiLo)?(ZonePoker)?\b/;

function parseGameToken(token: string): { variant: "holdem" | "other"; label: string; zone: boolean } {
  const match = token.match(GAME_RE);
  if (!match) {
    return { variant: "other", label: token, zone: false };
  }
  const zone = Boolean(match[2] || match[4]);
  const hiLo = Boolean(match[3]);
  return {
    variant: match[1] === "HOLDEM" && !hiLo ? "holdem" : "other",
    label: match[0],
    zone,
  };
}

function parseLimit(text: string): { limit: IgnitionHeader["limit"]; stated: boolean } {
  if (/\bPot Limit\b/i.test(text)) return { limit: "Pot Limit", stated: true };
  if (/\bFixed Limit\b/i.test(text)) return { limit: "Fixed Limit", stated: true };
  if (/\bNo Limit\b/i.test(text)) return { limit: "No Limit", stated: true };
  // Tournament headers print the speed word ("Turbo-", "Normal-") where a cash
  // header prints the limit. Every hold'em tournament in the corpus that does
  // this is no-limit, and the limit changes no arithmetic.
  return { limit: "No Limit", stated: false };
}

function parseHeaderLine(line: string): IgnitionHeader | null {
  const match = line.match(HEADER_RE);
  if (!match) {
    return null;
  }
  const handId = match[1];
  let rest = match[2].trim();

  const date = rest.match(DATE_RE);
  const playedAt = date
    ? new Date(
        Date.UTC(
          Number(date[1]),
          Number(date[2]) - 1,
          Number(date[3]),
          Number(date[4]),
          Number(date[5]),
          Number(date[6]),
        ),
      ).toISOString()
    : null;
  if (date) {
    rest = rest.slice(0, date.index).replace(/\s*-\s*$/, "").trim();
  }
  const mvs = /\[MVS\]/.test(rest);
  rest = rest.replace(/\s*\[MVS\]\s*/, " ").trim();

  const tournament = rest.match(
    /^(.+?)\s+Tournament\s+#(\S+)\s+TBL#([^,]+),\s*(.*?)\s*-\s*Level\s+(\S+)\s*\(([^)]*)\)$/,
  );
  if (tournament) {
    const game = parseGameToken(tournament[1]);
    const stakes = tournament[6].split("/");
    const limit = parseLimit(tournament[4]);
    const speed = tournament[4].replace(/\b(?:No|Pot|Fixed)\s+Limit\b/i, "").trim();
    return {
      handId,
      variant: game.variant,
      variantLabel: game.label,
      limit: limit.limit,
      limitStated: limit.stated,
      zonePoker: game.zone,
      mvs,
      tableId: tournament[3].trim(),
      tournamentId: tournament[2],
      speed: speed || null,
      levelLabel: tournament[5],
      levelSmallBlind: parseAmount(stakes[0], CHIPS),
      levelBigBlind: parseAmount(stakes[1] ?? stakes[0], CHIPS),
      playedAt,
    };
  }

  // Cash: `TBL#10916521 HOLDEM No Limit` or `Zone Poker ID#1232 HOLDEMZonePoker No Limit`.
  const cash = rest.match(/^(?:Zone Poker ID#(\S+)|TBL#(\S+))\s+(.*)$/);
  if (!cash) {
    return null;
  }
  const game = parseGameToken(cash[3].trim());
  const limit = parseLimit(cash[3]);
  return {
    handId,
    variant: game.variant,
    variantLabel: game.label,
    limit: limit.limit,
    limitStated: limit.stated,
    zonePoker: game.zone || Boolean(cash[1]),
    mvs,
    tableId: cash[1] ? `Zone Poker ${cash[1]}` : (cash[2] ?? null),
    tournamentId: null,
    speed: null,
    levelLabel: null,
    levelSmallBlind: 0,
    levelBigBlind: 0,
    playedAt,
  };
}

/* ------------------------------------------------------------------- cards - */

const CARD_RE = /\b(?:10|[2-9TJQKA])[cdhs]\b/g;

function cardsIn(text: string): string[] {
  return (text.match(CARD_RE) ?? []).map((card) => (card.startsWith("10") ? `T${card[2]}` : card));
}

/* ---------------------------------------------------------- street closure - */

interface ClosureSeat {
  remaining: Amount;
  live: boolean;
}

/**
 * Splits an action list into betting rounds when the source printed no street
 * markers.
 *
 * Two real shapes need this. An all-in run-out prints the board only in the
 * summary and has no post-flop action at all; the 2012 fixed-limit era prints
 * neither markers nor a `Card dealt to table` line even when there is real
 * post-flop betting. Rather than guess, the rounds are rebuilt with ordinary
 * poker closure rules - a round ends when every live player has acted since the
 * last aggression and everyone still in matches the bet - and the caller then
 * checks the answer against the number of board cards.
 */
function splitIntoRounds(actions: P5Action[], seats: P5Seat[]): P5Action[][] {
  const state = new Map<string, ClosureSeat>();
  for (const seat of seats) {
    state.set(seat.name, { remaining: seat.startingStack, live: true });
  }

  const rounds: P5Action[][] = [];
  let current: P5Action[] = [];
  let commit = new Map<string, Amount>();
  let bet: Amount = 0;
  let acted = new Set<string>();
  let closed = false;

  const isBetting = (kind: P5Action["kind"]) =>
    kind === "fold" ||
    kind === "check" ||
    kind === "call" ||
    kind === "bet" ||
    kind === "raise" ||
    kind === "allin";

  const evaluate = () => {
    const live = [...state.entries()].filter(([, entry]) => entry.live);
    if (live.length <= 1) {
      closed = true;
      return;
    }
    closed = live.every(
      ([name, entry]) =>
        entry.remaining <= 0 || (acted.has(name) && (commit.get(name) ?? 0) >= bet),
    );
  };

  for (const action of actions) {
    if (closed && isBetting(action.kind)) {
      rounds.push(current);
      current = [];
      commit = new Map();
      bet = 0;
      acted = new Set();
      closed = false;
    }
    current.push(action);

    const entry = state.get(action.player);
    const already = commit.get(action.player) ?? 0;
    const live = action.toTotal
      ? Math.max(0, (action.amount ?? 0) - already)
      : (action.amount ?? 0);

    switch (action.kind) {
      case "fold":
        if (entry) entry.live = false;
        break;
      case "check":
        acted.add(action.player);
        break;
      case "ante":
        if (entry) entry.remaining -= live;
        break;
      case "uncalled":
        commit.set(action.player, already - (action.amount ?? 0));
        if (entry) entry.remaining += action.amount ?? 0;
        break;
      default: {
        const next = already + live;
        commit.set(action.player, next);
        if (entry) entry.remaining -= live + (action.dead ?? 0);
        if (next > bet) {
          bet = next;
          // A raise re-opens the round for everybody else.
          acted = new Set([action.player]);
        }
        // Blind and dead posts are money, not a turn to act.
        if (isBetting(action.kind)) {
          acted.add(action.player);
        }
        break;
      }
    }
    evaluate();
  }
  rounds.push(current);
  return rounds;
}

/* ------------------------------------------------------------------ parser - */

export const ignitionParser: SiteParser = {
  id: "ignition",
  name: "Ignition / Bodog / Bovada",
  version: VERSION,

  detect(text: string): number {
    // Six brand-plus-"Hand #" literals, none of which any other room prints.
    if (new RegExp(String.raw`^(?:${BRANDS})\s+Hand\s+#`, "m").test(text)) {
      return 0.95;
    }
    // A header-less excerpt. `Card dealt to a spot` and the mid-hand button
    // marker are still unique to this network among every room we support.
    if (/^.* : Card dealt to a spot \[/m.test(text) && /: Set dealer(?:\/Bring in spot)? \[/.test(text)) {
      return 0.4;
    }
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .split(SPLIT_RE)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => HEADER_RE.test(chunk.split(/\r?\n/)[0] ?? ""));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const text = raw.replace(/^﻿/, "").trim();
    const lines = text.split(/\r?\n/);
    const header = parseHeaderLine(lines[0]);
    if (!header) {
      throw new ParseSkip("no-header", `Unreadable Ignition header: "${lines[0]}".`);
    }
    if (header.variant !== "holdem") {
      throw new ParseSkip(
        "unsupported-variant",
        `Round one is Hold'em only; this hand is "${header.variantLabel}".`,
      );
    }
    if (ctx.options.cashOnly && header.tournamentId) {
      throw new ParseSkip("tournament-in-cash-mode", "Tournament hand skipped.");
    }

    // Real exports splice two hands together mid-line, with the second hand's
    // header swallowed by the first hand's last action. The result parses as one
    // chunk with two deals in it, and every number in it is wrong.
    if (
      lines.filter((line) => /^\*\*\*\s*HOLE CARDS/i.test(line.trim())).length > 1 ||
      lines.filter((line) => /^\*\*\*\s*SUMMARY/i.test(line.trim())).length > 1 ||
      lines.slice(1).some((line) => ANY_HEADER_RE.test(line))
    ) {
      throw new ParseSkip(
        "corrupt-hand",
        "The chunk contains more than one hand; the export spliced them together.",
      );
    }

    const warnings: PhfWarning[] = [];
    const unit: CurrencyUnit = header.tournamentId ? CHIPS : unitForSymbol("$");

    const seats: P5Seat[] = [];
    const seatByName = new Map<string, P5Seat>();
    /** Source pseudonym -> the name we store, which differs only for the hero. */
    const nameOf = new Map<string, string>();
    const holeCards = new Map<string, string[]>();
    const actions: P5Action[] = [];
    const collected: P5Draft["collected"] = [];

    let smallBlind = 0;
    let bigBlind = 0;
    let statedPot: Amount | null = null;
    let statedRake: Amount | null = null;
    let buttonSeat: number | null = null;
    let setDealerValue: number | null = null;
    let street: P5Street = "preflop";
    let sawMarker = false;
    let sawHoleCards = false;
    let inSummary = false;
    let flop: string[] | null = null;
    let turn: string | null = null;
    let river: string | null = null;
    let summaryBoard: string[] = [];
    const summaryLines: string[] = [];
    const playerHashes: Array<{ seat: number; hash: string }> = [];

    // `Ante chip` is a real ante whenever more than one seat posts one. When a
    // single seat posts it alone the money is live - hand #2690849153 has the
    // button post `Ante chip 240` heads-up and then take 74 of it back as an
    // uncalled bet, which is only coherent if the post counted toward the bet.
    const antePosters = new Set(
      lines
        .map((line) => line.match(/^(.*?)\s*(?:\[ME\])?\s*:\s*Ante chip\b/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1].trim()),
    );
    const anteIsDead = antePosters.size > 1;

    const push = (action: Omit<P5Action, "street">) => {
      actions.push({ ...action, street });
    };

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      if (/^\*\*\*\s*SUMMARY/i.test(line)) {
        inSummary = true;
        continue;
      }
      if (inSummary) {
        const pot = line.match(/^Total Pot\(([^)]*)\)(?:\s*\|\s*Rake\s*\(([^)]*)\))?/i);
        if (pot) {
          statedPot = parseAmount(pot[1], unit);
          statedRake = pot[2] === undefined ? null : parseAmount(pot[2], unit);
          continue;
        }
        if (/^Board\s*\[/i.test(line)) {
          summaryBoard = cardsIn(line);
          continue;
        }
        if (/^Seat\s*\+?\s*\d+\s*:/.test(line)) {
          summaryLines.push(line);
          continue;
        }
        warnings.push({ code: "unknown-summary-line", message: line, line: i + 1 });
        continue;
      }

      if (/^\*\*\*\s*HOLE CARDS/i.test(line)) {
        sawHoleCards = true;
        continue;
      }
      const marker = line.match(/^\*\*\*\s*(FLOP|TURN|RIVER)\s*\*\*\*(.*)$/i);
      if (marker) {
        sawMarker = true;
        const groups = [...marker[2].matchAll(/\[([^\]]*)\]/g)].map((group) => cardsIn(group[1]));
        const last = groups[groups.length - 1] ?? [];
        const kind = marker[1].toUpperCase();
        if (kind === "FLOP") {
          flop = last.slice(0, 3);
          street = "flop";
        } else if (kind === "TURN") {
          turn = last[0] ?? null;
          street = "turn";
        } else {
          river = last[0] ?? null;
          street = "river";
        }
        continue;
      }
      // The 2012 "old format" deals the board with no street banner at all.
      const tableCards = line.match(/^Card (?:dealt to|to the) table\s*\[([^\]]*)\]/i);
      if (tableCards) {
        sawMarker = true;
        const cards = cardsIn(tableCards[1]);
        if (cards.length >= 3 && !flop) {
          flop = cards.slice(0, 3);
          street = "flop";
        } else if (!turn) {
          turn = cards[0] ?? null;
          street = "turn";
        } else {
          river = cards[0] ?? null;
          street = "river";
        }
        continue;
      }

      const seatLine = line.match(/^Seat\s+(\d+):\s+(.+?)\s*(\[ME\])?\s*\((.+?)\s+in chips\)$/);
      if (seatLine) {
        const pseudonym = seatLine[2].trim();
        const isHero = Boolean(seatLine[3]);
        const name = isHero ? "Hero" : pseudonym;
        const seat: P5Seat = {
          seat: Number(seatLine[1]),
          name,
          startingStack: parseAmount(seatLine[4], unit),
          isHero,
          dealtIn: true,
          dealtCards: [],
        };
        seats.push(seat);
        seatByName.set(name, seat);
        nameOf.set(pseudonym, name);
        if (pseudonym === "Dealer") {
          buttonSeat = seat.seat;
        }
        continue;
      }

      if (/^Table Info:/i.test(line)) {
        // `Table Info: Version: 1, Type: MVS, Stakes: $0.25-$0.50, Table: <guid>`
        const stakes = line.match(/Stakes:\s*\$?([\d.,]+)\s*-\s*\$?([\d.,]+)/i);
        if (stakes) {
          smallBlind = parseAmount(stakes[1], unit);
          bigBlind = parseAmount(stakes[2], unit);
        }
        continue;
      }
      if (/^Player Info:/i.test(line)) {
        for (const entry of line.matchAll(/P(\d+)-([0-9a-f]{32})/g)) {
          playerHashes.push({ seat: Number(entry[1]), hash: entry[2] });
        }
        continue;
      }
      if (NOISE_LINE_RE.test(line)) {
        continue;
      }

      const actor = line.match(/^(.*?)\s*(\[ME\])?\s*:\s*(.*)$/);
      if (!actor) {
        warnings.push({ code: "unknown-line", message: line, line: i + 1 });
        continue;
      }
      const pseudonym = actor[1].trim();
      const verb = actor[3].trim();

      const dealer = verb.match(/^Set dealer(?:\/Bring in spot)?\s*\[(\d+)\]/i);
      if (dealer) {
        setDealerValue = Number(dealer[1]);
        continue;
      }
      if (NOISE_VERB_RE.test(verb)) {
        continue;
      }

      const player = nameOf.get(pseudonym);
      if (player === undefined) {
        warnings.push({ code: "unknown-line", message: line, line: i + 1 });
        continue;
      }

      const dealt = verb.match(/^Card dealt to a spot\s*\[([^\]]*)\]/i);
      if (dealt) {
        const cards = cardsIn(dealt[1]);
        const seat = seatByName.get(player);
        if (seat) {
          seat.dealtCards = cards;
        }
        holeCards.set(player, cards);
        continue;
      }

      const money = (raw: string): Amount => parseAmount(raw, unit);

      const blind = verb.match(
        /^(?:Ante\/)?(Small [Bb]lind|Big [Bb]lind(?:\/Bring in)?)\s+\$?([\d,.]+)$/,
      );
      if (blind) {
        const amount = money(blind[2]);
        if (/^Small/i.test(blind[1])) {
          smallBlind = Math.max(smallBlind, amount);
          push({ player, kind: "small-blind", amount });
        } else {
          bigBlind = Math.max(bigBlind, amount);
          push({ player, kind: "big-blind", amount });
        }
        continue;
      }

      const ante = verb.match(/^Ante chip\s+\$?([\d,.]+)$/i);
      if (ante) {
        if (anteIsDead) {
          push({ player, kind: "ante", amount: money(ante[1]) });
        } else {
          warnings.push({
            code: "lone-ante-posted-live",
            message: `${pseudonym} is the only seat to post an ante; treated as a live post.`,
            line: i + 1,
          });
          push({ player, kind: "post", amount: money(ante[1]) });
        }
        continue;
      }

      const post = verb.match(/^Posts (dead )?chip\s+\$?([\d,.]+)$/i);
      if (post) {
        const amount = money(post[2]);
        // A returning player owes the blinds they sat out for. The part up to
        // one big blind is live and plays; the rest is dead money in the pot.
        const liveShare = bigBlind > 0 ? Math.min(amount, bigBlind) : amount;
        push({
          player,
          kind: "post",
          amount: liveShare,
          dead: amount - liveShare,
        });
        continue;
      }

      if (/^Folds?\b/i.test(verb)) {
        push({ player, kind: "fold" });
        continue;
      }
      if (/^Checks\b/i.test(verb)) {
        push({ player, kind: "check" });
        continue;
      }

      const call = verb.match(/^Calls?\s+\$?([\d,.]+)$/i);
      if (call) {
        push({ player, kind: "call", amount: money(call[1]) });
        continue;
      }
      const bet = verb.match(/^Bets?\s+\$?([\d,.]+)$/i);
      if (bet) {
        push({ player, kind: "bet", amount: money(bet[1]) });
        continue;
      }
      // `Raises X to Y` states an increment and a total; the bare `Raises X`
      // form of the same era states the street total on its own.
      const raiseTo = verb.match(
        /^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)\s+to\s+\$?([\d,.]+)$/i,
      );
      if (raiseTo) {
        push({
          player,
          kind: /All-in/i.test(verb) ? "allin" : "raise",
          amount: money(raiseTo[2]),
          toTotal: true,
          allIn: /All-in/i.test(verb),
        });
        continue;
      }
      const raise = verb.match(/^(?:Raises|All-in\(raise[^)]*\))(?:\(timeout\))?\s+\$?([\d,.]+)$/i);
      if (raise) {
        push({
          player,
          kind: /All-in/i.test(verb) ? "allin" : "raise",
          amount: money(raise[1]),
          toTotal: true,
          allIn: /All-in/i.test(verb),
        });
        continue;
      }
      const allIn = verb.match(/^All-in(?:\([^)]*\))?\s+\$?([\d,.]+)$/i);
      if (allIn) {
        const amount = money(allIn[1]);
        // An all-in can happen before the deal, when a short stack posts its
        // blind for less than the blind. The seat's own pseudonym says which
        // blind that was, and it is the only anchor the position ring gets.
        if (!sawHoleCards && (pseudonym === "Small Blind" || pseudonym === "Big Blind")) {
          const kind = pseudonym === "Small Blind" ? "small-blind" : "big-blind";
          if (kind === "small-blind") {
            smallBlind = Math.max(smallBlind, amount);
          } else {
            bigBlind = Math.max(bigBlind, amount);
          }
          push({ player, kind, amount, allIn: true });
        } else if (!sawHoleCards) {
          push({ player, kind: "post", amount, allIn: true });
        } else {
          push({ player, kind: "allin", amount, allIn: true });
        }
        continue;
      }

      const uncalled = verb.match(/^Return uncalled portion of bet\s+\$?([\d,.]+)$/i);
      if (uncalled) {
        push({ player, kind: "uncalled", amount: money(uncalled[1]) });
        continue;
      }

      // `Showdown [...]` lists the best five cards, never the hole cards.
      const showdown = verb.match(/^Showdown\s*(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))?$/i);
      if (showdown) {
        push({
          player,
          kind: "show",
          cards: holeCards.get(player) ?? [],
          description: showdown[2],
        });
        continue;
      }
      const reveal = verb.match(/^(Does not show|Mucks|Shows)\s*\[([^\]]*)\]\s*(?:\(([^)]*)\))?$/i);
      if (reveal) {
        const cards = cardsIn(reveal[2]);
        // Two cards is a hold'em hand; anything longer is a best-five list.
        if (cards.length === 2 && !holeCards.has(player)) {
          holeCards.set(player, cards);
        }
        const known = holeCards.get(player) ?? [];
        if (/^Shows$/i.test(reveal[1])) {
          push({ player, kind: "show", cards: known, description: reveal[3] });
        } else if (/^Mucks$/i.test(reveal[1])) {
          push({ player, kind: "muck", cards: known, description: reveal[3] });
        } else {
          // "Does not show" is the room's way of saying the pot was not
          // contested; the cards are printed but were never turned over.
          push({ player, kind: "muck", cards: [], description: reveal[3] });
        }
        continue;
      }

      const result = verb.match(/^Hand [Rr]esult(-Side [Pp]ot)?\s+\$?([\d,.]+)$/);
      if (result) {
        collected.push({
          player,
          amount: money(result[2]),
          potName: result[1] ? "side pot" : undefined,
        });
        continue;
      }

      warnings.push({ code: "unknown-line", message: line, line: i + 1 });
    }

    if (seats.length === 0) {
      throw new ParseSkip("no-players", "The hand lists no seats.");
    }

    /* ------------------------------------------------------- button ------- */

    if (buttonSeat === null && setDealerValue !== null) {
      // No seat is called `Dealer`, so the button is dead. `Set dealer [n]` is
      // only trustworthy when it names a seat that is actually in the hand -
      // in tournaments it is often a 1-based index into the printed seat order
      // instead, and sometimes neither.
      if (seats.some((seat) => seat.seat === setDealerValue)) {
        buttonSeat = setDealerValue;
      } else {
        warnings.push({
          code: "dead-button",
          message: `No seat is on the button; "Set dealer [${setDealerValue}]" names no seated player.`,
        });
      }
    }

    /* -------------------------------------------------------- summary ----- */

    const pseudonyms = [...nameOf.keys()].sort((a, b) => b.length - a.length);
    for (const line of summaryLines) {
      const rest = line.replace(/^Seat\s*\+?\s*\d+\s*:\s*/, "");
      // The summary's seat numbers do not always match the seat block's: a
      // large-field tournament numbers the summary 1..9 while the seat lines
      // carry the real table seats. The pseudonym is unique per hand, so it is
      // what the two blocks are matched on.
      const pseudonym = pseudonyms.find((name) => rest.startsWith(name));
      if (!pseudonym) {
        warnings.push({ code: "unknown-summary-line", message: line });
        continue;
      }
      const player = nameOf.get(pseudonym)!;
      if (holeCards.has(player)) {
        continue;
      }
      for (const group of rest.matchAll(/\[([^\]]*)\]/g)) {
        // `[Kd Qs-Kh Kd Qs Qd 9h]` is the hole cards, a dash, then the best five.
        const cards = cardsIn(group[1].split("-")[0]);
        if (cards.length === 2) {
          holeCards.set(player, cards);
          break;
        }
      }
    }

    /* ---------------------------------------------------------- board ----- */

    let board = [...(flop ?? []), ...(turn ? [turn] : []), ...(river ? [river] : [])];
    if (summaryBoard.length > board.length) {
      if (board.length > 0 && !summaryBoard.slice(0, board.length).every((c, i) => c === board[i])) {
        throw new ParseSkip(
          "board-mismatch",
          `The street markers deal [${board.join(" ")}] but the summary lists ` +
            `[${summaryBoard.join(" ")}].`,
        );
      }
      board = summaryBoard;
      flop = board.slice(0, 3);
      turn = board[3] ?? null;
      river = board[4] ?? null;
    }
    if (board.length > 0 && ![3, 4, 5].includes(board.length)) {
      throw new ParseSkip("board-size", `The board has ${board.length} cards.`);
    }

    /* -------------------------------------------------- street recovery --- */

    if (!sawMarker && board.length > 0) {
      const rounds = splitIntoRounds(actions, seats);
      const postflop = rounds.length - 1;
      const needed = postflop === 0 ? 0 : postflop + 2;
      if (postflop > 3 || board.length < needed) {
        throw new ParseSkip(
          "missing-street-markers",
          `The hand prints no street markers; ${postflop} post-flop betting ` +
            `round(s) cannot be reconciled with a ${board.length}-card board.`,
        );
      }
      const order: P5Street[] = ["preflop", "flop", "turn", "river"];
      rounds.forEach((round, index) => {
        for (const action of round) {
          action.street = order[index];
        }
      });
      if (postflop > 0) {
        warnings.push({
          code: "streets-inferred",
          message: `No street markers; ${postflop} post-flop round(s) recovered from betting closure.`,
        });
      }
    }

    /* ----------------------------------------------------------- build ---- */

    if (smallBlind === 0 && bigBlind > 0) {
      warnings.push({
        code: "dead-small-blind",
        message: "No small blind was posted; the seat to the button's left was empty.",
      });
    }
    if (
      header.levelBigBlind > 0 &&
      bigBlind > 0 &&
      header.levelBigBlind !== bigBlind
    ) {
      warnings.push({
        code: "stale-level-blinds",
        message:
          `The level header advertises ${header.levelSmallBlind}/${header.levelBigBlind} ` +
          `but ${smallBlind}/${bigBlind} was posted; the posted blinds win.`,
      });
    }

    const dealtIn = seats.length;
    const draft: P5Draft = {
      siteId: "ignition",
      siteName: "Ignition / Bodog / Bovada",
      parserId: "ignition",
      parserVersion: VERSION,
      handId: header.handId,
      gameLabel: `Hold'em ${header.limit}`,
      unit,
      decimals: "fixed2",
      smallBlind: smallBlind || header.levelSmallBlind,
      bigBlind: bigBlind || header.levelBigBlind,
      tableName: header.tournamentId
        ? `${header.tournamentId} ${header.tableId ?? ""}`.trim()
        : header.tableId,
      maxSeats: [2, 6, 9, 10].find((size) => size >= dealtIn) ?? dealtIn,
      buttonSeat,
      playedAt: header.playedAt,
      tournament: header.tournamentId
        ? {
            id: header.tournamentId,
            name: header.speed,
            // Only the 2021 `[MVS]` header carries a buy-in, on its Table Info
            // line; the rest of the corpus never states one.
            buyInToken: mvsBuyIn(lines) ?? "$0",
            levelLabel: header.levelLabel ?? "1",
          }
        : null,
      seats,
      actions,
      flop: flop && flop.length === 3 ? flop : null,
      turn,
      river,
      collected,
      statedPot,
      statedRake,
      holeCards,
      rawText: text,
      warnings,
    };
    if (statedPot === null) {
      warnings.push({
        code: "derived-pot",
        message: "The SUMMARY block states no pot; it was taken from the action stream.",
      });
    }

    const hand = p5BuildHand(draft, ctx, `IG${header.handId}`);
    if (playerHashes.length > 0) {
      // The 2021 `[MVS]` header carries a per-seat hash for every seat except
      // the hero's. Whether it is stable for the same player across hands is
      // unconfirmed - see docs/research/hh-formats/ignition-bodog-bovada.md - so
      // it is recorded as provenance rather than used as an identity.
      hand.meta.warnings.push({
        code: "mvs-player-hashes",
        message: playerHashes.map((entry) => `${entry.seat}=${entry.hash}`).join(" "),
      });
    }
    return hand;
  },
};

/** `Table Info: ..., Buyin: $25+$2.50, TableType: MTT` -> `$25+$2.50`. */
function mvsBuyIn(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^Table Info:.*\bBuyin:\s*([^,]+)/i);
    if (match) {
      return match[1].trim().replace(/\s+/g, "");
    }
  }
  return null;
}
