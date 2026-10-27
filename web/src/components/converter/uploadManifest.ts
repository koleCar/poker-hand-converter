/**
 * What an upload has stored so far, kept in the browser so it can resume (R4.2).
 *
 * ## What "resume" means
 *
 * A web page cannot reopen a file after a reload: the `File` handles of a drop
 * die with the tab. So an interrupted upload - tab closed, page reloaded,
 * network gone for longer than the retries, the day's budget spent - resumes
 * when **the user drops the same files or folder again**. The converter then
 * skips every file whose hands (and original, when kept) are all stored, and
 * inside a half-stored file the batches already stored: only the rest is
 * read, converted and sent. The page says so when it opens with an unfinished
 * upload ("412 of 1 030 files saved - drop the same files again to finish").
 *
 * Correctness does not depend on this record: the server dedupes on
 * `(owner, hand_key)`, so sending a stored hand again inserts nothing. The
 * record saves the time, the bandwidth and the account's budget of doing so.
 *
 * ## What is kept
 *
 * In IndexedDB (`rail-uploads`), per account: one `uploads` row per upload
 * (id, when, the dropped inputs' names and sizes, the counts so far) and one
 * `sources` row per file or archive entry touched (its key from
 * `bulkSource.ts`, the batches stored, done or not). Keys are paths, sizes,
 * times and CRCs - never hand text. A finished upload's rows are deleted;
 * only the newest unfinished upload per account is offered for resuming.
 */

import type { ResumeState } from "./bulkRun";

export interface UploadCounts {
  inserted: number;
  duplicates: number;
  refused: number;
  sourcesDone: number;
  originalsStored: number;
}

export interface UploadManifest {
  id: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  keepOriginals: boolean;
  /** The dropped inputs (first 200), to recognise the same drop again. */
  inputs: Array<{ path: string; size: number }>;
  inputCount: number;
  inputBytes: number;
  counts: UploadCounts;
  finished: boolean;
}

export interface SourceRecord {
  upload: string;
  key: string;
  /** Batches of this source stored, from its first. */
  batches: number;
  /** Every hand (and the original, when kept) stored. */
  done: boolean;
}

export interface ManifestStore {
  /** The account's newest unfinished upload. */
  latest(userId: string): Promise<UploadManifest | null>;
  put(manifest: UploadManifest): Promise<void>;
  sources(uploadId: string): Promise<SourceRecord[]>;
  putSource(record: SourceRecord): Promise<void>;
  remove(uploadId: string): Promise<void>;
}

export const EMPTY_COUNTS: UploadCounts = {
  inserted: 0,
  duplicates: 0,
  refused: 0,
  sourcesDone: 0,
  originalsStored: 0,
};

const MAX_LISTED_INPUTS = 200;

export function newManifest(
  userId: string,
  inputs: Array<{ path: string; size: number }>,
  keepOriginals: boolean,
  id: string = randomId(),
  now: Date = new Date(),
): UploadManifest {
  return {
    id,
    userId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    keepOriginals,
    inputs: inputs.slice(0, MAX_LISTED_INPUTS),
    inputCount: inputs.length,
    inputBytes: inputs.reduce((sum, input) => sum + input.size, 0),
    counts: { ...EMPTY_COUNTS },
    finished: false,
  };
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Is this drop (at least partly) the unfinished upload again? Any input with
 * the same path and size is enough: a user finishing an upload may drop the
 * folder it came from, or only the files that were left.
 */
export function isSameUpload(manifest: UploadManifest, inputs: Array<{ path: string; size: number }>): boolean {
  const known = new Set(manifest.inputs.map((input) => `${input.path}\u0000${input.size}`));
  return inputs.some((input) => known.has(`${input.path}\u0000${input.size}`));
}

/** The worker's view of what is stored. */
export function resumeStateOf(records: SourceRecord[]): ResumeState {
  return {
    done: records.filter((record) => record.done).map((record) => record.key),
    batches: records
      .filter((record) => !record.done && record.batches > 0)
      .map((record) => [record.key, record.batches] as [string, number]),
  };
}

/* --------------------------------------------------------------- memory - */

/** A store that lives as long as the page; for tests, and when IndexedDB is unavailable. */
export function memoryManifestStore(): ManifestStore {
  const uploads = new Map<string, UploadManifest>();
  const sources = new Map<string, SourceRecord>();
  const id = (upload: string, key: string) => `${upload}\u0000${key}`;
  return {
    async latest(userId) {
      const mine = [...uploads.values()]
        .filter((manifest) => manifest.userId === userId && !manifest.finished)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return mine[0] ? structuredClone(mine[0]) : null;
    },
    async put(manifest) {
      uploads.set(manifest.id, structuredClone(manifest));
    },
    async sources(uploadId) {
      return [...sources.values()].filter((record) => record.upload === uploadId).map((record) => ({ ...record }));
    },
    async putSource(record) {
      sources.set(id(record.upload, record.key), { ...record });
    },
    async remove(uploadId) {
      uploads.delete(uploadId);
      for (const [key, record] of sources) {
        if (record.upload === uploadId) {
          sources.delete(key);
        }
      }
    },
  };
}

/* ------------------------------------------------------------ IndexedDB - */

const DB_NAME = "rail-uploads";
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * The browser's store, or null when IndexedDB is unavailable (some private
 * modes): the upload then works as before, without resuming.
 */
export function indexedDbManifestStore(): ManifestStore | null {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) {
    return null;
  }
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("uploads")) {
          db.createObjectStore("uploads", { keyPath: "id" }).createIndex("user", "userId");
        }
        if (!db.objectStoreNames.contains("sources")) {
          db.createObjectStore("sources", { keyPath: ["upload", "key"] }).createIndex("upload", "upload");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };

  return {
    async latest(userId) {
      const db = await open();
      const all = await request(db.transaction("uploads").objectStore("uploads").index("user").getAll(userId)) as UploadManifest[];
      return all.filter((manifest) => !manifest.finished).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    },
    async put(manifest) {
      const db = await open();
      const tx = db.transaction("uploads", "readwrite");
      tx.objectStore("uploads").put(manifest);
      await done(tx);
    },
    async sources(uploadId) {
      const db = await open();
      return await request(db.transaction("sources").objectStore("sources").index("upload").getAll(uploadId)) as SourceRecord[];
    },
    async putSource(record) {
      const db = await open();
      const tx = db.transaction("sources", "readwrite");
      tx.objectStore("sources").put(record);
      await done(tx);
    },
    async remove(uploadId) {
      const db = await open();
      const tx = db.transaction(["uploads", "sources"], "readwrite");
      tx.objectStore("uploads").delete(uploadId);
      const index = tx.objectStore("sources").index("upload");
      const keys = await request(index.getAllKeys(uploadId));
      for (const key of keys) {
        tx.objectStore("sources").delete(key);
      }
      await done(tx);
    },
  };
}
