/**
 * Shared draft -> PHF builder for the PartyGaming-lineage rooms and iPoker.
 *
 * 888poker, partypoker and the iPoker network all state a hand as "who put how
 * much in, and who took how much out". None of them prints a pot total, a rake
 * line, or an `Uncalled bet ... returned to` line, and only iPoker states a
 * starting stack that is unambiguous. Every one of those has to be reconstructed
 * before the hand can be trusted, and reconstructing it three times in three
 * files is how the three copies drift apart.
 *
 * So each site parser reads its own dialect into a `HandDraft` - seats, an
 * ordered action list with *chips added* per action, the board, and whatever the
 * site says each player collected - and this module does the rest:
 *
 *   1. replays the betting to get per-street commitments, which is what turns a
 *      partypoker `raises [$0.70]` (chips added) into a standard `raises $0.45
 *      to $0.80` (street total),
 *   2. derives the uncalled return, because none of these rooms prints one,
 *   3. derives the pot and the rake from the contributions and the reported
 *      winnings, and refuses the hand when the two cannot be reconciled,
 *   4. emits GG-style standard text and hands it to `parseStandardHand`.
 *
 * Step 4 is the same route `parsers/weplay.ts` takes, and for the same reason:
 * the summary block, the position ring, the results object and the text round
 * trip are all implemented once, in `phf/serialize.ts`, and a new room should
 * not reimplement any of them.
 */

import {
  ParseSkip,
  type SiteParserContext,
} from "../../phf/detect";
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
export type DraftStreet = "preflop" | "flop" | "turn" | "river";

export const DRAFT_STREETS: DraftStreet[] = ["preflop", "flop", "turn", "river"];

export interface DraftSeat {
  seat: number;
  name: string;
  startingStack: Amount;
  /**
   * The seat took part in this hand.
   *
   * Seats that were sitting out are dropped rather than carried as players with
   * `sittingOut: true`: `resolvePositions` numbers the ring from *every* seat it
   * is given, so keeping a sat-out seat silently shifts everybody else's
   * position by one. A wrong `CO` is worse than a missing observer, and the
   * seat is still in `meta.rawText`.
   */
  dealtIn: boolean;
  isHero: boolean;
  /** Cards the source showed at deal time; normally the hero's only. */
  dealtCards: string[];
}

export type DraftKind =
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
  | "show"
  | "muck";

export interface DraftAction {
  street: DraftStreet;
  player: string;
  kind: DraftKind;
  /**
   * Chips this action adds to the pot, counting toward the current street bet.
   * Every one of these rooms states increments, never "to" totals, so the draft
   * does too.
   */
  amount?: Amount;
  /**
   * `amount` is the actor's total for the street, not the increment.
   *
   * iPoker is the odd one out: its raise action (`type="23"`) states the "to"
   * number while its call and all-in actions state the increment, in the same
   * hand. Converting here rather than in the site parser keeps the betting
   * state in one place.
   */
  toTotal?: boolean;
  /**
   * Chips added alongside `amount` that do *not* count toward the street bet:
   * partypoker's `posts big blind + dead [$3]` and 888's `posts dead blind
   * [$1 + $2]` are a live blind plus dead money that nobody has to match.
   */
  dead?: Amount;
  /** The source flagged the action as all-in. */
  allIn?: boolean;
  /** Cards a `show` / `muck` revealed. */
  cards?: string[];
  /** Showdown hand description, e.g. "two pairs, Jacks and Fours". */
  description?: string;
}

export interface DraftCollect {
  player: string;
  amount: Amount;
  /** "pot" | "main pot" | "side pot", as the source named it. */
  potName?: string;
}

export interface HandDraft {
  siteId: string;
  siteName: string;
  parserId: string;
  parserVersion: string;
  /**
   * Prefix put in front of the site's own hand number.
   *
   * `meta.handKey` is the dedupe key and these rooms share a numbering lineage -
   * the partypoker corpus alone contains two different hands with the id
   * `1458965856` - so an unprefixed number is not unique across sites.
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
  /** ISO 8601 UTC, or null when the source omits a usable timestamp. */
  playedAt: string | null;
  seats: DraftSeat[];
  actions: DraftAction[];
  flop: string[] | null;
  turn: string | null;
  river: string | null;
  collected: DraftCollect[];
  /**
   * Whether the amounts in `collected` already contain the winner's own
   * uncalled bet.
   *
   * partypoker and iPoker never return an uncalled bet; they leave it in the pot
   * and hand it back as part of "wins", so a $1 bet that nobody called shows up
   * inside the winner's total. 888poker deducts it first. Getting this backwards
   * inflates or deflates the rake by the whole uncalled amount.
   */
  collectedIncludesUncalled: boolean;
  rawText: string;
  warnings: PhfWarning[];
}

/* ------------------------------------------------------------ betting state - */

interface StreetState {
  street: DraftStreet;
  /** Live commitment per player on this street; dead money is excluded. */
  commit: Map<string, Amount>;
  /** Highest live commitment so far, i.e. the amount a caller has to match. */
  bet: Amount;
}

/** Live street totals for every street that saw money, oldest first. */
interface Replay {
  lines: Map<DraftStreet, string[]>;
  /** Per street, the live commitment each player ended with. */
  totals: Map<DraftStreet, Map<string, Amount>>;
  /** Everything every player put in, dead money included. */
  gross: Amount;
  contributed: Map<string, Amount>;
  folded: Map<string, DraftStreet>;
  smallBlind: Amount;
  bigBlind: Amount;
  blindPosters: { small: string | null; big: string | null };
  shows: Array<{ street: DraftStreet; player: string; cards: string[]; description?: string }>;
  mucks: Array<{ street: DraftStreet; player: string; cards: string[] }>;
}

function money(amount: Amount, unit: CurrencyUnit, decimals: DecimalStyle): string {
  return formatAmount(amount, unit, decimals);
}

/**
 * Replays the draft's action list into standard-text lines.
 *
 * The only genuinely tricky part is `raises`: the standard text prints both the
 * amount over the current bet and the resulting street total, and the source
 * gives neither - it gives the chips the player pushed. Both numbers therefore
 * have to come from the betting state, which is why this is a replay and not a
 * line-by-line rewrite.
 */
function replayActions(draft: HandDraft): Replay {
  const { unit, decimals } = draft;
  const lines = new Map<DraftStreet, string[]>();
  const totals = new Map<DraftStreet, Map<string, Amount>>();
  const contributed = new Map<string, Amount>();
  const folded = new Map<string, DraftStreet>();
  const shows: Replay["shows"] = [];
  const mucks: Replay["mucks"] = [];
  let gross = 0;
  let smallBlind = 0;
  let bigBlind = 0;
  const blindPosters: Replay["blindPosters"] = { small: null, big: null };

  for (const street of DRAFT_STREETS) {
    lines.set(street, []);
    totals.set(street, new Map());
  }

  let state: StreetState = { street: "preflop", commit: new Map(), bet: 0 };

  const put = (player: string, live: Amount, dead: Amount): Amount => {
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
    // Reveals are collected above so that they cannot close a betting street:
    // a showdown reveal is tagged with the street it happened on, which for an
    // all-in run-out is an earlier street than the last one that saw money.
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
        // Dead money rides on the same source line; the standard text has no
        // "+ dead" form, so it is re-emitted as a separate missed blind. It goes
        // first because `toStandardText` groups blinds and missed blinds ahead
        // of the deal but leaves a bare `posts` in the body, and emitting the
        // two the other way round would reorder the stream on a round trip.
        if (dead > 0) {
          out.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);
        }
        put(action.player, amount, dead);
        out.push(`${action.player}: posts big blind ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "post":
      case "straddle": {
        if (dead > 0) {
          out.push(`${action.player}: posts missed blind ${money(dead, unit, decimals)}`);
        }
        put(action.player, amount, dead);
        out.push(`${action.player}: posts ${money(amount, unit, decimals)}${allIn}`);
        break;
      }
      case "fold":
        folded.set(action.player, action.street);
        out.push(`${action.player}: folds`);
        break;
      case "check":
        out.push(`${action.player}: checks`);
        break;
      case "call":
        put(action.player, amount, dead);
        out.push(`${action.player}: calls ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "bet":
        put(action.player, amount, dead);
        out.push(`${action.player}: bets ${money(amount, unit, decimals)}${allIn}`);
        break;
      case "raise":
      case "allin": {
        // partypoker writes `is all-In [$4.90]` for a call, a bet and a raise
        // alike, and iPoker's raise code covers an opening bet, so which of the
        // three it was only follows from the betting state.
        const over = state.bet;
        const to = put(action.player, amount, dead);
        const flag = action.kind === "allin" ? " and is all-in" : allIn;
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
 * The uncalled bet none of these rooms prints.
 *
 * On the last street that saw money, whoever committed more than anybody else
 * gets the difference back. A tie means everybody was matched and nothing is
 * returned; a walk to the big blind is the same rule, which is why the big
 * blind gets its excess over the small blind back exactly as PokerStars writes
 * it.
 */
function deriveUncalled(
  replay: Replay,
): { player: string; amount: Amount; street: DraftStreet } | null {
  for (let i = DRAFT_STREETS.length - 1; i >= 0; i -= 1) {
    const street = DRAFT_STREETS[i];
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
  uncalled: { player: string; amount: Amount; street: DraftStreet } | null;
  collected: DraftCollect[];
  totalPot: Amount;
  rake: Amount;
}

/**
 * Reconciles the contributions with what the site says was won.
 *
 * Two readings are possible and the rooms disagree on which one they use, so
 * both are tried and the one that produces a non-negative rake wins. When
 * neither does, the source contradicts itself and the hand is refused rather
 * than stored with an invented pot.
 */
function settle(draft: HandDraft, replay: Replay): Settlement {
  const uncalled = deriveUncalled(replay);
  const reported = draft.collected.reduce((sum, entry) => sum + entry.amount, 0);

  const withReturn = (): Settlement | null => {
    if (!uncalled) {
      return null;
    }
    const entries = draft.collected.map((entry) => ({ ...entry }));
    let remaining = uncalled.amount;
    if (draft.collectedIncludesUncalled) {
      // partypoker prints the uncalled portion as a pot of its own ("wins $1.87
      // from the side pot 1"), so a line that matches it exactly *is* the
      // return and comes out whole; otherwise it is spread across the winner's
      // pots and has to be taken off them in order.
      const exact = entries.findIndex(
        (entry) => entry.player === uncalled.player && entry.amount === remaining,
      );
      if (exact >= 0) {
        entries.splice(exact, 1);
        remaining = 0;
      } else {
        for (const entry of entries) {
          if (entry.player !== uncalled.player || remaining === 0) {
            continue;
          }
          const take = Math.min(remaining, entry.amount);
          entry.amount -= take;
          remaining -= take;
        }
      }
      if (remaining > 0) {
        return null;
      }
    }
    const kept = entries.filter((entry) => entry.amount > 0);
    const totalPot = replay.gross - uncalled.amount;
    const rake = totalPot - kept.reduce((sum, entry) => sum + entry.amount, 0);
    return rake < 0 ? null : { uncalled, collected: kept, totalPot, rake };
  };

  const withoutReturn = (): Settlement | null => {
    const kept = draft.collected.filter((entry) => entry.amount > 0);
    const rake = replay.gross - reported;
    return rake < 0 ? null : { uncalled: null, collected: kept, totalPot: replay.gross, rake };
  };

  // The reading with the return is tried first for every room. For 888poker it
  // is simply the right one; for the other two `withReturn` already subtracts
  // the return from the reported winnings, so it is the right one there too.
  // `withoutReturn` is the fallback for the one case where a room hands the
  // whole pot to an unmatched blind: 888poker's walk to the big blind, where
  // `collected` is the small blind plus the big blind and nothing came back.
  for (const candidate of [withReturn(), withoutReturn()]) {
    if (candidate) {
      return candidate;
    }
  }

  throw new ParseSkip(
    "inconsistent-pot",
    `Players put in ${replay.gross} but the hand reports ${reported} collected, ` +
      "which cannot be reconciled with or without an uncalled return.",
  );
}

/* ------------------------------------------------------------------ summary - */

function positionLabelsFor(
  seat: number,
  seats: DraftSeat[],
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

/* -------------------------------------------------------------------- build - */

/** Renders `draft` as standard text. Exported for tests and for debugging. */
export function draftToStandardText(draft: HandDraft): string {
  const { unit, decimals } = draft;
  const replay = replayActions(draft);
  const settlement = settle(draft, replay);
  const seats = draft.seats.filter((seat) => seat.dealtIn).sort((a, b) => a.seat - b.seat);

  const smallBlind = replay.smallBlind || draft.headerSmallBlind;
  const bigBlind = replay.bigBlind || draft.headerBigBlind;
  const stakes = `${money(smallBlind, unit, decimals)}/${money(bigBlind, unit, decimals)}`;
  const date = draft.playedAt ? formatHeaderDate(draft.playedAt) : "";

  const lines: string[] = [];
  lines.push(`Poker Hand #${draft.handPrefix}${draft.handId}: ${draft.gameLabel} (${stakes}) - ${date}`);
  lines.push(
    `Table '${draft.tableName ?? ""}' ${draft.maxSeats}-max` +
      (draft.buttonSeat === null ? "" : ` Seat #${draft.buttonSeat} is the button`),
  );
  for (const seat of seats) {
    lines.push(`Seat ${seat.seat}: ${seat.name} (${money(seat.startingStack, unit, decimals)} in chips)`);
  }

  // Posting lines have to come before `*** HOLE CARDS ***`; everything else on
  // the preflop street comes after it.
  const preflop = replay.lines.get("preflop") ?? [];
  const postingCount = preflop.findIndex((line) => !/: posts /.test(line));
  const postings = postingCount < 0 ? preflop : preflop.slice(0, postingCount);
  const preflopBody = postingCount < 0 ? [] : preflop.slice(postingCount);
  lines.push(...postings);

  lines.push("*** HOLE CARDS ***");
  for (const seat of seats) {
    if (seat.dealtCards.length > 0) {
      lines.push(`Dealt to ${seat.name} [${seat.dealtCards.join(" ")}]`);
    }
  }
  lines.push(...preflopBody);
  if (settlement.uncalled?.street === "preflop") {
    lines.push(uncalledLine(settlement, unit, decimals));
  }

  const board = [...(draft.flop ?? []), ...(draft.turn ? [draft.turn] : []), ...(draft.river ? [draft.river] : [])];
  const emitStreet = (street: Exclude<DraftStreet, "preflop">, marker: string) => {
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
        foldedStreet === "preflop" ? "folded before Flop" : `folded on the ${capitalize(foldedStreet)}`;
      // "(didn't bet)" means the seat never put a chip in voluntarily; a blind
      // is not a voluntary bet, which is exactly the tracker definition.
      const voluntary = draft.actions.some(
        (action) =>
          action.player === seat.name &&
          (action.kind === "call" ||
            action.kind === "bet" ||
            action.kind === "raise" ||
            action.kind === "allin"),
      );
      // A seat that folded and still had its cards printed keeps them: the
      // clause goes after the fold so that the outcome still reads as a fold,
      // and `parseStandardHand` picks the cards up from the `mucked [...]`.
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

function uncalledLine(
  settlement: Settlement,
  unit: CurrencyUnit,
  decimals: DecimalStyle,
): string {
  const uncalled = settlement.uncalled!;
  return `Uncalled bet (${money(uncalled.amount, unit, decimals)}) returned to ${uncalled.player}`;
}

/** `2014-01-06T22:40:28.000Z` -> `2014/01/06 22:40:28`. */
export function formatHeaderDate(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Draft in, PHF out.
 *
 * `meta.rawText` is deliberately reset to the *site's* text: the normalized
 * standard text is an implementation detail, and a later bug fix has to be able
 * to re-convert from the original.
 */
export function buildHand(draft: HandDraft, ctx: SiteParserContext): PhfHand {
  if (draft.seats.filter((seat) => seat.dealtIn).length < 2) {
    throw new ParseSkip(
      "too-few-players",
      "Fewer than two seats were dealt in, so the hand cannot be reconstructed.",
    );
  }

  const text = draftToStandardText(draft);
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

  hand.meta.rawText = draft.rawText;
  hand.meta.warnings = [...draft.warnings, ...hand.meta.warnings];
  hand.meta.handKey = hand.meta.handId;
  return hand;
}
