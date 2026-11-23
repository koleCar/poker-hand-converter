/**
 * Stack depth buckets, the one definition (docs/ANALYTICS.md Step 11):
 * `config/stats/stack-buckets.json`.
 *
 * - the TypeScript copy (`packages/ui/hands/stackBuckets.ts`) is the file's
 *   data, and the chips' and the Breakdown's orders are read from it;
 * - SQL's `rail_stack_bucket` is generated from it into the migration that
 *   defines it (`STACK_BUCKETS_WRITE=1 npx vitest run test/stackBuckets.test.ts`
 *   rewrites the generated block);
 * - every `case` ladder over a starting stack still spelled out in an older
 *   migration (the library counts' triggers, the report rows' writers) has
 *   one scheme's edges, so the file cannot drift from what the database
 *   stores;
 * - every bucket has its words in English and Croatian.
 *
 * Rust reads the file itself (`rail_stats::stack_buckets`, its tests).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { STACK_ORDER } from "../../packages/ui/hands/filter.js";
import { STACK_BUCKETS, stackBucketOf, stackOrder, type StackScheme } from "../../packages/ui/hands/stackBuckets.js";
import { handsUiEn } from "../../packages/ui/strings/hands.en.js";
import { handsUiHr } from "../../packages/ui/strings/hands.hr.js";
import { reportsUiEn } from "../../packages/ui/strings/reports.en.js";
import { reportsUiHr } from "../../packages/ui/strings/reports.hr.js";

const ROOT = join(import.meta.dirname, "../..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const FILE = JSON.parse(readFileSync(join(ROOT, "config/stats/stack-buckets.json"), "utf8")) as Record<
  StackScheme,
  { id: string; min: number }[]
>;
const SCHEMES: StackScheme[] = ["filter", "breakdown"];
const DEFINING = "20271122110000_stack_depth_filter.sql";
const BEGIN = "-- <generated: stack buckets>";
const END = "-- </generated: stack buckets>";

/** `rail_stack_bucket`, as generated from the file. */
function generatedSql(): string {
  const ladder = (scheme: StackScheme) => {
    const buckets = FILE[scheme];
    const lines = buckets
      .slice(0, -1)
      .map((bucket, i) => `      when p_tenths < ${buckets[i + 1].min} then '${bucket.id}'`);
    return [`    when p_scheme = '${scheme}' then case`, ...lines, `      else '${buckets[buckets.length - 1].id}' end`];
  };
  return [
    BEGIN,
    "-- Generated from config/stats/stack-buckets.json by tests/test/stackBuckets.test.ts; do not edit.",
    "create or replace function public.rail_stack_bucket(p_tenths integer, p_scheme text)",
    "returns text",
    "language sql",
    "immutable",
    "parallel safe",
    "set search_path = ''",
    "as $fn$",
    "  select case",
    "    when p_tenths is null then null",
    ...SCHEMES.flatMap(ladder),
    "  end;",
    "$fn$;",
    END,
  ].join("\n");
}

describe("stack depth buckets", () => {
  it("the TypeScript copy is the file", () => {
    expect(STACK_BUCKETS).toEqual({ filter: FILE.filter, breakdown: FILE.breakdown });
    expect(STACK_ORDER).toEqual(FILE.filter.map((bucket) => bucket.id));
    expect(stackOrder("breakdown")).toEqual(["0-20", "20-40", "40-70", "70-100", "100-150", "150-250", "250+"]);
  });

  it("a bucket is half open, the last has no end", () => {
    expect(stackBucketOf("filter", 0)).toBe("0-40");
    expect(stackBucketOf("filter", 399)).toBe("0-40");
    expect(stackBucketOf("filter", 400)).toBe("40-80");
    expect(stackBucketOf("filter", 1199)).toBe("80-120");
    expect(stackBucketOf("filter", 1200)).toBe("120+");
    expect(stackBucketOf("filter", 99_999)).toBe("120+");
    expect(stackBucketOf("filter", -1)).toBeNull();
    expect(stackBucketOf("breakdown", 1000)).toBe("100-150");
  });

  it("SQL's rail_stack_bucket is generated from the file", () => {
    const path = join(MIGRATIONS, DEFINING);
    const text = readFileSync(path, "utf8");
    const at = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    expect(at).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(at);
    const block = text.slice(at, end + END.length);
    if (process.env.STACK_BUCKETS_WRITE === "1") {
      writeFileSync(path, text.slice(0, at) + generatedSql() + text.slice(end + END.length));
      return;
    }
    expect(block).toBe(generatedSql());
  });

  it("every stack ladder spelled out in a migration has one scheme's edges", () => {
    const schemes = SCHEMES.map((scheme) => FILE[scheme].map((bucket, i, all) => [bucket.id, all[i + 1]?.min ?? null] as const));
    let ladders = 0;
    for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"))) {
      const text = readFileSync(join(MIGRATIONS, name), "utf8");
      // A `case` whose arms compare a tenths column: `< 400 then '0-40'`.
      const re = /case\s+((?:when\s+[\w.]*(?:starting_stack_bb_tenths|p_tenths)\s+(?:is null|<\s*\d+)\s+then\s+(?:null|'[^']*')\s+)+)else\s+'([^']*)'/g;
      for (const match of text.matchAll(re)) {
        const arms = [...match[1].matchAll(/<\s*(\d+)\s+then\s+'([^']*)'/g)].map((arm) => [arm[2], Number(arm[1])] as const);
        if (arms.length === 0) continue;
        ladders += 1;
        const ladder = [...arms, [match[2], null] as const];
        expect(
          schemes.some((scheme) => JSON.stringify(scheme) === JSON.stringify(ladder)),
          `${name}: ${JSON.stringify(ladder)}`,
        ).toBe(true);
      }
    }
    // The report rows' writers, the counts' triggers, the library's band and the generated function.
    expect(ladders).toBeGreaterThan(10);
  });

  it("every bucket has its words", () => {
    for (const strings of [handsUiEn, handsUiHr]) {
      for (const id of stackOrder("filter")) expect(strings.filters.stacks[id as keyof typeof strings.filters.stacks]).toBeTruthy();
      expect(strings.filters.groups.effStack).toBeTruthy();
    }
    for (const strings of [reportsUiEn, reportsUiHr]) {
      for (const id of stackOrder("breakdown")) expect(strings.breakdown.stacks[id]).toBeTruthy();
    }
  });
});
