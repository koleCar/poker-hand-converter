/**
 * The account's private activity channel (Rail R4.3): one Realtime channel
 * per tab and account, `activity:<uid>`, shared by whoever in the tab needs
 * it - the converter publishing an upload, the shell showing other tabs'.
 *
 * - **Private.** `config.private` makes Realtime check the join and every
 *   presence track against `realtime.messages` RLS
 *   (`20270616090000_live_activity.sql`): only the account itself may join
 *   `activity:<its uid>`, only presence may be sent, `anon` may do nothing.
 *   The user's token goes on the socket before the join (`setAuth()` with no
 *   argument: supabase-js's own callback, which also refreshes it on every
 *   heartbeat and on `TOKEN_REFRESHED`).
 * - **One channel, counted.** realtime-js keeps one channel object per topic
 *   on a client, and listeners cannot be added after a join, so the tab's
 *   users share one, opened by the first and removed with the last.
 * - **Reconnects.** realtime-js rejoins on its own after a dropped socket;
 *   a rejoin starts with an empty presence for this tab, so what this tab had
 *   tracked is tracked again on every `SUBSCRIBED`. A refused or failed join
 *   refreshes the token (`setAuth()`) before realtime-js's own retry - an
 *   expired token is the usual reason.
 * - **Presence key**: one random id per page load (`tabKey`), so the shell
 *   can leave its own tab's upload out (the converter shows it already).
 *
 * Framework-free and written against a narrow client type, so the lifecycle
 * is tested with a fake client (`tests/test/liveActivity.test.ts`).
 */

import type { PresenceState, UploadActivity } from "../../lib/live/activity";

/** The part of a realtime-js channel this module uses. */
export interface ActivityChannelLike {
  on(type: "presence", filter: { event: "sync" }, callback: () => void): ActivityChannelLike;
  subscribe(callback: (status: string, error?: Error) => void): ActivityChannelLike;
  track(payload: Record<string, unknown>): Promise<unknown>;
  untrack(): Promise<unknown>;
  presenceState(): PresenceState;
}

/** The part of a Supabase client this module uses. */
export interface ActivityClientLike {
  realtime: { setAuth(token?: string | null): Promise<void> };
  channel(name: string, options: { config: { private: boolean; presence: { key: string; enabled: boolean } } }): ActivityChannelLike;
  removeChannel(channel: ActivityChannelLike): Promise<unknown>;
}

export type ActivityListener = (state: PresenceState, ownKey: string) => void;

export interface ActivityLink {
  /** This tab's presence key. */
  readonly key: string;
  /** Publishes this tab's upload, or withdraws it (null). */
  track(activity: UploadActivity | null): void;
  /** Done with the channel; the last link removes it. */
  release(): void;
}

export const ACTIVITY_TOPIC_PREFIX = "activity:";

export function activityTopic(userId: string): string {
  return `${ACTIVITY_TOPIC_PREFIX}${userId}`;
}

function randomKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Per page load; exported for tests. */
let tabKey: string | null = null;
export function currentTabKey(): string {
  tabKey ??= randomKey();
  return tabKey;
}

interface Hub {
  client: ActivityClientLike;
  userId: string;
  key: string;
  channel: ActivityChannelLike | null;
  listeners: Set<ActivityListener>;
  links: number;
  joined: boolean;
  closed: boolean;
  /** What this tab tracks, re-sent after every (re)join; null = nothing. */
  tracked: UploadActivity | null;
}

const hubs = new Map<string, Hub>();

let clientIds = new WeakMap<ActivityClientLike, number>();
let nextClientId = 1;

function hubId(client: ActivityClientLike, userId: string): string {
  // One hub per client and account; clients are per page in practice.
  let id = clientIds.get(client);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(client, id);
  }
  return `${id}:${userId}`;
}

function emit(hub: Hub) {
  if (!hub.channel || hub.closed) return;
  const state = hub.channel.presenceState();
  for (const listener of hub.listeners) {
    listener(state, hub.key);
  }
}

function pushTracked(hub: Hub) {
  if (!hub.channel || !hub.joined || hub.closed) return;
  const payload = hub.tracked;
  // A refused send is not fatal: the next update or heartbeat tries again.
  void (payload ? hub.channel.track({ ...payload }) : hub.channel.untrack()).catch(() => undefined);
}

function open(hub: Hub) {
  void hub.client.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (hub.closed) return;
      const channel = hub.client.channel(activityTopic(hub.userId), {
        config: { private: true, presence: { key: hub.key, enabled: true } },
      });
      hub.channel = channel;
      channel.on("presence", { event: "sync" }, () => emit(hub));
      channel.subscribe((status) => {
        if (hub.closed) return;
        if (status === "SUBSCRIBED") {
          hub.joined = true;
          if (hub.tracked) pushTracked(hub);
          emit(hub);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          hub.joined = false;
          // Others' entries cannot be trusted while disconnected.
          for (const listener of hub.listeners) listener({}, hub.key);
          if (status !== "CLOSED") {
            // Usually an expired token: the next rejoin carries a fresh one.
            void hub.client.realtime.setAuth().catch(() => undefined);
          }
        }
      });
    });
}

/**
 * Joins (or shares) the account's activity channel. `listener` gets the
 * channel's presence state on every change - and an empty one while the
 * channel is down.
 */
export function openActivityChannel(
  client: ActivityClientLike,
  userId: string,
  listener?: ActivityListener,
): ActivityLink {
  const id = hubId(client, userId);
  let hub = hubs.get(id);
  if (!hub) {
    hub = {
      client,
      userId,
      key: currentTabKey(),
      channel: null,
      listeners: new Set(),
      links: 0,
      joined: false,
      closed: false,
      tracked: null,
    };
    hubs.set(id, hub);
    open(hub);
  }
  const current = hub;
  current.links += 1;
  if (listener) {
    current.listeners.add(listener);
    if (current.joined) listener(current.channel?.presenceState() ?? {}, current.key);
  }
  let released = false;
  let tracking = false;

  return {
    key: current.key,
    track(activity) {
      if (released) return;
      tracking = activity !== null;
      current.tracked = activity;
      pushTracked(current);
    },
    release() {
      if (released) return;
      released = true;
      if (listener) current.listeners.delete(listener);
      if (tracking) {
        current.tracked = null;
        pushTracked(current);
      }
      current.links -= 1;
      if (current.links === 0) {
        current.closed = true;
        hubs.delete(id);
        if (current.channel) void current.client.removeChannel(current.channel).catch(() => undefined);
      }
    },
  };
}

/** Tests only: forget every hub and the tab key. */
export function resetActivityChannelsForTests() {
  hubs.clear();
  clientIds = new WeakMap();
  tabKey = null;
}
