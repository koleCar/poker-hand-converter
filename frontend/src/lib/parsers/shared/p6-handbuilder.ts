/**
 * Shared draft -> PHF builder for Winamax and the Chico network.
 *
 * Both rooms state a hand the same way: a seat list, an ordered action stream in
 * "chips added" form, and a settlement block. Neither of them is close enough to
 * the GG shape for a line-by-line rewrite - Winamax marks the blind round with
 * `*** ANTE/BLINDS ***` and never prints an uncalled return at all, Chico writes
 * the same event with three different spellings depending on the skin - so each
 * site parser reads its own dialect into a `P6Draft` and this module does the
 * rest:
 *
 *   1. replays the betting to get per-street commitments, which is what turns
 *      Chico's `raises 120.00 to 120.00` (a real, confirmed site bug where the
 *      "by" field repeats the "to" field) into a correct `raises 60 to 120`,
 *   2. derives the uncalled return, because Winamax never prints one and two of
 *      the four confirmed Chico skins do not either,
 *   3. reconciles the derived pot and rake against the numbers the source
 *      printed, and **refuses the hand when the two disagree**,
 *   4. emits GG-style standard text and hands it to `parseStandardHand`.
 *
 * Step 4 is the same route `parsers/weplay.ts` takes, and for the same reason:
 * the summary block, the position ring, the results object and the text round
 * trip are all implemented once, in `phf/serialize.ts`.
 *
 * Step 3 is what makes this file different from its sibling
 * `shared/p2-handbuilder.ts`, which has to *infer* a rake because none of the
 * PartyGaming-lineage rooms prints one. Winamax and Chico both print a rake, so
 * the derived number has something to be checked against, and a mismatch is a
 * refusal rather than a guess. Three of the sixteen Chico fixtures are refused
 * by exactly that check, and every one of them turned out to be genuinely
 * broken source text - see `parsers/chico.ts`.
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
export type P6Street = "preflop" | "flop" | "turn" | "river";

export const P6_STREETS: P6Street[] = ["preflop", "flop", "turn", "river"];

/** One minor unit of slack, the same tolerance the validator uses. */
const TOLERANCE: Amount = 1;

export interface P6Seat {
  seat: number;
  name: string;
  startingStack: Amount;
  /**
   * The seat took part in this hand.
   *
   * Seats that were sitting out are dropped rather than carried with
   * `sittingOut: true`: the position ring is numbered from every seat it is
   * given, so keeping an observer silently shifts everybody else round by one.
   * Chico marks them (`- Sitting out`) and Winamax simply omits them.
   */
  dealtIn: boolean;
  isHero: boolean;
  /** Cards the source showed at deal time; normally the hero's only. */
  dealtCards: string[];
}

export type P6Kind =
  | "ante"
  | "small-blind"
  | "big-blind"
  | "post"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "show"
  | "muck";

export interface P6Action {
  street: P6Street;
  player: string;
  kind: P6Kind;
  /** Chips this action adds to the pot, counting toward the current street bet. */
  amount?: Amount;
  /**
   * `amount` is the actor's total for the street, not the increment.
   *
   * Both rooms write `raises <by> to <to>`; the "to" number is the one that can
   * be trusted, because Chico's "by" field is wrong on the first raise of a
   * street. Every other verb on both sites states an increment.
   */
  toTotal?: boolean;
  /**
   * Chips added alongside `amount` that do *not* count toward the street bet.
   *
   * Chico's `post dead` is a live post plus a dead small blind that the line
   * never states; see `parsers/chico.ts` for the arithmetic that establishes it.
   */
  dead?: Amount;
  /** The source flagged the action as all-in. */
  allIn?: boolean;
  /** Cards a `show` / `muck` revealed. */
  cards?: string[];
  /** Showdown hand description, e.g. "One pair : Queens". */
  description?: string;
  /** 1-based line number in the site's own text, for warning messages. */
  line?: number;
}

export interface P6Collect {
  player: string;
  amount: Amount;
  /** "pot" | "main pot" | "side pot", as the source named it. */
  potName?: string;
}

export interface P6Draft {
  siteId: string;
  siteName: string;
  parserId: string;
  parserVersion: string;
  /**
   * Prefix put in front of the site's own hand number.
   *
   * `meta.handKey` is the dedupe key, and a bare sequential integer is not
   * unique across rooms - Chico's `Game #1002134798` and some future room's
   * hand 1002134798 would collide.
   */
  handPrefix: string;
  handId: string;
  /** Canonical GG-style label, e.g. "Hold'em No Limit". */
  gameLabel: string;
  unit: CurrencyUnit;
  decimals: DecimalStyle;
  /** Blinds from the header; overridden by what was actually posted. */
  headerSmallBlind: Amount;
  headerBigBlind: Amount;
  tableName: string | null;
  maxSeats: number;
  buttonSeat: number | null;
  /** Tournament id and level blinds, or null on a cash hand. */
  tournament: { id: string; levelSmallBlind: Amount; levelBigBlind: Amount } | null;
  /** ISO 8601, or null when the source omits a usable timestamp. */
  playedAt: string | null;
  seats: P6Seat[];
  actions: P6Action[];
  flop: string[] | null;
  turn: string | null;
  river: string | null;
  collected: P6Collect[];
  /**
   * Whether the amounts in `collected` already contain the winner's own
   * uncalled bet.
   *
   * Winamax leaves an unmatched bet in the pot and hands it straight back inside
   * the `collected` line - a 5&euro;/10&euro; hand where the river bet of 650&euro;
   * went uncalled reports `collected 1372&euro;` against a 722&euro; contested pot.
   * Chico deducts it first and prints an explicit return line. Getting this
   * backwards moves the whole uncalled amount into the rake.
   */
  collectedIncludesUncalled: boolean;
  /**
   * Uncalled returns the source printed, if it prints any. Cross-checked against
   * the return derived from the betting state; a disagreement means one of the
   * two is lying about the pot and the hand is refused.
   */
  printedUncalled: Array<{ player: string; amount: Amount }>;
  /** Total chips that went in, per the source, or null when it does not say. */
  reportedGross: Amount | null;
  /** Total paid out net of fees, per the source, or null when it does not say. */
  reportedPayout: Amount | null;
  /** Rake the source printed, or null when it prints none. */
  reportedRake: Amount | null;
  rawText: string;
  warnings: PhfWarning[];
}

/* ------------------------------------------------------------ betting state - */

interface StreetState {
  street: P6Street;
  /** Live commitment per player on this street. */
  commit: Map<string, Amount>;
  /** Highest live commitment so far, i.e. what a caller has to match. */
  bet: Amount;
}

interface Replay {
  lines: Map<P6Street, string[]>;
  /** Per street, the live commitment each player ended with. */
  totals: Map<P6Street, Map<string, Amount>>;
  /** Everything every player put in, uncalled money included. */
  gross: Amount;
  contributed: Map<string, Amount>;
  folded: Map<string, P6Street>;
  smallBlind: Amount;
  bigBlind: Amount;
  blindPosters: { small: string | null; big: string | null };
  shows: Array<{ street: P6Street; player: string; cards: string[]; description?: string }>;
  mucks: Array<{ street: P6Street; player: string; cards: string[] }>;
}

function money(amount: Amount, unit: CurrencyUnit, decimals: DecimalStyle): string {
  return formatAmount(amount, unit, decimals);
}

/**
 * Replays the draft's action list into standard-text lines.
 *
 * The genuinely tricky part is `raises`: standard text prints both the amount
 * over the current bet and the resulting street total, and neither room states
 * the first one reliably. Both numbers therefore come from the betting state,
 * which is why this is a replay rather than a line-by-line rewrite.
 */
function replayActions(draft: P6Draft): Replay {
  const { unit, decimals } = draft;
  const lines = new Map<P6Street, string[]>();
  const totals = new Map<P6Street, Map<string, Amount>>();
  const contributed = new Map<string, Amount>();
  const folded = new Map<string, P6Street>();
  const shows: Replay["shows"] = [];
  const mucks: Replay["mucks"] = [];
  let gross = 0;
  let smallBlind = 0;
  let bigBlind = 0;
  const blindPosters: Replay["blindPosters"] = { small: null, big: null };

  for (const street of P6_STREETS) {
    lines.set(street, []);
    totals.set(street, new Map());
  }

  let state: StreetState = { street: "preflop", commit: new Map(), bet: 0 };

  const put = (player: string, live: Amount, dead = 0): Amount => {
    const next = (state.commit.get(player) ?? 0) + live;
    state.commit.set(player, next);
    state.bet = Math.max(state.bet, next);
    contributed.set(player, (contributed.get(player) ?? 0) + live + dead);
    gross += live + dead;
    return next;
  };

  for (const action of draft.actions) {
    if (action.kind === "show") {
      shows.push({
        street: action.street,
        player: action.player,
        cards: action.cards ?? [],
        description: action.description,
      });
      continue;
    }
    if (action.kind === "muck") {
      mucks.push({ street: action.street, player: action.player, cards: action.cards ?? [] });
      continue;
    }
    // Reveals are collected above so that they cannot close a betting street: a
    // showdown reveal carries the street it physically happened on, which in an
    // all-in run-out is earlier than the last street that saw money.
    if (action.street !== state.street) {
      totals.set(state.street, state.commit);
      state = { street: action.street, commit: new Map(), bet: 0 };
    }
    const out = lines.get(action.street)!;
    const allIn = action.allIn ? " and is all-in" : "";
    const already = state.commit.get(action.player) ?? 0;
    const amount = action.toTotal
      ? Math.max(0, (action.amount ?? 0) - already)
      : (action.amount ?? 0);
    const dead = action.dead ?? 0;
    if (dead > 0) {
      // Dead money rides on the same source line, and the standard text has no
      // "+ dead" form, so it is re-emitted as a missed blind: `parseStandardHand`
      // reads that as chips in the pot that do not count toward the street bet,
      // which is exactly what dead money is. It goes first because the blind
      // block is grouped ahead of the deal on the way back out.
      out.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);
    }

    switch (action.kind) {
      case "ante":
        // Antes are dead by definition: they never count toward the street bet.
        contributed.set(action.player, (contributed.get(action.player) ?? 0) + amount);
        gross += amount;
        out.push(`${action.player}: posts the ante ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "small-blind":
        smallBlind = Math.max(smallBlind, amount);
        blindPosters.small ??= action.player;
        put(action.player, amount, dead);
        out.push(`${action.player}: posts small blind ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "big-blind":
        bigBlind = Math.max(bigBlind, amount);
        blindPosters.big ??= action.player;
        put(action.player, amount, dead);
        out.push(`${action.player}: posts big blind ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "post":
        put(action.player, amount, dead);
        // A post that is nothing but dead money - one real Chico hand posts a
        // dead small blind and no live chips at all - has already been written
        // out as the missed blind above.
        if (amount > 0) {
          out.push(`${action.player}: posts ${money(amount, unit, decimals)}${allIn}`);
        }
        break;
      case "fold":
        folded.set(action.player, action.street);
        out.push(`${action.player}: folds`);
        break;
      case "check":
        out.push(`${action.player}: checks`);
        break;
      case "call":
        put(action.player, amount);
        out.push(`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "bet":
        put(action.player, amount);
        out.push(`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "raise": {
        // A "raise" that does not actually get above the current bet is a call,
        // and one made into an unopened street is a bet. Both happen in real
        // text on these rooms, so the verb follows from the betting state.
        const over = state.bet;
        const to = put(action.player, amount);
        if (to <= over) {
          out.push(`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`);
        } else if (over > 0) {
          out.push(
            `${action.player}: raises ${money(to - over, unit, decimals)} to ` +
              `${money(to, unit, decimals)}${allIn}`,
          );
        } else {
          out.push(`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`);
        }
        break;
      }
    }
  }
  totals.set(state.street, state.commit);

  return {
    lines,
    totals,
    gross,
    contributed,
    folded,
    smallBlind,
    bigBlind,
    blindPosters,
    shows,
    mucks,
  };
}

/**
 * The uncalled bet, derived from the betting state.
 *
 * On the last street that saw money, whoever committed more than anybody else
 * gets the difference back. A tie means everybody was matched and nothing comes
 * back; a walk to the big blind is the same rule, which is why the big blind
 * gets its excess over the small blind returned exactly as PokerStars writes it.
 */
function deriveUncalled(replay: Replay): { player: string; amount: Amount; street: P6Street } | null {
  for (let i = P6_STREETS.length - 1; i >= 0; i -= 1) {
    const street = P6_STREETS[i];
    const commit = replay.totals.get(street);
    if (!commit) {
      continue;
    }
    const entries = [...commit.entries()].filter(([, value]) => value > 0);
    if (entries.length === 0) {
      continue;
    }
    entries.sort((a, b) => b[1] - a[1]);
    const [player, top] = entries[0];
    const second = entries[1]?.[1] ?? 0;
    return top > second ? { player, amount: top - second, street } : null;
  }
  return null;
}

interface Settlement {
  uncalled: { player: string; amount: Amount; street: P6Street } | null;
  collected: P6Collect[];
  totalPot: Amount;
  rake: Amount;
}

/**
 * Reconciles the contributions with what the source says was won, and refuses
 * anything that does not add up.
 *
 * Every branch here exists because a real fixture took it. The three Chico files
 * that fall out - a hidden dead blind, a side pot with no payout line, a
 * tournament hand whose summary reports a fifth of the pot that was bet - are
 * all cases where storing *something* would have meant storing a lie.
 */
function settle(draft: P6Draft, replay: Replay): Settlement {
  const uncalled = deriveUncalled(replay);

  if (draft.reportedGross !== null && Math.abs(replay.gross - draft.reportedGross) > TOLERANCE) {
    throw new ParseSkip(
      "inconsistent-pot",
      `Players put in ${replay.gross} but the hand's own pot and rake add up to ` +
        `${draft.reportedGross}.`,
    );
  }

  for (const printed of draft.printedUncalled) {
    if (!uncalled || uncalled.player !== printed.player) {
      throw new ParseSkip(
        "uncalled-mismatch",
        `The source returns ${printed.amount} to ${printed.player}, but the betting ` +
          `state says ${uncalled ? `${uncalled.amount} to ${uncalled.player}` : "nothing"} ` +
          "was left unmatched.",
      );
    }
    if (Math.abs(uncalled.amount - printed.amount) > TOLERANCE) {
      throw new ParseSkip(
        "uncalled-mismatch",
        `The source returns ${printed.amount} to ${printed.player} but only ` +
          `${uncalled.amount} was left unmatched.`,
      );
    }
  }

  // Normalize the reported winnings to "net of the uncalled return", which is
  // the convention the standard text and every tracker expect.
  const entries = draft.collected.map((entry) => ({ ...entry }));
  if (draft.collectedIncludesUncalled && uncalled) {
    let remaining = uncalled.amount;
    for (const entry of entries) {
      if (entry.player !== uncalled.player || remaining === 0) {
        continue;
      }
      const take = Math.min(remaining, entry.amount);
      entry.amount -= take;
      remaining -= take;
    }
    if (remaining > 0) {
      throw new ParseSkip(
        "inconsistent-pot",
        `${uncalled.player} had ${uncalled.amount} left unmatched but collected less ` +
          "than that, so the reported winnings cannot contain the return.",
      );
    }
  }

  const kept = entries.filter((entry) => entry.amount > 0);
  const paid = kept.reduce((sum, entry) => sum + entry.amount, 0);

  if (draft.reportedPayout !== null && Math.abs(paid - draft.reportedPayout) > TOLERANCE) {
    throw new ParseSkip(
      "payout-mismatch",
      `The summary credits ${paid} to named seats but reports pots totalling ` +
        `${draft.reportedPayout}; ${draft.reportedPayout - paid} is unaccounted for.`,
    );
  }

  const totalPot = replay.gross - (uncalled?.amount ?? 0);
  const rake = totalPot - paid;
  if (rake < -TOLERANCE) {
    throw new ParseSkip(
      "inconsistent-pot",
      `The contested pot is ${totalPot} but ${paid} was paid out of it, which would ` +
        "make the rake negative.",
    );
  }
  if (draft.reportedRake !== null && Math.abs(rake - draft.reportedRake) > TOLERANCE) {
    throw new ParseSkip(
      "rake-mismatch",
      `The source reports a rake of ${draft.reportedRake} but the contested pot of ` +
        `${totalPot} minus the ${paid} paid out leaves ${rake}.`,
    );
  }

  return { uncalled, collected: kept, totalPot, rake: Math.max(0, rake) };
}

/* ------------------------------------------------------------------ summary - */

function positionLabelsFor(
  seat: number,
  seats: P6Seat[],
  buttonSeat: number | null,
  blinds: Replay["blindPosters"],
): string[] {
  const labels: string[] = [];
  const name = seats.find((entry) => entry.seat === seat)?.name;
  if (buttonSeat !== null && seat === buttonSeat) {
    labels.push("(button)");
  }
  if (name && name === blinds.small) {
    labels.push("(small blind)");
  }
  if (name && name === blinds.big) {
    labels.push("(big blind)");
  }
  return labels;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `2014-01-06T22:40:28.000Z` -> `2014/01/06 22:40:28`. */
export function p6HeaderDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/* -------------------------------------------------------------------- build - */

/** Renders `draft` as standard text. Exported for tests and for debugging. */
export function p6ToStandardText(draft: P6Draft): string {
  const { unit, decimals } = draft;
  const replay = replayActions(draft);
  const settlement = settle(draft, replay);
  const seats = draft.seats.filter((seat) => seat.dealtIn).sort((a, b) => a.seat - b.seat);

  const smallBlind = replay.smallBlind || draft.headerSmallBlind;
  const bigBlind = replay.bigBlind || draft.headerBigBlind;
  const date = draft.playedAt ? p6HeaderDate(draft.playedAt) : "";

  const lines: string[] = [];
  if (draft.tournament) {
    // `Level -` is deliberate: Chico prints the level blinds but never a level
    // number, and inventing "Level 1" would be a claim the source never made.
    // The header regex in `phf/serialize.ts` reads `-` back as a null level.
    const level =
      `${money(draft.tournament.levelSmallBlind, unit, decimals)}/` +
      `${money(draft.tournament.levelBigBlind, unit, decimals)}`;
    lines.push(
      `Poker Hand #${draft.handPrefix}${draft.handId}: Tournament #${draft.tournament.id}, ` +
        `0 ${draft.gameLabel} - Level - (${level}) - ${date}`,
    );
  } else {
    const stakes = `${money(smallBlind, unit, decimals)}/${money(bigBlind, unit, decimals)}`;
    lines.push(
      `Poker Hand #${draft.handPrefix}${draft.handId}: ${draft.gameLabel} (${stakes}) - ${date}`,
    );
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

  // Posting lines belong before `*** HOLE CARDS ***`; everything else on the
  // preflop street comes after it.
  const preflop = replay.lines.get("preflop") ?? [];
  const postingCount = preflop.findIndex((line) => !/: posts /.test(line));
  const postings = postingCount < 0 ? preflop : preflop.slice(0, postingCount);
  const preflopBody = postingCount < 0 ? [] : preflop.slice(postingCount);
  lines.push(...postings);

  lines.push("*** HOLE CARDS ***");
  for (const seat of seats) {
    if (seat.dealtCards.length > 0) {
      lines.push(`Dealt to ${seat.name} [${seat.dealtCards.join(" ")}]`);
    } else if (seat.isHero) {
      // Both rooms identify the hero only by printing a deal line for it, and
      // both sometimes print that line with no cards on it (an export taken from
      // an observed table). The bare line is re-emitted so that
      // `dealtAnnounced` survives, which is the only part of it the standard
      // text can carry.
      lines.push(`Dealt to ${seat.name}`);
    }
  }
  lines.push(...preflopBody);
  if (settlement.uncalled?.street === "preflop") {
    lines.push(uncalledLine(settlement, unit, decimals));
  }

  const board = [
    ...(draft.flop ?? []),
    ...(draft.turn ? [draft.turn] : []),
    ...(draft.river ? [draft.river] : []),
  ];
  const emitStreet = (street: Exclude<P6Street, "preflop">, marker: string) => {
    lines.push(marker);
    lines.push(...(replay.lines.get(street) ?? []));
    if (settlement.uncalled?.street === street) {
      lines.push(uncalledLine(settlement, unit, decimals));
    }
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

  // Only a hand where somebody actually revealed gets a showdown marker: the
  // marker is what `results.wentToShowdown` keys off, and a hand where the last
  // two seats simply never folded is not a showdown.
  if (replay.shows.length > 0) {
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
  }
  for (const entry of settlement.collected) {
    lines.push(
      `${entry.player} collected ${money(entry.amount, unit, decimals)} from ${entry.potName ?? "pot"}`,
    );
  }

  lines.push("*** SUMMARY ***");
  const zero = money(0, unit, decimals);
  lines.push(
    `Total pot ${money(settlement.totalPot, unit, decimals)} | ` +
      `Rake ${money(settlement.rake, unit, decimals)} | Jackpot ${zero} | ` +
      `Bingo ${zero} | Fortune ${zero} | Tax ${zero}`,
  );
  if (board.length > 0) {
    lines.push(`Board [${board.join(" ")}]`);
  }

  const wonBy = new Map<string, Amount>();
  for (const entry of settlement.collected) {
    wonBy.set(entry.player, (wonBy.get(entry.player) ?? 0) + entry.amount);
  }
  const shownBy = new Map(replay.shows.map((show) => [show.player, show]));
  const muckedBy = new Map(replay.mucks.map((muck) => [muck.player, muck]));

  for (const seat of seats) {
    const labels = positionLabelsFor(seat.seat, seats, draft.buttonSeat, replay.blindPosters);
    const head = `Seat ${seat.seat}: ${seat.name}${labels.length ? ` ${labels.join(" ")}` : ""}`;
    const won = wonBy.get(seat.name) ?? 0;
    const shown = shownBy.get(seat.name);
    const mucked = muckedBy.get(seat.name);
    const foldedStreet = replay.folded.get(seat.name);

    if (foldedStreet) {
      const where =
        foldedStreet === "preflop"
          ? "folded before Flop"
          : `folded on the ${capitalize(foldedStreet)}`;
      // "(didn't bet)" means the seat never put a chip in voluntarily; a blind
      // is not a voluntary bet, which is the tracker definition.
      const voluntary = draft.actions.some(
        (action) =>
          action.player === seat.name &&
          (action.kind === "call" || action.kind === "bet" || action.kind === "raise"),
      );
      const revealed = shown ?? mucked;
      const cards =
        revealed && revealed.cards.length > 0 ? `, mucked [${revealed.cards.join(" ")}]` : "";
      lines.push(`${head} ${where}${voluntary ? "" : " (didn't bet)"}${cards}`);
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
    if (mucked && mucked.cards.length > 0) {
      lines.push(`${head} mucked [${mucked.cards.join(" ")}]`);
      continue;
    }
    if (won > 0) {
      lines.push(`${head} collected (${money(won, unit, decimals)})`);
      continue;
    }
    lines.push(`${head} mucked`);
  }

  return lines.join("\n");
}

function uncalledLine(settlement: Settlement, unit: CurrencyUnit, decimals: DecimalStyle): string {
  const uncalled = settlement.uncalled!;
  return `Uncalled bet (${money(uncalled.amount, unit, decimals)}) returned to ${uncalled.player}`;
}

/**
 * Draft in, PHF out.
 *
 * `meta.rawText` is deliberately reset to the *site's* text: the normalized
 * standard text is an implementation detail, and a later bug fix has to be able
 * to re-convert from the original.
 */
export function buildP6Hand(draft: P6Draft, ctx: SiteParserContext): PhfHand {
  const dealtIn = draft.seats.filter((seat) => seat.dealtIn);
  if (dealtIn.length < 2) {
    throw new ParseSkip(
      "too-few-players",
      "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
    );
  }
  if (draft.collected.length === 0) {
    throw new ParseSkip("no-winner", "The hand does not say who collected the pot.");
  }

  const text = p6ToStandardText(draft);
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

  // `isHero` is deliberately *not* restated here. Standard text can only say
  // "this seat is the hero" by printing its hole cards or by naming it `Hero`,
  // so a hero whose cards were never shown - a real case on both rooms, where
  // the export was taken from an observed table - cannot survive
  // `toStandardText` -> `parseStandardHand`. Setting the flag anyway would make
  // this parser's output fail its own round-trip test, which is a worse trade
  // than a hand with no hero marked. See the report for the format gap.
  hand.meta.rawText = draft.rawText;
  hand.meta.warnings = [...draft.warnings, ...hand.meta.warnings];
  hand.meta.handKey = hand.meta.handId;
  return hand;
}
