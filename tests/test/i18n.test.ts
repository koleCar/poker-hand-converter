import { describe, expect, it } from "vitest";

import { en } from "../../frontend/src/lib/i18n/en.js";
import { hr, plural } from "../../frontend/src/lib/i18n/hr.js";
import { negotiateLocale } from "../../frontend/src/lib/i18n/types.js";

describe("negotiateLocale", () => {
  it("prefers an explicit choice over the browser", () => {
    expect(negotiateLocale("hr", "en-US,en;q=0.9")).toBe("hr");
    expect(negotiateLocale("en", "hr-HR")).toBe("en");
  });
  it("reads Accept-Language by quality", () => {
    expect(negotiateLocale(undefined, "hr-HR,hr;q=0.9,en;q=0.8")).toBe("hr");
    expect(negotiateLocale(undefined, "de-DE,en;q=0.5,hr;q=0.9")).toBe("hr");
    expect(negotiateLocale(undefined, "bs-BA")).toBe("hr");
    expect(negotiateLocale(undefined, "sl-SI")).toBe("en");
  });
  it("ignores a cookie that is not a locale", () => {
    expect(negotiateLocale("fr", null)).toBe("en");
  });
});

describe("plural (hr)", () => {
  it("takes the three Croatian forms", () => {
    const glas = (n: number) => plural(n, "glas", "glasa", "glasova");
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(glas)).toEqual([
      "glas", "glasa", "glasa", "glasova", "glasova", "glasova", "glasova", "glas", "glasa", "glasova", "glas", "glasova",
    ]);
  });
});

describe("stats namespace", () => {
  it("counts hands with the right noun in both languages", () => {
    expect([1, 2, 5].map(en.stats.common.hands)).toEqual(["1 hand", "2 hands", "5 hands"]);
    expect([1, 2, 5, 12, 21, 22].map(hr.stats.common.hands)).toEqual([
      "1 ruka", "2 ruke", "5 ruku", "12 ruku", "21 ruka", "22 ruke",
    ]);
  });
  it("puts the count inside the Croatian sentence, in the case the sentence needs", () => {
    expect(hr.stats.coverage.behind(3, 5)).toBe("Ove brojke još ne uključuju 3 od 5 ruku.");
    expect(hr.stats.opponents.overHands(1)).toBe("kroz 1 ruku");
    expect(hr.stats.sessions.gap(60)).toBe("1 sata");
  });
});

describe("dictionaries", () => {
  // `Dict` already makes a missing key a compile error; this catches the one
  // thing types cannot: a translation left as an empty string.
  it("has no empty strings in either language", () => {
    const empties: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === "string" && node.trim() === "") empties.push(path);
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(en, "en");
    walk(hr, "hr");
    expect(empties).toEqual([]);
  });
});

describe("localizeServerMessage", () => {
  it("translates a known refusal for a Croatian reader and leaves English alone", async () => {
    const { localizeServerMessage } = await import("../../frontend/src/lib/i18n/serverErrors.js");
    expect(localizeServerMessage("This thread is locked.", "hr")).toBe("Ovaj thread je zaključan.");
    expect(localizeServerMessage("This thread is locked.", "en")).toBe("This thread is locked.");
    expect(localizeServerMessage('Write rate limit exceeded for bucket "post:x" (5 per 01:00:00). Try again later.', "hr")).toMatch(/^Previše/);
    expect(localizeServerMessage("Some brand new refusal.", "hr")).toBe("Some brand new refusal.");
  });

  it("only knows sentences the migrations actually raise", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "../../supabase/migrations");
    const sql = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const source = readFileSync(join(import.meta.dirname, "../../frontend/src/lib/i18n/serverErrors.ts"), "utf8");
    const keys = [...source.matchAll(/^\s+"([A-Z][^"]+)":/gm)].map((m) => m[1]).concat([...source.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]));
    const authOnly = new Set(["Invalid login credentials", "Email not confirmed", "User already registered", "Password should be at least 6 characters."]);
    const stale = keys.filter((key) => !authOnly.has(key) && !sql.includes(key.replace(/'/g, "''")));
    expect(stale).toEqual([]);
  });
});
