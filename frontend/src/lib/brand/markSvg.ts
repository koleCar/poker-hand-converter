/**
 * The Rail mark as an SVG string, for the places a React component cannot go:
 * the generated app icons (`app/icon.tsx`, `app/apple-icon.tsx`) and the Open
 * Graph cards, which render through `next/og` and take an `<img>`.
 *
 * Same geometry as `components/brand/RailMark.tsx` at its large size — the rail
 * and the board — drawn on a felt plate, because an app icon has no ancestor to
 * inherit a colour from and sits on whatever the home screen is.
 */
export function railIconSvg({ plate = true }: { plate?: boolean } = {}): string {
  const background = plate
    ? `<defs><radialGradient id="f" cx="50%" cy="42%" r="70%"><stop offset="0" stop-color="#1d5a43"/><stop offset="1" stop-color="#0b2a20"/></radialGradient></defs>` +
      `<rect width="32" height="32" rx="7" fill="url(#f)"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    background +
    `<ellipse cx="16" cy="16" rx="11.5" ry="6.8" fill="none" stroke="#e8eef6" stroke-width="2.4"/>` +
    `<rect x="12.1" y="14.7" width="7.8" height="2.6" rx="1.3" fill="#3ea6ff"/>` +
    `</svg>`
  );
}

export function railIconDataUri(options?: { plate?: boolean }): string {
  return `data:image/svg+xml;base64,${Buffer.from(railIconSvg(options)).toString("base64")}`;
}
