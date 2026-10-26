/**
 * The account export (Rail R6.5, GDPR Art. 15 / 20): pages through the
 * owner-only readers and writes one ZIP, in the browser.
 *
 *   README.md          what each file is, in the reader's language
 *   manifest.json      format, times, options, every file with its row count,
 *                      the server's counts and the data inventory
 *   profile.json       the account, profile, plan, roles, reserved names
 *   hands/hands-00001.ndjson ...   2 000 hands a file: id, key, origin, times,
 *                      stored texts and the PHF document as stored
 *   hand_stats/..., analysis/...   (optional) the same hands' statistics and
 *                      analysis rows, one file per hands file
 *   <section>.ndjson   every other table the inventory exports, one JSON
 *                      object per line, columns as in the database
 *   originals/...      (optional) the original files kept on an upload,
 *                      as stored (gzip)
 *
 * Why the browser, and why page files: see the migration's header. A page of
 * hands is one entry, so derived rows never wait in memory for a file to
 * close; the tab holds one page at a time.
 */

import type { Cursor, ExportManifest, ExportSource, InventoryEntry } from "../db/accountData";
import type { ZipWriter } from "./zipWriter";

export const EXPORT_FORMAT = "rail-account-export/1";

export type ExportPhase = "manifest" | "profile" | "hands" | "sections" | "originals" | "finishing" | "done";

export interface ExportProgress {
  phase: ExportPhase;
  handsDone: number;
  handsTotal: number;
  sectionsDone: number;
  sectionsTotal: number;
  originalsDone: number;
  originalsTotal: number;
  bytes: number;
}

export interface ExportedFile {
  name: string;
  section: string;
  rows: number;
}

export interface ReadmeContext {
  manifest: ExportManifest;
  derived: boolean;
  originals: boolean;
  exportedAt: string;
}

export interface ExportOptions {
  /** Statistics and analysis rows with the hands (rebuildable from the PHF). */
  derived: boolean;
  /** The original files kept on an upload. */
  originals: boolean;
  readme: (context: ReadmeContext) => string;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
  handsPageSize?: number;
  rowsPageSize?: number;
  /** Transient failures retried per call (a network blip mid-export). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ExportResult {
  files: ExportedFile[];
  rows: number;
  bytes: number;
  entries: number;
}

export class ExportCancelled extends Error {
  constructor() {
    super("The export was cancelled.");
    this.name = "ExportCancelled";
  }
}

/** Codes a retry cannot fix: the budget, the session, a bad request. */
const FINAL_CODES = new Set(["53400", "42501", "22023", "PGRST202"]);

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

const HANDS_SECTIONS = ["hand_stats", "hand_stats_ev", "hand_analysis", "decision_analysis"] as const;

/** `hands/hands-NNNN.ndjson` with the page number. */
function pageFile(pattern: string | null, section: string, page: number): string {
  const base = pattern ?? `${section}/${section}-NNNN.ndjson`;
  return base.replace(/N{4,}/, String(page).padStart(5, "0"));
}

function ndjson(rows: readonly unknown[]): string {
  let out = "";
  for (const row of rows) {
    out += JSON.stringify(row) + "\n";
  }
  return out;
}

export async function exportAccount(source: ExportSource, zip: ZipWriter, options: ExportOptions): Promise<ExportResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.attempts ?? 3);
  // The server pages 1 000 hands with their derived rows, 2 000 without.
  const handsPageSize = options.handsPageSize ?? (options.derived ? 1000 : 2000);
  const rowsPageSize = options.rowsPageSize ?? 5000;
  const now = options.now ?? (() => new Date());
  const files: ExportedFile[] = [];
  let rows = 0;

  const progress: ExportProgress = {
    phase: "manifest",
    handsDone: 0,
    handsTotal: 0,
    sectionsDone: 0,
    sectionsTotal: 0,
    originalsDone: 0,
    originalsTotal: 0,
    bytes: 0,
  };
  const report = (phase?: ExportPhase) => {
    if (phase) progress.phase = phase;
    progress.bytes = zip.bytesWritten;
    options.onProgress?.({ ...progress });
  };
  const checkCancel = () => {
    if (options.signal?.aborted) throw new ExportCancelled();
  };
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      checkCancel();
      try {
        return await run();
      } catch (error) {
        const code = codeOf(error);
        if (attempt >= attempts || (code !== null && FINAL_CODES.has(code))) throw error;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  };

  report("manifest");
  const manifest = await call(() => source.manifest());
  const inventory: InventoryEntry[] = Array.isArray(manifest.inventory) ? manifest.inventory : [];
  const byName = new Map(inventory.filter((e) => e.section).map((e) => [e.section as string, e]));
  const exportedAt = now().toISOString();

  await zip.addEntry(
    "README.md",
    options.readme({ manifest, derived: options.derived, originals: options.originals, exportedAt }),
  );

  report("profile");
  const profile = await call(() => source.profile());
  await zip.addEntry("profile.json", JSON.stringify(profile, null, 2) + "\n");
  files.push({ name: "profile.json", section: "profile", rows: 1 });

  // Hands, a page a file; their derived rows beside them.
  progress.handsTotal = Number(manifest.counts?.hands ?? 0);
  report("hands");
  let after: Cursor = null;
  for (let page = 1; ; page++) {
    const result = await call(() => source.hands(after, handsPageSize, options.derived));
    if (result.hands.length > 0) {
      const name = pageFile(byName.get("hands")?.file ?? null, "hands", page);
      await zip.addEntry(name, ndjson(result.hands));
      files.push({ name, section: "hands", rows: result.hands.length });
      rows += result.hands.length;
      progress.handsDone += result.hands.length;
    }
    if (options.derived) {
      for (const section of HANDS_SECTIONS) {
        const list = result[section];
        if (!list || list.length === 0) continue;
        const name = pageFile(byName.get(section)?.file ?? null, section, page);
        await zip.addEntry(name, ndjson(list));
        files.push({ name, section, rows: list.length });
        rows += list.length;
      }
    }
    report();
    after = result.next;
    if (!after) break;
  }

  // Every other exported table, one file each.
  const sections = inventory
    .filter((e) => (e.reader === "rows" || e.reader === "sealed") && e.section && e.file)
    .sort((a, b) => (a.file as string).localeCompare(b.file as string));
  progress.sectionsTotal = sections.length;
  report("sections");
  for (const entry of sections) {
    let writer: Awaited<ReturnType<ZipWriter["openEntry"]>> | null = null;
    let count = 0;
    let cursor: Cursor = null;
    for (;;) {
      const result = await call(() =>
        source.rows(entry.reader as "rows" | "sealed", entry.section as string, cursor, rowsPageSize)
      );
      if (result.rows.length > 0) {
        writer ??= await zip.openEntry(entry.file as string);
        await writer.write(ndjson(result.rows));
        count += result.rows.length;
      }
      cursor = result.next;
      if (!cursor) break;
    }
    if (writer) {
      await writer.close();
      files.push({ name: entry.file as string, section: entry.section as string, rows: count });
      rows += count;
    }
    progress.sectionsDone++;
    report();
  }

  // The original files, as stored.
  if (options.originals) {
    progress.originalsTotal = Number(manifest.counts?.hand_uploads ?? 0);
    report("originals");
    let cursor: Cursor = null;
    for (;;) {
      const result = await call(() => source.rows("rows", "hand_uploads", cursor, 500));
      for (const row of result.rows) {
        const name = String(row.name ?? "");
        const relative = name.slice(name.indexOf("/") + 1);
        if (!relative) continue;
        const bytes = await call(() => source.upload(name));
        await zip.addEntry(`originals/${relative}`, bytes, { compress: false });
        files.push({ name: `originals/${relative}`, section: "hand_uploads", rows: 1 });
        progress.originalsDone++;
        report();
      }
      cursor = result.next;
      if (!cursor) break;
    }
  }

  report("finishing");
  await zip.addEntry(
    "manifest.json",
    JSON.stringify(
      {
        format: EXPORT_FORMAT,
        serverFormat: manifest.format,
        generatedAt: manifest.generatedAt,
        exportedAt,
        accountId: manifest.accountId,
        options: { derived: options.derived, originals: options.originals },
        files,
        serverCounts: manifest.counts,
        inventory,
      },
      null,
      2,
    ) + "\n",
  );
  const done = await zip.finish();
  progress.bytes = done.bytes;
  report("done");
  return { files, rows, bytes: done.bytes, entries: done.entries };
}

/** `rail-export-<username>-2026-10-26.zip` */
export function exportFileName(username: string | null, at: Date): string {
  const safe = (username ?? "account").replace(/[^A-Za-z0-9_-]/g, "") || "account";
  return `rail-export-${safe}-${at.toISOString().slice(0, 10)}.zip`;
}
