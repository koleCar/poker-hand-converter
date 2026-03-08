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

  if (line.startsWith("Table ")) {
    return normalizeTableLine(line);
  }

  if (line === "*** SHOW DOWN ***") {
    return "*** SHOWDOWN ***";
  }

  if (line.startsWith("Total pot")) {
    return normalizeSummaryLine(line);
  }

  return line;
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

  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    const { header } = normalizeHeader(lines[0] ?? "");

    if (header.includes("Tournament")) {
      warnings.push(`Preskacem tournament hand u cash-only modu: ${lines[0]}`);
      continue;
    }

    const normalized = lines
      .map((line, index) => {
        if (index === 0) {
          return header;
        }
        if (shouldDropLine(line)) {
          warnings.push(`Uklonjena linija: ${line.trim()}`);
          return "";
        }
        return normalizeLine(line);
      })
      .filter((line) => line !== "")
      .join("\n");

    normalizedHands.push(normalized);
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
