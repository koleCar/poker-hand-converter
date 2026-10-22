/**
 * Web/app parity (docs/RAIL-PLAN.md R4.4, Phase 4's exit): the same corpus
 * files through the desktop app's path and the web's bulk upload give the
 * same stored rows, and the web renders them the same.
 *
 * Against a **local** Supabase stack only (it creates and deletes two users
 * with the stack's service key, and reads and edits rows as `postgres`):
 *
 *   RAIL_PARITY_URL=http://127.0.0.1:<api port> \
 *   RAIL_PARITY_ANON_KEY=... RAIL_PARITY_SERVICE_KEY=... \
 *   RAIL_PARITY_PSQL="docker exec -i supabase_db_<project> psql -U postgres -d postgres" \
 *   npm run parity
 *
 * (`supabase status -o env` prints the keys. The GoTrue that a committed
 * `supabase/.temp/gotrue-version` pins refuses the stack's HS256 service key
 * on its admin API: start the stack from a copy without `.temp`, as CI does.)
 * `RAIL_PARITY_CORPUS`: `all` (default: every corpus file the goldens cover),
 * `sample` (the first two files of every corpus folder - every room and
 * format; a quick local run) or a comma-separated list of repository paths
 * (files or folders). `RAIL_PARITY_APP_BIN`: a built `parity_app` example to
 * run instead of `cargo run --release`. `RAIL_PARITY_KEEP=1` keeps the users
 * and their rows for a look afterwards.
 *
 * **The two paths**, each the product's own code end to end:
 *
 * - **App** (user A): `core/rail-sync/examples/parity_app.rs` - the files
 *   copied into a folder, a fresh `rail-store`, the `rail-watch` watcher on
 *   the folder (the incremental reader, native `rail-core`), the sync worker
 *   (`rail_sync::worker`, the real `Account` and `IngestClient`) draining the
 *   outbox into `ingest_hands` from the folder's `hand_sources` row:
 *   `origin = 'desktop'`.
 * - **Web** (user B): the converter's bulk run (`startBulkRun`, the code the
 *   conversion worker runs, and the page when no worker starts) over the same
 *   files as one multi-file drop, with the committed WebAssembly core
 *   (`lib/wasm/engine.ts`), its batches into the bulk saver (`createBulkSaver`
 *   over `createUploadApi` and a supabase-js client signed in as B, wired as
 *   `ConverterTab` wires them) - `ingest_hands` from the account's web
 *   source: `origin = 'upload'`.
 *
 * Two accounts, because one would dedupe the second path's rows into nothing
 * (`on conflict (owner_id, hand_key) do nothing`).
 *
 * **Statistics.** Neither path writes `hand_stats` itself: the app sends the
 * PHF only (R1.8, Q4), and the web's upload stores the PHF and then asks for a
 * rebuild. Both get their rows from the web's rebuild route
 * (`app/api/stats/rebuild/route.ts`: `hands_needing_stats` -> TypeScript
 * `handStatsRows` / `handEvRow` -> `save_hand_stats` / `save_hand_ev`), run
 * here as each user with villain rows on, so every seat is compared. Hands
 * with a seat number outside `hand_stats_seat_ok` (0-24; Ignition's
 * tournament seats run past 100) make the route fail for the whole account,
 * on either path alike - R4.4's finding F1 - so they are taken out of both
 * accounts before the rebuild, listed and counted.
 *
 * **Compared** (`psql` as `postgres`): every `hands` column but `id`,
 * `owner_id`, `origin` and `created_at`, as jsonb text - byte for byte - with
 * `phf` whole but for `meta.parsedAt` (the moment of conversion; its form is
 * checked on both sides); every `hand_stats` and `hand_stats_ev` column but
 * `hand_id`, `owner_id` and `created_at`, keyed by (hand key, version, seat).
 * The corpus holds some hands in more than one file, not always the same
 * text (a masked copy, say); each path stores the copy it read first, and
 * the watcher's order is not the drop's. Where the two stored copies come
 * from different files, the app's row is compared instead with the web's
 * conversion of *that* file (its PHF, byte for byte) and the pair is left out
 * of the row, statistics and rendering comparisons (counted as `split`).
 * **Rendered** (the web's readers, as each user): `get_hand` ->
 * `toHandRecord` (the record and its derived standard text) and the
 * replayer's frames - from the text as `ReplayerTab` builds them and from
 * the PHF as the analysis views do.
 *
 * A difference fails with the file, the hand key, the column and the first
 * differing byte and JSON path. A last step edits a few rows inside a
 * rolled-back transaction and checks the comparison reports each edit.
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startBulkRun, type BulkMessage } from "../../../frontend/src/components/converter/bulkRun";
import type { InputItem } from "../../../frontend/src/components/converter/bulkSource";
import { createBulkSaver, ingestRowOf, type SaveProgress } from "../../../frontend/src/components/converter/bulkSaver";
import { newManifest } from "../../../frontend/src/components/converter/uploadManifest";
import { handKeyOf, toHandRecord } from "../../../frontend/src/lib/db/mapping";
import { createUploadApi, type UploadClient } from "../../../frontend/src/lib/db/upload";
import { parseHand } from "../../../frontend/src/lib/phf";
import type { PhfHand } from "../../../frontend/src/lib/phf/types";
import { buildReplay } from "../../../frontend/src/lib/replay";
import { resetConversionEngine } from "../../../frontend/src/lib/wasm/engine";
import { ROOT, listInputs } from "../golden/emit";

/* ------------------------------------------------------------------ setup - */

/** The rebuild route's Supabase client: the user it is run as. */
const route = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../../frontend/src/lib/supabase/server", () => ({
  getWritableServerSupabase: async () => route.client,
}));

const URL_ = process.env.RAIL_PARITY_URL ?? "";
const ANON = process.env.RAIL_PARITY_ANON_KEY ?? "";
const SERVICE = process.env.RAIL_PARITY_SERVICE_KEY ?? "";
const PSQL = process.env.RAIL_PARITY_PSQL ?? "";
const CORPUS = process.env.RAIL_PARITY_CORPUS ?? "all";
const KEEP = process.env.RAIL_PARITY_KEEP === "1";
const CONFIGURED = Boolean(URL_ && ANON && SERVICE && PSQL);

/** `meta.parsedAt` as both paths write it: `Date.prototype.toISOString`'s form. */
const PARSED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** What the masked `meta.parsedAt` reads in a comparison. */
const MASK_TIME = "(conversion time)";

/** Columns that differ by design (docs/RAIL-PLAN.md R4.4 says why). */
const NOT_COMPARED = {
  hands: ["id", "owner_id", "origin", "created_at"],
  stats: ["hand_id", "owner_id", "created_at"],
} as const;

/** `hand_stats_seat_ok` (migration 20261005090000): the seats a statistics row may have. */
const STATS_SEATS = { min: 0, max: 24 };

type SupabaseClient = UploadClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  auth: UploadClient["auth"] & { setSession(s: Session): Promise<{ error: unknown }> };
  from(table: string): {
    select(columns: string): {
      order(column: string): {
        range(from: number, to: number): PromiseLike<{ data: Array<{ id: string; hand_key: string }> | null; error: { message: string } | null }>;
      };
    };
  };
};

interface Session {
  access_token: string;
  refresh_token: string;
}

interface User {
  id: string;
  email: string;
}

/* ---------------------------------------------------------------- helpers - */

/** The corpus files of this run, as repository paths in byte order. */
function selectedFiles(): string[] {
  const all = listInputs();
  if (CORPUS === "all") {
    return all;
  }
  if (CORPUS === "sample") {
    const byDir = new Map<string, string[]>();
    for (const path of all) {
      const dir = dirname(path);
      byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
    }
    return [...byDir.values()].flatMap((paths) => paths.slice(0, 2)).sort();
  }
  const wanted = CORPUS.split(",").map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean);
  return all.filter((path) => wanted.some((w) => path === w || path.startsWith(`${w}/`)));
}

/** Serves the committed `.wasm` from disk to the core's loader; every other request goes out. */
function wasmFromDisk(): void {
  const network = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    if (href.startsWith("file:")) {
      return new Response(readFileSync(fileURLToPath(href)), { headers: { "Content-Type": "application/wasm" } });
    }
    return network(input, init);
  }) as typeof fetch);
}

async function admin(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${URL_}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`auth admin ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

async function createUser(name: string, tag: string): Promise<User> {
  const email = `parity-${name}-${tag}@example.test`;
  const created = await admin("POST", "users", { email, email_confirm: true });
  return { id: String(created!.id), email };
}

/**
 * A fresh session of `user`: a magic-link token minted with the service key
 * and redeemed at `/verify` (what the desktop sign-in does, R1.7). No
 * password and no captcha, so no request leaves the machine.
 */
async function session(user: User): Promise<Session> {
  const link = await admin("POST", "generate_link", { type: "magiclink", email: user.email });
  const hash = (link!.hashed_token ?? (link!.properties as Record<string, unknown> | undefined)?.hashed_token) as string;
  const response = await fetch(`${URL_}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: hash }),
  });
  if (!response.ok) {
    throw new Error(`verify: ${response.status}`);
  }
  const body = (await response.json()) as Session;
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/** A supabase-js client signed in as `user` - the tab's own kind of client. */
async function clientFor(user: User): Promise<SupabaseClient> {
  const { createClient } = (await import(
    "../../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs"
  )) as { createClient(url: string, key: string, options: unknown): SupabaseClient };
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.setSession(await session(user));
  if (error) {
    throw new Error(`setSession: ${String(error)}`);
  }
  return client;
}

/** Runs `psql` with `sql` on stdin; the output lines. */
function psql(sql: string): Promise<string[]> {
  const [command, ...args] = PSQL.split(/\s+/);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, "-At", "-q", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`psql exited ${code}: ${Buffer.concat(err).toString().slice(0, 2000)}`));
        return;
      }
      resolve(Buffer.concat(out).toString().split("\n").filter(Boolean));
    });
    child.stdin.end(sql);
  });
}

/** The lines of `lines` tagged `prefix`, parsed. */
function tagged(lines: string[], prefix: string): Array<Record<string, unknown>> {
  return lines.filter((l) => l.startsWith(`${prefix} `)).map((l) => JSON.parse(l.slice(prefix.length + 1)) as Record<string, unknown>);
}

/** Where two strings first differ, with a little of each around it. */
function firstByte(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  return `first difference at character ${i}: app ${around(a)} / web ${around(b)}`;
}

/** The first JSON path at which two values differ. */
function firstPath(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) {
    return null;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return `${path}: app ${JSON.stringify(a)?.slice(0, 120)} / web ${JSON.stringify(b)?.slice(0, 120)}`;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const found = firstPath(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`,
    );
    if (found) {
      return found;
    }
  }
  return null;
}

/** A `diff` line as a readable sentence. */
function describeDiff(diff: Record<string, unknown>, fileOf: (key: unknown) => string): string {
  const app = String(diff.app ?? "null");
  const web = String(diff.web ?? "null");
  let detail = firstByte(app, web);
  if (diff.column === "phf") {
    detail += `; ${firstPath(JSON.parse(app), JSON.parse(web))}`;
  }
  return `${diff.table} ${diff.key} column ${diff.column} (file ${fileOf(diff.handKey)}): ${detail}`;
}

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        await work(items[next++]);
      }
    }),
  );
}

/* ------------------------------------------------------------------ state - */

const tag = Math.random().toString(36).slice(2, 8);
const files = selectedFiles();
/** Hand key -> the repository paths whose conversion holds it (from the web run). */
const keyFiles = new Map<string, Set<string>>();
/** Hand key -> `meta.originalFilename` -> the PHF the web would send, for keys in more than one file. */
const copies = new Map<string, Map<string, string>>();
/** Keys whose two stored rows came from different files. */
const split = new Set<string>();
let appUser: User;
let webUser: User;
let appClient: SupabaseClient;
let webClient: SupabaseClient;
const timings: Record<string, number> = {};
const report: Record<string, unknown> = { corpus: CORPUS, files: files.length };
const fileOf = (key: unknown) => [...(keyFiles.get(String(key)) ?? [])].join(", ") || "(not in the web run)";

const describeStack = CONFIGURED ? describe : describe.skip;

describeStack("web/app parity (R4.4)", () => {
  beforeAll(async () => {
    const host = new URL(URL_).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      throw new Error("Refusing: the parity test creates and deletes users, so it runs against a local stack only.");
    }
    expect(files.length).toBeGreaterThan(0);
    appUser = await createUser("app", tag);
    webUser = await createUser("web", tag);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    console.log(`parity: ${JSON.stringify({ ...report, timings })}`);
    if (!KEEP) {
      for (const user of [appUser, webUser]) {
        if (user) {
          await admin("DELETE", `users/${user.id}`).catch(() => undefined);
        }
      }
    }
  });

  it("app path: watcher, local store, sync worker, ingest_hands", async () => {
    const work = mkdtempSync(join(tmpdir(), "rail-parity-app-"));
    const folder = join(work, "hh");
    for (const path of files) {
      const target = join(folder, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(ROOT, path), target);
    }
    mkdirSync(join(work, "store"));
    const started = Date.now();
    const appSession = await session(appUser);
    const bin = process.env.RAIL_PARITY_APP_BIN;
    const [command, args] = bin
      ? [bin, []]
      : ["cargo", ["run", "--quiet", "--release", "--locked", "-p", "rail-sync", "--example", "parity_app"]];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          RAIL_PARITY_URL: URL_,
          RAIL_PARITY_ANON_KEY: ANON,
          RAIL_PARITY_USER_ID: appUser.id,
          RAIL_PARITY_EMAIL: appUser.email,
          RAIL_PARITY_REFRESH: appSession.refresh_token,
          RAIL_PARITY_FOLDER: folder,
          RAIL_PARITY_WORK: join(work, "store"),
          // The app never holds the service key.
          RAIL_PARITY_SERVICE_KEY: "",
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        const text = Buffer.concat(out).toString();
        if (code !== 0) {
          reject(new Error(`parity_app exited ${code}: ${text.slice(0, 2000)}`));
        } else {
          resolve(text);
        }
      });
    });
    timings.appMs = Date.now() - started;
    const summary = JSON.parse(output.trim().split("\n").at(-1)!) as Record<string, unknown>;
    report.app = summary;
    expect(summary.files).toBe(files.length);
    expect(summary.rejected).toEqual([]);
  });

  it("web path: the converter's bulk run, the WASM core, the bulk saver, ingest_hands", async () => {
    webClient = await clientFor(webUser);
    wasmFromDisk();
    resetConversionEngine();
    const items: InputItem[] = files.map((path) => {
      const full = join(ROOT, path);
      const file = new File([readFileSync(full)], basename(path), { lastModified: Math.floor(statSync(full).mtimeMs) });
      return { kind: "file", file, path };
    });
    const sourcePaths = new Map<string, string>();
    const converted = new Map<string, Map<string, string>>();
    const started = Date.now();
    const manifest = newManifest(webUser.id, files.map((path) => ({ path, size: statSync(join(ROOT, path)).size })), false);
    let run: ReturnType<typeof startBulkRun> | null = null;
    let finish!: (progress: SaveProgress) => void;
    const saved = new Promise<SaveProgress>((resolve) => {
      finish = resolve;
    });
    const saver = createBulkSaver({
      api: createUploadApi(webClient),
      store: null,
      manifest,
      userId: webUser.id,
      ack: (batches) => run?.ack(batches),
      onDone: finish,
    });
    // As `ConverterTab` wires the worker's messages to the saver (its WORKER_WINDOW is 4).
    run = startBulkRun(
      {
        type: "bulk",
        jobId: 1,
        items,
        options: { validate: true },
        keepOriginals: false,
        resume: { done: [], batches: [] },
        window: 4,
      },
      (message: BulkMessage) => {
        // The worker's messages cross a `postMessage`: a structured clone.
        const m = structuredClone(message);
        if (m.type === "bulk-source") {
          // A dropped file's key is `f|<path>|<size>|<mtime>`.
          sourcePaths.set(m.source.id, m.source.key.split("|")[1] ?? m.source.name);
          saver.addSource(m.source);
        } else if (m.type === "bulk-batch") {
          const { type: _type, jobId: _job, ...batch } = m;
          for (const hand of batch.hands) {
            const key = handKeyOf(hand);
            keyFiles.set(key, (keyFiles.get(key) ?? new Set<string>()).add(sourcePaths.get(batch.sourceId) ?? batch.sourceId));
            const byFile = converted.get(key) ?? new Map<string, string>();
            byFile.set(String(hand.meta.originalFilename), JSON.stringify(ingestRowOf(hand).phf));
            converted.set(key, byFile);
          }
          saver.addBatch(batch);
        } else if (m.type === "bulk-source-end") {
          saver.endSource(m.key);
        }
      },
      () => false,
    );
    const engine = await run.finished;
    saver.close();
    const progress = await saved;
    timings.webMs = Date.now() - started;
    for (const [key, paths] of keyFiles) {
      if (paths.size > 1) {
        copies.set(key, converted.get(key)!);
      }
    }
    report.web = {
      engine,
      received: progress.received,
      inserted: progress.inserted,
      duplicates: progress.duplicates,
      refused: progress.refused,
      refusedReasons: progress.refusedReasons,
    };
    expect(engine).toBe("wasm");
    expect(progress.state).toBe("done");
    expect(progress.refused).toBe(0);
    expect(progress.inserted).toBe(keyFiles.size);
  });

  it("stored hands: every column byte for byte", async () => {
    const started = Date.now();
    const lines = await psql(compareSql({ app: appUser.id, web: webUser.id, part: "hands" }));
    timings.compareHandsMs = Date.now() - started;
    const counts = tagged(lines, "count")[0];
    for (const line of tagged(lines, "split")) {
      split.add(String(line.handKey));
    }
    report.hands = { ...counts, inSeveralFiles: copies.size, split: split.size };
    const problems = problemsOf(lines);
    expect(counts.app).toBe(counts.web);
    expect(counts.app).toBe(keyFiles.size);
    expect(problems, `${problems.length} difference(s): ${JSON.stringify(tagged(lines, "difftotal")[0])}`).toEqual([]);
  });

  it("rendered: the record, its standard text and the replayer's frames", async () => {
    appClient = await clientFor(appUser);
    const started = Date.now();
    const ids = async (client: SupabaseClient) => {
      const out = new Map<string, string>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from("hands").select("id, hand_key").order("id").range(from, from + 999);
        if (error) {
          throw new Error(error.message);
        }
        for (const row of data ?? []) {
          out.set(row.hand_key, row.id);
        }
        if (!data || data.length < 1000) {
          return out;
        }
      }
    };
    const appIds = await ids(appClient);
    const webIds = await ids(webClient);
    expect(appIds.size).toBe(webIds.size);

    const view = async (client: SupabaseClient, id: string, key: string) => {
      const { data, error } = await client.rpc("get_hand", { p_id: id });
      if (error || !data) {
        throw new Error(`get_hand ${key}: ${error?.message ?? "no row"}`);
      }
      const record = toHandRecord(data as Record<string, unknown>);
      const { id: _id, createdAt: _created, ...rest } = record;
      const parsed = parseHand(record.standardText);
      return {
        record: { ...rest, phf: { ...rest.phf, meta: { ...rest.phf.meta, parsedAt: MASK_TIME } } },
        standardText: record.standardText,
        textFrames: parsed ? buildReplay(parsed) : null,
        phfFrames: buildReplay(structuredClone(record.phf) as PhfHand),
      };
    };

    const keys = [...appIds.keys()].filter((key) => !split.has(key)).sort();
    const problems: string[] = [];
    await mapLimit(keys, 16, async (key) => {
      const webId = webIds.get(key);
      if (!webId) {
        problems.push(`render ${key}: no web row`);
        return;
      }
      const [app, web] = await Promise.all([view(appClient, appIds.get(key)!, key), view(webClient, webId, key)]);
      if (app.standardText !== web.standardText) {
        problems.push(`render ${key} standard text (file ${fileOf(key)}): ${firstByte(app.standardText, web.standardText)}`);
      }
      for (const part of ["record", "textFrames", "phfFrames"] as const) {
        const a = JSON.stringify(app[part]);
        const b = JSON.stringify(web[part]);
        if (a !== b) {
          problems.push(`render ${key} ${part} (file ${fileOf(key)}): ${firstPath(JSON.parse(a), JSON.parse(b))}`);
        }
      }
      if (!app.textFrames) {
        problems.push(`render ${key} (file ${fileOf(key)}): the derived standard text does not read back`);
      }
    });
    timings.renderMs = Date.now() - started;
    report.rendered = keys.length;
    if (problems.length > 0) {
      console.log(problems.slice(0, 60).join("\n"));
    }
    expect(problems, `${problems.length} difference(s)`).toEqual([]);
  });

  it("statistics: the web's rebuild route as each user", async () => {
    // F1: a hand with a seat outside hand_stats_seat_ok fails its page of the
    // rebuild and stops it for the whole account, whichever path stored it.
    // F2: `save_hand_stats` spends one budget for every account together
    // (`hand_stats_insert`, 200 000 rows / 10 min); a whole-corpus run writes
    // ~88 000, so a second run within ten minutes on the same stack would
    // be refused - the budget is reset first (a local stack only).
    const blocked = await psql(`
delete from public.ingest_rate_limit where bucket = 'hand_stats_insert';
select 'blocked ' || jsonb_build_object('handKey', hand_key, 'owner', owner_id, 'file', source_filename)::text from public.hands h
 where owner_id in ('${appUser.id}', '${webUser.id}')
   and exists (select 1 from jsonb_array_elements(h.phf -> 'players') p
                where (p ->> 'seat')::bigint not between ${STATS_SEATS.min} and ${STATS_SEATS.max});
delete from public.hands h
 where owner_id in ('${appUser.id}', '${webUser.id}')
   and exists (select 1 from jsonb_array_elements(h.phf -> 'players') p
                where (p ->> 'seat')::bigint not between ${STATS_SEATS.min} and ${STATS_SEATS.max});`);
    const out = tagged(blocked, "blocked");
    const perSide = (owner: string) => out.filter((b) => b.owner === owner).map((b) => String(b.handKey)).sort();
    expect(perSide(appUser.id)).toEqual(perSide(webUser.id));
    report.statsBlocked = { hands: perSide(appUser.id).length, files: [...new Set(out.map((b) => String(b.file)))].sort() };

    const { POST } = await import("../../../frontend/src/app/api/stats/rebuild/route");
    const started = Date.now();
    const stats: Record<string, { processed: number; inserted: number; failed: number }> = {};
    for (const [name, client] of [["app", appClient], ["web", webClient]] as const) {
      route.client = client;
      const total = { processed: 0, inserted: 0, failed: 0 };
      let after: string | null = null;
      for (let slice = 0; slice < 2000; slice += 1) {
        const request = new Request("http://localhost/api/stats/rebuild", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify({ after, includeVillains: true }),
        });
        const response = await POST(request as Parameters<typeof POST>[0]);
        const payload = (await response.json()) as { processed: number; inserted: number; failed: number; after: string | null; done: boolean; error?: string };
        expect(response.status, `${name}: ${payload.error}`).toBe(200);
        total.processed += payload.processed;
        total.inserted += payload.inserted;
        total.failed += payload.failed;
        if (payload.done) {
          break;
        }
        after = payload.after;
      }
      stats[name] = total;
    }
    route.client = null;
    timings.statsMs = Date.now() - started;
    report.stats = stats;
    expect(stats.app.processed).toBe(stats.web.processed);
    expect(stats.app.failed).toBe(0);
    expect(stats.web.failed).toBe(0);
  });

  it("stored statistics: hand_stats and hand_stats_ev byte for byte", async () => {
    const started = Date.now();
    const lines = await psql(compareSql({ app: appUser.id, web: webUser.id, part: "stats" }));
    timings.compareStatsMs = Date.now() - started;
    const counts = tagged(lines, "count")[0];
    report.statsRows = counts;
    const problems = problemsOf(lines);
    expect(Number(counts.app_stats)).toBeGreaterThan(0);
    expect(counts.app_stats).toBe(counts.web_stats);
    expect(counts.app_ev).toBe(counts.web_ev);
    expect(problems, `${problems.length} difference(s): ${JSON.stringify(tagged(lines, "difftotal")[0])}`).toEqual([]);
  });

  it("the comparison reports a changed column, a changed statistic and a missing row", async () => {
    const web = webUser.id;
    const compared = `owner_id = '${web}' and hand_key not in (select jsonb_array_elements_text($k$${JSON.stringify([...split])}$k$::jsonb))`;
    const lines = await psql(`
begin;
create temporary table control as
  select (select id from public.hands where ${compared} order by hand_key limit 1) as hand_id,
         (select hand_id from public.hand_stats where ${compared} order by hand_key, seat limit 1) as stats_hand,
         (select hand_id from public.hand_stats where ${compared} order by hand_key desc, seat limit 1) as gone_hand,
         (select hand_id from public.hand_stats_ev where ${compared} order by hand_key limit 1) as ev_hand;
update public.hands set phf = jsonb_set(phf, '{meta,parserVersion}', to_jsonb((phf -> 'meta' ->> 'parserVersion') || '-control'))
 where id = (select hand_id from control);
update public.hand_stats set player = player || '~'
 where (hand_id, seat) = (select hand_id, seat from public.hand_stats where hand_id = (select stats_hand from control) order by seat limit 1);
delete from public.hand_stats
 where (hand_id, seat) = (select hand_id, seat from public.hand_stats where hand_id = (select gone_hand from control) order by seat limit 1);
update public.hand_stats_ev set ev_net = ev_net + 1 where hand_id = (select ev_hand from control);
${compareSql({ app: appUser.id, web, part: "hands" })}
${compareSql({ app: appUser.id, web, part: "stats" })}
rollback;`);
    const diffs = tagged(lines, "diff");
    const columns = diffs.map((d) => `${d.table}.${d.column}`).sort();
    expect(columns).toEqual(["hand_stats.player", "hand_stats_ev.ev_net", "hands.phf"]);
    const phf = diffs.find((d) => d.column === "phf")!;
    expect(describeDiff(phf, fileOf)).toContain("$.meta.parserVersion");
    expect(tagged(lines, "missing").map((m) => `${m.table} ${m.side}`)).toEqual(["hand_stats app"]);
  });
});

if (!CONFIGURED) {
  // Run on purpose only (`npm run parity`, CI's parity job): a run without a
  // stack is a mistake, not a pass.
  describe("web/app parity (R4.4)", () => {
    it("has a local stack to run against", () => {
      throw new Error("Set RAIL_PARITY_URL, RAIL_PARITY_ANON_KEY, RAIL_PARITY_SERVICE_KEY and RAIL_PARITY_PSQL (a local stack; see the file's header).");
    });
  });
}

/** Every difference a comparison printed, as sentences; logged, and empty when equal. */
function problemsOf(lines: string[]): string[] {
  const problems: string[] = [];
  for (const missing of tagged(lines, "missing")) {
    problems.push(`${missing.table}: ${missing.key} only in the ${missing.side} path's rows (file ${fileOf(missing.handKey)})`);
  }
  for (const diff of tagged(lines, "diff")) {
    problems.push(describeDiff(diff, fileOf));
  }
  for (const diff of tagged(lines, "splitdiff")) {
    problems.push(
      `hands ${diff.handKey}: the app stored the copy from ${diff.file}, which the web converted differently: ` +
        `${firstByte(String(diff.app), String(diff.web ?? ""))}; ${diff.web ? firstPath(JSON.parse(String(diff.app)), JSON.parse(String(diff.web))) : "no web conversion of that file"}`,
    );
  }
  for (const bad of tagged(lines, "parsedAt")) {
    problems.push(`hands ${bad.handKey} (${bad.side}): meta.parsedAt ${JSON.stringify(bad.value)} is not an ISO instant with milliseconds`);
  }
  for (const bad of tagged(lines, "shape")) {
    problems.push(`hands ${bad.handKey} (${bad.side}): origin ${bad.origin}, standard_text ${bad.standard ? "set" : "null"}, source_text ${bad.source ? "set" : "null"}`);
  }
  if (problems.length > 0) {
    console.log(problems.slice(0, 60).join("\n"));
  }
  return problems;
}

/* ---------------------------------------------------------------- the SQL - */

/**
 * One comparison as a script: counts, then every difference as a tagged JSON
 * line. Each row becomes the jsonb it is compared as once (`cmp_*`); whole
 * rows are compared first and only a differing pair is taken apart by column.
 */
function compareSql({ app, web, part }: { app: string; web: string; part: "hands" | "stats" }): string {
  const handsOut = NOT_COMPARED.hands.map((c) => `'${c}'`).join(", ");
  const statsOut = NOT_COMPARED.stats.map((c) => `'${c}'`).join(", ");
  const t = `cmp_${part}`;
  const splitKeys = JSON.stringify([...split]);
  const tail = `
create index on ${t} (tbl, side, key);
analyze ${t};

select 'missing ' || jsonb_build_object('table', tbl, 'side', case when has_app then 'app' else 'web' end,
         'handKey', hand_key, 'key', key)::text
  from (select tbl, key, min(hand_key) as hand_key, bool_or(side = 'app') as has_app, bool_or(side = 'web') as has_web
          from ${t} group by tbl, key) x
 where not (has_app and has_web)
 order by tbl, key;

create temporary table ${t}_diffs as
select a.tbl, a.hand_key, a.key, k as col, a.j -> k as app, w.j -> k as web
  from ${t} a
  join ${t} w on w.tbl = a.tbl and w.side = 'web' and w.key = a.key
 cross join lateral jsonb_object_keys(a.j || w.j) as k
 where a.side = 'app'
   and a.j::text is distinct from w.j::text
   and (a.j -> k)::text is distinct from (w.j -> k)::text;

select 'difftotal ' || coalesce(jsonb_object_agg(tbl || '.' || col, n), '{}'::jsonb)::text
  from (select tbl, col, count(*) as n from ${t}_diffs group by tbl, col) x;
select 'diff ' || jsonb_build_object('table', tbl, 'handKey', hand_key, 'key', key, 'column', col,
         'app', app::text, 'web', web::text)::text
  from (select *, row_number() over (partition by tbl, col order by key) as r from ${t}_diffs) d
 where r <= 5
 order by tbl, col, key;`;

  if (part === "stats") {
    const rows = (table: string, version: string) =>
      [["app", app], ["web", web]]
        .map(
          ([side, owner]) => `
insert into ${t}
select '${table}', '${side}', s.hand_key, s.hand_key || ' ' || s.${version} || ' seat ' || s.seat, to_jsonb(s) - array[${statsOut}]
  from public.${table} s
 where s.owner_id = '${owner}'
   and s.hand_key not in (select jsonb_array_elements_text($k$${splitKeys}$k$::jsonb));`,
        )
        .join("");
    return `
create temporary table ${t} (tbl text, side text, hand_key text, key text, j jsonb);
${rows("hand_stats", "stats_version")}
${rows("hand_stats_ev", "ev_version")}
select 'count ' || jsonb_build_object(
  'app_stats', (select count(*) from ${t} where tbl = 'hand_stats' and side = 'app'),
  'web_stats', (select count(*) from ${t} where tbl = 'hand_stats' and side = 'web'),
  'app_ev', (select count(*) from ${t} where tbl = 'hand_stats_ev' and side = 'app'),
  'web_ev', (select count(*) from ${t} where tbl = 'hand_stats_ev' and side = 'web'))::text;
${tail}`;
  }

  // The web's conversion of every copy of a hand the corpus has in more than one file.
  const alternatives = [...copies].flatMap(([key, byFile]) => [...byFile].map(([file, phf]) => ({ k: key, f: file, p: JSON.parse(phf) as unknown })));
  return `
create temporary table copies (hand_key text, file text, phf jsonb);
insert into copies select x ->> 'k', x ->> 'f', x -> 'p' from jsonb_array_elements($c$${JSON.stringify(alternatives)}$c$::jsonb) as x;

create temporary table hands_a as select * from public.hands where owner_id = '${app}';
create temporary table hands_w as select * from public.hands where owner_id = '${web}';

-- A hand whose two stored rows came from different files of the corpus.
create temporary table split as
select a.hand_key, a.phf -> 'meta' ->> 'originalFilename' as file, a.phf
  from hands_a a join hands_w w using (hand_key)
 where a.phf -> 'meta' ->> 'originalFilename' is distinct from w.phf -> 'meta' ->> 'originalFilename';
select 'split ' || jsonb_build_object('handKey', hand_key, 'file', file)::text from split order by hand_key;
-- ... is compared with the web's conversion of the file the app read it from.
select 'splitdiff ' || jsonb_build_object('handKey', s.hand_key, 'file', s.file,
         'app', jsonb_set(s.phf, '{meta,parsedAt}', '"${MASK_TIME}"')::text,
         'web', (select jsonb_set(c.phf, '{meta,parsedAt}', '"${MASK_TIME}"')::text from copies c
                  where c.hand_key = s.hand_key and c.file = s.file limit 1))::text
  from split s
 where not exists (select 1 from copies c
                    where c.hand_key = s.hand_key and c.file = s.file
                      and jsonb_set(c.phf, '{meta,parsedAt}', '"${MASK_TIME}"')::text
                        = jsonb_set(s.phf, '{meta,parsedAt}', '"${MASK_TIME}"')::text);

select 'count ' || jsonb_build_object('app', (select count(*) from hands_a), 'web', (select count(*) from hands_w))::text;

select 'shape ' || jsonb_build_object('handKey', hand_key, 'side', side, 'origin', origin,
         'standard', standard_text is not null, 'source', source_text is not null)::text
  from (select 'app' as side, * from hands_a union all select 'web', * from hands_w) h
 where origin::text <> case side when 'app' then 'desktop' else 'upload' end
    or standard_text is not null or source_text is not null;

select 'parsedAt ' || jsonb_build_object('handKey', hand_key, 'side', side, 'value', phf -> 'meta' -> 'parsedAt')::text
  from (select 'app' as side, * from hands_a union all select 'web', * from hands_w) h
 where coalesce(phf -> 'meta' ->> 'parsedAt', '') !~ '${PARSED_AT.source}';

-- A row as compared: the columns that may differ removed, the PHF's moment of conversion masked.
create temporary table ${t} (tbl text, side text, hand_key text, key text, j jsonb);
insert into ${t}
select 'hands', side, hand_key, hand_key,
       (to_jsonb(h) - array[${handsOut}, 'side']) || jsonb_build_object('phf', jsonb_set(h.phf, '{meta,parsedAt}', '"${MASK_TIME}"'))
  from (select 'app' as side, * from hands_a union all select 'web', * from hands_w) h
 where hand_key not in (select hand_key from split);
${tail}`;
}
