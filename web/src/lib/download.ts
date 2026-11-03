/**
 * Where the desktop app's installers are (`/download`).
 *
 * GitHub Releases of this repository: the release workflow
 * (`.github/workflows/release.yml`) publishes every version with the same two
 * asset names, so `releases/latest/download/<name>` always serves the newest
 * one and this file never changes per release. `NEXT_PUBLIC_APP_RELEASES_URL`
 * moves it elsewhere (a mirror, the Rail domain's update feed) without a code
 * change; Next inlines the literal at build time.
 */
export const APP_RELEASES_URL =
  process.env.NEXT_PUBLIC_APP_RELEASES_URL || "https://github.com/koleCar/poker-hand-converter/releases";

/** The asset names the release workflow uploads. Keep in step with `release.yml`. */
export const APP_ASSETS = {
  mac: "Rail-macOS.dmg",
  windows: "Rail-Windows-Setup.exe",
} as const;

export type AppPlatform = keyof typeof APP_ASSETS;

export function appDownloadUrl(platform: AppPlatform): string {
  return `${APP_RELEASES_URL}/latest/download/${APP_ASSETS[platform]}`;
}

/**
 * The visitor's desktop OS, to put its button first. Null for anything else
 * (a phone, Linux): both buttons then stay equal.
 */
export function detectPlatform(userAgent: string, platform = ""): AppPlatform | null {
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const text = `${platform} ${userAgent}`;
  if (/iPhone|iPad|iPod|Android/i.test(text)) return null;
  if (/Mac/i.test(text)) return "mac";
  if (/Win/i.test(text)) return "windows";
  return null;
}
