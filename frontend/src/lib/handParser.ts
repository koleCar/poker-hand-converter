import { extractCards, handClass } from "./cards";

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export const STREET_ORDER: Street[] = ["preflop", "flop", "turn", "river", "showdown"];

export type ActionType =
  | "ante"
  | "small-blind"
  | "big-blind"
  | "straddle"
  | "fold"
  | "check"
  | "call"
  | "bet"
  | "raise"
  | "uncalled"
  | "show"
  | "muck"
  | "collect";

export interface HandSeat {
  seatNo: number;
  name: string;
  stack: number;
  isHero: boolean;
  isButton: boolean;
  /** Hole cards when known (dealt to hero, or shown at showdown). */
  cards: string[];
  /** Filled from the SUMMARY block, e.g. "(small blind)". */
  positionLabel: string | null;
}

export interface HandAction {
  index: number;
  street: Street;
  player: string;
  type: ActionType;
  /** Chips this action moves into the pot (negative for an uncalled return). */
  amount: number;
  /** For bet/raise: the total street commitment the player is now at. */
  toAmount?: number;
  allIn: boolean;
  cards?: string[];
  /** Showdown hand description, e.g. "a pair of Aces". */
  description?: string;
  /** Human readable action label used by the replayer. */
  label: string;
  rawLine: string;
}

export interface ParsedHand {
  handId: string;
  handKey: string;
  gameLabel: string;
  gameType: "cash" | "tournament";
  currency: string;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  playedAt: string | null;
  tableName: string | null;
  maxSeats: number;
  buttonSeat: number | null;
  seats: HandSeat[];
  heroName: string | null;
  actions: HandAction[];
  /** Primary runout, up to five cards. */
  board: string[];
  /** Second runout when the hand was run twice. */
  boardSecond: string[];
  totalPot: number;
  rake: number;
  winners: Array<{ player: string; amount: number }>;
  /** Total chips each player put in, net of uncalled returns. */
  invested: Record<string, number>;
  /** GG "EV Cashout" entries; settled outside the pot. */
  cashouts: Array<{ player: string; risk: number }>;
  heroProfit: number | null;
  streetReached: Street;
  wentToShowdown: boolean;
  summaryLines: string[];
  rawText: string;
  warnings: string[];
}

const HEADER_REGEX =
  /^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#([A-Za-z0-9-]+):\s*(.*)$/i;
const TABLE_REGEX = /^Table\s+'?([^']*?)'?\s+(\d+)-max(?:\s+Seat\s+#(\d+)\s+is the button)?/i;
const SEAT_REGEX = /^Seat\s+(\d+):\s+(.+?)\s+\((?:\$|€|£)?([\d,]+(?:\.\d+)?)\s+in chips\)/;
const SUMMARY_SEAT_REGEX = /^Seat\s+(\d+):\s+(.+?)\s+(\((?:button|small blind|big blind)\))/i;
const MONEY = String.raw`(?:\$|€|£)?([\d,]+(?:\.\d+)?)`;

function num(raw: string | undefined): number {
  if (!raw) {
    return 0;
  }
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : 0;
}

/** Works in cents to keep sums free of float drift. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function detectCurrency(header: string): string {
  if (header.includes("€")) return "€";
  if (header.includes("£")) return "£";
  return "$";
}

function parsePlayedAt(payload: string): string | null {
  const match = payload.match(/(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = match;
  // Hand histories are written in UTC.
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).toISOString();
}

function streetFromMarker(line: string): Street | null {
  if (/^\*\*\*\s*(?:FIRST\s+|SECOND\s+)?FLOP\b/i.test(line)) return "flop";
  if (/^\*\*\*\s*(?:FIRST\s+|SECOND\s+)?TURN\b/i.test(line)) return "turn";
  if (/^\*\*\*\s*(?:FIRST\s+|SECOND\s+)?RIVER\b/i.test(line)) return "river";
  if (/^\*\*\*\s*(?:FIRST\s+|SECOND\s+)?SHOW\s?DOWN\b/i.test(line)) return "showdown";
  return null;
}

function money(currency: string, amount: number): string {
  const text = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return `${currency}${text}`;
}

/** Splits a multi-hand file into individual hand chunks. */
export function splitHands(text: string): string[] {
  return text
    .split(/(?=^(?:Poker|Weplay|PokerStars|GG)\s+Hand\s+#)/im)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && HEADER_REGEX.test(chunk.split(/\r?\n/)[0] ?? ""));
}

export function looksLikeHandHistory(text: string): boolean {
  return splitHands(text).length > 0;
}

export function isGgFormat(text: string): boolean {
  return /^Poker\s+Hand\s+#/im.test(text);
}

export function isWeplayFormat(text: string): boolean {
  return /^Weplay\s+Hand\s+#/im.test(text);
}

export function parseHand(text: string): ParsedHand | null {
  const rawText = text.trim();
  const lines = rawText.split(/\r?\n/);
  const headerMatch = lines[0]?.match(HEADER_REGEX);
  if (!headerMatch) {
    return null;
  }

  const warnings: string[] = [];
  const handId = headerMatch[1];
  const payload = headerMatch[2];
  const currency = detectCurrency(payload);
  const gameLabel = payload.split(" - ")[0]?.trim() ?? payload;
  const gameType: "cash" | "tournament" = /Tournament/i.test(payload) ? "tournament" : "cash";

  const stakesMatch = payload.match(
    new RegExp(String.raw`\(${MONEY}\s*/\s*${MONEY}(?:\s*/\s*${MONEY})?\)`),
  );
  const smallBlind = num(stakesMatch?.[1]);
  const bigBlind = num(stakesMatch?.[2]);

  const seats: HandSeat[] = [];
  const seatByName = new Map<string, HandSeat>();
  let tableName: string | null = null;
  let maxSeats = 0;
  let buttonSeat: number | null = null;

  const actions: HandAction[] = [];
  const board: string[] = [];
  const boardSecond: string[] = [];
  const summaryLines: string[] = [];
  const winners: Array<{ player: string; amount: number }> = [];
  const invested: Record<string, number> = {};
  const cashouts: Array<{ player: string; risk: number }> = [];

  let street: Street = "preflop";
  let inSummary = false;
  let totalPot = 0;
  let rake = 0;
  let ante = 0;
  let heroName: string | null = null;
  let sawShowdownMarker = false;

  // Per-street commitment, needed to turn "raises X to Y" into chips added.
  let streetCommit = new Map<string, number>();
  const folded = new Set<string>();

  function addInvested(player: string, amount: number) {
    invested[player] = round2((invested[player] ?? 0) + amount);
  }

  function push(action: Omit<HandAction, "index">) {
    actions.push({ ...action, index: actions.length });
  }

  function ensureSeat(name: string): HandSeat | undefined {
    return seatByName.get(name);
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^\*\*\*\s*SUMMARY/i.test(trimmed)) {
      inSummary = true;
      continue;
    }

    if (inSummary) {
      summaryLines.push(trimmed);

      const potMatch = trimmed.match(new RegExp(String.raw`^Total pot ${MONEY}`));
      if (potMatch) {
        totalPot = num(potMatch[1]);
        const rakeMatch = trimmed.match(new RegExp(String.raw`Rake ${MONEY}`));
        rake = num(rakeMatch?.[1]);
        continue;
      }

      const boardMatch = trimmed.match(/^Board\s*\[([^\]]*)\]/i);
      if (boardMatch && board.length === 0) {
        board.push(...extractCards(boardMatch[1]));
        continue;
      }

      const summarySeat = trimmed.match(SUMMARY_SEAT_REGEX);
      if (summarySeat) {
        const seat = seats.find((entry) => entry.seatNo === Number(summarySeat[1]));
        if (seat) {
          seat.positionLabel = summarySeat[3];
        }
      }

      // Late card reveal, e.g. "Seat 4: Hero showed [Ah Kd] and won ($12)".
      const showedMatch = trimmed.match(/^Seat\s+\d+:\s+(.+?)\s+(?:showed|mucked)\s+\[([^\]]+)\]/i);
      if (showedMatch) {
        const seat = ensureSeat(showedMatch[1]);
        const cards = extractCards(showedMatch[2]);
        if (seat && seat.cards.length === 0 && cards.length > 0) {
          seat.cards = cards;
        }
      }
      continue;
    }

    const tableMatch = trimmed.match(TABLE_REGEX);
    if (tableMatch) {
      tableName = tableMatch[1] || null;
      maxSeats = Number(tableMatch[2]) || 0;
      buttonSeat = tableMatch[3] ? Number(tableMatch[3]) : null;
      continue;
    }

    const seatMatch = trimmed.match(SEAT_REGEX);
    if (seatMatch) {
      const name = seatMatch[2];
      const seat: HandSeat = {
        seatNo: Number(seatMatch[1]),
        name,
        stack: num(seatMatch[3]),
        isHero: name === "Hero",
        isButton: false,
        cards: [],
        positionLabel: null,
      };
      seats.push(seat);
      seatByName.set(name, seat);
      if (seat.isHero) {
        heroName = name;
      }
      continue;
    }

    const marker = streetFromMarker(trimmed);
    if (marker) {
      const isSecondRun = /^\*\*\*\s*SECOND\b/i.test(trimmed);
      const cards = [...trimmed.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => extractCards(m[1]));
      const target = isSecondRun ? boardSecond : board;

      if (marker === "flop") {
        target.length = 0;
        target.push(...cards.slice(0, 3));
      } else if (marker === "turn" || marker === "river") {
        // Markers repeat the earlier streets, so the full list is authoritative.
        if (cards.length >= target.length) {
          target.length = 0;
          target.push(...cards);
        } else {
          target.push(...cards.slice(-1));
        }
      } else {
        sawShowdownMarker = true;
      }

      if (!isSecondRun) {
        street = marker;
        streetCommit = new Map();
      }
      continue;
    }

    if (/^\*\*\*\s*HOLE CARDS/i.test(trimmed)) {
      continue;
    }

    const dealtMatch = trimmed.match(/^Dealt to\s+(.+?)(?:\s+\[([^\]]*)\])?\s*$/);
    if (dealtMatch) {
      const seat = ensureSeat(dealtMatch[1].trim());
      const cards = dealtMatch[2] ? extractCards(dealtMatch[2]) : [];
      if (seat && cards.length > 0) {
        seat.cards = cards;
        // Some sites label the observer seat differently from "Hero".
        if (!heroName) {
          heroName = seat.name;
          seat.isHero = true;
        }
      }
      continue;
    }

    const uncalledMatch = trimmed.match(
      new RegExp(String.raw`^Uncalled bet \(${MONEY}\) returned to (.+)$`),
    );
    if (uncalledMatch) {
      const amount = num(uncalledMatch[1]);
      const player = uncalledMatch[2].trim();
      addInvested(player, -amount);
      streetCommit.set(player, round2((streetCommit.get(player) ?? 0) - amount));
      push({
        street,
        player,
        type: "uncalled",
        amount: -amount,
        allIn: false,
        label: `uncalled ${money(currency, amount)} returned`,
        rawLine: trimmed,
      });
      continue;
    }

    const collectedMatch = trimmed.match(
      new RegExp(String.raw`^(.+?) collected ${MONEY} from (?:the )?(\w+ )?pot`),
    );
    if (collectedMatch) {
      const player = collectedMatch[1].trim();
      const amount = num(collectedMatch[2]);
      const existing = winners.find((entry) => entry.player === player);
      if (existing) {
        existing.amount = round2(existing.amount + amount);
      } else {
        winners.push({ player, amount });
      }
      push({
        street: "showdown",
        player,
        type: "collect",
        amount,
        allIn: false,
        label: `wins ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const anteMatch = trimmed.match(new RegExp(String.raw`^(.+?): posts the ante ${MONEY}`));
    if (anteMatch) {
      const player = anteMatch[1];
      const amount = num(anteMatch[2]);
      ante = Math.max(ante, amount);
      addInvested(player, amount);
      push({
        street: "preflop",
        player,
        type: "ante",
        amount,
        allIn: /and is all-in/i.test(trimmed),
        label: `ante ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const blindMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts (small|big) blind ${MONEY}( and is all-in)?`),
    );
    if (blindMatch) {
      const player = blindMatch[1];
      const amount = num(blindMatch[3]);
      addInvested(player, amount);
      streetCommit.set(player, round2((streetCommit.get(player) ?? 0) + amount));
      push({
        street: "preflop",
        player,
        type: blindMatch[2].toLowerCase() === "small" ? "small-blind" : "big-blind",
        amount,
        toAmount: streetCommit.get(player),
        allIn: Boolean(blindMatch[4]),
        label: `${blindMatch[2].toLowerCase()} blind ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    // Dead money: the player owes a blind they sat out for. It goes straight to
    // the pot and does not count toward the current street's bet.
    const missedBlindMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts missed blind ${MONEY}`),
    );
    if (missedBlindMatch) {
      const player = missedBlindMatch[1];
      const amount = num(missedBlindMatch[2]);
      addInvested(player, amount);
      push({
        street: "preflop",
        player,
        type: "ante",
        amount,
        allIn: false,
        label: `missed blind ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    // GG "EV Cashout": settled outside the pot, so it must not change any math.
    const cashoutMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): (?:Chooses to EV Cashout|Pays Cashout Risk \(${MONEY}\))`),
    );
    if (cashoutMatch) {
      const amount = num(cashoutMatch[2]);
      cashouts.push({ player: cashoutMatch[1], risk: amount });
      continue;
    }

    const postMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): posts ${MONEY}( and is all-in)?$`),
    );
    if (postMatch) {
      const player = postMatch[1];
      const amount = num(postMatch[2]);
      addInvested(player, amount);
      streetCommit.set(player, round2((streetCommit.get(player) ?? 0) + amount));
      push({
        street,
        player,
        type: "straddle",
        amount,
        toAmount: streetCommit.get(player),
        allIn: Boolean(postMatch[3]),
        label: `posts ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const foldMatch = trimmed.match(/^(.+?): folds$/);
    if (foldMatch) {
      folded.add(foldMatch[1]);
      push({
        street,
        player: foldMatch[1],
        type: "fold",
        amount: 0,
        allIn: false,
        label: "folds",
        rawLine: trimmed,
      });
      continue;
    }

    const checkMatch = trimmed.match(/^(.+?): checks$/);
    if (checkMatch) {
      push({
        street,
        player: checkMatch[1],
        type: "check",
        amount: 0,
        allIn: false,
        label: "checks",
        rawLine: trimmed,
      });
      continue;
    }

    const callMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): calls ${MONEY}( and is all-in)?$`),
    );
    if (callMatch) {
      const player = callMatch[1];
      const amount = num(callMatch[2]);
      addInvested(player, amount);
      streetCommit.set(player, round2((streetCommit.get(player) ?? 0) + amount));
      push({
        street,
        player,
        type: "call",
        amount,
        toAmount: streetCommit.get(player),
        allIn: Boolean(callMatch[3]),
        label: `calls ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const betMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): bets ${MONEY}( and is all-in)?$`),
    );
    if (betMatch) {
      const player = betMatch[1];
      const amount = num(betMatch[2]);
      addInvested(player, amount);
      streetCommit.set(player, round2((streetCommit.get(player) ?? 0) + amount));
      push({
        street,
        player,
        type: "bet",
        amount,
        toAmount: streetCommit.get(player),
        allIn: Boolean(betMatch[3]),
        label: `bets ${money(currency, amount)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const raiseMatch = trimmed.match(
      new RegExp(String.raw`^(.+?): raises ${MONEY} to ${MONEY}( and is all-in)?$`),
    );
    if (raiseMatch) {
      const player = raiseMatch[1];
      const to = num(raiseMatch[3]);
      const already = streetCommit.get(player) ?? 0;
      const added = round2(to - already);
      addInvested(player, added);
      streetCommit.set(player, to);
      push({
        street,
        player,
        type: "raise",
        amount: added,
        toAmount: to,
        allIn: Boolean(raiseMatch[4]),
        label: `raises to ${money(currency, to)}`,
        rawLine: trimmed,
      });
      continue;
    }

    const showsMatch = trimmed.match(/^(.+?): shows \[([^\]]*)\](?:\s*\((.+)\))?/);
    if (showsMatch) {
      const player = showsMatch[1];
      const cards = extractCards(showsMatch[2]);
      const seat = ensureSeat(player);
      if (seat && cards.length > 0) {
        seat.cards = cards;
      }
      push({
        street: "showdown",
        player,
        type: "show",
        amount: 0,
        allIn: false,
        cards,
        description: showsMatch[3],
        label: cards.length ? `shows ${cards.join(" ")}` : "shows",
        rawLine: trimmed,
      });
      sawShowdownMarker = true;
      continue;
    }

    const muckMatch = trimmed.match(/^(.+?): (?:mucks hand|doesn't show hand)$/i);
    if (muckMatch) {
      push({
        street: "showdown",
        player: muckMatch[1],
        type: "muck",
        amount: 0,
        allIn: false,
        label: "mucks",
        rawLine: trimmed,
      });
      continue;
    }

    // Table chatter that carries no pot or card information.
    if (
      /\b(?:joins the table|leaves the table|sits out|has timed out|is (?:dis)?connected|declines straddle|was run two times|said,)\b/i.test(
        trimmed,
      )
    ) {
      continue;
    }

    warnings.push(`Nepoznata linija: ${trimmed}`);
  }

  if (seats.length === 0) {
    return null;
  }

  if (buttonSeat !== null) {
    const seat = seats.find((entry) => entry.seatNo === buttonSeat);
    if (seat) {
      seat.isButton = true;
    }
  }
  if (!maxSeats) {
    maxSeats = Math.max(seats.length, ...seats.map((seat) => seat.seatNo));
  }

  if (totalPot === 0) {
    totalPot = round2(Object.values(invested).reduce((sum, value) => sum + value, 0));
  }

  const streetReached: Street = (() => {
    if (board.length >= 5) return "river";
    if (board.length === 4) return "turn";
    if (board.length === 3) return "flop";
    return "preflop";
  })();

  const contenders = seats.filter((seat) => !folded.has(seat.name));
  const wentToShowdown = sawShowdownMarker && contenders.length >= 2;

  const heroProfit =
    heroName === null
      ? null
      : round2(
          (winners.find((entry) => entry.player === heroName)?.amount ?? 0) -
            (invested[heroName] ?? 0),
        );

  return {
    handId,
    handKey: handId,
    gameLabel,
    gameType,
    currency,
    smallBlind,
    bigBlind,
    ante,
    playedAt: parsePlayedAt(payload),
    tableName,
    maxSeats,
    buttonSeat,
    seats,
    heroName,
    actions,
    board,
    boardSecond,
    totalPot,
    rake,
    winners,
    invested,
    cashouts,
    heroProfit,
    streetReached: wentToShowdown ? "showdown" : streetReached,
    wentToShowdown,
    summaryLines,
    rawText,
    warnings,
  };
}

export function heroHandClass(hand: ParsedHand): string | null {
  const hero = hand.seats.find((seat) => seat.isHero);
  return hero ? handClass(hero.cards) : null;
}

export function heroCards(hand: ParsedHand): string[] {
  return hand.seats.find((seat) => seat.isHero)?.cards ?? [];
}
