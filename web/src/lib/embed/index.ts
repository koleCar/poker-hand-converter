/**
 * The `<iframe>` snippet for an embedded replayer (#52), shared by the oEmbed
 * endpoint and the "Embed" button. `src` is always one of this site's own
 * `/embed/*` URLs, built from an id, never from user input.
 */
export function embedCode(src: string, width: number | string = "100%", height = 520): string {
  return `<iframe src="${src}" width="${width}" height="${height}" style="border:0;max-width:100%" loading="lazy" allow="fullscreen" title="Poker hand replay"></iframe>`;
}
