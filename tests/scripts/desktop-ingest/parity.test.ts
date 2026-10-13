/**
 * Parity of the two `hands` mappings (docs/RAIL-PLAN.md R1.8).
 *
 * The web saves a hand with the row `handInsertFromPhf` builds in TypeScript
 * (`save_hands`); the desktop app sends only `{hand_key, phf}` and
 * `ingest_hands` derives the same row in SQL (`hand_row_from_phf`, migration
 * `20270428090000_desktop_ingest.sql`). Both must store the same search
 * columns for the same hand, or a filter on `/library` answers differently
 * for a hand depending on which client saved it.
 *
 * Every hand of the corpus is converted the way the converter tab converts
 * it, and given the shape the desktop sends (Q4: `meta.rawText` empty;
 * `meta.parsedAt` pinned so the output is stable). Then:
 *
 * - `npm run desktop-ingest:fixture` rewrites
 *   `supabase/tests/database/desktop_ingest_parity.test.sql`: a few dozen
 *   hands chosen to cover every parser and the mapping's special cases, each
 *   saved through both paths inside pgTAP, columns compared. That file runs
 *   in CI (`supabase test db`).
 * - `npm run desktop-ingest:parity` (needs `RAIL_PARITY_PSQL`, a command that
 *   runs `psql` against a **local** stack as `postgres`, e.g.
 *   `docker exec -i supabase_db_<project> psql -U postgres -d postgres`):
 *   the whole corpus through both paths in one transaction that is rolled
 *   back, every column of every hand compared. Not in CI (needs Docker and
 *   ~2 minutes); run it after any change to either mapping.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeSource } from "../../../frontend/src/components/converter/inputs.js";
import { handInsertFromPhf } from "../../../frontend/src/lib/db/mapping.js";
import { convertAny } from "../../../frontend/src/lib/parsers/index.js";
import { toStandardText } from "../../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { PINNED_PARSED_AT, ROOT, listInputs } from "../golden/emit.js";

const FIXTURE = join(ROOT, "supabase/tests/database/desktop_ingest_parity.test.sql");

const USER_WEB = "00000000-0000-0000-0000-0000000e1a01";
const USER_DESKTOP = "00000000-0000-0000-0000-0000000e1b01";
const DEVICE = "00000000-0000-0000-0000-0000000e1d01";

/** Columns that differ by design between the two paths. */
const NOT_COMPARED = ["id", "owner_id", "origin", "standard_text", "source_text", "created_at"];

interface Case {
  hand: PhfHand;
  key: string;
  /** The web's row, without `phf` (the SQL adds it back from `hand`). */
  web: Record<string, unknown>;
}

/** The hand as the desktop sends it. */
function desktopShape(hand: PhfHand): PhfHand {
  return { ...hand, meta: { ...hand.meta, rawText: "", parsedAt: PINNED_PARSED_AT } };
}

/**
 * One case per hand key: the corpus holds some hands in more than one file
 * (the same hand, another `originalFilename`), and the two paths would keep
 * different copies of the duplicate.
 */
async function corpusCases(): Promise<Case[]> {
  const out: Case[] = [];
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
      const hand = desktopShape(parsed);
      const { phf: _phf, ...web } = handInsertFromPhf(hand, toStandardText(hand));
      if (!seen.has(web.hand_key)) {
        seen.add(web.hand_key);
        out.push({ hand, key: web.hand_key, web });
      }
    }
  }
  return out;
}

/** A dollar-quote tag that does not occur in the text. */
function dollar(text: string, base: string): string {
  let tag = `$${base}$`;
  for (let n = 1; text.includes(tag); n++) {
    tag = `$${base}${n}$`;
  }
  return `${tag}${text}${tag}`;
}

/**
 * The fixture: the smallest hand of every parser, then the smallest showing
 * each case the mapping treats specially, without repeats. Deterministic:
 * the corpus order is the golden's (byte order of paths).
 */
function fixtureCases(cases: Case[]): { label: string; c: Case }[] {
  const picked = new Map<string, string>();
  const size = new Map(cases.map((c) => [c.key, JSON.stringify(c.hand).length]));
  // The smallest matching hand (first in corpus order on a tie), to keep the
  // generated file small.
  const take = (label: string, match: (c: Case) => boolean) => {
    let found: Case | undefined;
    for (const c of cases) {
      if (!picked.has(c.key) && match(c) && (!found || size.get(c.key)! < size.get(found.key)!)) {
        found = c;
      }
    }
    if (found) {
      picked.set(found.key, label);
    }
  };
  const parsers = Array.from(new Set(cases.map((c) => c.hand.meta.parserId)));
  for (const parser of parsers) {
    take(`parser ${parser}`, (c) => c.hand.meta.parserId === parser);
  }
  take("positional anonymity", (c) => c.web.site_anonymization === "positional");
  take("opaque ids from a parser warning", (c) =>
    c.hand.meta.warnings.some((w) => w.code === "numeric-player-ids"));
  take("opaque ids by structure", (c) =>
    c.web.site_anonymization === "opaque-id" && !["ggpoker"].includes(c.hand.meta.siteId) &&
    !c.hand.meta.warnings.some((w) => w.code === "numeric-player-ids"));
  take("short deck, ante only", (c) => c.hand.game.variant === "shortdeck" && !c.hand.game.smallBlind);
  take("run it twice", (c) => c.hand.board.runouts.length > 1);
  take("tournament", (c) => c.hand.tournament !== null);
  take("omaha (no hand class)", (c) => c.hand.game.variant.startsWith("omaha"));
  take("fixed2 decimals", (c) => c.hand.meta.textStyle.decimals === "fixed2" && c.hand.game.smallBlind % 100 !== 0);
  take("minimal decimals, cents", (c) => c.hand.meta.textStyle.decimals === "minimal" && c.hand.game.smallBlind % 10 !== 0);
  take("chips", (c) => c.hand.game.unit.minorUnits === 1);
  take("no hero", (c) => !c.hand.players.some((p) => p.isHero));
  take("no flop", (c) => c.web.board_cards.length === 0);
  take("showdown", (c) => c.web.showdown_positions.length > 1);
  take("ante", (c) => (c.hand.game.ante ?? 0) > 0);
  take("fast fold", (c) => Boolean(c.hand.table.fastFold));
  take("split pot", (c) => new Set(c.hand.results.winners.map((w) => w.player)).size > 1);
  take("rake and jackpot", (c) => c.hand.results.fees.jackpot > 0);
  take("hero lost", (c) => (c.hand.results.heroNet ?? 0) < 0);
  return cases.filter((c) => picked.has(c.key)).map((c) => ({ label: picked.get(c.key)!, c }));
}

const COMPARE_SQL = (where: string) => `
  select jsonb_build_object('handKey', a.hand_key, 'column', k,
                            'web', ja -> k, 'desktop', jb -> k)
    from public.hands a
    join public.hands b on b.hand_key = a.hand_key and b.owner_id = '${USER_DESKTOP}'
    cross join lateral (select to_jsonb(a) - array[${NOT_COMPARED.map((c) => `'${c}'`).join(", ")}] as ja,
                               to_jsonb(b) - array[${NOT_COMPARED.map((c) => `'${c}'`).join(", ")}] as jb) j
    cross join lateral jsonb_object_keys(ja) k
   where a.owner_id = '${USER_WEB}' ${where}
     and ja -> k is distinct from jb -> k`;

function writeFixture(cases: Case[]): number {
  const chosen = fixtureCases(cases);
  const values = chosen
    .map(({ label, c }, n) => `  (${n + 1}, ${dollar(label, "l")}, ${dollar(c.key, "k")},\n   ${dollar(JSON.stringify(c.hand), "p")}::jsonb,\n   ${dollar(JSON.stringify(c.web), "w")}::jsonb)`)
    .join(",\n");
  const sql = `-- pgTAP: Rail R1.8, parity of the two hands mappings.
--
-- GENERATED by \`npm run desktop-ingest:fixture\` (tests/scripts/desktop-ingest/
-- parity.test.ts) from the corpus; do not edit by hand. ${chosen.length} hands: the smallest
-- of every parser, then the smallest showing each case the mapping treats
-- specially. Each is saved through \`save_hands\` with the row the web's
-- \`handInsertFromPhf\` builds, and through \`ingest_hands\` with only its PHF
-- (in the shape the desktop sends: \`meta.rawText\` empty); every search column
-- must come out equal. The whole corpus (7 496 distinct hands) is compared the same way
-- by \`npm run desktop-ingest:parity\` against a local stack.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(${chosen.length + 3});

insert into auth.users (id, email, email_confirmed_at, created_at) values
  ('${USER_WEB}', 'parity.web@example.com', now(), now()),
  ('${USER_DESKTOP}', 'parity.desktop@example.com', now(), now());

create function pg_temp.act_as(p_uid uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;
grant execute on function pg_temp.act_as(uuid) to authenticated;

create temporary table parity_case (n int primary key, label text, hand_key text, phf jsonb, web jsonb);
grant select on parity_case to authenticated;
insert into parity_case values
${values};

select pg_temp.act_as('${USER_WEB}');
select is(
  (public.save_hands((select jsonb_agg(web || jsonb_build_object('phf', phf) order by n) from parity_case)) ->> 'inserted')::int,
  ${chosen.length}, 'the web path stores every hand');

select pg_temp.act_as('${USER_DESKTOP}');
select is(
  (public.ingest_hands(
     public.register_hand_source('${DEVICE}', 'parity'),
     (select jsonb_agg(jsonb_build_object('hand_key', hand_key, 'phf', phf) order by n) from parity_case)
   ) ->> 'inserted')::int,
  ${chosen.length}, 'the desktop path stores every hand');

reset role;
select is(
  (select count(*)::int from public.hands where owner_id = '${USER_DESKTOP}' and origin = 'desktop'
      and standard_text is null and source_text is null),
  ${chosen.length}, 'desktop rows carry no standard or source text');

${chosen
  .map(
    (_, n) => `select is(
  (select coalesce(jsonb_agg(d), '[]'::jsonb) from (${COMPARE_SQL(`and a.hand_key = (select hand_key from parity_case where n = ${n + 1})`)}) as x(d)),
  '[]'::jsonb, (select 'same columns: ' || label || ' (' || hand_key || ')' from parity_case where n = ${n + 1}));`,
  )
  .join("\n")}

select * from finish();
rollback;
`;
  writeFileSync(FIXTURE, sql);
  return chosen.length;
}

function corpusSql(cases: Case[]): string {
  const batches = <T>(items: T[], size: number): T[][] =>
    Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
  const parts: string[] = [
    "\\set ON_ERROR_STOP 1",
    "begin;",
    `insert into auth.users (id, email, email_confirmed_at, created_at) values
      ('${USER_WEB}', 'parity.web@example.com', now(), now()),
      ('${USER_DESKTOP}', 'parity.desktop@example.com', now(), now());`,
    // The global web budget is shared with whatever else ran on this stack.
    "delete from public.ingest_rate_limit where bucket = 'hands_insert';",
    `select set_config('request.jwt.claims', '{"sub":"${USER_WEB}","role":"authenticated"}', true);`,
    "set local role authenticated;",
  ];
  for (const batch of batches(cases, 500)) {
    const rows = batch.map((c) => ({ ...c.web, phf: c.hand }));
    parts.push(`select 'web ' || public.save_hands(${dollar(JSON.stringify(rows), "j")}::jsonb)::text;`);
  }
  parts.push(
    "reset role;",
    `select set_config('request.jwt.claims', '{"sub":"${USER_DESKTOP}","role":"authenticated"}', true);`,
    "set local role authenticated;",
    `select set_config('parity.source', public.register_hand_source('${DEVICE}', 'parity')::text, true);`,
  );
  for (const batch of batches(cases, 500)) {
    const rows = batch.map((c) => ({ hand_key: c.key, phf: c.hand }));
    parts.push(
      `select 'desktop ' || (public.ingest_hands(current_setting('parity.source')::uuid, ${dollar(JSON.stringify(rows), "j")}::jsonb) - 'rows')::text;`,
    );
  }
  parts.push(
    "reset role;",
    `select 'count ' || jsonb_build_object(
       'web', (select count(*) from public.hands where owner_id = '${USER_WEB}'),
       'desktop', (select count(*) from public.hands where owner_id = '${USER_DESKTOP}'))::text;`,
    `select 'diff ' || d::text from (${COMPARE_SQL("")}) as x(d) limit 50;`,
    `select 'diffcount ' || count(*) from (${COMPARE_SQL("")}) as x(d);`,
    "rollback;",
  );
  return parts.join("\n");
}

describe("desktop ingest parity", () => {
  it("writes the pgTAP fixture", async () => {
    if (!process.env.RAIL_PARITY_FIXTURE) {
      return;
    }
    const cases = await corpusCases();
    const written = writeFixture(cases);
    console.log(`desktop-ingest: ${written} hands written to ${FIXTURE}`);
    expect(written).toBeGreaterThan(19);
  });

  it("matches over the whole corpus", async () => {
    const psql = process.env.RAIL_PARITY_PSQL;
    if (!psql) {
      return;
    }
    const cases = await corpusCases();
    // A hand key's shape, as `hand_row_problem` checks it.
    const keyShape = /^[a-z0-9][a-z0-9._-]{0,63}:[^\s:]\S{0,135}$/;
    expect(cases.filter((c) => !keyShape.test(c.key)).map((c) => c.key)).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "rail-parity-"));
    const file = join(dir, "parity.sql");
    writeFileSync(file, corpusSql(cases));
    const [command, ...args] = psql.split(/\s+/);
    const run = spawnSync(command, [...args, "-At", "-q"], {
      input: readFileSync(file),
      maxBuffer: 1 << 30,
    });
    const stdout = run.stdout.toString();
    if (run.status !== 0) {
      throw new Error(`psql failed: ${run.stderr.toString().slice(0, 2000)}`);
    }
    const lines = stdout.split("\n").filter(Boolean);
    const sum = (prefix: string, key: string) =>
      lines
        .filter((l) => l.startsWith(prefix))
        .reduce((total, l) => total + Number(JSON.parse(l.slice(prefix.length))[key] ?? 0), 0);
    const diffs = lines.filter((l) => l.startsWith("diff "));
    const count = JSON.parse(lines.find((l) => l.startsWith("count "))!.slice(6));
    const report = {
      hands: cases.length,
      web: { inserted: sum("web ", "inserted"), duplicates: sum("web ", "duplicates") },
      desktop: {
        inserted: sum("desktop ", "inserted"),
        duplicates: sum("desktop ", "duplicates"),
        rejected: sum("desktop ", "rejected"),
      },
      stored: count,
      differences: Number(lines.find((l) => l.startsWith("diffcount "))!.slice(10)),
    };
    console.log(JSON.stringify(report, null, 2));
    for (const line of diffs.slice(0, 20)) {
      console.log(line);
    }
    expect(report.desktop.rejected).toBe(0);
    expect(count.desktop).toBe(count.web);
    expect(report.differences).toBe(0);
  });
});
