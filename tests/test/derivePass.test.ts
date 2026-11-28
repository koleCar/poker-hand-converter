/**
 * The one pass and its drain (docs/POOL.md P1, `web/src/lib/derive/`):
 *
 * - `onePass` gives, from one read of a hand, exactly what the retired
 *   page-driven paths gave: the rebuild route's statistics, facts and EV
 *   rows (`handDerivation`, `handEvRow`), the checker backfill's rows
 *   (`analyticsRowsHand` over the stored decisions) and the pool backfill's
 *   opponents (`poolHand`) - over the Analytics fixture (22 hands with a
 *   made-up stored analysis), opponents' rows on and off;
 * - `passPage` reads a stored row's PHF, or parses a text-only row and puts
 *   its provenance back, and hands back an unreadable hand as a final
 *   failure;
 * - `drain` claims, saves and fails through the three RPCs with the claim's
 *   versions, stops when a claim comes back short, at its budget and at its
 *   cap, and lets an RPC error through;
 * - the routes: `/api/derive` refuses another origin and a signed-out
 *   caller and answers the slice with the pending count; `/api/derive/cron`
 *   refuses everyone without `CRON_SECRET` and is inert without
 *   `DERIVE_WORKER_JWT`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANALYSIS_VERSION } from "../../web/src/lib/analysis/types.js";
import { poolHand } from "../../web/src/lib/db/poolCounts.js";
import { handDerivation, handEvRow } from "../../web/src/lib/db/statsRows.js";
import { CLAIM_VERSIONS, drain, type RpcClient } from "../../web/src/lib/derive/drain.js";
import { analyticsRowsHand, onePass, passPage, type ClaimedHand } from "../../web/src/lib/derive/onePass.js";
import { parseStandardHand, toStandardText } from "../../web/src/lib/phf/serialize.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import { ANALYTICS_MEMBERSHIP_VERSION } from "../../web/src/lib/stats/analytics.js";
import type { RowsDecisionIn } from "../../web/src/lib/stats/analyticsRows.js";

const ROOT = join(import.meta.dirname, "../..");
const DIR = "core/rail-stats/tests/data/analytics/rows";
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };
const text = (path: string): string => readFileSync(join(ROOT, path), "utf8");

interface Case {
  file: string;
  decisions: RowsDecisionIn[];
}

const cases = (JSON.parse(text(`${DIR}/cases.json`)) as { cases: Case[] }).cases;
const hands: Array<{ file: string; hand: PhfHand; decisions: RowsDecisionIn[] }> = cases.map((c) => {
  const hand = parseStandardHand(text(c.file), CTX);
  if (!hand) throw new Error(`${c.file} did not parse`);
  return { file: c.file, hand, decisions: c.decisions };
});

const parse = (source: string) => parseStandardHand(source, CTX);
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("onePass", () => {
  it("has a fixture with heroes and named opponents", () => {
    expect(hands.length).toBeGreaterThanOrEqual(20);
    expect(hands.some(({ hand }) => poolHand("x", hand).players.length > 0)).toBe(true);
  });

  for (const includeVillains of [false, true]) {
    it(`gives each retired path's rows, opponents' rows ${includeVillains ? "on" : "off"}`, () => {
      for (const { file, hand, decisions } of hands) {
        const out = onePass("00000000-0000-0000-0000-000000000001", hand, {
          includeVillains,
          analysisVersion: ANALYSIS_VERSION,
          decisions,
        });
        const derivation = handDerivation(hand, { includeVillains });
        expect(out.stats, file).toEqual(derivation.stats);
        expect(out.facts, file).toEqual(derivation.facts);
        const hero = derivation.stats.find((row) => row.is_hero);
        expect(out.ev, file).toEqual(hero ? [handEvRow(hand, hero)] : []);
        const { hand_id: _id, ...checker } = analyticsRowsHand(out.hand_id, ANALYSIS_VERSION, hand, decisions);
        expect(_id).toBe(out.hand_id);
        expect(out.checker, file).toEqual(checker);
        expect(out.pool, file).toEqual({
          version: ANALYTICS_MEMBERSHIP_VERSION,
          players: poolHand(out.hand_id, hand).players,
        });
        if (!includeVillains) expect(out.stats.every((row) => row.is_hero), file).toBe(true);
      }
    });
  }

  it("writes no checker rows without an analysis", () => {
    const { hand } = hands[0];
    expect(onePass("h", hand, { includeVillains: false }).checker).toBeNull();
    expect(onePass("h", hand, { includeVillains: false, analysisVersion: ANALYSIS_VERSION, decisions: null }).checker).toBeNull();
  });

  it("survives the wire: the products are plain JSON", () => {
    const { hand, decisions } = hands[1];
    const out = onePass("h", hand, { includeVillains: true, analysisVersion: ANALYSIS_VERSION, decisions });
    expect(json(out)).toEqual(out);
  });
});

/** A stored row as `derive_claim` returns it. */
function claimed(id: number, hand: PhfHand, extra: Partial<ClaimedHand> = {}): ClaimedHand {
  return {
    hand_id: `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`,
    owner_id: "00000000-0000-0000-0000-0000000000aa",
    reason: "new",
    villains: false,
    analysis_version: null,
    decisions: null,
    hand_key: `standard:${hand.meta.handKey || hand.meta.handId}`,
    site: "standard",
    phf: json(hand),
    standard_text: null,
    parser_version: hand.meta.parserVersion || null,
    source_filename: null,
    created_at: "2026-11-27T09:00:00.000Z",
    ...extra,
  };
}

describe("passPage", () => {
  it("reads a PHF row and a text-only row alike; an unreadable row is a final failure", async () => {
    const [a, b] = hands;
    const page = [
      claimed(1, a.hand),
      claimed(2, b.hand, { phf: null, standard_text: toStandardText(b.hand) }),
      claimed(3, a.hand, { phf: null, standard_text: "not a hand" }),
    ];
    const { derived, failed } = await passPage(page, parse);
    expect(derived.map((d) => d.hand_id)).toEqual([page[0].hand_id, page[1].hand_id]);
    expect(derived[0].stats).toEqual(handDerivation(a.hand, { includeVillains: false }).stats);
    // The text-only row: the same statistics as its PHF gives.
    expect(derived[1].stats.map((row) => row.net)).toEqual(
      handDerivation(b.hand, { includeVillains: false }).stats.map((row) => row.net),
    );
    expect(failed).toEqual([{ hand_id: page[2].hand_id, error: "The stored hand could not be read.", final: true }]);
  });

  it("follows the row's opponents' setting and analysis", async () => {
    const { hand, decisions } = hands[2];
    const { derived } = await passPage(
      [claimed(1, hand, { villains: true, analysis_version: ANALYSIS_VERSION, decisions })],
      parse,
    );
    expect(derived[0].stats).toEqual(handDerivation(hand, { includeVillains: true }).stats);
    expect(derived[0].checker?.analysis_version).toBe(ANALYSIS_VERSION);
  });
});

/** A fake database: a queue of claimed pages, recording every call. */
function fakeClient(pages: ClaimedHand[][], fail: Record<string, string> = {}) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args = {}) {
      calls.push({ fn, args });
      if (fail[fn]) return Promise.resolve({ data: null, error: { code: "57014", message: fail[fn] } });
      if (fn === "derive_claim") {
        const limit = Number(args.p_limit);
        const page = pages.shift() ?? [];
        return Promise.resolve({ data: page.slice(0, limit), error: null });
      }
      if (fn === "derive_save") {
        return Promise.resolve({ data: { saved: (args.p_hands as unknown[]).length, failed: 0 }, error: null });
      }
      if (fn === "derive_fail") return Promise.resolve({ data: { failed: 0, retry: 0 }, error: null });
      if (fn === "derive_pending") return Promise.resolve({ data: 0, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    },
  };
  return { client, calls };
}

describe("drain", () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => claimed(from + i, hands[(from + i) % hands.length].hand));

  it("claims with the versions, saves what it worked out, fails what it could not read, stops on a short page", async () => {
    const bad = claimed(99, hands[0].hand, { phf: null, standard_text: "garbage" });
    const { client, calls } = fakeClient([page(1, 10), [...page(11, 3), bad]]);
    const result = await drain(client, { parse, budgetMs: 60_000, pageSize: 10, saveSize: 4 });
    expect(result).toEqual({ processed: 14, saved: 13, failed: 1, empty: true });
    const claims = calls.filter((c) => c.fn === "derive_claim");
    expect(claims).toHaveLength(2);
    expect(claims[0].args).toEqual({ p_limit: 10, p_versions: CLAIM_VERSIONS });
    expect(CLAIM_VERSIONS).toEqual({ analysis: ANALYSIS_VERSION, membership: ANALYTICS_MEMBERSHIP_VERSION });
    // 10 hands in saves of 4: 4 + 4 + 2; then 3.
    expect(calls.filter((c) => c.fn === "derive_save").map((c) => (c.args.p_hands as unknown[]).length)).toEqual([4, 4, 2, 3]);
    const failed = calls.find((c) => c.fn === "derive_fail");
    expect(failed?.args.p_hands).toEqual([{ hand_id: bad.hand_id, error: "The stored hand could not be read.", final: true }]);
  });

  it("stops at an empty claim, at its cap and at its budget", async () => {
    let r = await drain(fakeClient([]).client, { parse, budgetMs: 60_000 });
    expect(r).toEqual({ processed: 0, saved: 0, failed: 0, empty: true });

    const capped = fakeClient([page(1, 5), page(6, 5), page(11, 5)]);
    r = await drain(capped.client, { parse, budgetMs: 60_000, pageSize: 5, maxHands: 7 });
    expect(r.processed).toBe(7);
    expect(capped.calls.filter((c) => c.fn === "derive_claim").map((c) => c.args.p_limit)).toEqual([5, 2]);

    let clock = 0;
    const timed = fakeClient([page(1, 5), page(6, 5), page(11, 5)]);
    r = await drain(timed.client, { parse, budgetMs: 10, pageSize: 5, now: () => (clock += 6) });
    expect(r.processed).toBe(5);
    expect(r.empty).toBe(false);
  });

  it("lets an RPC error through (the claim lapses and the rows go back)", async () => {
    const { client } = fakeClient([page(1, 3)], { derive_save: "canceling statement due to statement timeout" });
    await expect(drain(client, { parse, budgetMs: 60_000 })).rejects.toThrow(/derive_save: canceling statement/);
  });
});

/* ---------------------------------------------------------------- routes - */

const server = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../web/src/lib/supabase/server", () => ({
  getWritableServerSupabase: async () => server.client,
}));

describe("/api/derive", () => {
  afterEach(() => {
    server.client = null;
  });

  const post = async (origin: string | null) => {
    const { POST } = await import("../../web/src/app/api/derive/route");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    const response = await POST(new Request("http://localhost/api/derive", { method: "POST", headers }) as never);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("refuses another origin and a signed-out caller", async () => {
    expect((await post("http://evil.example")).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    server.client = { auth: { getUser: async () => ({ data: { user: null } }) } };
    expect((await post("http://localhost")).status).toBe(401);
  });

  it("drains the caller's queue and answers the slice with the pending count", async () => {
    const { client, calls } = fakeClient([[claimed(1, hands[0].hand), claimed(2, hands[1].hand)]]);
    server.client = { ...client, rpc: client.rpc, auth: { getUser: async () => ({ data: { user: { id: "u" } } }) } };
    const { status, body } = await post("http://localhost");
    expect(status).toBe(200);
    expect(body).toEqual({ processed: 2, saved: 2, failed: 0, pending: 0, done: true });
    expect(calls.map((c) => c.fn)).toEqual(["derive_claim", "derive_save", "derive_pending"]);
  });
});

describe("/api/derive/cron", () => {
  const saved = { secret: process.env.CRON_SECRET, jwt: process.env.DERIVE_WORKER_JWT };
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.DERIVE_WORKER_JWT;
  });
  afterEach(() => {
    if (saved.secret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved.secret;
    if (saved.jwt === undefined) delete process.env.DERIVE_WORKER_JWT;
    else process.env.DERIVE_WORKER_JWT = saved.jwt;
  });

  const get = async (authorization: string | null) => {
    const { GET } = await import("../../web/src/app/api/derive/cron/route");
    const headers: Record<string, string> = {};
    if (authorization) headers.authorization = authorization;
    const response = await GET(new Request("http://localhost/api/derive/cron", { headers }) as never);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("refuses everyone while CRON_SECRET is unset, and a wrong secret", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get("Bearer anything")).status).toBe(401);
    process.env.CRON_SECRET = "s3cret";
    expect((await get("Bearer wrong")).status).toBe(401);
  });

  it("does nothing without the worker's key", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect(await get("Bearer s3cret")).toEqual({ status: 200, body: { inert: true } });
  });
});
