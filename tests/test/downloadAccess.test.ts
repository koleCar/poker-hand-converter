/**
 * The desktop app is for Rail Pro (`web/src/lib/download.ts`,
 * `components/download/DownloadButtons.tsx`, `app/download/[platform]/route.ts`):
 *
 * - signed out -> sign in; a plan without the app -> upgrade; a plan that
 *   could not be read -> no download (fails closed); Pro -> the installers;
 * - while enforcement is off every signed-in account is Pro, so allowed;
 * - the page links to the web's gate, never to the installer itself;
 * - the browser's view waits for the session and the plan before it decides.
 */

import { describe, expect, it } from "vitest";

import { clientAccess } from "../../web/src/components/download/DownloadButtons.js";
import { parseEntitlements } from "../../web/src/lib/db/entitlements.js";
import {
  appDownloadPath,
  appDownloadUrl,
  downloadAccess,
  isAppPlatform,
} from "../../web/src/lib/download.js";

const free = parseEntitlements({ plan: "free", enforced: true, features: { hud: false, desktop_sync: false } });
const pro = parseEntitlements({ plan: "pro", enforced: true, features: { hud: true, desktop_sync: true } });
const notEnforced = parseEntitlements({ plan: "pro", enforced: false, features: {} });

describe("downloadAccess", () => {
  it("asks a signed-out visitor to sign in, whatever plan data is passed", () => {
    expect(downloadAccess(false, null)).toBe("signin");
    expect(downloadAccess(false, pro)).toBe("signin");
  });

  it("allows a Pro account and refuses a Free one under enforcement", () => {
    expect(downloadAccess(true, pro)).toBe("allowed");
    expect(downloadAccess(true, free)).toBe("pro");
  });

  it("allows every signed-in account while enforcement is off", () => {
    expect(downloadAccess(true, notEnforced)).toBe("allowed");
  });

  it("fails closed when the plan could not be read", () => {
    expect(downloadAccess(true, null)).toBe("unknown");
  });
});

describe("the installer addresses", () => {
  it("knows the two platforms and nothing else", () => {
    expect(isAppPlatform("mac")).toBe(true);
    expect(isAppPlatform("windows")).toBe(true);
    expect(isAppPlatform("linux")).toBe(false);
    expect(isAppPlatform("toString")).toBe(false);
    expect(isAppPlatform("rail-app-promo.en.png")).toBe(false);
  });

  it("links the page to the web's gate, not to the file", () => {
    expect(appDownloadPath("mac")).toBe("/download/mac");
    expect(appDownloadPath("windows")).toBe("/download/windows");
    expect(appDownloadUrl("mac")).toMatch(/\/latest\/download\/Rail-macOS\.dmg$/);
    expect(appDownloadUrl("windows")).toMatch(/\/latest\/download\/Rail-Windows-Setup\.exe$/);
  });
});

describe("clientAccess (the page's view)", () => {
  it("waits for the session, then for the plan", () => {
    expect(clientAccess("loading", true, "none", null)).toBe("checking");
    expect(clientAccess("signed-in", true, "loading", null)).toBe("checking");
    expect(clientAccess("signed-in", true, "none", null)).toBe("checking");
  });

  it("decides once both are known", () => {
    expect(clientAccess("signed-out", true, "none", null)).toBe("signin");
    expect(clientAccess("signed-in", true, "ready", pro)).toBe("allowed");
    expect(clientAccess("signed-in", true, "ready", free)).toBe("pro");
    expect(clientAccess("signed-in", true, "ready", notEnforced)).toBe("allowed");
  });

  it("offers nothing when the plan cannot be read or there is no database", () => {
    expect(clientAccess("signed-in", true, "error", pro)).toBe("unknown");
    expect(clientAccess("signed-in", true, "unavailable", null)).toBe("unknown");
    expect(clientAccess("signed-out", false, "none", null)).toBe("unknown");
  });
});
