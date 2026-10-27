/**
 * The account export and deletion of a big account, measured (docs/RAIL-PLAN.md
 * R6.5: "large accounts (1M hands) must work"). Not in CI: it needs a local
 * stack serving the functions and a loaded account.
 *
 * ```text
 * # 1. A million generated hands (and their analysis) for perf.r29@example.test:
 * RAIL_PERF_PSQL='docker exec -i supabase_db_<project> psql -U postgres -d postgres' \
 *   RAIL_PERF_ANALYSIS=1 RAIL_PERF_SET=review npm run supabase:perf
 * # 2. Export it (and, with RAIL_ACCOUNT_DELETE=1, delete it):
 * RAIL_ACCOUNT_URL=http://127.0.0.1:<api port> RAIL_ACCOUNT_ANON_KEY=... RAIL_ACCOUNT_SERVICE_KEY=... \
 *   [RAIL_ACCOUNT_EMAIL=perf.r29@example.test] [RAIL_ACCOUNT_DERIVED=0] [RAIL_ACCOUNT_DELETE=1] \
 *   [RAIL_ACCOUNT_EXPORT=0] [RAIL_ACCOUNT_OUT=<dir>] npm run account:measure
 * ```
 *
 * **Only against a throwaway local stack** - it refuses any other URL. It
 * signs the account in with a one-time token (the service key mints it, as
 * the desktop sign-in does), so the session is fresh for the deletion.
 *
 * The export is the web's own code (`web/src/lib/account/export.ts` and
 * `zipWriter.ts`) over PostgREST, as the browser runs it, writing the ZIP to
 * a file (then deleted unless RAIL_ACCOUNT_KEEP=1); Node's
 * `CompressionStream` stands in for the browser's. The deletion is the Edge
 * Function, called again while it answers 202, as the page does.
 * Prints times, sizes and calls; nothing is asserted.
 */

import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "vitest";

import { exportAccount } from "../../../web/src/lib/account/export.js";
import { buildReadme } from "../../../web/src/lib/account/readme.js";
import { ZipWriter, type ZipSink } from "../../../web/src/lib/account/zipWriter.js";
import type { Cursor, ExportSource } from "../../../web/src/lib/db/accountData.js";
import { en } from "../../../web/src/lib/i18n/en.js";

const URL_ = process.env.RAIL_ACCOUNT_URL ?? "";
const ANON = process.env.RAIL_ACCOUNT_ANON_KEY ?? "";
const SERVICE = process.env.RAIL_ACCOUNT_SERVICE_KEY ?? "";
const EMAIL = process.env.RAIL_ACCOUNT_EMAIL ?? "perf.r29@example.test";
const FUNCTIONS = process.env.RAIL_ACCOUNT_FUNCTIONS_URL ?? `${URL_}/functions/v1`;
const DERIVED = process.env.RAIL_ACCOUNT_DERIVED !== "0";
const DELETE = process.env.RAIL_ACCOUNT_DELETE === "1";
const KEEP = process.env.RAIL_ACCOUNT_KEEP === "1";
const EXPORT = process.env.RAIL_ACCOUNT_EXPORT !== "0";

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** A session for the account, minted with a one-time token. */
async function signIn(): Promise<string> {
  const service = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
  const link = await fetch(`${URL_}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: service,
    body: JSON.stringify({ type: "magiclink", email: EMAIL }),
  });
  const minted = (await json(link)) as { hashed_token?: string };
  if (!minted.hashed_token) throw new Error(`generate_link: HTTP ${link.status}`);
  const verify = await fetch(`${URL_}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: minted.hashed_token }),
  });
  const session = (await json(verify)) as { access_token?: string };
  if (!session.access_token) throw new Error(`verify: HTTP ${verify.status}`);
  return session.access_token;
}

function source(jwt: string, calls: Record<string, number>): ExportSource {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls[fn] = (calls[fn] ?? 0) + 1;
    const response = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await json(response);
    if (!response.ok) {
      throw Object.assign(new Error(`${fn}: HTTP ${response.status} ${JSON.stringify(body).slice(0, 300)}`), {
        code: (body as { code?: string } | null)?.code ?? null,
      });
    }
    return body;
  };
  return {
    manifest: () => rpc("export_my_manifest", {}) as never,
    profile: () => rpc("export_my_profile", {}),
    hands: (after: Cursor, limit: number, derived: boolean) =>
      rpc("export_my_hands", { p_after: after, p_limit: limit, p_derived: derived }) as never,
    rows: (reader, section, after, limit) =>
      rpc(reader === "rows" ? "export_my_rows" : "export_my_sealed", {
        p_section: section,
        p_after: after,
        p_limit: limit,
      }) as never,
    async upload(name) {
      calls.upload = (calls.upload ?? 0) + 1;
      const response = await fetch(`${URL_}/storage/v1/object/authenticated/hand-uploads/${name}`, {
        headers: { apikey: ANON, Authorization: `Bearer ${jwt}` },
      });
      if (!response.ok) throw new Error(`upload ${name}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function fileSink(path: string): ZipSink {
  const stream = createWriteStream(path);
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    close: () => new Promise<void>((resolve) => stream.end(resolve)),
  };
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

describe("account data at scale", () => {
  it("exports (and deletes) the account", async () => {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_) || !ANON || !SERVICE) {
      throw new Error("RAIL_ACCOUNT_URL must be a local stack, with RAIL_ACCOUNT_ANON_KEY and RAIL_ACCOUNT_SERVICE_KEY");
    }
    if (EXPORT) {
      const jwt = await signIn();
      const calls: Record<string, number> = {};
      const dir = mkdtempSync(join(process.env.RAIL_ACCOUNT_OUT ?? tmpdir(), "rail-export-"));
      const path = join(dir, "export.zip");
      const phases: [string, number][] = [];
      let phase = "";
      let phaseStart = performance.now();
      const started = performance.now();
      const result = await exportAccount(source(jwt, calls), new ZipWriter(fileSink(path)), {
        derived: DERIVED,
        originals: true,
        readme: (context) => buildReadme(en.yourData.readme, context),
        onProgress: (p) => {
          if (p.phase !== phase) {
            if (phase) phases.push([phase, performance.now() - phaseStart]);
            phase = p.phase;
            phaseStart = performance.now();
          }
        },
      });
      const total = performance.now() - started;
      const hands = result.files.filter((f) => f.section === "hands").reduce((n, f) => n + f.rows, 0);
      console.log(`EXPORT ${EMAIL}: ${hands} hands, derived ${DERIVED ? "on" : "off"}`);
      console.log(`  ${result.rows} rows in ${result.entries} files, ${mb(statSync(path).size)} zip, ${s(total)}`);
      console.log(`  ${(hands / (total / 1000)).toFixed(0)} hands/s; heap ${mb(process.memoryUsage().heapUsed)}`);
      for (const [name, ms] of phases) console.log(`  phase ${name}: ${s(ms)}`);
      console.log(`  calls: ${JSON.stringify(calls)}`);
      if (!KEEP) rmSync(dir, { recursive: true, force: true });
      else console.log(`  kept at ${path}`);
    }

    if (DELETE) {
      const fresh = await signIn();
      const startedDelete = performance.now();
      const username = (await (
        await fetch(`${URL_}/rest/v1/rpc/my_profile`, {
          method: "POST",
          headers: { apikey: ANON, Authorization: `Bearer ${fresh}`, "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()) as { username?: string } | null;
      let body: Record<string, unknown> = { confirm: username?.username ?? EMAIL };
      const rounds: string[] = [];
      for (let i = 0; i < 500; i++) {
        const t = performance.now();
        const response = await fetch(`${FUNCTIONS}/account-delete`, {
          method: "POST",
          headers: { Authorization: `Bearer ${fresh}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const answer = (await json(response)) as Record<string, unknown> | null;
        rounds.push(`${response.status}${answer?.step ? `:${String(answer.step)}` : ""} ${s(performance.now() - t)}`);
        if (response.status !== 202) {
          console.log(`DELETE: HTTP ${response.status} ${JSON.stringify(answer)} after ${s(performance.now() - startedDelete)}`);
          break;
        }
        body = {};
      }
      console.log(`  calls: ${rounds.length}: ${rounds.join(", ")}`);
    }
  });
});
