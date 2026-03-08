export type GameType = "cash" | "tournament";

export interface ParsedHand {
  handId: string;
  gameType: GameType;
  originalHeader: string;
  convertedHeader: string;
  lines: string[];
  warnings: string[];
}

export interface ConvertedFile {
  inputFileName: string;
  outputFileName: string;
  handCount: number;
  warnings: string[];
  outputText: string;
}

export interface ConversionReport {
  id: string;
  createdAt: string;
  files: Array<{
    inputFileName: string;
    outputFileName: string;
    handCount: number;
    warningCount: number;
    status: "converted" | "failed";
    message?: string;
  }>;
}
