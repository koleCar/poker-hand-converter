/**
 * Share links hide the players' names by default (docs/RAIL-PLAN.md R4.5),
 * checked end to end: the pages a stranger opens, as the web serves them.
 *
 * pgTAP (`supabase/tests/database/share_names.test.sql`) pins `read_share`'s
 * payload on a made-up hand. This checks what the payload becomes: the
 * share page `/h/:slug` (body, RSC payload, `<title>`, Open Graph tags) and
 * the embed `/embed/h/:slug`, for corpus hands chosen for awkward names
 * (`fixtures/samples/pokerstars`: slashes and brackets, a colon, mojibake),
 * for a stored hand and a never-saved (embedded) one - no screen name may
 * appear anywhere in the HTML, "Hero" and "Villain1" must. Then the owner
 * turns names on and the page must show them (so the check cannot pass by
 * showing nothing), and off again.
 *
 * Against a **local** stack and a local web server only (it creates a user
 * with the service key and deletes it):
 *
 *   RAIL_SHARE_SUPABASE_URL=http://127.0.0.1:<api port> \
 *   RAIL_SHARE_ANON_KEY=... RAIL_SHARE_SERVICE_KEY=... \
 *   RAIL_SHARE_WEB_URL=http://localhost:<port> \
 *   npm run share:names
 *
 * The web server is `next build && next start` of `frontend/` with
 * `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` pointing at the
 * same stack. The stack needs Turnstile's test secret (as
 * `supabase/config.toml` has it) and its `supabase/.temp` removed (R1.7's
 * local-stack pitfall) so the admin API accepts the service key. Not in CI:
 * it needs Docker and a production build.
 *
 * The OG image of a share is the static `/og-default.png` (no per-share
 * image route exists); `/og/p/:id` serves published hands, which were
 * anonymised by `publish_hand` before R4.5.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient, type SupabaseClient } from "../../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodeSource } from "../../../frontend/src/components/converter/inputs.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import { handKeyOf } from "../../../frontend/src/lib/db/mapping.js";
import { toStandardText } from "../../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { ROOT } from "../golden/emit.js";

const SUPABASE = process.env.RAIL_SHARE_SUPABASE_URL ?? "";
const ANON = process.env.RAIL_SHARE_ANON_KEY ?? "";
const SERVICE = process.env.RAIL_SHARE_SERVICE_KEY ?? "";
const WEB = process.env.RAIL_SHARE_WEB_URL ?? "";
const LOCAL = ["127.0.0.1", "localhost", "[::1]"];
const configured = Boolean(SUPABASE && ANON && SERVICE && WEB);
if (configured && (!LOCAL.includes(new URL(SUPABASE).hostname) || !LOCAL.includes(new URL(WEB).hostname))) {
  throw new Error("Refusing: this check creates and deletes a user, so it runs against a local stack only.");
}

const FILES = [
  "fixtures/samples/pokerstars/03-cash-plo-run-it-twice-sidepot-dualtimestamp.txt",
  "fixtures/samples/pokerstars/30-cash-nlhe-eur-dual-timestamp-cet-et.txt",
  "fixtures/samples/pokerstars/31-cash-zoom-nlhe-utc-timezone.txt",
  "fixtures/samples/pokerstars/04-cash-nlhe-playername-slashes-brackets.txt",
  "fixtures/samples/pokerstars/05-cash-nlhe-playername-with-colon.txt",
  "fixtures/samples/pokerstars/09-cash-nlhe-sidepot-ante-mojibake-name.txt",
];

async function firstHand(file: string): Promise<PhfHand> {
  const bytes = readFileSync(join(ROOT, file));
  const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  const result = await convertAny(decoded.text, { sourceFilename: file.split("/").pop() ?? "", validate: true });
  const hand =
    result.hands.find((candidate) => candidate.players.some((player) => player.isHero)) ?? result.hands[0];
  if (!hand) throw new Error(`${file}: no hand`);
  return hand;
}

/** The names a page must not print: every player's, as written and HTML-escaped. */
function forbidden(hand: PhfHand): string[] {
  const out = new Set<string>();
  for (const player of hand.players) {
    const name = player.name;
    // "Hero" is the scrubber's own word; a name that short would match markup.
    if (!name || name === "Hero" || name.length < 3) continue;
    out.add(name);
    out.add(name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
    // Inside the RSC payload a name is a JSON string.
    out.add(JSON.stringify(name).slice(1, -1));
  }
  return [...out];
}

async function page(path: string): Promise<string> {
  const response = await fetch(`${WEB}${path}`, { headers: { "accept-language": "en" } });
  expect(response.status, path).toBe(200);
  return response.text();
}

async function admin(method: string, route: string, body?: unknown) {
  const response = await fetch(`${SUPABASE}/auth/v1/admin/${route}`, {
    method,
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status}`);
  return text ? JSON.parse(text) : null;
}

describe.skipIf(!configured)("share links hide names by default (R4.5)", () => {
  let userId = "";
  let client: SupabaseClient;
  const hands: PhfHand[] = [];

  beforeAll(async () => {
    for (const file of FILES) hands.push(await firstHand(file));
    const email = `share-names-${randomBytes(3).toString("hex")}@example.test`;
    const password = randomBytes(12).toString("base64url");
    userId = (await admin("POST", "users", { email, password, email_confirm: true })).id;
    client = createClient(SUPABASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken: "XXXX.DUMMY.TOKEN.XXXX" },
    });
    if (error) throw error;
  });

  afterAll(async () => {
    // `RAIL_SHARE_KEEP=1` keeps the user and its links for a look in a browser.
    if (userId && !process.env.RAIL_SHARE_KEEP) await admin("DELETE", `users/${userId}`);
  });

  async function storedShare(hand: PhfHand, spoilers: boolean): Promise<string> {
    const { data: source, error: e1 } = await client.rpc("register_hand_source", {
      p_device_id: `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`,
      p_local_id: "share-names",
    });
    if (e1) throw e1;
    const key = handKeyOf(hand);
    const { data: ingested, error: e2 } = await client.rpc("ingest_hands", {
      p_source: source,
      p_rows: [{ hand_key: key, phf: { ...hand, meta: { ...hand.meta, rawText: "" } } }],
    });
    if (e2) throw e2;
    const { data: row, error: e3 } = await client.from("hands").select("id").eq("hand_key", key).maybeSingle();
    if (e3) throw e3;
    if (!row) throw new Error(`not stored: ${JSON.stringify(ingested).slice(0, 300)}`);
    const { data, error } = await client.rpc("create_share", { p_hand_id: row.id, p_spoilers: spoilers });
    if (error) throw error;
    return (data as { slug: string }).slug;
  }

  async function embeddedShare(hand: PhfHand): Promise<string> {
    const { data, error } = await client.rpc("create_share", {
      p_phf: hand,
      p_standard_text: toStandardText(hand),
      p_spoilers: true,
    });
    if (error) throw error;
    return (data as { slug: string }).slug;
  }

  function expectAnonymised(html: string, hand: PhfHand, where: string) {
    for (const name of forbidden(hand)) {
      expect(html.includes(name), `${where}: a screen name is in the page`).toBe(false);
    }
    if (hand.players.some((player) => player.isHero)) {
      expect(html, `${where}: the hero is "Hero"`).toContain("Hero");
    }
    expect(html, `${where}: an opponent is "Villain1"`).toContain("Villain1");
  }

  it("a stored hand's link and its embed show no names, metadata included", async () => {
    for (const [i, hand] of hands.entries()) {
      // Spoilers on, so the unfurl's description names the winner - by pseudonym.
      const slug = await storedShare(hand, true);
      if (process.env.RAIL_SHARE_KEEP) console.log(`kept: /h/${slug} (${FILES[i]})`);
      expectAnonymised(await page(`/h/${slug}`), hand, `${FILES[i]} /h`);
      expectAnonymised(await page(`/embed/h/${slug}`), hand, `${FILES[i]} /embed/h`);
    }
  });

  it("a never-saved hand's link and its embed show no names", async () => {
    for (const [i, hand] of hands.entries()) {
      const slug = await embeddedShare(hand);
      expectAnonymised(await page(`/h/${slug}`), hand, `${FILES[i]} embedded /h`);
      expectAnonymised(await page(`/embed/h/${slug}`), hand, `${FILES[i]} embedded /embed/h`);
    }
  });

  it("names appear only after the owner turns them on, and go when turned off", async () => {
    const hand = hands.find((candidate) => candidate.players.some((player) => player.isHero && player.name.length > 2));
    if (!hand) throw new Error("no corpus hand with a named hero");
    const hero = hand.players.find((player) => player.isHero)?.name ?? "";
    // The same hand again is the same stored row (a duplicate), and a second link to it.
    const slug = await storedShare(hand, false);

    const on = await client.rpc("set_share_names", { p_slug: slug, p_show: true });
    expect(on.error).toBeNull();
    expect(await page(`/h/${slug}`)).toContain(hero);
    expect(await page(`/embed/h/${slug}`)).toContain(hero);

    const off = await client.rpc("set_share_names", { p_slug: slug, p_show: false });
    expect(off.error).toBeNull();
    expectAnonymised(await page(`/h/${slug}`), hand, "turned off again");
  });
});
