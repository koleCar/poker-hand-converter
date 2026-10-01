import { ImageResponse } from "next/og";
import { railIconDataUri } from "../lib/brand/markSvg";

/**
 * `apple-touch-icon` (#10): Safari will not take an SVG for the home screen.
 * 180×180, generated from the same geometry as every other copy of the mark.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <img src={railIconDataUri()} width={180} height={180} alt="" />,
    size,
  );
}
