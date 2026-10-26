/**
 * The web's plan refusals (Rail R6.4):
 *
 * - `PT402` (HTTP 402, R6.2) read: the feature from the hint, the cap's
 *   numbers from the detail, anything else is not a plan refusal;
 * - the one handler: `rpc()` hands every plan refusal to the listeners (the
 *   upgrade prompt) and still throws it to its caller; other errors reach
 *   no listener; the prompt's words in both languages;
 * - the bulk upload: a 402 is a `plan` failure with the cap's numbers, and a
 *   save that would go over the Free cap - refused **whole** by the server -
 *   is trimmed to the room left, so every hand that fits is saved, then
 *   pauses (`cap`) and resumes after an upgrade; duplicates cost nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBulkSaver, type SaveProgress } from "../../frontend/src/components/converter/bulkSaver";
import type { StreamBatch } from "../../frontend/src/components/converter/pipeline";
import { memoryManifestStore, newManifest } from "../../frontend/src/components/converter/uploadManifest";
import { promptText } from "../../frontend/src/components/plan/PlanRefusalPrompt";
import { DatabaseRpcError, rpc } from "../../frontend/src/lib/db/client";
import { classifyFailure, createUploadApi, UploadError, type IngestRow, type UploadApi, type UploadClient } from "../../frontend/src/lib/db/upload";
import {
  allowanceOf,
  onPlanRefusal,
  planRefusalOf,
  reportPlanRefusal,
  type PlanRefusal,
} from "../../frontend/src/lib/entitlements/planRefusal";
import { en } from "../../frontend/src/lib/i18n/en";
import { hr } from "../../frontend/src/lib/i18n/hr";
import type { PhfHand } from "../../frontend/src/lib/phf/types";

const fakeRpc = vi.fn();
vi.mock("../../frontend/src/lib/supabase/browser.js", () => {
  const client = { rpc: (...args: unknown[]) => fakeRpc(...args) };
  return {
    getBrowserSupabase: () => client,
    requireBrowserSupabase: () => client,
    isSupabaseConfigured: true,
    SUPABASE_NOT_CONFIGURED_MESSAGE: "not configured",
  };
});

const CAP_DETAIL = JSON.stringify({ cap: 10000, stored: 9990, attempted: 250 });
const capError = {
  code: "PT402",
  message: "Your library is full on the Free plan. Upgrade to Pro to keep saving hands.",
  hint: "hand_cap",
  details: CAP_DETAIL,
};
const proError = { code: "PT402", message: "This is a Pro feature. Upgrade to Pro to use it.", hint: "analysis", details: null };

describe("a plan refusal, read", () => {
  it("the feature and the cap's numbers", () => {
    expect(planRefusalOf(proError)).toEqual({ feature: "analysis", cap: null, message: proError.message });
    expect(planRefusalOf(capError)).toEqual({
      feature: "hand_cap",
      cap: { cap: 10000, stored: 9990, attempted: 250 },
      message: capError.message,
    });
    expect(allowanceOf(planRefusalOf(capError))).toBe(10);
    expect(allowanceOf(planRefusalOf({ ...capError, details: JSON.stringify({ cap: 5, stored: 9, attempted: 1 }) }))).toBe(0);
    expect(allowanceOf(null)).toBe(0);
  });

  it("only PT402 is one; odd hints and details are dropped, not trusted", () => {
    expect(planRefusalOf({ code: "42501", message: "You must be signed in." })).toBeNull();
    expect(planRefusalOf(null)).toBeNull();
    expect(planRefusalOf({ code: "PT402", message: "m", hint: "<b>x</b>", details: "not json" })).toEqual({
      feature: null,
      cap: null,
      message: "m",
    });
    expect(planRefusalOf({ code: "PT402", message: "m", details: JSON.stringify({ cap: "10" }) })?.cap).toBeNull();
  });

  it("reaches every listener once, and a listener can leave", () => {
    const heard: PlanRefusal[] = [];
    const stop = onPlanRefusal((r) => heard.push(r));
    expect(reportPlanRefusal({ code: "23503", message: "x" })).toBeNull();
    expect(reportPlanRefusal(proError)?.feature).toBe("analysis");
    stop();
    reportPlanRefusal(proError);
    expect(heard.map((r) => r.feature)).toEqual(["analysis"]);
  });
});

describe("rpc(): the one handler", () => {
  beforeEach(() => fakeRpc.mockReset());

  it("a 402 reaches the prompt and still throws to the caller", async () => {
    const heard: PlanRefusal[] = [];
    const stop = onPlanRefusal((r) => heard.push(r));
    fakeRpc.mockResolvedValueOnce({ data: null, error: { ...proError }, status: 402 });
    const error = await rpc("analysis_overview", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseRpcError);
    expect((error as DatabaseRpcError).code).toBe("PT402");
    expect(heard).toHaveLength(1);
    expect(heard[0]?.feature).toBe("analysis");
    // Any other failure: no prompt.
    fakeRpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" }, status: 500 });
    await expect(rpc("analysis_overview", {})).rejects.toBeInstanceOf(DatabaseRpcError);
    expect(heard).toHaveLength(1);
    stop();
  });

  it("the prompt's words, in both languages", () => {
    for (const dict of [en, hr]) {
      const count = (n: number) => String(n);
      const feature = promptText(planRefusalOf(proError) as PlanRefusal, dict, count);
      expect(feature).toEqual({ heading: dict.planNotice.prompt.heading, body: dict.plan.lock.body.analysis });
      const cap = promptText(planRefusalOf(capError) as PlanRefusal, dict, count);
      expect(cap).toEqual({ heading: dict.planNotice.prompt.capHeading, body: dict.planNotice.prompt.cap("10000") });
      const unknown = promptText({ feature: null, cap: null, message: "" }, dict, count);
      expect(unknown.body).toBe(dict.planNotice.prompt.generic);
    }
    expect(hr.planNotice.prompt.heading).not.toBe(en.planNotice.prompt.heading);
  });
});

/* -------------------------------------------------------- the bulk save - */

function hand(id: string): PhfHand {
  return {
    schema: "phf/1",
    meta: { siteId: "weplay", siteName: "WePlay", handId: id, handKey: id, rawText: "x" },
  } as unknown as PhfHand;
}

function batch(key: string, ids: string[], index = 0): StreamBatch {
  return { sourceId: "s1", key, index, last: true, hands: ids.map(hand), failures: [], done: ids.length, total: ids.length };
}

/**
 * `ingest_hands` under a Free cap as R6.2's trigger enforces it: a call
 * whose *new* rows would put the library over the cap is refused whole
 * (PT402, the cap's numbers in the detail); duplicates cost nothing.
 */
function cappedServer(cap: number | null, already: string[] = []) {
  const stored = new Set(already.map((id) => `weplay:${id}`));
  const calls: number[] = [];
  let limit = cap;
  const api: UploadApi = {
    userId: async () => "user-1",
    registerWebSource: async () => "source-1",
    ingest: async (_source, rows: IngestRow[]) => {
      calls.push(rows.length);
      const fresh = rows.filter((row) => !stored.has(row.hand_key));
      if (limit !== null && stored.size + new Set(fresh.map((r) => r.hand_key)).size > limit) {
        throw new UploadError(
          "plan",
          "ingest_hands: Your library is full on the Free plan.",
          planRefusalOf({ ...capError, details: JSON.stringify({ cap: limit, stored: stored.size, attempted: fresh.length }) }),
        );
      }
      const report = { received: rows.length, inserted: 0, duplicates: 0, rejected: 0, rows: [] as Array<{ handKey: string; status: "inserted" | "duplicate" }> };
      for (const row of rows) {
        if (stored.has(row.hand_key)) {
          report.duplicates += 1;
          report.rows.push({ handKey: row.hand_key, status: "duplicate" });
        } else {
          stored.add(row.hand_key);
          report.inserted += 1;
          report.rows.push({ handKey: row.hand_key, status: "inserted" });
        }
      }
      return report;
    },
    storeOriginal: async () => "stored",
    recordFailures: async () => ({ created: 0, updated: 0 }),
  };
  return { api, stored, calls, upgrade: () => (limit = null) };
}

function saverOn(api: UploadApi) {
  return createBulkSaver({
    api,
    store: memoryManifestStore(),
    manifest: newManifest("user-1", [{ path: "export.zip", size: 1 }], false, "upload-cap"),
    userId: "user-1",
    ack: () => undefined,
    sleep: async () => undefined,
    random: () => 1,
    now: () => 0,
    maxHandsPerCall: 50,
  });
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe("the bulk save at the Free cap", () => {
  it("is classified as the plan's, with the numbers", async () => {
    expect(classifyFailure("PT402", 402, "full")).toBe("plan");
    expect(classifyFailure(null, 402, "full")).toBe("plan");
    const client = {
      auth: { getSession: async () => ({ data: { session: null } }) },
      rpc: async () => ({ data: null, error: { ...capError }, status: 402 }),
      storage: { from: () => ({ upload: async () => ({ data: null, error: null }) }) },
    } as unknown as UploadClient;
    const error = await createUploadApi(client).ingest("source-1", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).kind).toBe("plan");
    expect((error as UploadError).refusal?.cap).toEqual({ cap: 10000, stored: 9990, attempted: 250 });
  });

  it("saves every hand that fits, then pauses with `cap`; resumes after an upgrade", async () => {
    // 7 of 10 stored; 40 more dropped: 3 fit.
    const server = cappedServer(10, ids("old", 7));
    const saver = saverOn(server.api);
    saver.addBatch(batch("k1", ids("new", 40)));
    saver.close();
    const paused: SaveProgress = await saver.idle();
    expect(paused.state).toBe("paused");
    expect(paused.pauseReason).toBe("cap");
    expect(paused.inserted).toBe(3);
    expect(paused.trimmed).toBe(true);
    expect(paused.cap).toEqual({ cap: 10, stored: 10 });
    expect(server.stored.size).toBe(10);
    // The refused call (40), the trimmed one (3), the one that found it full (37).
    expect(server.calls).toEqual([40, 3, 37]);
    expect(paused.queued).toBe(37);

    server.upgrade();
    saver.resume();
    const done = await saver.idle();
    expect(done.state).toBe("done");
    expect(done.inserted).toBe(40);
    expect(done.cap).toBeNull();
    expect(server.stored.size).toBe(47);
  });

  it("duplicates are free: a re-upload past the cap stores nothing new and is not refused", async () => {
    const server = cappedServer(10, ids("new", 10));
    const saver = saverOn(server.api);
    saver.addBatch(batch("k1", ids("new", 10)));
    saver.close();
    const done = await saver.idle();
    expect(done.state).toBe("done");
    expect([done.inserted, done.duplicates]).toEqual([0, 10]);
    expect(done.trimmed).toBe(false);
  });

  it("room left after duplicates: the trimmed calls go on until it is spent", async () => {
    // 5 of 10 stored; the drop repeats 4 of them and adds 20: 5 new fit.
    const server = cappedServer(10, ids("old", 5));
    const saver = saverOn(server.api);
    saver.addBatch(batch("k1", [...ids("old", 4), ...ids("new", 20)]));
    saver.close();
    const paused = await saver.idle();
    expect(paused.pauseReason).toBe("cap");
    expect(paused.inserted).toBe(5);
    expect(paused.duplicates).toBe(4);
    expect(server.stored.size).toBe(10);
  });

  it("another plan refusal pauses with `plan`, nothing counted as refused", async () => {
    const api: UploadApi = {
      ...cappedServer(null).api,
      ingest: async () => {
        throw new UploadError("plan", "ingest_hands: This is a Pro feature.", planRefusalOf(proError));
      },
    };
    const saver = saverOn(api);
    saver.addBatch(batch("k1", ids("new", 5)));
    saver.close();
    const paused = await saver.idle();
    expect(paused.pauseReason).toBe("plan");
    expect(paused.refused).toBe(0);
    expect(paused.queued).toBe(5);
  });
});
