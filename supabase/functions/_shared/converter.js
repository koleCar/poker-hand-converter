"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertWeplayFile = convertWeplayFile;
const HAND_SPLIT_REGEX = /(?=^Weplay Hand #\d+:)/gm;
function normalizeTableLine(line) {
    if (!line.startsWith("Table ")) {
        return line;
    }
    return line
        .replace(/\(\d+\)/, "")
        .replace(/\s+\(Money 3\)/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}
function normalizeSummaryTotal(line) {
    if (!line.startsWith("Total pot")) {
        return line;
    }
    const beforePipe = line.split("|")[0].trim();
    const rakeMatch = line.match(/Rake\s+([$\d.]+)/);
    const rake = rakeMatch ? rakeMatch[1] : "$0";
    return `${beforePipe} | Rake ${rake} | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0`;
}
function shouldDropLine(line) {
    return (line.includes("has timed out") ||
        line.includes("leaves the table") ||
        line.includes("sits out") ||
        line.includes("while being disconnected"));
}
function normalizeLine(line) {
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
function parseHeader(line) {
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
    const gameType = payload.includes("Tournament") ? "tournament" : "cash";
    const dateMatch = payload.match(/-\s(\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2})$/);
    const playedAt = dateMatch ? dateMatch[1].replace(" ", "T") + "Z" : null;
    return {
        convertedHeader: `Poker Hand #HD${sourceHandId}: ${payload}`,
        sourceHandId,
        gameType,
        playedAt,
    };
}
function extractPlayers(lines) {
    const players = new Map();
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
function extractKnownCards(lines) {
    const result = new Map();
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
function extractActions(lines) {
    return lines.filter((line) => line.includes(":") && !line.startsWith("Seat "));
}
function tableNameFromLines(lines) {
    const tableLine = lines.find((line) => line.startsWith("Table "));
    if (!tableLine) {
        return null;
    }
    const match = tableLine.match(/^Table '(.+?)'/);
    return match ? match[1] : null;
}
function outputNameFromInput(inputFileName) {
    return `${inputFileName.replace(/\.txt$/i, "")}.gg.txt`;
}
function convertWeplayFile(inputFileName, input) {
    const chunks = input
        .split(HAND_SPLIT_REGEX)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
    const hands = [];
    const fileWarnings = [];
    for (const chunk of chunks) {
        const rawLines = chunk.split(/\r?\n/);
        const rawHeader = rawLines[0] ?? "";
        const headerMeta = parseHeader(rawHeader);
        const warnings = [];
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
