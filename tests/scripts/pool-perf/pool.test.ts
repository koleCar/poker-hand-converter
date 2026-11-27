/**
 * The Pool tab's gate (docs/POOL.md P3, "Done when"): on a big account with
 * nothing pending, every read the web's Analytics screen makes to open the
 * Pool tab answers in under a second, and none of them catches up.
 *
 * ```text
 * RAIL_PERF_PSQL='docker exec -i supabase_db_<project> psql -U postgres -d postgres' \
 *   RAIL_POOL_PERF_EMAIL=<a drained account, e.g. fp-p1-big@example.test> npm run pool:perf
 * ```
 *
 * **Only against a local stack** (never production). Read-only: the reads
 * run as the account (role `authenticated`, its JWT claims) inside a
 * transaction that is rolled back. Not in CI: it needs a drained account of
 * realistic size (the program's is 92 616 hands with opponents' statistics
 * on: `fp-p1-big@example.test` on the stack `rail-f6-test`). Skipped when
 * the two variables are unset.
 *
 * The reads, each with the arguments the web sends (`lib/db/*`), over no
 * filter, cash only, and a stake with a date range cut inside days:
 *   - `report_open` + `report_graph` (the screen's own report, every tab);
 *   - `analytics_checker` (the player's numbers and targets: the rows);
 *   - `analytics_pool` (the opponents by type: `player_types`, P3) and
 *     `analytics_pool_you` (the two "You" figures, `hero_opp_rollups`, P3) -
 *     the Pool tab's own;
 *   - `derive_pending` (must be 0: "nothing pending").
 * Each runs three times (the first is the cold one a user waits for); the
 * gate is the slowest run of each under `RAIL_POOL_PERF_BUDGET_MS` (1000),
 * and the Pool tab's own two together under it too.
 */
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { checkerFiltersOf } from "../../../packages/ui/analytics/view.js";
import { poolFiltersOf } from "../../../packages/ui/analytics/poolView.js";
import type { HandFilter } from "../../../packages/ui/hands/model.js";
import { ANALYSIS_VERSION } from "../../../web/src/lib/analysis/types.js";
import { EV_VERSION } from "../../../web/src/lib/equity/allInEv.js";
import { ANALYTICS_MEMBERSHIP_VERSION } from "../../../web/src/lib/stats/analytics.js";
import { FACTS_VERSION } from "../../../web/src/lib/stats/builderFacts.js";
import { STATS_VERSION } from "../../../web/src/lib/stats/types.js";

const PSQL = process.env.RAIL_PERF_PSQL ?? "";
const EMAIL = process.env.RAIL_POOL_PERF_EMAIL ?? "";
const BUDGET = Number(process.env.RAIL_POOL_PERF_BUDGET_MS ?? "1000");
const RUNS = 3;

function psql(sql: string): string {
  const run = spawnSync("sh", ["-c", `${PSQL} -X -At -v ON_ERROR_STOP=1`], { input: sql, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`psql failed (${run.status}): ${run.stderr.slice(0, 1200)}`);
  return run.stdout;
}

const quote = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;

/** The Hands list's filter as the readers take it (`libraryFilter`, the versions the client reads). */
const library = (filter: HandFilter) => ({
  ...filter,
  statsVersion: STATS_VERSION,
  evVersion: EV_VERSION,
  analysisVersion: ANALYSIS_VERSION,
  factsVersion: FACTS_VERSION,
});

function reads(filter: HandFilter): Array<{ name: string; pool: boolean; sql: string }> {
  return [
    { name: "report_open", pool: false, sql: `select public.report_open(${quote(library(filter))}) is not null` },
    { name: "report_graph", pool: false, sql: `select public.report_graph(${quote(library(filter))}, 150) is not null` },
    {
      name: "analytics_checker",
      pool: false,
      sql: `select public.analytics_checker(${quote({
        analysisVersion: ANALYSIS_VERSION,
        membershipVersion: ANALYTICS_MEMBERSHIP_VERSION,
        ...checkerFiltersOf(filter).filters,
      })}) is not null`,
    },
    {
      name: "analytics_pool",
      pool: true,
      sql: `select public.analytics_pool(${quote({
        membershipVersion: ANALYTICS_MEMBERSHIP_VERSION,
        statsVersion: STATS_VERSION,
        ...poolFiltersOf(filter),
      })}) is not null`,
    },
    { name: "analytics_pool_you", pool: true, sql: `select public.analytics_pool_you(${quote(library(filter))}) is not null` },
  ];
}

/**
 * Each read's milliseconds per run, as the user, in one rolled-back
 * transaction: psql's `\timing` (the server's time plus the local round
 * trip, sub-millisecond; PostgREST and the network add to it in production).
 */
function measure(user: string, filter: HandFilter): Array<{ name: string; pool: boolean; ms: number[] }> {
  const list = reads(filter);
  const parts = [
    "begin;",
    `select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', true);`,
    "set local role authenticated;",
    "\\timing on",
  ];
  for (let run = 0; run < RUNS; run++) {
    for (const [i, read] of list.entries()) {
      parts.push(`\\echo read:${i}`, `${read.sql};`);
    }
  }
  parts.push("rollback;");
  const ms = list.map(() => [] as number[]);
  let at = -1;
  for (const line of psql(parts.join("\n")).split("\n")) {
    const read = /^read:(\d+)$/.exec(line.trim());
    if (read) at = Number(read[1]);
    const time = /^Time: ([\d.]+) ms/.exec(line.trim());
    if (time && at >= 0) {
      ms[at].push(Number(time[1]));
      at = -1;
    }
  }
  return list.map((read, i) => ({ name: read.name, pool: read.pool, ms: ms[i] }));
}

describe.skipIf(!PSQL || !EMAIL)("the Pool tab opens in under a second (docs/POOL.md P3)", () => {
  const user = (): string => {
    const id = psql(`select id from auth.users where email = '${EMAIL.replace(/'/g, "''")}';`).trim();
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`no account ${EMAIL}`);
    return id;
  };

  it("nothing pending, every hand tagged", () => {
    const id = user();
    const [hands, pending, untagged] = psql(
      `select (select count(*) from public.hands where owner_id = '${id}') || '|' ||
              coalesce((select pending from public.derive_pending_counts where owner_id = '${id}'), 0) || '|' ||
              (select count(*) from public.hero_report_rows where owner_id = '${id}' and opp_mix is null);`,
    )
      .trim()
      .split("|")
      .map(Number);
    console.log(`${EMAIL}: ${hands} hands, ${pending} pending, ${untagged} hero rows untagged`);
    expect(pending).toBe(0);
    expect(untagged).toBe(0);
  });

  const filters: Array<[string, HandFilter]> = [
    ["no filter", {}],
    ["cash", { formats: ["cash"] }],
    ["a stake, a range cut inside days", { formats: ["cash"], stakes: ["USD:50"], from: "2026-01-01T13:00:00Z", to: "2026-11-01T05:00:00Z" }],
  ];
  for (const [label, filter] of filters) {
    it(`${label}: each read under ${BUDGET} ms`, () => {
      const rows = measure(user(), filter);
      for (const row of rows) {
        console.log(`${label.padEnd(36)} ${row.name.padEnd(20)} ${row.ms.map((ms) => ms.toFixed(1).padStart(8)).join(" ")} ms`);
        expect(row.ms).toHaveLength(RUNS);
        expect(Math.max(...row.ms), `${row.name} (${label})`).toBeLessThan(BUDGET);
      }
      const pool = rows.filter((row) => row.pool).map((row) => Math.max(...row.ms));
      expect(pool.reduce((a, b) => a + b, 0), `the Pool tab's own reads (${label})`).toBeLessThan(BUDGET);
    });
  }
});
