import type { MetadataRoute } from "next";
import { getDict } from "../lib/i18n/server";
import { paths } from "../lib/routes";

/**
 * The web app manifest (#55): Rail installs to a home screen or a dock.
 *
 * It opens on the converter, not the feed: the thing someone installs a poker
 * tool for is to drop a hand history on it, and the converter runs entirely in
 * a Web Worker with no server, so it is the screen that is most useful when the
 * network is not.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const en = await getDict();
  return {
    name: en.brand.name,
    short_name: en.brand.name,
    description: en.brand.tagline,
    start_url: paths.convert(),
    scope: "/",
    display: "standalone",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
