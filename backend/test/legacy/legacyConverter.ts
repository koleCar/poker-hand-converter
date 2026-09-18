/**
 * FROZEN COPY of `frontend/src/lib/converter.ts` as it stood before the PHF
 * rewrite (commit e5a078a).
 *
 * Do not "fix" anything in here. Its only job is to be the reference the
 * byte-compatibility test measures the new pipeline against: Holdem Manager and
 * PokerTracker import the text this function used to produce, so any change to
 * that text has to be a deliberate, reviewed one rather than a regression.
 *
 * `backend/test/byteCompat.test.ts` lists the differences that are accepted and
 * why.
 */

export type FileStatus = "converted" | "failed";

export interface ConvertedFile {
  inputFileName: string;
  outputFileName: string;
  handCount: number;
  warningCount: number;
  warnings: string[];
  status: FileStatus;
  message?: string;
  outputText: string;
}

const HAND_SPLIT_REGEX = /(?=^Weplay Hand #\d+:)/gm;
const RAISE_LINE_REGEX =
  /^(.+?): raises \$(\d+(?:\.\d+)?) to \$(\d+(?:\.\d+)?)( and is all-in)?$/;
const STREET_MARKER_REGEX = /^\*\*\* (?:FIRST |SECOND )?(?:FLOP|TURN|RIVER)\b/;
const SHOWS_HIDDEN_REGEX = /^(.+?): shows \[.*#.*\].*$/;
const SEAT_LINE_REGEX = /^Seat\s+\d+:\s+(.+?)\s+\((.+) in chips\)$/;
const PLAYER_ACTION_REGEX =
  /^(.+?): (?:posts|raises|calls|bets|folds|checks|shows|mucks|doesn't show)/;
const COLLECTED_REGEX = /^(.+?) collected /;
const UNCALLED_REGEX = /^Uncalled bet \(\$(\d+(?:\.\d+)?)\) returned to (.+)$/;
const HEADER_STAKES_REGEX = /\(\$(\d+(?:\.\d+)?)\/\$(\d+(?:\.\d+)?)\)/;

function parseCents(raw: string): number {
  return Math.round(Number(raw) * 100);
}

function formatCents(cents: number): string {
  if (cents % 100 === 0) {
    return `$${cents / 100}`;
  }
  return `$${(cents / 100).toFixed(2)}`;
}

function normalizeTableLine(line: string): string {
  return line
    .replace(/\(\d+\)/, "")
    .replace(/\s+\(Money 3\)/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeSummaryLine(line: string): string {
  const beforePipe = line.split("|")[0].trim();
  const rakeMatch = line.match(/Rake\s+([$\d.]+)/);
  const rake = rakeMatch ? rakeMatch[1] : "$0";
  return `${beforePipe} | Rake ${rake} | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0`;
}

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

function parseHeaderStakes(header: string): { sbCents: number; bbCents: number } | null {
  const match = header.match(HEADER_STAKES_REGEX);
  if (!match) {
    return null;
  }
  return { sbCents: parseCents(match[1]), bbCents: parseCents(match[2]) };
}

function normalizeShowsLine(line: string): string {
  const match = line.match(SHOWS_HIDDEN_REGEX);
  if (!match) {
    return line;
  }
  return `${match[1]}: doesn't show hand`;
}

function normalizeLine(line: string): string {
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
    return normalizeSummaryLine(line);
  }

  if (line.startsWith("Seat ")) {
    return scrubSummarySeatLine(line);
  }

  return normalizeShowsLine(line);
}

function updateCurrentBetFromLine(line: string, currentBetCents: number): number {
  const blindMatch = line.match(/: posts (?:small|big) blind \$(\d+(?:\.\d+)?)/);
  if (blindMatch) {
    return Math.max(currentBetCents, parseCents(blindMatch[1]));
  }

  const postMatch = line.match(/: posts \$(\d+(?:\.\d+)?)/);
  if (postMatch) {
    return Math.max(currentBetCents, parseCents(postMatch[1]));
  }

  const betMatch = line.match(/: bets \$(\d+(?:\.\d+)?)/);
  if (betMatch) {
    return parseCents(betMatch[1]);
  }

  return currentBetCents;
}

function addCommitment(map: Map<string, number>, player: string, cents: number): void {
  map.set(player, (map.get(player) ?? 0) + cents);
}

function setCommitment(map: Map<string, number>, player: string, cents: number): void {
  map.set(player, cents);
}

function rewriteRaiseLine(
  line: string,
  currentBetCents: number,
): { line: string; currentBetCents: number; callAllInCents?: number } | null {
  const match = line.match(RAISE_LINE_REGEX);
  if (!match) {
    return null;
  }

  const player = match[1];
  const raiseByCents = parseCents(match[2]);
  const toCents = parseCents(match[3]);
  const allInSuffix = match[4] ?? "";
  const impliedPrevious = toCents - raiseByCents;

  // Short cover all-in written as raise-to below current bet → call all-in.
  if (allInSuffix && toCents < currentBetCents) {
    return {
      line: `${player}: calls ${formatCents(raiseByCents)} and is all-in`,
      currentBetCents,
      callAllInCents: raiseByCents,
    };
  }

  // Already GG-like: Y - X matches the tracked previous bet.
  if (impliedPrevious === currentBetCents) {
    return { line, currentBetCents: toCents };
  }

  const overCents = toCents - currentBetCents;
  if (overCents <= 0) {
    return { line, currentBetCents: Math.max(currentBetCents, toCents) };
  }

  return {
    line: `${player}: raises ${formatCents(overCents)} to ${formatCents(toCents)}${allInSuffix}`,
    currentBetCents: toCents,
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

function getEarlySkipReason(chunk: string, header: string): string | null {
  if (isAllInOrFoldTable(chunk)) {
    return "All-in or Fold table";
  }

  const hasBigBlind = /: posts big blind \$/i.test(chunk);
  const hasSmallBlind = /: posts small blind \$/i.test(chunk);
  if (hasBigBlind && !hasSmallBlind) {
    return "BB-only walk (no small blind)";
  }

  const stakes = parseHeaderStakes(header);
  if (stakes) {
    const shortSb = chunk.matchAll(
      /: posts small blind \$(\d+(?:\.\d+)?) and is all-in/gi,
    );
    for (const match of shortSb) {
      if (parseCents(match[1]) < stakes.sbCents) {
        return "short all-in small blind";
      }
    }
    const shortBb = chunk.matchAll(/: posts big blind \$(\d+(?:\.\d+)?) and is all-in/gi);
    for (const match of shortBb) {
      if (parseCents(match[1]) < stakes.bbCents) {
        return "short all-in big blind";
      }
    }
  }

  const seats = extractSeatedPlayers(chunk.split(/\r?\n/));
  const zeroStackPlayers = new Set<string>();
  for (const [name, stackText] of seats) {
    if (/^\$?0(?:\.0+)?$/.test(stackText.trim()) || stackText.trim() === "$0") {
      zeroStackPlayers.add(name);
    }
  }
  if (zeroStackPlayers.size > 0) {
    for (const line of chunk.split(/\r?\n/)) {
      for (const name of zeroStackPlayers) {
        const moneyAction = new RegExp(
          `^${escapeRegExp(name)}: (?:posts|raises|calls|bets)\\b`,
        );
        if (moneyAction.test(line)) {
          return `zero-stack player acted (${name})`;
        }
      }
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findIntegritySkipReason(
  lines: string[],
  header: string,
): string | null {
  const seats = extractSeatedPlayers(lines);
  const seatedNames = new Set(seats.keys());
  const stakes = parseHeaderStakes(header);

  let sawFlop = false;
  let sawTurn = false;
  let sawRiver = false;
  let sawFirstFlop = false;
  let sawFirstTurn = false;
  let sawSecondFlop = false;
  let sawSecondTurn = false;
  let inSummary = false;
  let currentBetCents = 0;
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
      currentBetCents = 0;
      commitment.clear();
      preflop = false;
      continue;
    }
    if (/^\*\*\* (?:FIRST |SECOND )?TURN\b/.test(line)) {
      const isSecond = /SECOND/.test(line);
      if (!isSecond && !sawFlop && !sawFirstFlop) {
        return "TURN without FLOP";
      }
      if (isSecond && !sawSecondFlop && !sawFlop) {
        return "SECOND TURN without FLOP";
      }
      sawTurn = true;
      if (/FIRST/.test(line)) {
        sawFirstTurn = true;
      }
      if (isSecond) {
        sawSecondTurn = true;
      }
      currentBetCents = 0;
      commitment.clear();
      continue;
    }
    if (/^\*\*\* (?:FIRST |SECOND )?RIVER\b/.test(line)) {
      const isSecond = /SECOND/.test(line);
      if (!isSecond && !sawTurn && !sawFirstTurn) {
        return "RIVER without TURN";
      }
      if (isSecond && !sawSecondTurn && !sawTurn && !sawFirstTurn) {
        return "SECOND RIVER without TURN";
      }
      sawRiver = true;
      currentBetCents = 0;
      commitment.clear();
      continue;
    }

    const uncalled = line.match(UNCALLED_REGEX);
    if (uncalled) {
      const amount = parseCents(uncalled[1]);
      const player = uncalled[2];
      const committed = commitment.get(player) ?? 0;
      if (amount > committed) {
        return `uncalled bet greater than commitment (${player})`;
      }
      continue;
    }

    const anteMatch = line.match(/^(.+?): posts the ante \$(\d+(?:\.\d+)?)/);
    if (anteMatch) {
      const player = anteMatch[1];
      if (!seatedNames.has(player)) {
        return `ghost ante (${player})`;
      }
      continue;
    }

    const actor =
      line.match(PLAYER_ACTION_REGEX)?.[1] ??
      line.match(COLLECTED_REGEX)?.[1] ??
      null;
    if (actor && !seatedNames.has(actor)) {
      if (
        /: (?:posts|raises|calls|bets|shows|collected)/.test(line) ||
        / collected /.test(line)
      ) {
        return `unseated actor (${actor})`;
      }
    }

    const blindMatch = line.match(
      /^(.+?): posts (small|big) blind \$(\d+(?:\.\d+)?)( and is all-in)?$/,
    );
    if (blindMatch) {
      const player = blindMatch[1];
      const amount = parseCents(blindMatch[3]);
      setCommitment(commitment, player, amount);
      currentBetCents = Math.max(currentBetCents, amount);
      continue;
    }

    const raiseMatch = line.match(RAISE_LINE_REGEX);
    if (raiseMatch) {
      const player = raiseMatch[1];
      const toCents = parseCents(raiseMatch[3]);
      setCommitment(commitment, player, toCents);
      currentBetCents = Math.max(currentBetCents, toCents);
      continue;
    }

    const callMatch = line.match(
      /^(.+?): calls \$(\d+(?:\.\d+)?)( and is all-in)?$/,
    );
    if (callMatch) {
      const player = callMatch[1];
      const amount = parseCents(callMatch[2]);
      const allIn = Boolean(callMatch[3]);
      addCommitment(commitment, player, amount);
      if (preflop && allIn && stakes && amount < stakes.bbCents) {
        return "short all-in call";
      }
      continue;
    }

    const betMatch = line.match(/^(.+?): bets \$(\d+(?:\.\d+)?)/);
    if (betMatch) {
      const player = betMatch[1];
      const amount = parseCents(betMatch[2]);
      setCommitment(commitment, player, amount);
      currentBetCents = amount;
    }
  }

  void sawRiver;
  return null;
}

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

function normalizeHandLines(
  header: string,
  lines: string[],
  warnings: string[],
): { text: string } | { skipReason: string } {
  let currentBetCents = 0;
  const normalized: string[] = [];
  const commitment = new Map<string, number>();

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";

    if (index === 0) {
      normalized.push(header);
      continue;
    }

    if (shouldDropLine(rawLine)) {
      warnings.push(`Uklonjena linija: ${rawLine.trim()}`);
      continue;
    }

    const line = normalizeLine(rawLine);
    if (line === "") {
      continue;
    }

    if (STREET_MARKER_REGEX.test(line)) {
      currentBetCents = 0;
      commitment.clear();
      normalized.push(line);
      continue;
    }

    const raised = rewriteRaiseLine(line, currentBetCents);
    if (raised) {
      currentBetCents = raised.currentBetCents;
      if (raised.callAllInCents !== undefined) {
        const player = raised.line.match(/^(.+?):/)?.[1];
        if (player) {
          addCommitment(commitment, player, raised.callAllInCents);
        }
      } else {
        const player = raised.line.match(/^(.+?):/)?.[1];
        const toMatch = raised.line.match(/ to \$(\d+(?:\.\d+)?)/);
        if (player && toMatch) {
          setCommitment(commitment, player, parseCents(toMatch[1]));
        }
      }
      normalized.push(raised.line);
      continue;
    }

    const blindMatch = line.match(
      /^(.+?): posts (?:small|big) blind \$(\d+(?:\.\d+)?)/,
    );
    if (blindMatch) {
      setCommitment(commitment, blindMatch[1], parseCents(blindMatch[2]));
    }
    const callMatch = line.match(/^(.+?): calls \$(\d+(?:\.\d+)?)/);
    if (callMatch) {
      addCommitment(commitment, callMatch[1], parseCents(callMatch[2]));
    }
    const betMatch = line.match(/^(.+?): bets \$(\d+(?:\.\d+)?)/);
    if (betMatch) {
      setCommitment(commitment, betMatch[1], parseCents(betMatch[2]));
    }

    currentBetCents = updateCurrentBetFromLine(line, currentBetCents);
    normalized.push(line);
  }

  const cleaned = stripPhantomWalkBoards(normalized);
  const integrityReason = findIntegritySkipReason(cleaned, header);
  if (integrityReason) {
    return { skipReason: integrityReason };
  }

  return { text: cleaned.join("\n") };
}

export function convertCashWeplayFile(fileName: string, input: string): ConvertedFile {
  const chunks = input
    .split(HAND_SPLIT_REGEX)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  if (chunks.length === 0 || !input.includes("Weplay Hand #")) {
    return {
      inputFileName: fileName,
      outputFileName: `${fileName.replace(/\.txt$/i, "")}.gg.txt`,
      handCount: 0,
      warningCount: 0,
      warnings: [],
      status: "failed",
      message: "Datoteka nema prepoznatljiv WePlay hand history format.",
      outputText: "",
    };
  }

  const normalizedHands: string[] = [];
  const warnings: string[] = [];
  let skippedBombPots = 0;
  let skippedOmaha = 0;
  let skippedCorrupt = 0;

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const rawHeader = lines[0] ?? "";
    const { header } = normalizeHeader(rawHeader);

    if (header.includes("Tournament")) {
      warnings.push(`Preskacem tournament hand u cash-only modu: ${rawHeader}`);
      continue;
    }

    if (isOmahaHand(rawHeader) || isOmahaHand(header)) {
      skippedOmaha += 1;
      warnings.push(`Preskacem Omaha hand: ${rawHeader}`);
      continue;
    }

    if (isBombPotHand(chunk)) {
      skippedBombPots += 1;
      warnings.push(`Preskacem Bomb Pot hand: ${rawHeader}`);
      continue;
    }

    const earlySkip = getEarlySkipReason(chunk, header);
    if (earlySkip) {
      skippedCorrupt += 1;
      warnings.push(`Preskacem ruku (${earlySkip}): ${rawHeader}`);
      continue;
    }

    const result = normalizeHandLines(header, lines, warnings);
    if ("skipReason" in result) {
      skippedCorrupt += 1;
      warnings.push(`Preskacem ruku (${result.skipReason}): ${rawHeader}`);
      continue;
    }

    normalizedHands.push(result.text);
  }

  if (skippedOmaha > 0) {
    warnings.push(`Ukupno preskočeno Omaha handova: ${skippedOmaha}`);
  }

  if (skippedBombPots > 0) {
    warnings.push(`Ukupno preskočeno Bomb Pot handova: ${skippedBombPots}`);
  }

  if (skippedCorrupt > 0) {
    warnings.push(`Ukupno preskočeno problematičnih handova: ${skippedCorrupt}`);
  }

  if (normalizedHands.length === 0) {
    return {
      inputFileName: fileName,
      outputFileName: `${fileName.replace(/\.txt$/i, "")}.gg.txt`,
      handCount: 0,
      warningCount: warnings.length,
      warnings,
      status: "failed",
      message: "Nema cash handova za konverziju u odabranom fileu.",
      outputText: "",
    };
  }

  return {
    inputFileName: fileName,
    outputFileName: `${fileName.replace(/\.txt$/i, "")}.gg.txt`,
    handCount: normalizedHands.length,
    warningCount: warnings.length,
    warnings,
    status: "converted",
    outputText: normalizedHands.join("\n\n"),
  };
}
