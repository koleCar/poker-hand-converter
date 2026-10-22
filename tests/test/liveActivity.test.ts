import { afterEach, describe, expect, it } from "vitest";

import {
  createActivityBoard,
  createActivityPublisher,
  estimateUploadTotal,
  uploadActivityFromMeta,
  uploadActivityOf,
  type ActivityTimers,
  type PresenceState,
  type UploadActivity,
} from "../../frontend/src/lib/live/activity.js";
import {
  activeDesktopSync,
  noteDesktopBatch,
  type ArrivalBatch,
} from "../../frontend/src/lib/live/arrivals.js";
import {
  activityTopic,
  openActivityChannel,
  resetActivityChannelsForTests,
  type ActivityChannelLike,
  type ActivityClientLike,
} from "../../frontend/src/components/live/activityChannel.js";

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 1_000_000;
  let nextId = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  const timers: ActivityTimers = {
    set(callback, ms) {
      const id = nextId++;
      queue.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
    now: () => now,
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let due: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of queue) {
        if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = end;
  }
  return { timers, advance, now: () => now, pending: () => queue.size };
}

function upload(over: Partial<UploadActivity> = {}): UploadActivity {
  return {
    v: 1,
    kind: "upload",
    id: "u1",
    state: "saving",
    sent: 0,
    inserted: 0,
    duplicates: 0,
    received: 0,
    total: null,
    estimated: false,
    at: 0,
    ...over,
  };
}

describe("what an upload publishes", () => {
  it("reads a well-formed entry and nothing else", () => {
    const meta = { ...upload({ sent: 120000, inserted: 119000, duplicates: 1000, total: 1000000, estimated: true, at: 5 }), presence_ref: "x" };
    expect(uploadActivityFromMeta(meta)).toEqual(upload({ sent: 120000, inserted: 119000, duplicates: 1000, total: 1000000, estimated: true, at: 5 }));
    for (const bad of [
      null,
      "upload",
      { ...meta, v: 2 },
      { ...meta, kind: "sync" },
      { ...meta, state: "exploded" },
      { ...meta, id: "" },
      { ...meta, id: "x".repeat(65) },
      { ...meta, id: 7 },
    ]) {
      expect(uploadActivityFromMeta(bad)).toBeNull();
    }
  });

  it("coerces counts off the wire: negative, fractional, junk", () => {
    const read = uploadActivityFromMeta({ ...upload(), sent: -5, inserted: 2.9, duplicates: "x", received: "12", total: 0, estimated: true });
    expect(read).toMatchObject({ sent: 0, inserted: 2, duplicates: 0, received: 12, total: null, estimated: false });
  });

  it("estimates the total from the files opened so far, once there is enough to go on", () => {
    const extent = (knownHands: number, bytesKnown: number, bytesTotal: number, converting = true) => ({ knownHands, bytesKnown, bytesTotal, converting });
    expect(estimateUploadTotal(100, extent(100, 1, 1000))).toEqual({ total: null, estimated: false });
    expect(estimateUploadTotal(0, extent(0, 500, 1000))).toEqual({ total: null, estimated: false });
    // A folder: 120 000 hands in the 12 % of bytes opened.
    expect(estimateUploadTotal(5000, extent(120000, 12, 100))).toEqual({ total: 1000000, estimated: true });
    // One big file: its split is the answer the moment it is opened, whatever was saved yet.
    expect(estimateUploadTotal(250, extent(30000, 100, 100))).toEqual({ total: 30000, estimated: true });
    // Never below what was already handed over, and exact once converting is over.
    expect(estimateUploadTotal(900, extent(500, 100, 100))).toEqual({ total: 900, estimated: true });
    expect(estimateUploadTotal(987654, extent(5, 3, 100, false))).toEqual({ total: 987654, estimated: false });
  });

  it("maps the saver's progress; a cancelled upload publishes nothing", () => {
    const progress = { state: "waiting-budget" as const, received: 2000, sent: 1500, inserted: 1400, duplicates: 100 };
    expect(uploadActivityOf("u9", progress, { knownHands: 3000, bytesKnown: 50, bytesTotal: 100, converting: true })).toEqual(
      upload({ id: "u9", state: "waiting", sent: 1500, inserted: 1400, duplicates: 100, received: 2000, total: 6000, estimated: true }),
    );
    expect(uploadActivityOf("u9", { ...progress, state: "cancelled" }, { knownHands: 0, bytesKnown: 0, bytesTotal: 0, converting: false })).toBeNull();
  });

  it("carries no hand and no file name, and stays small", () => {
    const activity = uploadActivityOf(
      "3f0c1a2e-8d7b-4c55-9e61-0a1b2c3d4e5f",
      { state: "saving", received: 1000000, sent: 999750, inserted: 990000, duplicates: 9750 },
      { knownHands: 1000000, bytesKnown: 1, bytesTotal: 1, converting: false },
    );
    expect(Object.keys(activity!).sort()).toEqual(
      ["at", "duplicates", "estimated", "id", "inserted", "kind", "received", "sent", "state", "total", "v"],
    );
    expect(JSON.stringify(activity).length).toBeLessThan(250);
  });
});

describe("createActivityPublisher", () => {
  function setup() {
    const clock = fakeTimers();
    const sent: Array<{ at: number; activity: UploadActivity | null }> = [];
    const publisher = createActivityPublisher({
      send: (activity) => sent.push({ at: clock.now(), activity }),
      timers: clock.timers,
    });
    return { ...clock, sent, publisher };
  }

  it("sends the first state at once, then counts at most every 2 s, latest wins", () => {
    const { publisher, advance, sent, now } = setup();
    const start = now();
    publisher.update(upload({ sent: 0 }));
    expect(sent).toHaveLength(1);
    for (let i = 1; i <= 10; i += 1) {
      advance(150);
      publisher.update(upload({ sent: i * 250 }));
    }
    expect(sent).toHaveLength(1);
    advance(500);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ at: start + 2000, activity: { sent: 2500 } });
    expect(sent[1].activity!.at).toBe(start + 2000);
  });

  it("a state change goes out at once", () => {
    const { publisher, advance, sent } = setup();
    publisher.update(upload());
    advance(100);
    publisher.update(upload({ state: "retrying", sent: 10 }));
    expect(sent.map((entry) => entry.activity?.state)).toEqual(["saving", "retrying"]);
  });

  it("nothing moving: a heartbeat every 15 s keeps the entry alive", () => {
    const { publisher, advance, sent } = setup();
    publisher.update(upload({ state: "paused", sent: 400 }));
    publisher.update(upload({ state: "paused", sent: 400 })); // the same again: nothing
    advance(15000 * 4);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((entry) => entry.activity!.at)).size).toBe(5);
  });

  it("done: sent at once, kept up 20 s for others to see, then withdrawn", () => {
    const { publisher, advance, sent, pending } = setup();
    publisher.update(upload({ sent: 10 }));
    publisher.update(upload({ state: "done", sent: 20, inserted: 20 }));
    expect(sent.at(-1)!.activity).toMatchObject({ state: "done", sent: 20 });
    publisher.update(upload({ state: "done", sent: 20, inserted: 20 }));
    advance(19999);
    expect(sent).toHaveLength(2);
    advance(1);
    expect(sent.at(-1)!.activity).toBeNull();
    expect(pending()).toBe(0);
  });

  it("a new upload after one finished is published at once", () => {
    const { publisher, advance, sent } = setup();
    publisher.update(upload({ state: "done" }));
    advance(25000);
    publisher.update(upload({ id: "u2" }));
    expect(sent.map((entry) => entry.activity?.id ?? null)).toEqual(["u1", null, "u2"]);
  });

  it("dispose withdraws once and silences everything after", () => {
    const { publisher, advance, sent, pending } = setup();
    publisher.update(upload({ sent: 1 }));
    advance(100);
    publisher.update(upload({ sent: 2 })); // a trailing send is scheduled
    publisher.dispose();
    publisher.dispose();
    expect(sent.map((entry) => entry.activity?.sent ?? null)).toEqual([1, null]);
    expect(pending()).toBe(0);
    publisher.update(upload({ sent: 3 }));
    advance(60000);
    expect(sent).toHaveLength(2);
  });

  it("a million-hand upload costs one message per 2 s, not one per call", () => {
    const { publisher, advance, sent } = setup();
    // ~4 000 calls of 250 hands over 67 minutes (R4.2's measured save rate).
    const calls = 4000;
    const gap = Math.round((67 * 60 * 1000) / calls);
    for (let i = 1; i <= calls; i += 1) {
      publisher.update(upload({ sent: i * 250, received: i * 250 }));
      advance(gap);
    }
    publisher.update(upload({ state: "done", sent: calls * 250 }));
    const messages = sent.filter((entry) => entry.activity !== null).length;
    expect(messages).toBeLessThanOrEqual((67 * 60) / 2 + 2);
    expect(messages).toBeGreaterThan(1000);
  });
});

describe("createActivityBoard", () => {
  function setup() {
    let now = 5_000_000;
    const board = createActivityBoard({ now: () => now });
    return { board, advance: (ms: number) => (now += ms), now: () => now };
  }
  const state = (...entries: Array<[string, UploadActivity]>): PresenceState =>
    Object.fromEntries(entries.map(([key, activity]) => [key, [{ ...activity, presence_ref: `ref-${key}` }]]));

  it("shows other tabs' uploads, never its own tab's", () => {
    const { board } = setup();
    board.sync(state(["mine", upload({ id: "a", at: 1 })], ["other", upload({ id: "b", at: 1, sent: 7 })]), "mine");
    expect(board.visible().map((entry) => [entry.id, entry.sent])).toEqual([["b", 7]]);
  });

  it("an entry that stops changing for 45 s is gone; a heartbeat keeps it", () => {
    const { board, advance } = setup();
    board.sync(state(["t", upload({ at: 1 })]));
    advance(30000);
    board.sync(state(["t", upload({ at: 2 })])); // heartbeat
    advance(44000);
    expect(board.visible()).toHaveLength(1);
    advance(1000);
    expect(board.visible()).toHaveLength(0);
  });

  it("uses its own clock: an uploader's clock far ahead keeps nothing alive", () => {
    const { board, advance } = setup();
    board.sync(state(["t", upload({ at: 99_999_999_999 })]));
    advance(45000);
    board.sync(state(["t", upload({ at: 99_999_999_999 })])); // unchanged
    expect(board.visible()).toHaveLength(0);
  });

  it("a tab that leaves takes its upload with it, unless it had finished", () => {
    const { board, advance } = setup();
    board.sync(state(["t1", upload({ id: "a", at: 1 })], ["t2", upload({ id: "b", state: "done", at: 1 })]));
    advance(5000);
    board.sync({});
    expect(board.visible().map((entry) => entry.id)).toEqual(["b"]);
    expect(board.nextChange()).not.toBeNull();
    advance(15000);
    expect(board.visible()).toHaveLength(0);
    expect(board.nextChange()).toBeNull();
  });

  it("one upload is one line, the newest entry wins; junk is skipped", () => {
    const { board } = setup();
    board.sync({
      t1: [{ ...upload({ id: "a", at: 5, sent: 50 }) }, { ...upload({ id: "a", at: 9, sent: 90 }) }],
      t2: [{ v: 1, kind: "upload", id: "a", state: "saving", at: 7, sent: 70 }, { hello: "world" }, null],
      t3: "not a list" as unknown as unknown[],
    });
    expect(board.visible()).toEqual([upload({ id: "a", at: 9, sent: 90 })]);
  });

  it("clear forgets everything (sign-out)", () => {
    const { board } = setup();
    board.sync(state(["t", upload()]));
    board.clear();
    expect(board.visible()).toEqual([]);
  });
});

describe("desktop sync line", () => {
  const batch = (desktopHands: number, hands = desktopHands): ArrivalBatch => ({
    seq: 1,
    hands,
    desktop: desktopHands > 0,
    desktopHands,
    resync: false,
  });

  it("adds desktop hands while batches keep coming, starts over after 2 quiet minutes", () => {
    let sync = noteDesktopBatch(null, batch(500), 0);
    sync = noteDesktopBatch(sync, batch(500), 60_000);
    sync = noteDesktopBatch(sync, batch(0, 3), 70_000); // web hands only: unchanged
    expect(sync).toEqual({ hands: 1000, lastAt: 60_000 });
    expect(activeDesktopSync(sync, 179_999)).not.toBeNull();
    expect(activeDesktopSync(sync, 180_000)).toBeNull();
    expect(noteDesktopBatch(sync, batch(200), 200_000)).toEqual({ hands: 200, lastAt: 200_000 });
  });
});

/* -------------------------------------------------------------- channel - */

class FakeChannel implements ActivityChannelLike {
  syncHandlers: Array<() => void> = [];
  statusHandler: ((status: string) => void) | null = null;
  state: PresenceState = {};
  tracks: Array<Record<string, unknown> | null> = [];
  constructor(
    readonly name: string,
    readonly options: unknown,
  ) {}
  on(_type: "presence", _filter: { event: "sync" }, callback: () => void) {
    this.syncHandlers.push(callback);
    return this;
  }
  subscribe(callback: (status: string) => void) {
    this.statusHandler = callback;
    return this;
  }
  track(payload: Record<string, unknown>) {
    this.tracks.push(payload);
    return Promise.resolve("ok");
  }
  untrack() {
    this.tracks.push(null);
    return Promise.resolve("ok");
  }
  presenceState() {
    return this.state;
  }
  status(status: string) {
    this.statusHandler?.(status);
  }
  presence(state: PresenceState) {
    this.state = state;
    for (const handler of this.syncHandlers) handler();
  }
}

function fakeClient() {
  const log: string[] = [];
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const client: ActivityClientLike = {
    realtime: {
      setAuth(token) {
        log.push(`setAuth:${token ?? "callback"}`);
        return Promise.resolve();
      },
    },
    channel(name, options) {
      log.push(`channel:${name}`);
      const channel = new FakeChannel(name, options);
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) {
      log.push("remove");
      removed.push(channel as FakeChannel);
      return Promise.resolve("ok");
    },
  };
  return { client, log, channels, removed };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the activity channel", () => {
  afterEach(() => resetActivityChannelsForTests());

  it("puts the user's token on the socket, then joins activity:<uid> privately with this tab's key", async () => {
    const { client, log, channels } = fakeClient();
    const link = openActivityChannel(client, "uid-a");
    await settle();
    expect(log).toEqual(["setAuth:callback", "channel:activity:uid-a"]);
    expect(activityTopic("uid-a")).toBe("activity:uid-a");
    expect(channels[0].options).toEqual({ config: { private: true, presence: { key: link.key, enabled: true } } });
    link.release();
  });

  it("the tab's users share one channel; the last one out removes it", async () => {
    const { client, channels, removed } = fakeClient();
    const viewer = openActivityChannel(client, "uid-a", () => undefined);
    const uploader = openActivityChannel(client, "uid-a");
    await settle();
    expect(channels).toHaveLength(1);
    expect(viewer.key).toBe(uploader.key);
    viewer.release();
    expect(removed).toHaveLength(0);
    uploader.release();
    uploader.release();
    expect(removed).toEqual([channels[0]]);
  });

  it("another account is another channel", async () => {
    const { client, channels } = fakeClient();
    const a = openActivityChannel(client, "uid-a");
    const b = openActivityChannel(client, "uid-b");
    await settle();
    expect(channels.map((channel) => channel.name)).toEqual(["activity:uid-a", "activity:uid-b"]);
    a.release();
    b.release();
  });

  it("listeners get the presence state on join and on every sync, and an empty one while down", async () => {
    const { client, channels, log } = fakeClient();
    const seen: Array<[PresenceState, string]> = [];
    const link = openActivityChannel(client, "uid-a", (state, key) => seen.push([state, key]));
    await settle();
    const channel = channels[0];
    channel.state = { other: [{ id: "x" }] };
    channel.status("SUBSCRIBED");
    channel.presence({ other: [{ id: "y" }] });
    channel.status("CHANNEL_ERROR");
    expect(seen.map(([state]) => Object.values(state).flat())).toEqual([[{ id: "x" }], [{ id: "y" }], []]);
    expect(seen.every(([, key]) => key === link.key)).toBe(true);
    // A failed join refreshes the token before realtime-js retries.
    expect(log.filter((entry) => entry.startsWith("setAuth"))).toHaveLength(2);
    link.release();
  });

  it("what this tab tracks waits for the join and is tracked again after a reconnect", async () => {
    const { client, channels } = fakeClient();
    const link = openActivityChannel(client, "uid-a");
    link.track(upload({ sent: 1 }));
    await settle();
    const channel = channels[0];
    expect(channel.tracks).toEqual([]);
    channel.status("SUBSCRIBED");
    expect(channel.tracks).toEqual([upload({ sent: 1 })]);
    link.track(upload({ sent: 2 }));
    channel.status("TIMED_OUT");
    link.track(upload({ sent: 3 })); // while down: held
    channel.status("SUBSCRIBED");
    expect(channel.tracks.map((payload) => payload?.sent)).toEqual([1, 2, 3]);
    link.release();
    expect(channel.tracks.at(-1)).toBeNull();
  });

  it("a viewer's release never untracks the uploader's entry", async () => {
    const { client, channels } = fakeClient();
    const uploader = openActivityChannel(client, "uid-a");
    const viewer = openActivityChannel(client, "uid-a", () => undefined);
    await settle();
    channels[0].status("SUBSCRIBED");
    uploader.track(upload());
    viewer.release();
    expect(channels[0].tracks).toEqual([upload()]);
    uploader.release();
  });

  it("released before the token is set: no channel is ever opened", async () => {
    const { client, channels } = fakeClient();
    const link = openActivityChannel(client, "uid-a");
    link.release();
    await settle();
    expect(channels).toHaveLength(0);
  });

  it("after the last release, late statuses and syncs reach nobody", async () => {
    const { client, channels } = fakeClient();
    const seen: unknown[] = [];
    const link = openActivityChannel(client, "uid-a", (state) => seen.push(state));
    await settle();
    link.release();
    channels[0].status("SUBSCRIBED");
    channels[0].presence({ t: [{}] });
    expect(seen).toEqual([]);
  });
});
