/**
 * A10 in the desktop app (guideline §7; plan R3.8): while the HUD has a
 * poker table open, nothing that helps with play is shown - analysis,
 * solver, equity and chart screens (R5.4: the Analysis screen, classified
 * in `app/src/lib/duringPlay.ts`), the replayer's pot odds and the
 * starting-hand chart. Pure TypeScript and the app's sources, so it runs
 * here; the app has no test runner of its own.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLAY_HELP,
  SCREEN_HELP,
  hiddenDuringPlay,
  offeredScreens,
  screenHiddenDuringPlay,
  screenOffered,
} from "../../app/src/lib/duringPlay.js";

/** The sidebar's screens (`app/src/lib/router.ts`'s `SCREENS`; that module needs React, which this harness does not install). */
const SCREENS = ["today", "hands", "reports", "players", "analysis", "hud", "settings"] as const;

const APP_SRC = join(__dirname, "../../app/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("A10: no help during play", () => {
  it("hides every kind of help while a table is open, and only then", () => {
    for (const help of PLAY_HELP) {
      expect(hiddenDuringPlay(help, true)).toBe(true);
      expect(hiddenDuringPlay(help, false)).toBe(false);
    }
    expect(hiddenDuringPlay(null, true)).toBe(false);
  });

  it("classifies every route: (R5.4) the analysis is analysis, the rest give no help", () => {
    expect(Object.keys(SCREEN_HELP).sort()).toEqual(
      ["analysis", "hands", "hud", "players", "reports", "settings", "setup", "today"].sort(),
    );
    for (const route of Object.keys(SCREEN_HELP) as (keyof typeof SCREEN_HELP)[]) {
      const analysis = route === "analysis";
      expect(SCREEN_HELP[route], route).toBe(analysis ? "analysis" : null);
      expect(screenHiddenDuringPlay(route, true), route).toBe(analysis);
      expect(screenHiddenDuringPlay(route, false), route).toBe(false);
    }
  });

  it("puts the pot odds, the starting-hand chart and the way into a hand's analysis behind the gate wherever they are drawn", () => {
    const files = sources(APP_SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
    const replayers = files.filter((f) => f.text.includes("<ReplayViewer"));
    // The starting-hand chart is the shared Reports screen's since R4.5c
    // (`packages/ui/reports/Breakdown.tsx`, behind its `hideHandChart`): every
    // app screen that renders it passes the gate.
    const charts = files.filter((f) => f.text.includes("<HandMatrix") || f.text.includes("<ReportsScreen"));
    expect(replayers.length).toBeGreaterThan(0);
    expect(charts.length).toBeGreaterThan(0);
    for (const { path, text } of replayers) {
      expect(text, path).toMatch(/hiddenDuringPlay\("potOdds"/);
      expect(text, path).toMatch(/potOdds=\{/);
    }
    for (const { path, text } of charts) {
      expect(text, path).toMatch(/hiddenDuringPlay\("handChart"/);
    }
    const breakdown = readFileSync(join(APP_SRC, "../../packages/ui/reports/Breakdown.tsx"), "utf8");
    expect(breakdown).toMatch(/const hidden = hideHandChart && tab === "handClass";/);
    // The shell gates whole screens.
    const app = readFileSync(join(APP_SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/screenHiddenDuringPlay\(route, tablesOpen\)/);
    // (R5.4) Every link into the analysis is drawn only when it may be
    // followed, and the shared analysis screens are told too (they read
    // nothing then).
    const links = files.filter((f) => /screenHref\("analysis"/.test(f.text) && !f.path.includes("/screens/analysis/") && !f.path.endsWith("Analysis.tsx"));
    expect(links.length).toBeGreaterThan(0);
    for (const { path, text } of links) expect(text, path).toMatch(/hiddenDuringPlay\("analysis"/);
    const screen = readFileSync(join(APP_SRC, "screens/Analysis.tsx"), "utf8");
    expect(screen).toMatch(/const hidden = hiddenDuringPlay\("analysis", tablesOpen\);/);
    expect(screen.match(/hiddenDuringPlay=\{hidden\}/g)?.length).toBe(2);
  });

  it("(R3.10) leaves a helping screen out of the sidebar and the palette while a table is open", () => {
    expect(readFileSync(join(APP_SRC, "lib/router.ts"), "utf8")).toContain(
      `export const SCREENS = ${JSON.stringify(SCREENS).replaceAll(",", ", ")} as const;`,
    );
    for (const route of Object.keys(SCREEN_HELP) as (keyof typeof SCREEN_HELP)[]) {
      expect(screenOffered(route, true), route).toBe(route !== "analysis");
      expect(screenOffered(route, false), route).toBe(true);
    }
    // (R5.4) The analysis goes while a table is open and comes back when the
    // tables close; the others keep their order.
    expect(offeredScreens(SCREENS, true)).toEqual(SCREENS.filter((s) => s !== "analysis"));
    expect(offeredScreens(SCREENS, false)).toEqual([...SCREENS]);
    // A classification of another screen (a test's) is honoured the same way.
    const help = { ...SCREEN_HELP, reports: "analysis" as const };
    expect(screenOffered("reports", true, help)).toBe(false);
    expect(offeredScreens(SCREENS, true, help)).toEqual(SCREENS.filter((s) => s !== "reports" && s !== "analysis"));
  });

  it("(R3.10) the sidebar, the palette's list and its shortcuts all ask the gate", () => {
    const sidebar = readFileSync(join(APP_SRC, "components/Sidebar.tsx"), "utf8");
    expect(sidebar).toMatch(/offeredScreens\(SCREENS, tablesOpen\)\.map/);
    expect(sidebar).not.toMatch(/\{SCREENS\.map/);
    const palette = readFileSync(join(APP_SRC, "components/Palette.tsx"), "utf8");
    // The list of screens and the Cmd/Ctrl + digit shortcut.
    expect(palette.match(/screenOffered\(screen, tablesOpen\)/g)?.length).toBe(2);
    const app = readFileSync(join(APP_SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/<Sidebar [^>]*tablesOpen=\{tablesOpen\}/);
    expect(app).toMatch(/<Palette tablesOpen=\{tablesOpen\}/);
  });

  it("(R5.4) stops the background analysis while a table is open", () => {
    const service = readFileSync(join(APP_SRC, "analysis/service.ts"), "utf8");
    expect(service).toMatch(/onTablesOpen\(\(open\) => runner\.tablesOpen\(open\)\)/);
    const gate = readFileSync(join(APP_SRC, "../src-tauri/src/analysis.rs"), "utf8");
    expect(gate).toMatch(/hud\.tables_open\(\)/);
  });
});
