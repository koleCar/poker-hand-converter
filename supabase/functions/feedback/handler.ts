/**
 * The handler of `feedback` (`index.ts` serves it): stores a bug report, a
 * feature request or a question sent from the web or the desktop app, with up
 * to three screenshots (`20271119090000_feedback.sql`).
 *
 * Anyone may send one. With a bearer token that GoTrue accepts
 * (`GET /auth/v1/user`) the report carries the account; without one, or with
 * one GoTrue refuses (an expired session), it is a visitor's: the report
 * matters more than who sent it.
 *
 *  1. Validates the JSON body: kind, message, the optional reply email and
 *     context (page, app version, platform, locale), and the images, each
 *     base64 and recognised by its first bytes (PNG, JPEG, WebP, GIF), never
 *     by the type the client claims. A filled-in honeypot (`website`) is
 *     answered as a success and dropped.
 *  2. The rate limit: a signed-in account `ACCOUNT_PER_DAY` reports a day, a
 *     visitor `VISITOR_PER_HOUR` an hour per address. The address is kept only
 *     as an HMAC under the service role key (`client_hash`).
 *  3. With the service role: uploads the images to the private `feedback`
 *     bucket under `<user id>/<report id>/` (a visitor's under `anon/`), then
 *     inserts the row. If the insert fails, the uploaded images are removed.
 *
 * The service role key is the runtime's own `SUPABASE_SERVICE_ROLE_KEY`. Logs
 * carry refusal codes and upstream statuses only: no message, email, token
 * or address.
 */

export interface Env {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

export const KINDS = ["bug", "feature", "question"] as const;
export type Kind = (typeof KINDS)[number];
export const SOURCES = ["web", "app"] as const;

export const MAX_MESSAGE = 4000;
export const MAX_IMAGES = 3;
/** Per image, decoded: the bucket's `file_size_limit`. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Three images in base64 and the text. */
export const MAX_BODY_BYTES = 13 * 1024 * 1024;
export const VISITOR_PER_HOUR = 5;
export const ACCOUNT_PER_DAY = 20;

const BUCKET = "feedback";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
};

/** Error codes the dialog maps to sentences (`packages/ui/strings/feedback.*.ts`). */
export type FeedbackErrorCode =
  | "method_not_allowed"
  | "invalid_request"
  | "too_large"
  | "rate_limited"
  | "unavailable";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(status: number, error: FeedbackErrorCode, detail?: string): Response {
  console.log(`feedback: refused ${error}${detail ? ` (${detail})` : ""}`);
  return json(status, { error });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

/** One line of text: control characters out, trimmed, cut to `max`. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // deno-lint-ignore no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return clean.length > 0 ? clean : null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface Image {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  ext: "png" | "jpg" | "webp" | "gif";
  bytes: Uint8Array;
}

/** The image's type from its first bytes, or null when it is none of the four. */
export function sniff(bytes: Uint8Array): Pick<Image, "mime" | "ext"> | null {
  const at = (i: number, ...values: number[]) => values.every((v, k) => bytes[i + k] === v);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (bytes.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (bytes.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", ext: "gif" };
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  // A data URL is accepted too: the browser's FileReader gives one.
  const data = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export interface Report {
  kind: Kind;
  message: string;
  email: string | null;
  source: "web" | "app";
  page: string | null;
  appVersion: string | null;
  platform: string | null;
  locale: string | null;
  images: Image[];
  /** The honeypot was filled in: a bot. */
  trap: boolean;
}

/** The body as a report, or the refusal. */
export function parse(body: unknown): Report | { error: FeedbackErrorCode; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "invalid_request", detail: "not an object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== "string" || !(KINDS as readonly string[]).includes(b.kind)) {
    return { error: "invalid_request", detail: "kind" };
  }
  if (typeof b.message !== "string") return { error: "invalid_request", detail: "message" };
  const message = b.message.trim();
  if (message.length === 0 || message.length > MAX_MESSAGE) {
    return { error: "invalid_request", detail: "message length" };
  }
  let email: string | null = null;
  if (b.email !== undefined && b.email !== null && b.email !== "") {
    email = line(b.email, 320);
    if (!email || !EMAIL.test(email)) return { error: "invalid_request", detail: "email" };
  }
  const source = typeof b.source === "string" && (SOURCES as readonly string[]).includes(b.source)
    ? (b.source as "web" | "app")
    : null;
  if (!source) return { error: "invalid_request", detail: "source" };

  const images: Image[] = [];
  if (b.images !== undefined && b.images !== null) {
    if (!Array.isArray(b.images)) return { error: "invalid_request", detail: "images" };
    if (b.images.length > MAX_IMAGES) return { error: "too_large", detail: "too many images" };
    for (const item of b.images) {
      const data = item && typeof item === "object" ? (item as Record<string, unknown>).data : item;
      if (typeof data !== "string") return { error: "invalid_request", detail: "image data" };
      // base64 is 4/3 of the bytes: refuse before decoding what cannot fit.
      if (data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) {
        return { error: "too_large", detail: "image too large" };
      }
      const bytes = decodeBase64(data);
      if (!bytes) return { error: "invalid_request", detail: "image base64" };
      if (bytes.length > MAX_IMAGE_BYTES) return { error: "too_large", detail: "image too large" };
      const type = sniff(bytes);
      if (!type) return { error: "invalid_request", detail: "image type" };
      images.push({ ...type, bytes });
    }
  }

  return {
    kind: b.kind as Kind,
    message,
    email,
    source,
    page: line(b.page, 500),
    appVersion: line(b.appVersion, 50),
    platform: line(b.platform, 300),
    locale: line(b.locale, 20),
    images,
    trap: typeof b.website === "string" && b.website.trim().length > 0,
  };
}

/** The sender's address as the proxy saw it. */
function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown";
}

/** HMAC-SHA256 of the address under the service role key: stable, not reversible without the key. */
export async function clientHash(address: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(address)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

class Upstream extends Error {}

export async function handle(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
  newId: () => string = () => crypto.randomUUID(),
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return fail(405, "method_not_allowed");
  }
  if (!env.supabaseUrl || !env.anonKey || !env.serviceRoleKey) {
    return fail(503, "unavailable", "function environment incomplete");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return fail(413, "too_large", "content-length");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return fail(413, "too_large", "body");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "invalid_request", "not JSON");
  }
  const report = parse(body);
  if ("error" in report) {
    return fail(report.error === "too_large" ? 413 : 400, report.error, report.detail);
  }
  if (report.trap) {
    console.log("feedback: dropped (honeypot)");
    return json(201, { id: newId() });
  }

  // 1. Who is sending: an account, or a visitor.
  let userId: string | null = null;
  const jwt = bearer(request);
  if (jwt && jwt !== env.anonKey) {
    try {
      const response = await fetchFn(`${env.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: env.anonKey, Authorization: `Bearer ${jwt}` },
      });
      if (response.ok) {
        const user = (await response.json()) as { id?: unknown };
        if (typeof user.id === "string" && user.id.length === 36) userId = user.id;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // GoTrue unreachable: the report goes in as a visitor's.
    }
  }

  const service = { apikey: env.serviceRoleKey, Authorization: `Bearer ${env.serviceRoleKey}` };
  const hash = await clientHash(clientAddress(request), env.serviceRoleKey);

  // 2. The rate limit.
  try {
    const since = new Date(now() - (userId ? 24 * 3600_000 : 3600_000)).toISOString();
    const filter = userId ? `user_id=eq.${userId}` : `client_hash=eq.${hash}&user_id=is.null`;
    const response = await fetchFn(
      `${env.supabaseUrl}/rest/v1/feedback?select=id&${filter}&created_at=gte.${encodeURIComponent(since)}`,
      { method: "HEAD", headers: { ...service, Prefer: "count=exact" } },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Upstream(`count ${response.status}`);
    const total = Number((response.headers.get("content-range") ?? "").split("/")[1]);
    if (!Number.isFinite(total)) throw new Upstream("count unreadable");
    if (total >= (userId ? ACCOUNT_PER_DAY : VISITOR_PER_HOUR)) {
      return fail(429, "rate_limited", userId ? "account" : "visitor");
    }
  } catch (error) {
    return fail(503, "unavailable", error instanceof Error ? error.message : "count failed");
  }

  // 3. The images, then the row.
  const id = newId();
  const prefix = `${userId ?? "anon"}/${id}`;
  const stored: string[] = [];
  const removeStored = async () => {
    if (stored.length === 0) return;
    await fetchFn(`${env.supabaseUrl}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: { ...service, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: stored }),
    }).then((r) => r.body?.cancel()).catch(() => undefined);
  };
  try {
    for (const [index, image] of report.images.entries()) {
      const name = `${prefix}/${index + 1}.${image.ext}`;
      const response = await fetchFn(`${env.supabaseUrl}/storage/v1/object/${BUCKET}/${name}`, {
        method: "POST",
        headers: { ...service, "Content-Type": image.mime, "x-upsert": "false" },
        body: image.bytes,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Upstream(`upload ${response.status}`);
      stored.push(name);
    }
    const response = await fetchFn(`${env.supabaseUrl}/rest/v1/feedback`, {
      method: "POST",
      headers: { ...service, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        id,
        kind: report.kind,
        message: report.message,
        email: report.email,
        user_id: userId,
        source: report.source,
        page: report.page,
        app_version: report.appVersion,
        platform: report.platform,
        locale: report.locale,
        images: stored,
        client_hash: hash,
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Upstream(`insert ${response.status}`);
  } catch (error) {
    await removeStored();
    return fail(503, "unavailable", error instanceof Error ? error.message : "store failed");
  }

  console.log(`feedback: stored ${report.kind} from ${report.source}${userId ? " (account)" : ""}`);
  return json(201, { id });
}

/** The environment Supabase sets inside every function. */
export function envFromDeno(): Env {
  return {
    supabaseUrl: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, ""),
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  };
}
