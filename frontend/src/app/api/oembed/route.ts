import { NextResponse, type NextRequest } from "next/server";
import { embedCode } from "../../../lib/embed";
import { canonicalUrl, SITE_URL } from "../../../lib/routes";

/**
 * oEmbed (#52): paste a Rail link into WordPress, Ghost, Notion or anything
 * else that speaks oEmbed, and it becomes the embedded replayer.
 *
 * It only ever answers for this site's own two embeddable shapes, matched by
 * pattern; the `url` parameter is never fetched, followed or echoed into the
 * markup except as the id the pattern captured. So it cannot be turned into a
 * proxy, and the HTML it returns contains nothing the caller chose but an id
 * from a fixed alphabet.
 */

export const dynamic = "force-dynamic";

const PUBLISHED = /^\/p\/([23456789abcdefghjkmnpqrstuvwxyz]{10})\/?$/;
const SHARED = /^\/h\/([23456789abcdefghjkmnpqrstuvwxyz]{8,16})\/?$/;

export function GET(request: NextRequest): NextResponse {
  const params = new URL(request.url).searchParams;
  const raw = params.get("url");
  if (params.get("format") && params.get("format") !== "json") {
    return NextResponse.json({ error: "Only json is supported." }, { status: 501 });
  }
  let target: URL;
  try {
    target = new URL(raw ?? "");
  } catch {
    return NextResponse.json({ error: "Missing or invalid url." }, { status: 400 });
  }
  const own = new URL(SITE_URL);
  if (target.host !== own.host && target.host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Not a Rail URL." }, { status: 404 });
  }

  const published = target.pathname.match(PUBLISHED);
  const shared = target.pathname.match(SHARED);
  const embedPath = published ? `/embed/p/${published[1]}` : shared ? `/embed/h/${shared[1]}` : null;
  if (!embedPath) {
    return NextResponse.json({ error: "Not an embeddable Rail URL." }, { status: 404 });
  }

  const maxWidth = Math.min(Number(params.get("maxwidth")) || 720, 1200);
  const width = Math.max(320, maxWidth);
  const height = Math.round(width * 0.72);
  const src = canonicalUrl(embedPath);

  return NextResponse.json(
    {
      version: "1.0",
      type: "rich",
      provider_name: "Rail",
      provider_url: SITE_URL,
      title: "Poker hand replay",
      width,
      height,
      html: embedCode(src, width, height),
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
