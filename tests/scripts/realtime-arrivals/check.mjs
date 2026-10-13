/**
 * Live arrival on the web (docs/RAIL-PLAN.md R1.10): what Realtime actually
 * delivers for `hand_arrivals`, checked through a real Realtime server.
 *
 * pgTAP (`supabase/tests/database/hand_arrivals.test.sql`) proves the table,
 * the policy, the grants, the trigger and the publication. This proves the
 * part pgTAP cannot reach: that Realtime applies the policy to the change
 * feed. Against a **local** stack only (it creates two users with the
 * service key and deletes one of them):
 *
 *   RAIL_REALTIME_URL=http://127.0.0.1:<api port> \
 *   RAIL_REALTIME_ANON_KEY=... RAIL_REALTIME_SERVICE_KEY=... \
 *   npm run realtime:arrivals
 *
 * (`supabase status -o env` prints the keys.) The stack needs Turnstile's
 * test secret, as `supabase/config.toml` has it, and `supabase/.temp`
 * removed from the stack's copy (docs/RAIL-PLAN.md R1.7, local-stack
 * pitfall) so the admin API accepts the service key.
 *
 * Subscriptions: A on its own id, A on B's id (a forged filter), A with no
 * filter, B on its own id, anon with no filter. Writes: one 500-hand
 * `ingest_hands` call as A, a 3-hand call as B, one web `save_hands` as A,
 * A's batch again (all duplicates). Then B's account is deleted.
 */

import { randomBytes } from "node:crypto";

const URL_ = process.env.RAIL_REALTIME_URL ?? "";
const ANON = process.env.RAIL_REALTIME_ANON_KEY ?? "";
const SERVICE = process.env.RAIL_REALTIME_SERVICE_KEY ?? "";
if (!URL_ || !ANON || !SERVICE) {
  console.error("Set RAIL_REALTIME_URL, RAIL_REALTIME_ANON_KEY and RAIL_REALTIME_SERVICE_KEY (a local stack).");
  process.exit(2);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(URL_).hostname)) {
  console.error("Refusing: this check creates and deletes users, so it runs against a local stack only.");
  process.exit(2);
}

const { createClient } = await import("../../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs");

const tag = randomBytes(3).toString("hex");
const password = randomBytes(12).toString("base64url");
const results = [];
const check = (ok, name) => {
  results.push(ok);
  console.log(`${ok ? "ok" : "NOT OK"} - ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function admin(method, route, body) {
  const response = await fetch(`${URL_}/auth/v1/admin/${route}`, {
    method,
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function user(name) {
  const email = `${name}-${tag}@example.test`;
  const created = await admin("POST", "users", { email, password, email_confirm: true });
  const client = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
    // Turnstile's documented dummy token; the stack's test secret accepts it.
    options: { captchaToken: "XXXX.DUMMY.TOKEN.XXXX" },
  });
  if (error) throw error;
  await client.realtime.setAuth(data.session.access_token);
  return { id: created.id, client };
}

/** A small hold'em hand in the shape the desktop sends (rawText empty). */
function phf(id) {
  return {
    schema: "phf/1",
    meta: {
      siteId: "weplay", siteName: "WePlay", handId: id, handKey: id, originalFilename: "HH20261001.txt",
      parserId: "weplay", parserVersion: "1.0.0", warnings: [], rawText: "", parsedAt: "1970-01-01T00:00:00.000Z",
      textStyle: { decimals: "minimal" },
    },
    game: {
      variant: "holdem", limit: "nl", format: "cash", ante: 0,
      unit: { code: "USD", symbol: "$", minorUnits: 100, kind: "cash" }, smallBlind: 50, bigBlind: 100,
    },
    table: { name: "Table 1", maxSeats: 6 },
    tournament: null,
    players: [
      { seat: 1, name: "HeroName", isHero: true, position: "BTN", holeCards: ["Ah", "Kh"] },
      { seat: 2, name: "Villain1", isHero: false, position: "SB" },
      { seat: 3, name: "Villain2", isHero: false, position: "BB" },
    ],
    actions: [],
    board: { runouts: [{ flop: ["2c", "3d", "4s"], turn: "5h", river: null }] },
    results: {
      streetReached: "turn", wentToShowdown: false, totalPot: 300, heroNet: 200,
      fees: { rake: 5, jackpot: 1, bingo: 0, fortune: 0, tax: 0, other: 0 },
      winners: [{ player: "HeroName", seat: 1 }], players: [],
    },
    playedAt: "2026-10-01T12:00:00.000Z",
  };
}

async function ingest(u, prefix, n) {
  const { data: source, error: e1 } = await u.client.rpc("register_hand_source", {
    p_device_id: "00000000-0000-4000-8000-" + randomBytes(6).toString("hex"),
    p_local_id: "f1",
  });
  if (e1) throw e1;
  const rows = Array.from({ length: n }, (_, i) => ({ hand_key: `weplay:${prefix}${i}`, phf: phf(`${prefix}${i}`) }));
  const { data, error } = await u.client.rpc("ingest_hands", { p_source: source, p_rows: rows });
  if (error) throw error;
  return data;
}

function listen(u, label, filter) {
  const events = [];
  return new Promise((resolve, reject) => {
    const channel = u.client.channel(`${label}-${tag}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "hand_arrivals", ...(filter ? { filter } : {}) },
      (payload) => events.push({ at: Date.now(), payload, bytes: JSON.stringify(payload).length }),
    );
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") resolve({ events });
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") reject(err ?? new Error(`${label}: ${status}`));
    });
  });
}
const summary = (sub) =>
  sub.events.map((e) => `${e.payload.eventType}:${e.payload.new?.hands ?? "-"}:${e.payload.new?.origin ?? "-"}`);

const A = await user("arrivals-a");
const B = await user("arrivals-b");
const anon = { client: createClient(URL_, ANON, { auth: { persistSession: false } }) };

const own = await listen(A, "a-own", `owner_id=eq.${A.id}`);
const forged = await listen(A, "a-forged", `owner_id=eq.${B.id}`);
const unfiltered = await listen(A, "a-all", null);
const ownB = await listen(B, "b-own", `owner_id=eq.${B.id}`);
const anonAll = await listen(anon, "anon-all", null);
await sleep(1500);

const first = await ingest(A, "a", 500);
const returned = Date.now();
check(first.inserted === 500, "A's ingest_hands call stores 500 desktop hands");
check((await ingest(B, "b", 3)).inserted === 3, "B's call stores 3");
const { data: saved, error: saveError } = await A.client.rpc("save_hands", {
  p_hands: [{ hand_key: "weplay:aweb", phf: phf("aweb"), site: "weplay", standard_text: "Poker Hand #aweb" }],
});
if (saveError) throw saveError;
check(saved.inserted === 1, "A saves one hand on the web");
check((await ingest(A, "a", 500)).duplicates === 500, "A's batch again: all duplicates");
await sleep(5000);

check(
  JSON.stringify(summary(own)) === JSON.stringify(["INSERT:500:desktop", "UPDATE:1:web"]),
  `A receives one change per call, none for the duplicates: ${JSON.stringify(summary(own))}`,
);
check(own.events.every((e) => e.payload.new.owner_id === A.id), "every change A receives is A's own row");
check(forged.events.length === 0, "A subscribed to B's owner_id receives nothing");
check(
  unfiltered.events.length === 2 && unfiltered.events.every((e) => e.payload.new.owner_id === A.id),
  "A subscribed with no filter receives only A's own changes",
);
check(JSON.stringify(summary(ownB)) === JSON.stringify(["INSERT:3:desktop"]), "B receives only B's change");
check(anonAll.events.length === 0, "anon with no filter receives nothing (not even 401 notices)");
const latency = own.events[0] ? own.events[0].at - returned : Number.POSITIVE_INFINITY;
check(latency < 2000, `the first change arrives ${latency} ms after the call returned`);
const sizes = own.events.map((e) => e.bytes);
check(sizes.every((bytes) => bytes < 1000), `payloads are ${sizes.join(" and ")} bytes`);
check(own.events.every((e) => !("phf" in (e.payload.new ?? {}))), "no hand content in any payload");

// The one change RLS cannot check: a DELETE, which only an account's removal causes.
await admin("DELETE", `users/${B.id}`);
await sleep(3000);
const deletes = unfiltered.events.filter((e) => e.payload.eventType === "DELETE");
check(
  deletes.every((e) => Object.keys(e.payload.old ?? {}).join(",") === "id" && e.payload.old.id !== B.id),
  `B's removal shows an unfiltered subscriber at most the row's random id: ${JSON.stringify(deletes.map((e) => e.payload.old))}`,
);
check(own.events.length === 2 && forged.events.length === 0, "filtered subscriptions see no DELETE");

for (const u of [A, B, anon]) await u.client.removeAllChannels();
await admin("DELETE", `users/${A.id}`);
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
