/**
 * What the desktop app takes of the web's analysis library (R5.4,
 * `app/src/analysis/library.ts`): the library is used in place, through one
 * door, and the app's analysis worker - bundled here as Vite bundles it -
 * reaches only pure TypeScript of `web/src/lib/` and the chart sets'
 * JSON. Nothing that knows about Supabase, Next, the browser client or the
 * web's own worker comes in, and no npm package at all.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP = join(ROOT, "app/src");

/** The folders of `web/src/lib/` the analysis may reach. */
const ALLOWED = [
  "web/src/lib/analysis/",
  "web/src/lib/charts/",
  "web/src/lib/solver/",
  "web/src/lib/equity/",
  "web/src/lib/stats/",
  "web/src/lib/phf/types.ts",
  "web/src/lib/cards.ts",
  "web/src/lib/db/analysisRows.ts",
  "web/src/lib/db/villainCounters.ts",
];

function inputsOf(entry: string): string[] {
  const result = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    splitting: true,
    outdir: "out",
    metafile: true,
    logLevel: "silent",
    alias: { "@rail/web-lib": join(ROOT, "web/src/lib"), "@rail/ui": join(ROOT, "packages/ui") },
    // React and Tauri are the app's own (`service.ts`); the worker has neither.
    external: ["react", "react-dom", "@tauri-apps/*"],
  });
  return Object.keys(result.metafile?.inputs ?? {}).map((path) => relative(ROOT, join(process.cwd(), path)));
}

describe("the app's analysis and the web's library", () => {
  it("the worker reaches only the library's pure TypeScript and the chart sets", () => {
    const inputs = inputsOf(join(APP, "analysis/worker.entry.ts"));
    const web = inputs.filter((path) => path.startsWith("web/"));
    const own = inputs.filter((path) => path.startsWith("app/"));
    // The shared package's chart vocabulary (R5.3), which files a preflop decision for the own charts.
    expect(inputs.filter((path) => path.startsWith("packages/")).sort()).toEqual(["packages/ui/charts/model.ts", "packages/ui/charts/nodeKey.ts"]);
    expect(inputs.filter((path) => !/^(app|web|packages)\//.test(path))).toEqual([]);
    expect(web.length).toBeGreaterThan(40);
    expect(own.sort()).toEqual(
      ["app/src/analysis/engine.ts", "app/src/analysis/library.ts", "app/src/analysis/rows.ts", "app/src/analysis/worker.entry.ts", "app/src/analysis/worker.ts"].sort(),
    );
    const outside = web.filter((path) => !ALLOWED.some((allowed) => path.startsWith(allowed)) && !/charts\/data\/[a-z0-9-]+\.json$/.test(path));
    expect(outside).toEqual([]);
    expect(inputs.filter((path) => path.includes("node_modules"))).toEqual([]);
    for (const forbidden of ["supabase", "lib/db/analysis.ts", "lib/db/client", "workers/", "components/", "next"]) {
      expect(web.filter((path) => path.includes(forbidden)), forbidden).toEqual([]);
    }
  });

  it("only the two doors import the web's library; no app file copies it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk(APP);
    const imports = /(?:from|import)\s*\(?\s*"(?:@rail\/web-lib[^"]*|[^"]*web\/src\/[^"]*)"/;
    const importers = files.filter((path) => imports.test(readFileSync(path, "utf8")));
    expect(importers.map((path) => relative(ROOT, path)).sort()).toEqual(["app/src/analysis/leakWords.ts", "app/src/analysis/library.ts"]);
    // The analysis is not copied: no app file defines the library's entry points.
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      expect(/export function (analyzeHand|analyseStoredHands|gradePreflop)\b/.test(text), relative(ROOT, path)).toBe(false);
    }
  });
});
