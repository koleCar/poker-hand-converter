/**
 * Per-hand Open Graph tags for link-unfurl crawlers.
 *
 * A static SPA cannot set meta tags at request time, so `frontend/vercel.json`
 * rewrites `/h/:slug` to this function *only* when the User-Agent looks like a
 * crawler. Humans keep getting the SPA straight from the CDN, so this adds zero
 * latency to the normal path.
 *
 * The `shares` table is sealed — RLS on, no anon policies, no grants — so the
 * only read path is the `resolve_share` RPC, same as the browser uses. That RPC
 * also increments the view counter, which means an unfurl counts as one view.
 * That is the price of the table having no readable surface; it is deliberate.
 *
 * Everything here degrades: if the database is unreachable or the slug does not
 * exist, it still returns a valid 200 HTML document with the generic product
 * card rather than a broken unfurl.
 *
 * Env (Vercel project settings):
 *   SUPABASE_URL / VITE_SUPABASE_URL           required for per-hand tags
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY required for per-hand tags
 *   SITE_URL                                   optional, overrides the request origin
 *
 * NOTE: this file is not covered by `tsc -b` (tsconfig.app.json includes `src`
 * only). Vercel compiles it with esbuild.
 */

export const config = { runtime: "edge" };

const FALLBACK_TITLE = "Shared poker hand | PokerConverter";
const FALLBACK_DESCRIPTION =
  "Replay a shared poker hand action by action, free and without an account, on PokerConverter.";

/** The slice of `resolve_share`'s JSON this function reads. */
interface ResolvedShareJson {
  title?: string | null;
  standardText?: string | null;
  phf?: {
    game?: {
      label?: string;
      smallBlind?: number;
      bigBlind?: number;
      unit?: { symbol?: string; minorUnits?: number };
    };
    players?: unknown[];
    results?: {
      totalPot?: number;
      wentToShowdown?: boolean;
      winners?: Array<{ player?: string; amount?: number }>;
    };
  } | null;
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** PHF money is integer minor units; mirror `formatAmount()` from lib/phf/types. */
function money(amount: number | undefined, symbol = "$", minorUnits = 100): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) {
    return "";
  }
  if (minorUnits <= 1) {
    return `${symbol}${amount}`;
  }
  const whole = amount / minorUnits;
  const text = whole % 1 === 0 ? String(whole) : whole.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${symbol}${text}`;
}

function describe(share: ResolvedShareJson | null): { title: string; description: string } {
  if (!share) {
    return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION };
  }

  const game = share.phf?.game;
  const results = share.phf?.results;
  const symbol = game?.unit?.symbol ?? "$";
  const minor = game?.unit?.minorUnits ?? 100;

  const stakes =
    game?.smallBlind !== undefined && game?.bigBlind !== undefined
      ? `${money(game.smallBlind, symbol, minor)}/${money(game.bigBlind, symbol, minor)}`
      : "";
  const label = (game?.label ?? "").replace(/\s*\([^)]*\)\s*$/, "");
  const pot = money(results?.totalPot, symbol, minor);

  // `title` is the human label stored at share time and is already good copy.
  const title =
    share.title?.trim() ||
    ([stakes, label, pot ? `— ${pot} pot` : ""].filter(Boolean).join(" ").trim()
      ? `${[stakes, label, pot ? `— ${pot} pot` : ""].filter(Boolean).join(" ").trim()} | PokerConverter`
      : FALLBACK_TITLE);

  const bits: string[] = [];
  const playerCount = share.phf?.players?.length;
  if (playerCount) {
    bits.push(`${playerCount}-handed`);
  }
  // Read the board off the standard text rather than re-implementing runout
  // resolution here; the serializer always writes a single `Board [...]` line.
  const board = share.standardText?.match(/^Board \[([^\]]+)\]/m)?.[1];
  bits.push(board ? `board ${board}` : "no flop");

  // PHF lists one entry per collect per runout, so a split main/side pot shows
  // up as two rows for the same player. Sum before picking the biggest winner.
  const byPlayer = new Map<string, number>();
  for (const win of results?.winners ?? []) {
    if (win?.player) {
      byPlayer.set(win.player, (byPlayer.get(win.player) ?? 0) + (win.amount ?? 0));
    }
  }
  const winner = [...byPlayer.entries()].sort((a, b) => b[1] - a[1])[0];
  if (winner) {
    bits.push(`${winner[0]} wins ${money(winner[1], symbol, minor)}`.trim());
  }
  if (results?.wentToShowdown) {
    bits.push("shown down");
  }
  bits.push("Replay it action by action on PokerConverter.");

  return { title, description: bits.join(" · ") };
}

async function fetchShare(slug: string): Promise<ResolvedShareJson | null> {
  const baseUrl = env("SUPABASE_URL", "VITE_SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY");
  if (!baseUrl || !anonKey) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/rpc/resolve_share`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ p_slug: slug }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      return null;
    }
    return ((await response.json()) as ResolvedShareJson | null) ?? null;
  } catch {
    return null;
  }
}

function page(opts: { title: string; description: string; url: string; image: string }): string {
  const title = escapeHtml(opts.title);
  const description = escapeHtml(opts.description);
  const url = escapeHtml(opts.url);
  const image = escapeHtml(opts.image);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="article" />
<meta property="og:site_name" content="PokerConverter" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${image}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="${image}" />
<meta http-equiv="refresh" content="0; url=${url}" />
</head>
<body>
<p><a href="${url}">${title}</a></p>
</body>
</html>`;
}

export default async function handler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const slug =
    requestUrl.searchParams.get("slug") ?? requestUrl.pathname.split("/").filter(Boolean).pop() ?? "";

  const origin = env("SITE_URL")?.replace(/\/$/, "") ?? requestUrl.origin;
  const share = slug ? await fetchShare(slug) : null;
  const { title, description } = describe(share);

  return new Response(
    page({
      title,
      description,
      url: `${origin}/h/${encodeURIComponent(slug)}`,
      image: `${origin}/og-default.png`,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Crawlers re-fetch often; a short edge cache keeps the RPC quiet.
        "cache-control": "public, max-age=0, s-maxage=600, stale-while-revalidate=86400",
      },
    },
  );
}
