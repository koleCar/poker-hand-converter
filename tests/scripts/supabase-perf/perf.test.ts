/**
 * The web's reports over a million hands of one user (docs/RAIL-PLAN.md
 * R2.9, second bullet; guideline §1: a report over 1M hands opens in < 1 s).
 * Decides whether the server needs the `player_stats` rollup (§3.5) or
 * indexes. Not in CI: it needs Docker, a few GB and ~half an hour.
 *
 * ```text
 * RAIL_PERF_PSQL='docker exec -i supabase_db_<project> psql -U postgres -d postgres' \
 *   [RAIL_PERF_HANDS=1000000] [RAIL_PERF_SKIP_LOAD=1] npm run supabase:perf
 * ```
 *
 * **Only against a throwaway local stack** (a copy of `supabase/` with its own
 * project id and ports; never the project's, never production): it writes a
 * user and a million GENERATED hands.
 *
 * 1. **The real write path, once.** Every corpus hand (one per hand key) in
 *    the shape the desktop sends (`meta.rawText` empty) through
 *    `register_hand_source` + `ingest_hands` (500 a call), its statistics
 *    rows - hero and villains, `handStatsRows(hand, { includeVillains: true })`,
 *    what the web's writer sends with opponent statistics on - through
 *    `save_hand_stats`, and the hero's all-in EV row through `save_hand_ev`,
 *    each called **as the user** (role `authenticated`, the user's JWT
 *    claims), so RLS, the normalising triggers and the checks run as in
 *    production.
 * 2. **Copies, to a million.** As `postgres`, copy *c* of every row the
 *    calls wrote (`hands`, `hand_stats`, `hand_stats_ev`): a fresh `hands.id`
 *    and `hand_key` (`~c` appended), played `7 c` days earlier (the desktop
 *    benchmark's spread: a real day's volume), villains renamed per copy
 *    (`~c`) except the corpus's most frequent 5 % (heavy regulars across
 *    every copy). Triggers off for the copy (`session_replication_role =
 *    replica`; the rows are copies of rows the RPCs checked); the table
 *    checks and every index stay on. Then `ANALYZE`.
 * 3. **The reports**, as the user, each three times (the first is what a
 *    user opening `/stats` waits for; Postgres has no result cache, so the
 *    others differ only by the buffer cache): `stats_summary`, `stats_graph`
 *    (60 buckets, the web's default), `stats_breakdown` by every group,
 *    `stats_opponents` (50 rows, and a search), `stats_sessions`; everything
 *    and cash only. psql's `\timing` gives the server's time plus the local
 *    round trip (sub-millisecond); PostgREST and the network add to it in
 *    production.
 *
 * Prints a table; nothing is asserted (the decision is the plan's).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it } from "vitest";

import { decodeSource } from "../../../frontend/src/components/converter/inputs.js";
import { handKeyOf } from "../../../frontend/src/lib/db/mapping.js";
import { handEvRow, handStatsRows } from "../../../frontend/src/lib/db/statsRows.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { STATS_VERSION } from "../../../frontend/src/lib/stats/types.js";
import { PINNED_PARSED_AT, ROOT, listInputs } from "../golden/emit.js";

const USER = "00000000-0000-0000-0000-00000000e290";
const DEVICE = "00000000-0000-0000-0000-00000000e291";
const PSQL = process.env.RAIL_PERF_PSQL ?? "";
const HANDS = Number(process.env.RAIL_PERF_HANDS ?? "1000000");
const SKIP_LOAD = process.env.RAIL_PERF_SKIP_LOAD === "1";

/** A dollar-quote tag that does not occur in the text. */
function dollar(text: string, base: string): string {
  let tag = `$${base}$`;
  for (let n = 1; text.includes(tag); n++) {
    tag = `$${base}${n}$`;
  }
  return `${tag}${text}${tag}`;
}

function psql(sql: string): string {
  const run = spawnSync("sh", ["-c", PSQL], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (run.status !== 0) {
    throw new Error(`psql failed (${run.status}): ${run.stderr.slice(0, 1200)}`);
  }
  return run.stdout;
}

const AS_USER = `select set_config('request.jwt.claims', '{"sub":"${USER}","role":"authenticated"}', false);
set role authenticated;`;

/** The corpus as the desktop sends it, one hand per key. */
async function corpus(): Promise<PhfHand[]> {
  const out: PhfHand[] = [];
  const seen = new Set<string>();
  for (const path of listInputs()) {
    const bytes = new Uint8Array(readFileSync(join(ROOT, path)));
    const decoded = decodeSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    if (decoded.problem) {
      continue;
    }
    const name = path.split("/").pop()!;
    const result = await convertAny(decoded.text, { sourceFilename: name, validate: true });
    for (const parsed of result.hands) {
      const hand: PhfHand = { ...parsed, meta: { ...parsed.meta, rawText: "", parsedAt: PINNED_PARSED_AT } };
      if (!seen.has(handKeyOf(hand))) {
        seen.add(handKeyOf(hand));
        out.push(hand);
      }
    }
  }
  return out;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function loadSql(hands: PhfHand[]): string {
  const parts: string[] = [
    "\\set ON_ERROR_STOP on",
    `delete from auth.users where id = '${USER}';`,
    `insert into auth.users (id, email, email_confirmed_at, created_at)
       values ('${USER}', 'perf.r29@example.test', now(), now());`,
    AS_USER,
    `select public.register_hand_source('${DEVICE}', 'perf-r29', 'perf', 'perf', null) as src \\gset`,
  ];
  for (const batch of chunks(hands, 500)) {
    const rows = batch.map((hand) => ({ hand_key: handKeyOf(hand), phf: hand }));
    parts.push(`select public.ingest_hands(:'src'::uuid, ${dollar(JSON.stringify(rows), "r")}::jsonb) - 'rows' as ingested;`);
  }
  const stats = [];
  let skipped = 0;
  const ev = [];
  for (const hand of hands) {
    let rows;
    try {
      rows = handStatsRows(hand, { includeVillains: true });
    } catch {
      continue;
    }
    // `hand_stats_seat_ok` (0-24) refuses the corpus's few hands with
    // higher seat numbers, and with them their whole batch: left out.
    if (rows.some((row) => row.seat < 0 || row.seat > 24)) {
      skipped += 1;
      continue;
    }
    stats.push(...rows);
    const hero = rows.find((row) => row.is_hero);
    if (hero) {
      try {
        ev.push(handEvRow(hand, hero));
      } catch {
        // as the web's writer: no EV row
      }
    }
  }
  console.log(`statistics rows for ${hands.length - skipped} hands (${skipped} left out: seats over 24)`);
  for (const batch of chunks(stats, 1000)) {
    parts.push(`select public.save_hand_stats(${dollar(JSON.stringify(batch), "s")}::jsonb) as saved;`);
  }
  for (const batch of chunks(ev, 1000)) {
    parts.push(`select public.save_hand_ev(${dollar(JSON.stringify(batch), "e")}::jsonb) as ev_saved;`);
  }
  parts.push("reset role;");
  return parts.join("\n");
}

/** Copies of the user's rows to `hands` hands (see the file header). */
function copySql(base: number): string {
  const copies = Math.max(1, Math.ceil(HANDS / base));
  return `\\set ON_ERROR_STOP on
reset role;
set session_replication_role = replica;
set maintenance_work_mem = '512MB';
create temp table perf_copy as select generate_series(1, ${copies - 1}) as c;
create temp table perf_regular as
  select player from public.hand_stats where owner_id = '${USER}' and not is_hero
  group by player order by count(*) desc
  limit (select greatest(1, count(distinct player) / 20) from public.hand_stats where owner_id = '${USER}' and not is_hero);

create function pg_temp.copy_rows(p_table text, p_overrides jsonb) returns void language plpgsql as $f$
declare
  v_cols text;
  v_sel  text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(coalesce(p_overrides ->> column_name, 'x.' || quote_ident(column_name)), ', ' order by ordinal_position)
    into v_cols, v_sel
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and is_generated = 'NEVER' and (column_default is null or column_default not like 'nextval%');
  execute format('insert into public.%I (%s) select %s from public.%I x cross join perf_copy c where x.owner_id = %L',
                 p_table, v_cols, v_sel, p_table, '${USER}');
end;
$f$;

select pg_temp.copy_rows('hands', jsonb_build_object(
  'id', 'md5(x.id::text || '':'' || c.c)::uuid',
  'hand_key', 'x.hand_key || ''~'' || c.c',
  'site_hand_id', 'x.site_hand_id || ''~'' || c.c',
  'played_at', 'x.played_at - make_interval(days => 7 * c.c)',
  'created_at', 'now()'));
select pg_temp.copy_rows('hand_stats', jsonb_build_object(
  'hand_id', 'md5(x.hand_id::text || '':'' || c.c)::uuid',
  'hand_key', 'x.hand_key || ''~'' || c.c',
  'played_at', 'x.played_at - make_interval(days => 7 * c.c)',
  'player', 'case when x.is_hero or x.player in (select player from perf_regular) then x.player else left(x.player, 110) || ''~'' || c.c end'));
select pg_temp.copy_rows('hand_stats_ev', jsonb_build_object(
  'hand_id', 'md5(x.hand_id::text || '':'' || c.c)::uuid',
  'hand_key', 'x.hand_key || ''~'' || c.c'));
set session_replication_role = origin;
analyze public.hands;
analyze public.hand_stats;
analyze public.hand_stats_ev;
select count(*) as hands from public.hands where owner_id = '${USER}';
select count(*) as stats_rows, count(*) filter (where is_hero) as hero_rows,
       count(distinct player) filter (where not is_hero) as opponents
  from public.hand_stats where owner_id = '${USER}';
select pg_size_pretty(pg_total_relation_size('public.hands')) as hands_size,
       pg_size_pretty(pg_total_relation_size('public.hand_stats')) as hand_stats_size;
`;
}

function measureSql(): string {
  const v = STATS_VERSION;
  const all = `{"statsVersion":"${v}"}`;
  const cash = `{"statsVersion":"${v}","gameFormat":"cash"}`;
  const calls: [string, string][] = [];
  for (const [scope, f] of [["everything", all], ["cash", cash]]) {
    calls.push([`stats_summary ${scope}`, `public.stats_summary('${f}'::jsonb)`]);
    calls.push([`stats_graph ${scope}`, `public.stats_graph('${f}'::jsonb, 60)`]);
    for (const group of ["position", "pot_type", "stack_bb", "hand_class", "stakes", "site", "table_size"]) {
      calls.push([`stats_breakdown ${group} ${scope}`, `public.stats_breakdown('${f}'::jsonb, '${group}')`]);
    }
    calls.push([`stats_opponents ${scope}`, `public.stats_opponents('${f}'::jsonb, null, 50)`]);
    calls.push([`stats_sessions ${scope}`, `public.stats_sessions('${f}'::jsonb, 30)`]);
  }
  calls.push(["stats_opponents search", `public.stats_opponents('${all}'::jsonb, 'a', 50)`]);
  const lines = ["\\set ON_ERROR_STOP on", AS_USER, "\\timing on"];
  for (const [label, call] of calls) {
    for (const run of [1, 2, 3]) {
      lines.push(`\\echo MARK ${label} #${run}`);
      lines.push(`select octet_length(${call}::text) as bytes;`);
    }
  }
  lines.push("\\timing off", "reset role;");
  return lines.join("\n");
}

describe.skipIf(!PSQL)("the web's reports over a million hands", () => {
  it("loads, copies and measures", async () => {
    if (!SKIP_LOAD) {
      const hands = await corpus();
      let started = Date.now();
      const loaded = psql(loadSql(hands)).split("\n").filter((line) => line.includes("{"));
      console.log(loaded.slice(0, 3).join("\n"), `... ${loaded.length} calls`);
      console.log(`loaded ${hands.length} corpus hands through the RPCs in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      started = Date.now();
      console.log(psql(copySql(hands.length)));
      console.log(`copied to ~${HANDS} hands in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    const out = psql(measureSql());
    const results = new Map<string, number[]>();
    let label = "";
    for (const line of out.split("\n")) {
      const mark = /^MARK (.*) #\d+$/.exec(line);
      if (mark) {
        label = mark[1];
        continue;
      }
      const time = /^Time: ([\d.,]+) ms/.exec(line);
      if (time && label) {
        results.set(label, [...(results.get(label) ?? []), Number(time[1].replace(",", ""))]);
        label = "";
      }
    }
    console.log("| report | first ms | then ms |\n| --- | ---: | ---: |");
    for (const [name, times] of results) {
      const rest = times.slice(1).sort((a, b) => a - b);
      console.log(`| ${name} | ${times[0].toFixed(0)} | ${(rest[0] ?? times[0]).toFixed(0)} |`);
    }
  });
});
