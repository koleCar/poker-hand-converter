export type GameType = "cash" | "tournament";
export type CardSource = "dealt" | "shown";

export interface ParsedPlayer {
  playerName: string;
  seatNo: number | null;
  stackText: string | null;
}

export interface ParsedKnownCard {
  playerName: string;
  card1: string;
  card2: string;
  source: CardSource;
}

export interface ConvertedHand {
  sourceHandId: string;
  gameType: GameType;
  tableName: string | null;
  playedAt: string | null;
  rawHandText: string;
  ggHandText: string;
  warnings: string[];
  players: ParsedPlayer[];
  knownCards: ParsedKnownCard[];
  actions: string[];
}

export interface ConvertedFilePayload {
  outputFileName: string;
  handCount: number;
  warningCount: number;
  warnings: string[];
  ggText: string;
  hands: ConvertedHand[];
}

const HAND_SPLIT_REGEX = /(?=^Weplay Hand #\d+:)/gm;

function normalizeTableLine(line: string): string {
  if (!line.startsWith("Table ")) {
    return line;
  }
  return line
    .replace(/\(\d+\)/, "")
    .replace(/\s+\(Money 3\)/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeSummaryTotal(line: string): string {
  if (!line.startsWith("Total pot")) {
    return line;
  }
  const beforePipe = line.split("|")[0].trim();
  const rakeMatch = line.match(/Rake\s+([$\d.]+)/);
  const rake = rakeMatch ? rakeMatch[1] : "$0";
  return `${beforePipe} | Rake ${rake} | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0`;
}

function shouldDropLine(line: string): boolean {
  return (
    line.includes("has timed out") ||
    line.includes("leaves the table") ||
    line.includes("sits out") ||
    line.includes("while being disconnected")
  );
}

function normalizeLine(line: string): string {
  if (!line.trim()) {
    return line;
  }
  if (shouldDropLine(line)) {
    return "";
  }
  if (line.startsWith("Table ")) {
    return normalizeTableLine(line);
  }
  if (line === "*** SHOW DOWN ***") {
    return "*** SHOWDOWN ***";
  }
  if (line.startsWith("Total pot")) {
    return normalizeSummaryTotal(line);
  }
  return line;
}

function parseHeader(line: string): {
  convertedHeader: string;
  sourceHandId: string;
  gameType: GameType;
  playedAt: string | null;
} {
  const match = line.match(/^Weplay Hand #(\d+):\s*(.+)$/);
  if (!match) {
    return {
      convertedHeader: line,
      sourceHandId: "unknown",
      gameType: "cash",
      playedAt: null,
    };
  }

  const sourceHandId = match[1];
  const payload = match[2].replace(/\s+UTC$/, "");
  const gameType: GameType = payload.includes("Tournament") ? "tournament" : "cash";

  const dateMatch = payload.match(/-\s(\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2})$/);
  const playedAt = dateMatch ? dateMatch[1].replace(" ", "T") + "Z" : null;

  return {
    convertedHeader: `Poker Hand #HD${sourceHandId}: ${payload}`,
    sourceHandId,
    gameType,
    playedAt,
  };
}

function extractPlayers(lines: string[]): ParsedPlayer[] {
  const players = new Map<string, ParsedPlayer>();
  for (const line of lines) {
    const match = line.match(/^Seat\s+(\d+):\s+(.+?)\s+\((.+?) in chips\)$/);
    if (!match) {
      continue;
    }
    const playerName = match[2];
    players.set(playerName, {
      playerName,
      seatNo: Number(match[1]),
      stackText: match[3],
    });
  }
  return Array.from(players.values());
}

function extractKnownCards(lines: string[]): ParsedKnownCard[] {
  const result = new Map<string, ParsedKnownCard>();
  for (const line of lines) {
    const dealt = line.match(/^Dealt to (.+?) \[([2-9TJQKA][cdhs]) ([2-9TJQKA][cdhs])\]$/);
    if (dealt) {
      result.set(`${dealt[1]}-dealt`, {
        playerName: dealt[1],
        card1: dealt[2],
        card2: dealt[3],
        source: "dealt",
      });
    }

    const shown = line.match(/^(.+?): shows \[([2-9TJQKA][cdhs]) ([2-9TJQKA][cdhs])\]/);
    if (shown) {
      result.set(`${shown[1]}-shown`, {
        playerName: shown[1],
        card1: shown[2],
        card2: shown[3],
        source: "shown",
      });
    }
  }
  return Array.from(result.values());
}

function extractActions(lines: string[]): string[] {
  return lines.filter((line) => line.includes(":") && !line.startsWith("Seat "));
}

function tableNameFromLines(lines: string[]): string | null {
  const tableLine = lines.find((line) => line.startsWith("Table "));
  if (!tableLine) {
    return null;
  }
  const match = tableLine.match(/^Table '(.+?)'/);
  return match ? match[1] : null;
}

function outputNameFromInput(inputFileName: string): string {
  return `${inputFileName.replace(/\.txt$/i, "")}.gg.txt`;
}

export function convertWeplayFile(inputFileName: string, input: string): ConvertedFilePayload {
  const chunks = input
    .split(HAND_SPLIT_REGEX)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const hands: ConvertedHand[] = [];
  const fileWarnings: string[] = [];

  for (const chunk of chunks) {
    const rawLines = chunk.split(/\r?\n/);
    const rawHeader = rawLines[0] ?? "";
    const headerMeta = parseHeader(rawHeader);
    const warnings: string[] = [];

    const normalizedLines = rawLines
      .map((line, index) => {
        if (index === 0) {
          return headerMeta.convertedHeader;
        }
        const normalized = normalizeLine(line);
        if (!normalized && line.trim()) {
          warnings.push(`Dropped line: "${line.trim()}"`);
        }
        return normalized;
      })
      .filter((line) => line !== "");

    const players = extractPlayers(normalizedLines);
    const knownCards = extractKnownCards(normalizedLines);
    const actions = extractActions(normalizedLines);

    hands.push({
      sourceHandId: headerMeta.sourceHandId,
      gameType: headerMeta.gameType,
      tableName: tableNameFromLines(normalizedLines),
      playedAt: headerMeta.playedAt,
      rawHandText: chunk,
      ggHandText: normalizedLines.join("\n"),
      warnings,
      players,
      knownCards,
      actions,
    });
    fileWarnings.push(...warnings);
  }

  return {
    outputFileName: outputNameFromInput(inputFileName),
    handCount: hands.length,
    warningCount: fileWarnings.length,
    warnings: fileWarnings,
    ggText: hands.map((hand) => hand.ggHandText).join("\n\n"),
    hands,
  };
}
