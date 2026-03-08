import type { GameType, ParsedHand } from "../domain/types.js";

const HAND_SPLIT_REGEX = /(?=^Weplay Hand #\d+:)/gm;

function convertHeader(line: string): { header: string; handId: string; gameType: GameType } {
  const handMatch = line.match(/^Weplay Hand #(\d+):\s*(.+)$/);
  if (!handMatch) {
    return {
      header: line,
      handId: "unknown",
      gameType: "cash",
    };
  }

  const handId = handMatch[1];
  const payload = handMatch[2].replace(/\s+UTC$/, "");
  const gameType: GameType = payload.includes("Tournament") ? "tournament" : "cash";

  return {
    handId,
    gameType,
    header: `Poker Hand #HD${handId}: ${payload}`,
  };
}

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

export function parseWeplayText(input: string): ParsedHand[] {
  const chunks = input
    .split(HAND_SPLIT_REGEX)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  const hands: ParsedHand[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const firstLine = lines[0] ?? "";
    const { header, handId, gameType } = convertHeader(firstLine);
    const warnings: string[] = [];

    const normalizedLines = lines
      .map((line, index) => {
        if (index === 0) {
          return header;
        }

        const normalized = normalizeLine(line);
        if (!normalized && line.trim()) {
          warnings.push(`Dropped non-action line: "${line.trim()}"`);
        }
        return normalized;
      })
      .filter((line) => line !== "");

    hands.push({
      handId,
      gameType,
      originalHeader: firstLine,
      convertedHeader: header,
      lines: normalizedLines,
      warnings,
    });
  }

  return hands;
}
