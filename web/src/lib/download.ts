import type { Entitlements } from "./db/entitlements";

/**
 * Where the desktop app's installers are (`/download`), and who may have them.
 *
 * The desktop app is part of Rail Pro: the page's buttons go to the web's own
 * `/download/<platform>` (`app/download/[platform]/route.ts`), which checks the
 * account's plan on the server before it redirects to the installer. The
 * installer's address below never reaches a page.
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

export function isAppPlatform(value: string): value is AppPlatform {
  return Object.hasOwn(APP_ASSETS, value);
}

/** The installer itself. Server side only: the route redirects here once the plan allows it. */
export function appDownloadUrl(platform: AppPlatform): string {
  return `${APP_RELEASES_URL}/latest/download/${APP_ASSETS[platform]}`;
}

/** What the page's buttons link to: the web's gate in front of the installer. */
export function appDownloadPath(platform: AppPlatform): string {
  return `/download/${platform}`;
}

/**
 * May this visitor download the desktop app?
 *
 *   * `allowed` - signed in, and the plan includes the desktop app (the
 *     `hud` feature, which only Pro has). While enforcement is off every
 *     account's plan is Pro, so every signed-in account is allowed.
 *   * `signin`  - signed out: there is no plan to check.
 *   * `pro`     - signed in on a plan without it (Free, enforcement on).
 *   * `unknown` - signed in, but the plan could not be read. Not a download:
 *     the gate fails closed.
 */
export type DownloadAccess = "allowed" | "signin" | "pro" | "unknown";

export function downloadAccess(signedIn: boolean, entitlements: Pick<Entitlements, "features"> | null): DownloadAccess {
  if (!signedIn) return "signin";
  if (!entitlements) return "unknown";
  return entitlements.features.hud ? "allowed" : "pro";
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
