import { ImageResponse } from "next/og";
import { railIconDataUri } from "../../../lib/brand/markSvg";

/**
 * The manifest's PNG icons (#55), 192 and 512. A route rather than the
 * `app/icon.tsx` convention on purpose: that convention also takes over the
 * tab icon, and the tab icon is `favicon.svg`, which a PNG cannot match at
 * 16px. Generated from the mark's geometry, so the repo still holds no authored
 * rasters (#10).
 */
const SIZES = new Set([192, 512]);

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const edge = Number((await params).size);
  if (!SIZES.has(edge)) {
    return new Response("Not found", { status: 404 });
  }
  return new ImageResponse(
    <img src={railIconDataUri()} width={edge} height={edge} alt="" />,
    { width: edge, height: edge, headers: { "cache-control": "public, max-age=604800, immutable" } },
  );
}
