/**
 * Shared draft -> PHF builder for the two US-facing networks, Ignition/Bodog/
 * Bovada and ACR/WPN.
 *
 * `shared/p2-handbuilder.ts` already does this job for the PartyGaming lineage,
 * but it exists because those rooms state *nothing* about the settlement: it
 * derives the uncalled bet, the pot and the rake from the contributions. Both
 * rooms here are the opposite case. They print the uncalled return, the pot and
 * (sometimes) the rake themselves, and re-deriving those numbers would throw
 * away the only cross-check the source offers - the point where a
 * misunderstood action line stops balancing.
 *
 * So this module keeps the same shape as its sibling and changes one thing: the
 * settlement comes from the draft, and the replay is what gets checked against
 * it. What it still does for the caller:
 *
 *   1. replays the betting to turn "chips added" / "street total" - the two
 *      rooms disagree, and Ignition disagrees with itself - into the standard
 *      `raises X to Y` form,
 *   2. keeps live money and dead money apart, because a dead blind does not
 *      count toward the street bet even though it is in the pot,
 *   3. emits GG-style standard text and hands it to `parseStandardHand`, so the
 *      summary block, the position ring, the results object and the text round
 *      trip stay implemented exactly once.
 */

import { ParseSkip, type SiteParserContext } from "../../phf/detect";
import { parseStandardHand } from "../../phf/serialize";
import {
  formatAmount,
  type Amount,
  type CurrencyUnit,
  type DecimalStyle,
  type PhfHand,
  type PhfWarning,
} from "../../phf/types";

/** Streets a draft can carry. `showdown` is generated, never drafted. */
export type P5Street = "preflop" | "flop" | "turn" | "river";

export const P5_STREETS: P5Street[] = ["preflop", "flop", "turn", "river"];

export interface P5Seat {
  seat: number;
  name: string;
  startingStack: Amount;
  isHero: boolean;
  /**
   * The seat took part in this hand.
   *
   * Seats that were only sitting at the table are dropped rather than carried:
   * the position ring is numbered from every seat it is given, so keeping an
   * observer silently shifts everybody else round by one.
   */
  dealtIn: boolean;
  /** Cards the source printed at deal time, if any. */
  dealtCards: string[];
}

export type P5Kind =
  | "ante"
  | "small-blind"
  | "big-blind"
  | "post"
  | "straddle"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  /** The source only said "all-in"; the builder works out call/bet/raise. */
  | "allin"
  /** The source printed the return itself. `amount` is what came back. */
  | "uncalled"
  | "show"
  | "muck";

export interface P5Action {
  street: P5Street;
  player: string;
  kind: P5Kind;
  /** Chips this action adds to the pot, unless `toTotal` says otherwise. */
  amount?: Amount;
  /**
   * `amount` is the actor's total for the street rather than the increment.
   *
   * Both rooms need this and neither is consistent about it: Ignition writes
   * `Raises 300` (a street total) and `Raises 300 to 450` (an increment plus a
   * total) in the same era, and WPN's older grammar states raise totals while
   * stating call increments.
   */
  toTotal?: boolean;
  /**
   * Chips added alongside `amount` that do *not* count toward the street bet,
   * i.e. a dead blind owed by a returning player.
   */
  dead?: Amount;
  /** The source flagged the action as all-in. */
  allIn?: boolean;
  /** Cards a `show` / `muck` revealed. These are hole cards, never a best five. */
  cards?: string[];
  /** Showdown hand description, e.g. "Two pair". */
  description?: string;
}

export interface P5Collect {
  player: string;
  amount: Amount;
  /** "pot" | "main pot" | "side pot", as the source named it. */
  potName?: string;
}

export interface P5Tournament {
  id: string;
  /** Free text the header carried, e.g. "Turbo"; null when there is none. */
  name: string | null;
  /** Printed buy-in, e.g. `$25+$2.50`. Must contain no spaces. */
  buyInToken: string;
  levelLabel: string;
}

export interface P5Draft {
  siteId: string;
  siteName: string;
  parserId: string;
  parserVersion: string;
  handId: string;
  /** Canonical GG-style label, e.g. "Hold'em No Limit". */
  gameLabel: string;
  unit: CurrencyUnit;
  decimals: DecimalStyle;
  /** Blinds for the header. Callers pass what was posted when they know it. */
  smallBlind: Amount;
  bigBlind: Amount;
  tableName: string | null;
  maxSeats: number;
  buttonSeat: number | null;
  /** ISO 8601 UTC, or null when the source omits a usable timestamp. */
  playedAt: string | null;
  tournament: P5Tournament | null;
  seats: P5Seat[];
  actions: P5Action[];
  flop: string[] | null;
  turn: string | null;
  river: string | null;
  collected: P5Collect[];
  /**
   * The pot as the source stated it, or null to take the replay's own total.
   *
   * When it is stated and the replay disagrees by more than a minor unit the
   * hand is refused: one of the two readings is wrong and there is no way to
   * tell which, so storing either would be storing a guess.
   */
  statedPot: Amount | null;
  /**
   * The rake as the source stated it, or null to call the whole shortfall rake.
   *
   * What the pot loses between the contributions and the payouts is not always
   * all rake. WPN's older jackpot tables take a flat $0.25 jackpot drop and
   * print only `Pot: 7.73. Rake 0.41` - the drop is real money leaving the pot
   * and is simply not itemized. Anything above the stated rake is therefore
   * booked as a jackpot fee rather than folded into the rake, which keeps
   * win-rate maths able to add the promotional part back.
   */
  statedRake: Amount | null;
  /**
   * Per-player totals the source reports independently of its action lines,
   * i.e. WPN's `Bets: 12.` summary column. When present every one of them has
   * to agree with the replay or the hand is refused: a disagreement means an
   * action line was misread, which is exactly the failure that produces a
   * plausible-looking wrong hand.
   */
  statedContributions: Map<string, Amount> | null;
  /** Cards each seat held, when the source revealed them outside the deal. */
  holeCards: Map<string, string[]>;
  rawText: string;
  warnings: PhfWarning[];
}

/** One minor unit of slack, matching `validateHand`. */
const TOLERANCE: Amount = 1;

function money(amount: Amount, unit: CurrencyUnit, decimals: DecimalStyle): string {
  return formatAmount(amount, unit, decimals);
}

/* ------------------------------------------------------------ betting state - */

interface Replay {
  lines: Map<P5Street, string[]>;
  /**
   * Lines that belong above `*** HOLE CARDS ***`.
   *
   * `toStandardText` groups exactly the ante, blind, missed-blind and straddle
   * actions there and leaves a bare `posts` in the preflop body, so the two have
   * to be split the same way here or the hand comes back in a different order
   * on the round trip. Both rooms print a pre-deal `posts` - Ignition's short
   * stack going all-in for its blind, WPN's catch-up post - so this is not
   * hypothetical.
   */
  preDeal: string[];
  /** Everything every player put in, dead money and uncalled returns included. */
  gross: Amount;
  /** The same total, per player, for cross-checking against the source. */
  contributed: Map<string, Amount>;
  folded: Map<string, P5Street>;
  voluntary: Set<string>;
  blindPosters: { small: string | null; big: string | null };
  shows: Array<{ player: string; cards: string[]; description?: string }>;
  mucks: Array<{ player: string; cards: string[] }>;
  /** Street each reveal physically appeared on; the last street that saw money. */
  lastStreet: P5Street;
}

/**
 * Replays the draft's action list into standard-text lines.
 *
 * The interesting part is `raises`: standard text prints both the amount over
 * the current bet and the resulting street total, and neither room gives both
 * reliably, so both numbers come out of the betting state here rather than off
 * the source line.
 */
function replayActions(draft: P5Draft): Replay {
  const { unit, decimals } = draft;
  const lines = new Map<P5Street, string[]>();
  for (const street of P5_STREETS) {
    lines.set(street, []);
  }

  const preDeal: string[] = [];
  const folded = new Map<string, P5Street>();
  const voluntary = new Set<string>();
  const shows: Replay["shows"] = [];
  const mucks: Replay["mucks"] = [];
  const blindPosters: Replay["blindPosters"] = { small: null, big: null };
  const contributed = new Map<string, Amount>();
  let gross = 0;
  let lastStreet: P5Street = "preflop";

  let street: P5Street = "preflop";
  let commit = new Map<string, Amount>();
  let bet: Amount = 0;

  const bank = (player: string, amount: Amount): void => {
    contributed.set(player, (contributed.get(player) ?? 0) + amount);
    gross += amount;
  };

  /** Puts `live` toward the street bet and `dead` straight into the pot. */
  const put = (player: string, live: Amount, dead: Amount): Amount => {
    const next = (commit.get(player) ?? 0) + live;
    commit.set(player, next);
    bet = Math.max(bet, next);
    bank(player, live + dead);
    return next;
  };

  for (const action of draft.actions) {
    if (action.kind === "show") {
      shows.push({
        player: action.player,
        cards: action.cards ?? [],
        description: action.description,
      });
      continue;
    }
    if (action.kind === "muck") {
      mucks.push({ player: action.player, cards: action.cards ?? [] });
      continue;
    }
    // Reveals are collected above so that they cannot close a street: a reveal
    // is tagged with the street it physically appeared on, which after an
    // all-in run-out is earlier than the last street that saw money.
    if (action.street !== street) {
      street = action.street;
      commit = new Map();
      bet = 0;
    }
    const body = lines.get(street)!;
    // Antes, blinds and straddles are re-grouped above the deal; everything
    // else, `post` included, stays in the street body.
    const out =
      action.kind === "ante" ||
      action.kind === "small-blind" ||
      action.kind === "big-blind" ||
      action.kind === "straddle"
        ? preDeal
        : body;
    const already = commit.get(action.player) ?? 0;
    const amount = action.toTotal
      ? Math.max(0, (action.amount ?? 0) - already)
      : (action.amount ?? 0);
    const dead = action.dead ?? 0;
    const allIn = action.allIn ? " and is all-in" : "";
    if (amount > 0 || dead > 0) {
      lastStreet = street;
    }

    switch (action.kind) {
      case "ante":
        // Antes never count toward the street bet, so they are pure dead money.
        bank(action.player, amount);
        out.push(`${action.player}: posts the ante ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "small-blind":
        blindPosters.small ??= action.player;
        put(action.player, amount, dead);
        out.push(`${action.player}: posts small blind ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "big-blind":
        blindPosters.big ??= action.player;
        // Dead money rides on the same source line. Standard text has no
        // "+ dead" form, so it is re-emitted as a missed blind, and it goes
        // first because `toStandardText` groups missed blinds ahead of the deal.
        if (dead > 0) {
          out.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);
        }
        put(action.player, amount, dead);
        out.push(`${action.player}: posts big blind ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "post":
      case "straddle":
        if (dead > 0) {
          preDeal.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);
        }
        put(action.player, amount, dead);
        // WPN splits a dead+live post across two lines and prints the dead half
        // on its own, so a post can be pure dead money with nothing live in it.
        if (amount > 0 || dead === 0) {
          out.push(`${action.player}: posts ${money(amount, unit, decimals)}${allIn}`);
        }
        break;
      case "fold":
        folded.set(action.player, street);
        out.push(`${action.player}: folds`);
        break;
      case "check":
        out.push(`${action.player}: checks`);
        break;
      case "call":
        voluntary.add(action.player);
        put(action.player, amount, dead);
        out.push(`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "bet":
        voluntary.add(action.player);
        put(action.player, amount, dead);
        out.push(`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "raise":
      case "allin": {
        // Both rooms write one token for an opening bet, a call and a raise
        // alike, so which of the three it was only follows from the state.
        voluntary.add(action.player);
        const over = bet;
        const to = put(action.player, amount, dead);
        const flag = action.kind === "allin" && !action.allIn ? " and is all-in" : allIn;
        if (to <= over) {
          out.push(`${action.player}: calls ${money(amount, unit, decimals)}${flag}`);
        } else if (over > 0) {
          out.push(
            `${action.player}: raises ${money(to - over, unit, decimals)} to ` +
              `${money(to, unit, decimals)}${flag}`,
          );
        } else {
          out.push(`${action.player}: bets ${money(amount, unit, decimals)}${flag}`);
        }
        break;
      }
      case "uncalled": {
        // The source states the return, so it is replayed rather than derived.
        const returned = action.amount ?? 0;
        commit.set(action.player, already - returned);
        bank(action.player, -returned);
        out.push(
          `Uncalled bet (${money(returned, unit, decimals)}) returned to ${action.player}`,
        );
        break;
      }
    }
  }

  return {
    lines,
    preDeal,
    gross,
    contributed,
    folded,
    voluntary,
    blindPosters,
    shows,
    mucks,
    lastStreet,
  };
}

/* ------------------------------------------------------------------ summary - */

function positionLabelsFor(
  seat: P5Seat,
  buttonSeat: number | null,
  blinds: Replay["blindPosters"],
): string[] {
  const labels: string[] = [];
  if (buttonSeat !== null && seat.seat === buttonSeat) {
    labels.push("(button)");
  }
  if (seat.name === blinds.small) {
    labels.push("(small blind)");
  }
  if (seat.name === blinds.big) {
    labels.push("(big blind)");
  }
  return labels;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `2014-01-06T22:40:28.000Z` -> `2014/01/06 22:40:28`. */
export function p5HeaderDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/* -------------------------------------------------------------------- build - */

/** Renders `draft` as standard text. Exported for tests and for debugging. */
export function p5DraftToStandardText(draft: P5Draft): string {
  const { unit, decimals } = draft;
  const replay = replayActions(draft);
  const seats = draft.seats.filter((seat) => seat.dealtIn).sort((a, b) => a.seat - b.seat);

  const totalPot = draft.statedPot ?? replay.gross;
  if (draft.statedPot !== null && Math.abs(replay.gross - draft.statedPot) > TOLERANCE) {
    throw new ParseSkip(
      "chip-mismatch",
      `The action stream puts ${replay.gross} in the pot but the hand reports ` +
        `${draft.statedPot}; one of the two readings is wrong.`,
    );
  }
  const paidOut = draft.collected.reduce((sum, entry) => sum + entry.amount, 0);
  if (paidOut === 0 && totalPot > TOLERANCE) {
    // A walk where the blind is handed straight back leaves a zero pot and no
    // winner, which is fine. Chips in the middle and nobody named to take them
    // is a truncated hand.
    throw new ParseSkip(
      "no-winner",
      `The hand puts ${totalPot} in the pot but never says who collected it.`,
    );
  }
  const shortfall = totalPot - paidOut;
  if (shortfall < -TOLERANCE) {
    throw new ParseSkip(
      "inconsistent-pot",
      `Winners collected ${paidOut} out of a pot of ${totalPot}, which leaves a ` +
        `negative rake of ${shortfall}.`,
    );
  }
  // Anything the pot lost beyond the stated rake is an unitemized jackpot drop;
  // see `statedRake`. With no stated rake the whole shortfall is rake.
  const rake = draft.statedRake === null ? shortfall : Math.min(draft.statedRake, shortfall);
  const jackpot = Math.max(0, shortfall - rake);

  if (draft.statedContributions) {
    for (const [player, stated] of draft.statedContributions) {
      const actual = replay.contributed.get(player) ?? 0;
      if (Math.abs(actual - stated) > TOLERANCE) {
        throw new ParseSkip(
          "contribution-mismatch",
          `${player} is reported to have put in ${stated} but the action stream ` +
            `replays to ${actual}.`,
        );
      }
    }
  }

  const stakes = `${money(draft.smallBlind, unit, decimals)}/${money(draft.bigBlind, unit, decimals)}`;
  const date = draft.playedAt ? p5HeaderDate(draft.playedAt) : "";

  const lines: string[] = [];
  if (draft.tournament) {
    const name = draft.tournament.name ? `(${draft.tournament.name}) ` : "";
    lines.push(
      `Poker Hand #${draft.handId}: Tournament ${name}#${draft.tournament.id}, ` +
        `${draft.tournament.buyInToken} ${draft.gameLabel} - ` +
        `Level ${draft.tournament.levelLabel} (${stakes}) - ${date}`,
    );
  } else {
    lines.push(`Poker Hand #${draft.handId}: ${draft.gameLabel} (${stakes}) - ${date}`);
  }
  lines.push(
    `Table '${draft.tableName ?? ""}' ${draft.maxSeats}-max` +
      (draft.buttonSeat === null ? "" : ` Seat #${draft.buttonSeat} is the button`),
  );
  for (const seat of seats) {
    lines.push(
      `Seat ${seat.seat}: ${seat.name} (${money(seat.startingStack, unit, decimals)} in chips)`,
    );
  }

  lines.push(...replay.preDeal);

  lines.push("*** HOLE CARDS ***");
  for (const seat of seats) {
    if (seat.dealtCards.length > 0) {
      lines.push(`Dealt to ${seat.name} [${seat.dealtCards.join(" ")}]`);
    }
  }
  lines.push(...(replay.lines.get("preflop") ?? []));

  const board = [
    ...(draft.flop ?? []),
    ...(draft.turn ? [draft.turn] : []),
    ...(draft.river ? [draft.river] : []),
  ];
  const emitStreet = (street: Exclude<P5Street, "preflop">, marker: string) => {
    lines.push(marker);
    lines.push(...(replay.lines.get(street) ?? []));
  };
  if (draft.flop) {
    emitStreet("flop", `*** FLOP *** [${draft.flop.join(" ")}]`);
  }
  if (draft.turn) {
    emitStreet("turn", `*** TURN *** [${board.slice(0, 3).join(" ")}] [${draft.turn}]`);
  }
  if (draft.river) {
    emitStreet("river", `*** RIVER *** [${board.slice(0, 4).join(" ")}] [${draft.river}]`);
  }

  lines.push("*** SHOWDOWN ***");
  for (const show of replay.shows) {
    lines.push(
      `${show.player}: shows [${show.cards.join(" ")}]` +
        (show.description ? ` (${show.description})` : ""),
    );
  }
  for (const muck of replay.mucks) {
    lines.push(`${muck.player}: doesn't show hand`);
  }
  for (const entry of draft.collected) {
    lines.push(
      `${entry.player} collected ${money(entry.amount, unit, decimals)} from ${entry.potName ?? "pot"}`,
    );
  }

  lines.push("*** SUMMARY ***");
  const zero = money(0, unit, decimals);
  lines.push(
    `Total pot ${money(totalPot, unit, decimals)} | Rake ${money(Math.max(0, rake), unit, decimals)} | ` +
      `Jackpot ${money(jackpot, unit, decimals)} | Bingo ${zero} | Fortune ${zero} | Tax ${zero}`,
  );
  if (board.length > 0) {
    lines.push(`Board [${board.join(" ")}]`);
  }

  const wonBy = new Map<string, Amount>();
  for (const entry of draft.collected) {
    wonBy.set(entry.player, (wonBy.get(entry.player) ?? 0) + entry.amount);
  }
  const shownBy = new Map(replay.shows.map((show) => [show.player, show]));
  const muckedBy = new Map(replay.mucks.map((muck) => [muck.player, muck]));

  for (const seat of seats) {
    const labels = positionLabelsFor(seat, draft.buttonSeat, replay.blindPosters);
    const head = `Seat ${seat.seat}: ${seat.name}${labels.length ? ` ${labels.join(" ")}` : ""}`;
    const won = wonBy.get(seat.name) ?? 0;
    const shown = shownBy.get(seat.name);
    const mucked = muckedBy.get(seat.name);
    const foldedStreet = replay.folded.get(seat.name);
    // Only cards the source actually turned over. Ignition prints every seat's
    // hole cards in its deal block, and those ride out on the `Dealt to` lines;
    // repeating them here would report a fold as a showdown reveal.
    const revealedCards = (shown ?? mucked)?.cards ?? [];

    if (foldedStreet) {
      const where =
        foldedStreet === "preflop"
          ? "folded before Flop"
          : `folded on the ${capitalize(foldedStreet)}`;
      // "(didn't bet)" is the tracker definition: no chip went in voluntarily,
      // and a blind is not a voluntary bet.
      const voluntary = replay.voluntary.has(seat.name);
      const revealed = revealedCards.length > 0 ? `, mucked [${revealedCards.join(" ")}]` : "";
      lines.push(`${head} ${where}${voluntary ? "" : " (didn't bet)"}${revealed}`);
      continue;
    }
    if (shown && won > 0) {
      lines.push(
        `${head} showed [${shown.cards.join(" ")}] and won (${money(won, unit, decimals)})` +
          (shown.description ? ` with ${shown.description}` : ""),
      );
      continue;
    }
    if (shown) {
      lines.push(
        `${head} showed [${shown.cards.join(" ")}] and lost` +
          (shown.description ? ` with ${shown.description}` : ""),
      );
      continue;
    }
    if (won > 0) {
      lines.push(`${head} collected (${money(won, unit, decimals)})`);
      continue;
    }
    if (revealedCards.length > 0) {
      lines.push(`${head} mucked [${revealedCards.join(" ")}]`);
      continue;
    }
    lines.push(`${head} mucked`);
  }

  return lines.join("\n");
}

/**
 * Draft in, PHF out.
 *
 * `meta.rawText` is reset to the *site's* text afterwards: the normalized
 * standard text is an implementation detail and a later fix has to be able to
 * re-convert from the original bytes.
 */
export function p5BuildHand(
  draft: P5Draft,
  ctx: SiteParserContext,
  handKey: string,
): PhfHand {
  if (draft.seats.filter((seat) => seat.dealtIn).length < 2) {
    throw new ParseSkip(
      "too-few-players",
      "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
    );
  }

  const text = p5DraftToStandardText(draft);
  const hand = parseStandardHand(text, {
    siteId: draft.siteId,
    siteName: draft.siteName,
    originalFilename: ctx.sourceFilename,
    parserId: draft.parserId,
    parserVersion: draft.parserVersion,
  });
  if (!hand) {
    throw new ParseSkip(
      "normalized-unparseable",
      "The normalized text was not readable as a standard-format hand.",
    );
  }

  // Cards the source revealed outside the deal block, e.g. in its summary.
  for (const player of hand.players) {
    const cards = draft.holeCards.get(player.name);
    if (cards && cards.length > 0 && player.holeCards.length === 0) {
      player.holeCards = cards;
    }
  }

  hand.meta.rawText = draft.rawText;
  hand.meta.warnings = [...draft.warnings, ...hand.meta.warnings];
  hand.meta.handKey = handKey;
  return hand;
}
