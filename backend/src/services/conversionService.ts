import { randomUUID } from "node:crypto";
import { formatHandsAsGg } from "../formatters/ggFormatter.js";
import type { ConvertedFile, ConversionReport } from "../domain/types.js";
import { parseWeplayText } from "../parsers/weplayParser.js";

interface StoredJob {
  report: ConversionReport;
  convertedFiles: ConvertedFile[];
}

const jobs = new Map<string, StoredJob>();

function outputNameFromInput(inputFileName: string): string {
  const safeBase = inputFileName.replace(/\.txt$/i, "");
  return `${safeBase}.gg.txt`;
}

export function convertUploadedFiles(
  files: Array<{ originalname: string; buffer: Buffer }>,
): StoredJob {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const convertedFiles: ConvertedFile[] = [];
  const reportFiles: ConversionReport["files"] = [];

  for (const file of files) {
    try {
      const inputText = file.buffer.toString("utf8");
      const parsedHands = parseWeplayText(inputText);
      const outputText = formatHandsAsGg(parsedHands);
      const warnings = parsedHands.flatMap((hand) => hand.warnings);
      const outputFileName = outputNameFromInput(file.originalname);

      convertedFiles.push({
        inputFileName: file.originalname,
        outputFileName,
        handCount: parsedHands.length,
        warnings,
        outputText,
      });

      reportFiles.push({
        inputFileName: file.originalname,
        outputFileName,
        handCount: parsedHands.length,
        warningCount: warnings.length,
        status: "converted",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown conversion error";
      reportFiles.push({
        inputFileName: file.originalname,
        outputFileName: outputNameFromInput(file.originalname),
        handCount: 0,
        warningCount: 0,
        status: "failed",
        message,
      });
    }
  }

  const report: ConversionReport = {
    id,
    createdAt,
    files: reportFiles,
  };

  const payload: StoredJob = { report, convertedFiles };
  jobs.set(id, payload);
  return payload;
}

export function getJob(id: string): StoredJob | undefined {
  return jobs.get(id);
}
