/**
 * The account deletion end to end against a LOCAL Supabase stack serving the
 * function (docs/RAIL-PLAN.md R6.5). Never against production: it creates a
 * user and deletes it. Run through `e2e.sh <workdir>`, which reads the
 * stack's URL and keys from `supabase status` and refuses a non-local URL.
 *
 * Creates a confirmed user, signs it in with a one-time token (a fresh
 * sign-in: the JWT's `amr` is now), gives it a web source, hands, a stored
 * original file and notes, then:
 *   - a wrong username is refused (400 confirmation_mismatch) and starts
 *     nothing;
 *   - the right one deletes, calling again while the function answers 202;
 *   - afterwards: the auth user is gone, no hand, note, source or stored
 *     object of it is left, the request is recorded as completed, and the
 *     same token is refused as signed out.
 * Prints no key, token or password.
 */

const url = Deno.env.get("RAIL_E2E_URL") ?? "";
const anon = Deno.env.get("RAIL_E2E_ANON_KEY") ?? "";
const service = Deno.env.get("RAIL_E2E_SERVICE_KEY") ?? "";
const functions = Deno.env.get("RAIL_E2E_FUNCTIONS_URL") ?? `${url}/functions/v1`;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) || !anon || !service) {
  console.error("refusing: RAIL_E2E_URL must be a local stack, with its anon and service keys");
  Deno.exit(1);
}

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}

const asService = { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" };

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// A confirmed user, signed in with a one-time token.
const email = `delete-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.test`;
const created = await call("/auth/v1/admin/users", {
  method: "POST",
  headers: asService,
  body: JSON.stringify({ email, email_confirm: true, password: crypto.randomUUID() }),
});
if (created.status !== 200) {
  console.error(`could not create the test user (HTTP ${created.status})`);
  Deno.exit(1);
}
const userId = (created.body as { id: string }).id;
const link = await call("/auth/v1/admin/generate_link", {
  method: "POST",
  headers: asService,
  body: JSON.stringify({ type: "magiclink", email }),
});
const tokenHash = (link.body as { hashed_token?: string }).hashed_token;
const session = await call("/auth/v1/verify", {
  method: "POST",
  headers: { apikey: anon, "Content-Type": "application/json" },
  body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
});
const jwt = (session.body as { access_token?: string }).access_token;
if (!jwt) {
  console.error(`could not sign the test user in (HTTP ${session.status})`);
  Deno.exit(1);
}
console.log(`test user: ${email}`);
const asUser = { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };

// Its data.
await call("/rest/v1/rpc/register_web_hand_source", { method: "POST", headers: asUser, body: "{}" });
const phf = (id: string) => ({
  schema: "phf/1",
  meta: { siteId: "pokerstars", handId: id, handKey: id, rawText: "", warnings: [] },
  game: { variant: "holdem", limit: "nl" },
  table: { name: "E2E", maxSeats: 6, buttonSeat: 1 },
  playedAt: "2026-08-30T21:43:07Z",
  players: [{ seat: 1, name: "Hero", isHero: true }],
  actions: [],
  board: { runouts: [] },
  results: { totalPot: 0, pots: [], players: [], winners: [] },
});
const hands = Array.from({ length: 25 }, (_, i) => ({
  owner_id: userId,
  hand_key: `pokerstars:e2e${i}`,
  phf: phf(`e2e${i}`),
  standard_text: `hand ${i}`,
  site: "pokerstars",
}));
const inserted = await call("/rest/v1/hands", { method: "POST", headers: asService, body: JSON.stringify(hands) });
check(inserted.status === 201, `25 hands stored (HTTP ${inserted.status})`);
await call("/rest/v1/player_notes", {
  method: "POST",
  headers: asService,
  body: JSON.stringify({ owner_id: userId, site: "pokerstars", player: "Villain", note: "e2e" }),
});
const gz = new Uint8Array(
  await new Response(new Blob(["hand history"]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
);
const upload = await fetch(`${url}/storage/v1/object/hand-uploads/${userId}/up1/HH1.txt.0badc0de.gz`, {
  method: "POST",
  headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/gzip" },
  body: gz,
});
await upload.body?.cancel();
check(upload.ok, `an original file stored under the user's folder (HTTP ${upload.status})`);
const profile = await call("/rest/v1/rpc/my_profile", { method: "POST", headers: asUser, body: "{}" });
const username = (profile.body as { username: string }).username;

const count = async (path: string) => {
  const r = await fetch(`${url}${path}`, { headers: { ...asService, Prefer: "count=exact" } });
  await r.body?.cancel();
  return Number((r.headers.get("content-range") ?? "*/-1").split("/")[1]);
};
check((await count(`/rest/v1/hands?owner_id=eq.${userId}&select=id`)) === 25, "before: 25 hands");

// The wrong username: refused, nothing started.
const fn = (body: unknown) =>
  fetch(`${functions}/account-delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const wrong = await fn({ confirm: "somebody_else" });
check(
  wrong.status === 400 && (wrong.body as { error?: string })?.error === "confirmation_mismatch",
  `a wrong username is refused (HTTP ${wrong.status})`,
);
check((await count(`/rest/v1/account_deletions?user_id=eq.${userId}&select=user_id`)) === 0, "... and starts nothing");

// The right one, called again while the function says it is still working.
let result = await fn({ confirm: username.toUpperCase() });
let rounds = 1;
while (result.status === 202 && rounds < 50) {
  result = await fn({});
  rounds++;
}
check(result.status === 200, `the deletion completes (HTTP ${result.status}, ${rounds} call(s))`);

const user = await call(`/auth/v1/admin/users/${userId}`, { headers: asService });
check(user.status === 404, `the auth user is gone (HTTP ${user.status})`);
check((await count(`/rest/v1/hands?owner_id=eq.${userId}&select=id`)) === 0, "no hand is left");
check((await count(`/rest/v1/player_notes?owner_id=eq.${userId}&select=owner_id`)) === 0, "no note is left");
check((await count(`/rest/v1/hand_sources?owner_id=eq.${userId}&select=id`)) === 0, "no source is left");
check((await count(`/rest/v1/profiles?id=eq.${userId}&select=id`)) === 0, "no profile is left");
const objects = await call("/storage/v1/object/list/hand-uploads", {
  method: "POST",
  headers: asService,
  body: JSON.stringify({ prefix: `${userId}/up1`, limit: 10 }),
});
check(Array.isArray(objects.body) && (objects.body as unknown[]).length === 0, "no stored object is left");
const record = await call(`/rest/v1/account_deletions?user_id=eq.${userId}&select=completed_at`, {
  headers: asService,
});
check(
  Array.isArray(record.body) && typeof (record.body as { completed_at?: string }[])[0]?.completed_at === "string",
  "the request is recorded as completed",
);
const after = await fn({});
check(after.status === 401, `the same token is refused afterwards (HTTP ${after.status})`);

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
Deno.exit(failures === 0 ? 0 : 1);
