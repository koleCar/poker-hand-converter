/**
 * A10 in the desktop app (guideline §7; plan R3.8): while the HUD has a
 * poker table open, nothing that helps with play is shown - analysis,
 * solver, equity and chart screens (none exists in the app yet: the gate is
 * where they will be classified, `app/src/lib/duringPlay.ts`), the
 * replayer's pot odds and the starting-hand chart. Pure TypeScript and the
 * app's sources, so it runs here; the app has no test runner of its own.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PLAY_HELP,
  SCREEN_HELP,
  hiddenDuringPlay,
  screenHiddenDuringPlay,
} from "../../app/src/lib/duringPlay.js";

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

  it("classifies every route, and no screen of today's app is analysis, solver, equity or charts", () => {
    expect(Object.keys(SCREEN_HELP).sort()).toEqual(
      ["hands", "hud", "players", "reports", "settings", "setup", "today"].sort(),
    );
    for (const route of Object.keys(SCREEN_HELP) as (keyof typeof SCREEN_HELP)[]) {
      expect(SCREEN_HELP[route], route).toBeNull();
      expect(screenHiddenDuringPlay(route, true), route).toBe(false);
    }
  });

  it("puts the pot odds and the starting-hand chart behind the gate wherever they are drawn", () => {
    const files = sources(APP_SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
    const replayers = files.filter((f) => f.text.includes("<ReplayViewer"));
    const charts = files.filter((f) => f.text.includes("<HandMatrix"));
    expect(replayers.length).toBeGreaterThan(0);
    expect(charts.length).toBeGreaterThan(0);
    for (const { path, text } of replayers) {
      expect(text, path).toMatch(/hiddenDuringPlay\("potOdds"/);
      expect(text, path).toMatch(/potOdds=\{/);
    }
    for (const { path, text } of charts) {
      expect(text, path).toMatch(/hiddenDuringPlay\("handChart"/);
    }
    // The shell gates whole screens.
    const app = readFileSync(join(APP_SRC, "App.tsx"), "utf8");
    expect(app).toMatch(/screenHiddenDuringPlay\(route, tablesOpen\)/);
  });
});
