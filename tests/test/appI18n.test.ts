/**
 * The desktop app's words (R2.8): English and Croatian complete, Croatian
 * counts in the right one of its three forms, numbers grouped the
 * language's way, and the command palette's fuzzy match. Pure TypeScript,
 * so it runs here; the app has no test runner of its own. The lint rule in
 * `app/eslint.config.js` keeps words out of the components; this keeps the
 * dictionaries whole.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "../../app/src/i18n/en.js";
import { countIn, liveNumberFormat, setFormatLocale } from "../../app/src/i18n/format.js";
import { hr } from "../../app/src/i18n/hr.js";
import { fuzzyMatch, rankItems } from "../../packages/ui/palette/fuzzy.js";

type Node = string | ((...args: never[]) => string) | { [key: string]: Node };

/** Every leaf of a dictionary, with its path; a function is called with sample arguments. */
function leaves(dict: Node, path = ""): [string, string][] {
  if (typeof dict === "string") return [[path, dict]];
  if (typeof dict === "function") {
    // Numbers where the English source takes them, words elsewhere.
    const source = dict.toString();
    const args = Array.from({ length: dict.length }, (_, i) => (/\b(count|waiting|sent|total|done|hands|players|files|moved|detached|shown|matching|perSecond|kb|minutes|seconds|percent|folders|handsToday|version|ms|n|permille)\b/.test(source.split("=>")[0]?.split(",")[i] ?? "") ? 3 : "x"));
    return [[`${path}()`, (dict as (...a: unknown[]) => string)(...args)]];
  }
  return Object.entries(dict).flatMap(([key, value]) => leaves(value, path ? `${path}.${key}` : key));
}

describe("dictionaries", () => {
  it("have no empty strings in either language", () => {
    const empty = [...leaves(en as unknown as Node), ...leaves(hr as unknown as Node)].filter(
      ([, text]) => typeof text === "string" && text.trim() === "",
    );
    expect(empty).toEqual([]);
  });

  it("translate every sentence: Croatian equals English only for names and poker's own words", () => {
    // What Croatian players say in English too, the app's name, units and signs.
    const same = new Set([
      "HUD", "Rail", "Pot", "Board", "Parser", "Limit", "Stack", "All-in", "Cash", "Sit & Go", "Spin",
      "No limit", "Pot limit", "Fixed limit", "Heads-up", "6-max", "Full ring", "Walk", "Bomb pot", "3-bet",
      "4-bet+", "Showdown", "Preflop", "Postflop", "Flop", "Turn", "River", "VPIP", "PFR", "bb", "bb/100",
      "All-in EV bb/100", "—", "256 KB/s", "4 MB/s", "English", "Hrvatski", "Filter: x",
    ]);
    const english = new Map(leaves(en as unknown as Node));
    const untranslated = leaves(hr as unknown as Node).filter(([path, text]) => {
      if (english.get(path) !== text || same.has(text)) return false;
      // A function whose output is only its arguments and signs ("#3", "3 – x", "3 bb").
      return /\p{L}{3}/u.test(text.replace(/\bx\b|\bbb\b|\bEV\b|\bmin\b|\bms\b|\bKB\b/g, ""));
    });
    expect(untranslated).toEqual([]);
  });
});

describe("Croatian counts", () => {
  it("pick one, few or many", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 1204].map(hr.hands.count)).toEqual([
      "1 ruka", "2 ruke", "5 ruku", "11 ruku", "21 ruka", "22 ruke", "25 ruku", "1.204 ruke",
    ]);
    expect(hr.hands.countOf(3, 21)).toBe("3 od 21 ruke");
    expect(hr.hands.countOf(3, 25)).toBe("3 od 25 ruku");
    expect([1, 3, 7].map(hr.players.count)).toEqual(["1 protivnik", "3 protivnika", "7 protivnika"]);
    expect(hr.players.profile.resultLine("+1,5", 1)).toBe("+1,5 bb kroz 1 ruku");
    expect(hr.palette.playerDetail("Soba", 2)).toBe("Soba · 2 zajedničke ruke");
    expect([0, 1, 4].map(hr.palette.results)).toEqual(["Nema rezultata", "1 rezultat", "4 rezultata"]);
  });

  it("agree the verb with the count", () => {
    expect(hr.sync.today.waiting(1)).toBe("1 ruka čeka sinkronizaciju.");
    expect(hr.sync.today.waiting(3)).toBe("3 ruke čekaju sinkronizaciju.");
    expect(hr.sync.today.waiting(12)).toBe("12 ruku čeka sinkronizaciju.");
    expect(hr.firstRun.folders.found(1)).toBe("Rail je na ovom računalu pronašao 1 mapu.");
    expect(hr.firstRun.folders.found(2)).toBe("Rail je na ovom računalu pronašao 2 mape.");
    expect(hr.refused.total(5)).toBe("Odbijeno je 5 ruku.");
  });

  it("and English says one hand, not one hands", () => {
    expect([1, 2, 1204].map(en.hands.count)).toEqual(["1 hand", "2 hands", "1,204 hands"]);
    expect(en.sync.today.waiting(1)).toBe("1 hand waits to sync.");
    expect(en.players.count(1)).toBe("1 opponent");
    expect(en.palette.results(1)).toBe("1 result");
  });
});

describe("number formatting", () => {
  it("follows the chosen language, not the system's", () => {
    expect(countIn("en")(1234567)).toBe("1,234,567");
    expect(countIn("hr")(1234567)).toBe("1.234.567");
    const live = liveNumberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
    setFormatLocale("hr");
    expect(live.format(12.5)).toBe("12,5");
    setFormatLocale("en");
    expect(live.format(12.5)).toBe("12.5");
  });
});

describe("appearance before the first paint", () => {
  it("reads the copy the app writes", () => {
    const root = join(import.meta.dirname, "../../app");
    const boot = readFileSync(join(root, "public/appearance.js"), "utf8");
    const store = readFileSync(join(root, "src/lib/appearance.ts"), "utf8");
    const key = /STORAGE_KEY = "([^"]+)"/.exec(store)?.[1];
    expect(key).toBe("rail.appearance");
    expect(boot).toContain(`"${key}"`);
    expect(readFileSync(join(root, "index.html"), "utf8")).toMatch(/<head>[\s\S]*<script src="\/appearance.js"><\/script>[\s\S]*<\/head>/);
  });
});

describe("command palette match", () => {
  it("finds the letters in order, ignoring case and diacritics", () => {
    expect(fuzzyMatch("gtrep", "Go to Reports")).not.toBeNull();
    expect(fuzzyMatch("cas", "Čas")).not.toBeNull();
    expect(fuzzyMatch("nocni", "noćni")?.indexes).toEqual([0, 1, 2, 3, 4]);
    expect(fuzzyMatch("xyz", "Reports")).toBeNull();
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indexes: [] });
  });

  it("prefers word starts and prefixes", () => {
    const items = [
      { label: "Show refused hands" },
      { label: "Reports" },
      { label: "Settings: Refused hands" },
      { label: "Use the dark theme", keywords: ["theme", "dark"] },
    ];
    expect(rankItems("rep", items)[0]?.label).toBe("Reports");
    expect(rankItems("dark", items).map((item) => item.label)).toEqual(["Use the dark theme"]);
    expect(rankItems("ref", items).map((item) => item.label)).toEqual(["Show refused hands", "Settings: Refused hands"]);
    expect(rankItems("", items)).toHaveLength(4);
  });
});
