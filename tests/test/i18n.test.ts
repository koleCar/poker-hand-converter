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
