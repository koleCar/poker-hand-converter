/**
 * Live progress across tabs (docs/RAIL-PLAN.md R4.3): what Realtime actually
 * allows on the account's private presence channel `activity:<uid>`, checked
 * through a real Realtime server.
 *
 * pgTAP (`supabase/tests/database/live_activity.test.sql`) proves the two
 * `realtime.messages` policies as SQL. This proves the part pgTAP cannot
 * reach: that Realtime runs them on a private join and on a presence track,
 * and that a public channel of the same name is not a way round them.
 * Against a **local** stack only (it creates and deletes two users with the
 * service key):
 *
 *   RAIL_REALTIME_URL=http://127.0.0.1:<api port> \
 *   RAIL_REALTIME_ANON_KEY=... RAIL_REALTIME_SERVICE_KEY=... \
 *   npm run realtime:activity
 *
 * (`supabase status -o env` prints the keys; same stack notes as
 * `npm run realtime:arrivals`.)
 *
 * Sockets: A's uploading tab, A's other device (a second sign-in), B, anon.
 * A tracks an upload; the other device must see it, and see it leave when
 * the uploading tab goes away. B and anon must not be able to join A's
 * private channel, and nothing on a public channel called `activity:<A>`
 * may reach A's private one or come out of it.
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

function client() {
  return createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email) {
  const c = client();
  const { data, error } = await c.auth.signInWithPassword({
    email,
    password,
    // Turnstile's documented dummy token; the stack's test secret accepts it.
    options: { captchaToken: "XXXX.DUMMY.TOKEN.XXXX" },
  });
  if (error) throw error;
  // The web does the same before a join: the user's token, from the client's own callback.
  await c.realtime.setAuth();
  return c;
}

async function user(name) {
  const email = `${name}-${tag}@example.test`;
  const created = await admin("POST", "users", { email, password, email_confirm: true });
  return { id: created.id, email };
}

/**
 * Joins `topic` and resolves with the join's outcome; presence syncs are
 * recorded as the set of upload ids seen.
 */
function join(c, topic, { isPrivate = true, key = "viewer" } = {}) {
  const syncs = [];
  const broadcasts = [];
  const channel = c.channel(topic, { config: { private: isPrivate, presence: { key, enabled: true } } });
  channel.on("broadcast", { event: "probe" }, (message) => broadcasts.push(message));
  channel.on("presence", { event: "sync" }, () => {
    const state = channel.presenceState();
    const ids = Object.values(state)
      .flat()
      .map((meta) => meta.id)
      .filter(Boolean)
      .sort();
    syncs.push({ at: Date.now(), ids, raw: state });
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = (status, err) => {
      if (settled) return;
      settled = true;
      resolve({ channel, status, error: err ? String(err.message ?? err) : null, syncs, broadcasts });
    };
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") done(status, err);
    });
    setTimeout(() => done("NO_ANSWER", null), 8000);
  });
}
const lastIds = (sub) => (sub.syncs.length ? sub.syncs[sub.syncs.length - 1].ids : []);

const a = await user("activity-a");
const b = await user("activity-b");
const aTab = await signIn(a.email);
const aOther = await signIn(a.email);
const bTab = await signIn(b.email);
const anon = client();

const topicA = `activity:${a.id}`;
const topicB = `activity:${b.id}`;

// The uploading tab joins and tracks an upload.
const uploader = await join(aTab, topicA, { key: "tab-1" });
check(uploader.status === "SUBSCRIBED", `A joins its own private channel: ${uploader.status} ${uploader.error ?? ""}`);
const upload = { v: 1, kind: "upload", id: `up-${tag}`, state: "saving", sent: 120000, inserted: 119000, duplicates: 1000, received: 121500, total: 1000000, at: Date.now() };
const tracked = await uploader.channel.track(upload);
check(tracked === "ok", `A tracks its upload on its private channel: ${tracked}`);

// The same account elsewhere.
const other = await join(aOther, topicA, { key: "tab-2" });
check(other.status === "SUBSCRIBED", `A's other device joins: ${other.status}`);
await sleep(1500);
check(JSON.stringify(lastIds(other)) === JSON.stringify([upload.id]), `A's other device sees the upload at once: ${JSON.stringify(lastIds(other))}`);
const meta = Object.values(other.syncs.at(-1)?.raw ?? {}).flat()[0] ?? {};
check(meta.total === 1000000 && meta.sent === 120000, "with its counts");
const bytes = JSON.stringify(meta).length;
check(bytes < 400, `one presence entry is ${bytes} bytes`);

// Someone else.
const bOnA = await join(bTab, topicA, { key: "intruder" });
check(bOnA.status !== "SUBSCRIBED", `B cannot join A's private channel: ${bOnA.status} ${bOnA.error ?? ""}`);
const anonOnA = await join(anon, topicA, { key: "anon" });
check(anonOnA.status !== "SUBSCRIBED", `anon cannot join A's private channel: ${anonOnA.status} ${anonOnA.error ?? ""}`);
const aOnB = await join(aOther, topicB, { key: "tab-2b" });
check(aOnB.status !== "SUBSCRIBED", `A cannot join B's private channel: ${aOnB.status}`);
const bOwn = await join(bTab, topicB, { key: "b-tab" });
check(bOwn.status === "SUBSCRIBED", `B joins its own: ${bOwn.status}`);

// A public channel with the same name is another channel. Fresh sockets: a
// client keeps one channel object per topic, and these already tried it.
const bSpy = await signIn(b.email);
const anonSpy = client();
const bPublic = await join(bSpy, topicA, { isPrivate: false, key: "spy" });
const anonPublic = await join(anonSpy, topicA, { isPrivate: false, key: "anon-spy" });
let spoof = "skipped";
if (bPublic.status === "SUBSCRIBED") {
  spoof = await bPublic.channel.track({ v: 1, kind: "upload", id: "forged", state: "saving", sent: 1, total: 2, at: Date.now() });
}
await uploader.channel.track({ ...upload, sent: 130000, at: Date.now() });
await sleep(2000);
const leaked = [...bPublic.syncs, ...anonPublic.syncs].some((sync) => sync.ids.includes(upload.id));
check(!leaked, `a public channel named activity:<A> receives none of A's presence (B public: ${bPublic.status}, anon public: ${anonPublic.status})`);
check(!lastIds(other).includes("forged"), `nothing tracked on that public channel reaches A's private one (track: ${spoof})`);
check([...bOwn.syncs].every((sync) => sync.ids.length === 0), "B's own channel never shows A's upload");
const latest = Object.values(other.syncs.at(-1)?.raw ?? {}).flat()[0] ?? {};
check(latest.sent === 130000, `an update reaches the other device: sent ${latest.sent}`);

// Members may receive on the channel (Realtime's join needs it) but nobody
// may broadcast on it: the only thing sent here is presence.
const sent = await uploader.channel.send({ type: "broadcast", event: "probe", payload: { x: 1 } });
await sleep(1500);
check(other.broadcasts.length === 0, `a broadcast on the private channel is not delivered (send: ${sent})`);

// The uploading tab goes away: its entry leaves.
const before = Date.now();
await aTab.removeAllChannels();
let left = Number.POSITIVE_INFINITY;
for (let i = 0; i < 40; i += 1) {
  await sleep(250);
  if (lastIds(other).length === 0) {
    left = Date.now() - before;
    break;
  }
}
check(left < 10000, `the upload leaves A's other device when the tab closes (${left} ms)`);

for (const c of [aOther, bTab, anon, bSpy, anonSpy]) await c.removeAllChannels();
await admin("DELETE", `users/${a.id}`);
await admin("DELETE", `users/${b.id}`);
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
