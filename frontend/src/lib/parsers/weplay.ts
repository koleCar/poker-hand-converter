/**
 * WePlay parser.
 *
 * The normalization in this file is a direct port of the old
 * `frontend/src/lib/converter.ts`. It is deliberately *not* a rewrite: every
 * branch below exists because of a real broken hand in `weplay-hh/`, and every
 * one of them has a fixture in `backend/test/fixtures/weplay/`. Ghost antes,
 * phantom river walks, zero-stack actors, short covering all-ins written as
 * raises, hidden `##` showdown cards - all of it is load bearing.
 *
 * What changed is where the output goes. WePlay text is normalized into
 * standard text exactly as before, and that text is then parsed into PHF by
 * `parseStandardHand`. The old pipeline stopped at the text; this one continues
 * to a typed object, and `toStandardText` reproduces the same bytes.
 */

import {
  ParseSkip,
  type SiteParser,
  type SiteParserContext,
} from "../phf/detect";
import { parseStandardHand } from "../phf/serialize";
import type { PhfHand } from "../phf/types";

export const WEPLAY_PARSER_VERSION = "2.0.0";

const HAND_SPLIT_REGEX = /(?=^Weplay Hand #\d+:)/gm;
const AMOUNT = String.raw`(?:\$|€|£)?(\d+(?:\.\d+)?)`;
const RAISE_LINE_REGEX = new RegExp(
  String.raw`^(.+?): raises ${AMOUNT} to ${AMOUNT}( and is all-in)?$`,
);
const STREET_MARKER_REGEX = /^\*\*\* (?:FIRST |SECOND )?(?:FLOP|TURN|RIVER)\b/;
const SHOWS_HIDDEN_REGEX = /^(.+?): shows \[.*#.*\].*$/;
const SEAT_LINE_REGEX = /^Seat\s+\d+:\s+(.+?)\s+\((.+) in chips\)$/;
const PLAYER_ACTION_REGEX =
  /^(.+?): (?:posts|raises|calls|bets|folds|checks|shows|mucks|doesn't show)/;
const COLLECTED_REGEX = /^(.+?) collected /;
const UNCALLED_REGEX = new RegExp(String.raw`^Uncalled bet \(${AMOUNT}\) returned to (.+)$`);
const HEADER_STAKES_REGEX = new RegExp(String.raw`\(${AMOUNT}\/${AMOUNT}\)`);

/** Minor units. Cash hands are in cents; tournament chips are already whole. */
function parseUnits(raw: string, minorUnits: number): number {
  return Math.round(Number(raw) * minorUnits);
}

/**
 * The WePlay money style: round amounts lose their decimals, everything else
 * gets exactly two. `$2.5` never appears in a WePlay file and must not appear
 * in our output either.
 */
function formatUnits(units: number, symbol: string, minorUnits: number): string {
  if (minorUnits === 1) {
    return `${symbol}${units}`;
  }
  if (units % minorUnits === 0) {
    return `${symbol}${units / minorUnits}`;
  }
  return `${symbol}${(units / minorUnits).toFixed(2)}`;
}

interface MoneyContext {
  symbol: string;
  minorUnits: number;
}

function moneyContextFor(chunk: string, header: string): MoneyContext {
  const isTournament = /Tournament/i.test(header);
  if (isTournament) {
    // Stacks and bets are chips; the buy-in in the header is the only real money.
    return { symbol: "", minorUnits: 1 };
  }
  const symbol = chunk.includes("€") ? "€" : chunk.includes("£") ? "£" : "$";
  return { symbol, minorUnits: 100 };
}

function normalizeTableLine(line: string): string {
  return line
    .replace(/\(\d+\)/, "")
    .replace(/\s+\(Money 3\)/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * WePlay writes `Total pot $11 | Rake $0.55 `; trackers expect the full GG fee
 * breakdown. The extra columns are always zero because WePlay does not report
 * them separately.
 */
function normalizeSummaryLine(line: string, money: MoneyContext): string {
  const beforePipe = line.split("|")[0].trim();
  const rakeMatch = line.match(/Rake\s+([$€£\d.]+)/);
  const zero = `${money.symbol}0`;
  const rake = rakeMatch ? rakeMatch[1] : zero;
  return `${beforePipe} | Rake ${rake} | Jackpot ${zero} | Bingo ${zero} | Fortune ${zero} | Tax ${zero}`;
}

/**
 * WePlay masks cards it will not reveal as `##`. A summary line that claims a
 * player "showed [## ##]" is noise, so the reveal is dropped; a line that
 * claims a folder showed something is simply wrong and is dropped too.
 */
function scrubSummarySeatLine(line: string): string {
  if (!line.startsWith("Seat ")) {
    return line;
  }
  if (/folded/i.test(line)) {
    return line.replace(/\s+showed \[[^\]]*\]/i, "").replace(/\s+and lost with .+$/i, "").trim();
  }
  if (/showed \[[^\]]*#[^\]]*\]/i.test(line)) {
    return line.replace(/\s+showed \[[^\]]*\]/i, "").replace(/\s+and lost with .+$/i, "").trim();
  }
  return line;
}

function normalizeHeader(line: string): { header: string; handId: string } {
  const match = line.match(/^Weplay Hand #(\d+):\s*(.+)$/);
  if (!match) {
    return { header: line, handId: "unknown" };
  }

  const handId = match[1];
  const payload = match[2].replace(/\s+UTC$/, "");
  return {
    // The "HD" prefix keeps WePlay ids from colliding with real GG ids.
    header: `Poker Hand #HD${handId}: ${payload}`,
    handId,
  };
}

function shouldDropLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.includes("has timed out") ||
    trimmed.includes("leaves the table") ||
    trimmed.includes("joins the table") ||
    trimmed.includes("sits out") ||
    trimmed.includes("while being disconnected") ||
    // Time-bank notices are UI events; GG has no equivalent line.
    /\bactivates time bank\b/i.test(trimmed) ||
    // GG has no equivalent lines; the runout is already in the FIRST/SECOND markers.
    /\bdeclines straddle\b/i.test(trimmed) ||
    /\bwas run two times\b/i.test(trimmed) ||
    /\bis disconnected\b/i.test(trimmed) ||
    /\bis connected\b/i.test(trimmed)
  );
}

function isOmahaHand(headerOrChunk: string): boolean {
  return /\bOmaha\b/i.test(headerOrChunk) || /\bPLO\b/i.test(headerOrChunk);
}

function isBombPotHand(chunk: string): boolean {
  if (/\*\*\*\s*BOMB POT\s*\*\*\*/i.test(chunk) || /posts bomb pot/i.test(chunk)) {
    return true;
  }
  const hasAnte = /posts the ante/i.test(chunk);
  const hasBlind = /posts (?:small|big) blind/i.test(chunk);
  return hasAnte && !hasBlind;
}

function isAllInOrFoldTable(chunk: string): boolean {
  return /All-in or Fold/i.test(chunk);
}

function parseHeaderStakes(
  header: string,
  money: MoneyContext,
): { sb: number; bb: number } | null {
  const match = header.match(HEADER_STAKES_REGEX);
  if (!match) {
    return null;
  }
  return {
    sb: parseUnits(match[1], money.minorUnits),
    bb: parseUnits(match[2], money.minorUnits),
  };
}

function normalizeShowsLine(line: string): string {
  const match = line.match(SHOWS_HIDDEN_REGEX);
  if (!match) {
    return line;
  }
  return `${match[1]}: doesn't show hand`;
}

function normalizeLine(line: string, money: MoneyContext): string {
  if (!line.trim()) {
    return line;
  }

  if (line.startsWith("Table ")) {
    return normalizeTableLine(line);
  }

  if (line === "*** SHOW DOWN ***") {
    return "*** SHOWDOWN ***";
  }

  if (line.startsWith("Total pot")) {
    return normalizeSummaryLine(line, money);
  }

  if (line.startsWith("Seat ")) {
    return scrubSummarySeatLine(line);
  }

  return normalizeShowsLine(line);
}

function updateCurrentBetFromLine(line: string, currentBet: number, money: MoneyContext): number {
  const blindMatch = line.match(new RegExp(String.raw`: posts (?:small|big) blind ${AMOUNT}`));
  if (blindMatch) {
    return Math.max(currentBet, parseUnits(blindMatch[1], money.minorUnits));
  }

  const postMatch = line.match(new RegExp(String.raw`: posts ${AMOUNT}`));
  if (postMatch) {
    return Math.max(currentBet, parseUnits(postMatch[1], money.minorUnits));
  }

  const betMatch = line.match(new RegExp(String.raw`: bets ${AMOUNT}`));
  if (betMatch) {
    return parseUnits(betMatch[1], money.minorUnits);
  }

  return currentBet;
}

function addCommitment(map: Map<string, number>, player: string, units: number): void {
  map.set(player, (map.get(player) ?? 0) + units);
}

function setCommitment(map: Map<string, number>, player: string, units: number): void {
  map.set(player, units);
}

/**
 * WePlay writes `raises <chips added> to <total>`; GG writes
 * `raises <amount over the current bet> to <total>`. Trackers read the first
 * number, so it has to be rewritten.
 */
function rewriteRaiseLine(
  line: string,
  currentBet: number,
  money: MoneyContext,
): { line: string; currentBet: number; callAllInUnits?: number } | null {
  const match = line.match(RAISE_LINE_REGEX);
  if (!match) {
    return null;
  }

  const player = match[1];
  const raiseBy = parseUnits(match[2], money.minorUnits);
  const to = parseUnits(match[3], money.minorUnits);
  const allInSuffix = match[4] ?? "";
  const impliedPrevious = to - raiseBy;
  const fmt = (units: number) => formatUnits(units, money.symbol, money.minorUnits);

  // Short cover all-in written as raise-to below current bet → call all-in.
  if (allInSuffix && to < currentBet) {
    return {
      line: `${player}: calls ${fmt(raiseBy)} and is all-in`,
      currentBet,
      callAllInUnits: raiseBy,
    };
  }

  // Already GG-like: Y - X matches the tracked previous bet.
  if (impliedPrevious === currentBet) {
    return { line, currentBet: to };
  }

  const over = to - currentBet;
  if (over <= 0) {
    return { line, currentBet: Math.max(currentBet, to) };
  }

  return {
    line: `${player}: raises ${fmt(over)} to ${fmt(to)}${allInSuffix}`,
    currentBet: to,
  };
}

function extractSeatedPlayers(lines: string[]): Map<string, string> {
  const seats = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(SEAT_LINE_REGEX);
    if (!match) {
      continue;
    }
    seats.set(match[1], match[2]);
  }
  return seats;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Skip {
  reason: string;
  message: string;
}

/** Cheap structural checks that can be made before any rewriting happens. */
function getEarlySkip(chunk: string, header: string, money: MoneyContext): Skip | null {
  if (isAllInOrFoldTable(chunk)) {
    return { reason: "all-in-or-fold-table", message: "All-in or Fold table." };
  }

  const hasBigBlind = /: posts big blind /i.test(chunk);
  const hasSmallBlind = /: posts small blind /i.test(chunk);
  if (hasBigBlind && !hasSmallBlind) {
    return {
      reason: "bb-only-walk",
      message: "Big blind posted without a small blind (BB-only walk).",
    };
  }

  const stakes = parseHeaderStakes(header, money);
  if (stakes) {
    const shortSb = chunk.matchAll(
      new RegExp(String.raw`: posts small blind ${AMOUNT} and is all-in`, "gi"),
    );
    for (const match of shortSb) {
      if (parseUnits(match[1], money.minorUnits) < stakes.sb) {
        return {
          reason: "short-allin-small-blind",
          message: "Small blind posted all-in for less than the stated blind.",
        };
      }
    }
    const shortBb = chunk.matchAll(
      new RegExp(String.raw`: posts big blind ${AMOUNT} and is all-in`, "gi"),
    );
    for (const match of shortBb) {
      if (parseUnits(match[1], money.minorUnits) < stakes.bb) {
        return {
          reason: "short-allin-big-blind",
          message: "Big blind posted all-in for less than the stated blind.",
        };
      }
    }
  }

  const seats = extractSeatedPlayers(chunk.split(/\r?\n/));
  const zeroStackPlayers = new Set<string>();
  for (const [name, stackText] of seats) {
    if (/^[$€£]?0(?:\.0+)?$/.test(stackText.trim())) {
      zeroStackPlayers.add(name);
    }
  }
  if (zeroStackPlayers.size > 0) {
    for (const line of chunk.split(/\r?\n/)) {
      for (const name of zeroStackPlayers) {
        const moneyAction = new RegExp(`^${escapeRegExp(name)}: (?:posts|raises|calls|bets)\\b`);
        if (moneyAction.test(line)) {
          return {
            reason: "zero-stack-actor",
            message: `A player with a zero stack acted (${name}).`,
          };
        }
      }
    }
  }

  return null;
}

/** Structural checks that only make sense after the rewrites are applied. */
function findIntegritySkip(lines: string[], header: string, money: MoneyContext): Skip | null {
  const seats = extractSeatedPlayers(lines);
  const seatedNames = new Set(seats.keys());
  const stakes = parseHeaderStakes(header, money);

  let sawFlop = false;
  let sawTurn = false;
  let sawFirstFlop = false;
  let sawFirstTurn = false;
  let sawSecondFlop = false;
  let sawSecondTurn = false;
  let inSummary = false;
  let currentBet = 0;
  let preflop = true;
  const commitment = new Map<string, number>();

  for (const line of lines) {
    if (line.startsWith("*** SUMMARY")) {
      inSummary = true;
      continue;
    }
    if (inSummary) {
      continue;
    }

    if (/^\*\*\* (?:FIRST |SECOND )?FLOP\b/.test(line)) {
      sawFlop = true;
      if (/FIRST/.test(line)) {
        sawFirstFlop = true;
      }
      if (/SECOND/.test(line)) {
        sawSecondFlop = true;
      }
      currentBet = 0;
      commitment.clear();
      preflop = false;
      continue;
    }
    if (/^\*\*\* (?:FIRST |SECOND )?TURN\b/.test(line)) {
      const isSecond = /SECOND/.test(line);
      if (!isSecond && !sawFlop && !sawFirstFlop) {
        return { reason: "turn-without-flop", message: "A turn was dealt without a flop." };
      }
      if (isSecond && !sawSecondFlop && !sawFlop) {
        return {
          reason: "turn-without-flop",
          message: "A second turn was dealt without a flop.",
        };
      }
      sawTurn = true;
      if (/FIRST/.test(line)) {
        sawFirstTurn = true;
      }
      if (isSecond) {
        sawSecondTurn = true;
      }
      currentBet = 0;
      commitment.clear();
      continue;
    }
    if (/^\*\*\* (?:FIRST |SECOND )?RIVER\b/.test(line)) {
      const isSecond = /SECOND/.test(line);
      if (!isSecond && !sawTurn && !sawFirstTurn) {
        return { reason: "river-without-turn", message: "A river was dealt without a turn." };
      }
      if (isSecond && !sawSecondTurn && !sawTurn && !sawFirstTurn) {
        return {
          reason: "river-without-turn",
          message: "A second river was dealt without a turn.",
        };
      }
      currentBet = 0;
      commitment.clear();
      continue;
    }

    const uncalled = line.match(UNCALLED_REGEX);
    if (uncalled) {
      const amount = parseUnits(uncalled[1], money.minorUnits);
      const player = uncalled[2];
      const committed = commitment.get(player) ?? 0;
      if (amount > committed) {
        return {
          reason: "uncalled-exceeds-commitment",
          message: `Uncalled bet is larger than what ${player} committed.`,
        };
      }
      continue;
    }

    const anteMatch = line.match(new RegExp(String.raw`^(.+?): posts the ante ${AMOUNT}`));
    if (anteMatch) {
      const player = anteMatch[1];
      if (!seatedNames.has(player)) {
        return { reason: "ghost-ante", message: `Ante posted by an unseated player (${player}).` };
      }
      continue;
    }

    const actor =
      line.match(PLAYER_ACTION_REGEX)?.[1] ?? line.match(COLLECTED_REGEX)?.[1] ?? null;
    if (actor && !seatedNames.has(actor)) {
      if (/: (?:posts|raises|calls|bets|shows|collected)/.test(line) || / collected /.test(line)) {
        return { reason: "unseated-actor", message: `An unseated player acted (${actor}).` };
      }
    }

    const blindMatch = line.match(
      new RegExp(String.raw`^(.+?): posts (small|big) blind ${AMOUNT}( and is all-in)?$`),
    );
    if (blindMatch) {
      const amount = parseUnits(blindMatch[3], money.minorUnits);
      setCommitment(commitment, blindMatch[1], amount);
      currentBet = Math.max(currentBet, amount);
      continue;
    }

    const raiseMatch = line.match(RAISE_LINE_REGEX);
    if (raiseMatch) {
      const to = parseUnits(raiseMatch[3], money.minorUnits);
      setCommitment(commitment, raiseMatch[1], to);
      currentBet = Math.max(currentBet, to);
      continue;
    }

    const callMatch = line.match(
      new RegExp(String.raw`^(.+?): calls ${AMOUNT}( and is all-in)?$`),
    );
    if (callMatch) {
      const amount = parseUnits(callMatch[2], money.minorUnits);
      const allIn = Boolean(callMatch[3]);
      addCommitment(commitment, callMatch[1], amount);
      if (preflop && allIn && stakes && amount < stakes.bb) {
        return {
          reason: "short-allin-call",
          message: "An all-in call preflop is smaller than the big blind.",
        };
      }
      continue;
    }

    const betMatch = line.match(new RegExp(String.raw`^(.+?): bets ${AMOUNT}`));
    if (betMatch) {
      const amount = parseUnits(betMatch[2], money.minorUnits);
      setCommitment(commitment, betMatch[1], amount);
      currentBet = amount;
    }
  }

  return null;
}

/**
 * A preflop walk sometimes carries a board and a `*** RIVER ***` marker that
 * never happened. Nothing was dealt, so the phantom runout is removed.
 */
function stripPhantomWalkBoards(lines: string[]): string[] {
  const showdownIndex = lines.findIndex(
    (line) => line === "*** SHOWDOWN ***" || line === "*** SHOW DOWN ***",
  );
  if (showdownIndex < 0) {
    return lines;
  }

  const hasFlopBeforeShowdown = lines
    .slice(0, showdownIndex)
    .some((line) => /^\*\*\* (?:FIRST |SECOND )?FLOP\b/.test(line));
  if (hasFlopBeforeShowdown) {
    return lines;
  }

  return lines.filter((line, index) => {
    if (index <= showdownIndex) {
      return true;
    }
    if (line === "*** HOLE CARDS ***") {
      return false;
    }
    if (/^Dealt to /.test(line)) {
      return false;
    }
    if (STREET_MARKER_REGEX.test(line)) {
      return false;
    }
    if (/^Board \[/.test(line)) {
      return false;
    }
    return true;
  });
}

/**
 * WePlay chunk -> standard text.
 *
 * Exported because the byte-compatibility test drives it directly, and because
 * `converter.ts` keeps a thin shim on top of it.
 */
export function normalizeWeplayChunk(
  chunk: string,
): { text: string; handId: string } | { skip: Skip } {
  const lines = chunk.split(/\r?\n/);
  const rawHeader = lines[0] ?? "";
  const { header, handId } = normalizeHeader(rawHeader);
  const money = moneyContextFor(chunk, header);

  if (isOmahaHand(rawHeader) || isOmahaHand(header)) {
    return {
      skip: {
        reason: "unsupported-variant",
        message: "Omaha is not supported yet; the hand is kept for a future parser.",
      },
    };
  }

  const early = getEarlySkip(chunk, header, money);
  if (early) {
    return { skip: early };
  }

  let currentBet = 0;
  const normalized: string[] = [];
  const commitment = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";

    if (index === 0) {
      normalized.push(header);
      continue;
    }

    if (shouldDropLine(rawLine)) {
      continue;
    }

    const line = normalizeLine(rawLine, money);
    if (line === "") {
      continue;
    }

    if (STREET_MARKER_REGEX.test(line)) {
      currentBet = 0;
      commitment.clear();
      normalized.push(line);
      continue;
    }

    const raised = rewriteRaiseLine(line, currentBet, money);
    if (raised) {
      currentBet = raised.currentBet;
      const player = raised.line.match(/^(.+?):/)?.[1];
      if (raised.callAllInUnits !== undefined) {
        if (player) {
          addCommitment(commitment, player, raised.callAllInUnits);
        }
      } else {
        const toMatch = raised.line.match(new RegExp(String.raw` to ${AMOUNT}`));
        if (player && toMatch) {
          setCommitment(commitment, player, parseUnits(toMatch[1], money.minorUnits));
        }
      }
      normalized.push(raised.line);
      continue;
    }

    const blindMatch = line.match(
      new RegExp(String.raw`^(.+?): posts (?:small|big) blind ${AMOUNT}`),
    );
    if (blindMatch) {
      setCommitment(commitment, blindMatch[1], parseUnits(blindMatch[2], money.minorUnits));
    }
    const callMatch = line.match(new RegExp(String.raw`^(.+?): calls ${AMOUNT}`));
    if (callMatch) {
      addCommitment(commitment, callMatch[1], parseUnits(callMatch[2], money.minorUnits));
    }
    const betMatch = line.match(new RegExp(String.raw`^(.+?): bets ${AMOUNT}`));
    if (betMatch) {
      setCommitment(commitment, betMatch[1], parseUnits(betMatch[2], money.minorUnits));
    }

    currentBet = updateCurrentBetFromLine(line, currentBet, money);
    normalized.push(line);
  }

  const cleaned = stripPhantomWalkBoards(normalized);
  const integrity = findIntegritySkip(cleaned, header, money);
  if (integrity) {
    return { skip: integrity };
  }

  return { text: cleaned.join("\n"), handId };
}

/* ------------------------------------------------------------------ parser - */

export const weplayParser: SiteParser = {
  id: "weplay",
  name: "WePlay",
  version: WEPLAY_PARSER_VERSION,

  detect(text: string): number {
    // Tolerates the byte-order mark some exports start the file with.
    if (/(?:^|\n)\uFEFF?Weplay Hand #\d+:/.test(text)) {
      return 0.99;
    }
    // A WePlay export without its header is not something we want to guess at.
    return 0;
  },

  splitHands(text: string): string[] {
    return text
      .replace(/^﻿/, "")
      .split(HAND_SPLIT_REGEX)
      .map((chunk) => chunk.replace(/^﻿/, "").trim())
      .filter((chunk) => chunk.startsWith("Weplay Hand #"));
  },

  parseHand(raw: string, ctx: SiteParserContext): PhfHand {
    const options = ctx.options;
    const header = raw.split(/\r?\n/)[0] ?? "";

    if (options.cashOnly && /Tournament/i.test(header)) {
      throw new ParseSkip(
        "tournament-in-cash-mode",
        "Tournament hand skipped because the converter is in cash-only mode.",
      );
    }
    if (options.skipBombPots && isBombPotHand(raw)) {
      throw new ParseSkip("bomb-pot", "Bomb pot hand skipped by request.");
    }

    const normalized = normalizeWeplayChunk(raw);
    if ("skip" in normalized) {
      throw new ParseSkip(normalized.skip.reason, normalized.skip.message);
    }

    const hand = parseStandardHand(normalized.text, {
      siteId: "weplay",
      siteName: "WePlay",
      originalFilename: ctx.sourceFilename,
      parserId: "weplay",
      parserVersion: WEPLAY_PARSER_VERSION,
    });
    if (!hand) {
      throw new ParseSkip(
        "normalized-unparseable",
        "The hand normalized cleanly but the result could not be parsed.",
      );
    }
    // The raw text we keep is the WePlay original, not our rewrite of it: if we
    // ever fix a bug in the normalizer we want to be able to re-convert.
    hand.meta.rawText = raw.trim();
    return hand;
  },
};

export { isBombPotHand, isOmahaHand };
