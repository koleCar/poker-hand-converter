/**
 * The app's Trainer answers on their way to the account
 * (`app/src/trainer/outbox.ts`): kept on this computer first, sent fifty at
 * a time, kept through a wait (signed out, the plan, the rate limit,
 * offline), dropped only when the server refuses them for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[][] = [];
let answer: () => Promise<number> = async () => 0;

vi.mock("../../app/src/lib/ipc", () => ({
  inApp: true,
  TRAINER_SYNC_WAIT: ["signedOut", "rateLimited", "plan", "unavailable", "unreachable"],
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  ipc: {
    trainerResultsRecord: (rows: unknown[]) => {
      sent.push(rows);
      return answer();
    },
  },
}));

const store = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

const { enqueue, flushOutbox, isWait, readOutbox } = await import("../../app/src/trainer/outbox");

const row = (i: number) => ({
  mode: "preflop" as const,
  family: "vs-open",
  spot: `r${i}`,
  position: "BB",
  hand_class: "AKs",
  grade: "good",
  ev_loss_bb: 0,
  ev_loss_pot: 0,
  score: 90,
});

beforeEach(() => {
  store.clear();
  sent.length = 0;
  answer = async () => 0;
});

describe("the trainer outbox", () => {
  it("sends what waits in batches of fifty and empties", async () => {
    for (let i = 0; i < 120; i += 1) enqueue(row(i));
    await flushOutbox();
    expect(sent.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(readOutbox()).toEqual([]);
  });

  it("keeps everything through a wait", async () => {
    for (let i = 0; i < 3; i += 1) enqueue(row(i));
    answer = async () => {
      throw new Error("signedOut");
    };
    await flushOutbox();
    expect(sent).toHaveLength(1);
    expect(readOutbox()).toHaveLength(3);
    // Signed in again: they go.
    answer = async () => 3;
    await flushOutbox();
    expect(readOutbox()).toEqual([]);
  });

  it("drops a batch the server refuses for good, and goes on", async () => {
    for (let i = 0; i < 60; i += 1) enqueue(row(i));
    let calls = 0;
    answer = async () => {
      calls += 1;
      if (calls === 1) throw new Error("refused (400 22023)");
      return 10;
    };
    await flushOutbox();
    expect(sent.map((batch) => batch.length)).toEqual([50, 10]);
    expect(readOutbox()).toEqual([]);
  });

  it("tells a wait from a refusal", () => {
    for (const wait of ["signedOut", "rateLimited", "plan", "unavailable", "unreachable", "not reachable: timed out"]) {
      expect(isWait(wait), wait).toBe(true);
    }
    for (const refusal of ["refused (400 22023)", "refused (400 23514)"]) expect(isWait(refusal), refusal).toBe(false);
  });
});
