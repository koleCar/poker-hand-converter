/**
 * The release checklist's compliance item (guideline §7; docs/RAIL-PLAN.md
 * §12, R3.0, R3.10): every room whose HUD `config/sites.json` allows, with the
 * page its policy was read from and the date it was read - and a failure when
 * any of those dates is older than the limit, so a release cannot ship on a
 * stale policy check.
 *
 *   npm run hud:policy-check                      # limit 90 days, today
 *   npm run hud:policy-check -- --max-age-days 60
 *   npm run hud:policy-check -- --today 2027-01-20 --file ../config/sites.json
 *
 * In GitHub Actions (`.github/workflows/release-checklist.yml`, run by hand
 * before a release) the table also goes to the job summary.
 *
 * Re-checking a room: read its page again (docs/research/HUD-POLICIES.md has
 * the checklist), update `hud.source` / `hud.checkedAt` / `hud.notes` (or
 * switch `hud.allowed` off), and merge. The web then publishes the new file
 * (`/sites.json`) and the apps take it - stricter only - without a release.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default age limit, days. */
export const MAX_AGE_DAYS = 90;

/** A `YYYY-MM-DD` date as UTC midnight, or `null`. */
function day(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(at) ? null : at;
}

/**
 * Every entry with `hud.allowed === true`: id, name, source, checkedAt, its
 * age in days and the problem with it (`null` when fine).
 *
 * @param {{ sites: Array<{ id: string, name: string, kind: string, hud: { allowed: boolean | null, source: string | null, checkedAt: string | null } }> }} config
 * @param {string} today `YYYY-MM-DD`
 * @param {number} maxAgeDays
 */
export function review(config, today, maxAgeDays = MAX_AGE_DAYS) {
  const now = day(today);
  if (now === null) throw new Error(`not a date: ${today}`);
  return config.sites
    .filter((site) => site.hud?.allowed === true)
    .map((site) => {
      const checked = day(site.hud.checkedAt);
      const age = checked === null ? null : Math.floor((now - checked) / DAY_MS);
      let problem = null;
      if (site.kind !== "room") problem = "not a room";
      else if (typeof site.hud.source !== "string" || !site.hud.source.startsWith("https://"))
        problem = "no https source";
      else if (checked === null) problem = "no checkedAt";
      else if (age < 0) problem = "checkedAt is in the future";
      else if (age > maxAgeDays) problem = `checked ${age} days ago (limit ${maxAgeDays})`;
      return {
        id: site.id,
        name: site.name,
        source: site.hud.source ?? null,
        checkedAt: site.hud.checkedAt ?? null,
        age,
        problem,
      };
    });
}

/** The rows as a Markdown table. */
export function table(rows) {
  const lines = [
    "| Room | Policy page | Checked | Age (days) | Status |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.name} (\`${row.id}\`) | ${row.source ?? "-"} | ${row.checkedAt ?? "-"} | ${row.age ?? "-"} | ${row.problem ?? "ok"} |`,
    );
  }
  return lines.join("\n");
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  let file = join(here, "..", "..", "..", "config", "sites.json");
  let maxAge = MAX_AGE_DAYS;
  let today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--max-age-days":
        maxAge = Number(value);
        if (!Number.isInteger(maxAge) || maxAge < 1) throw new Error(`--max-age-days ${value}`);
        i += 1;
        break;
      case "--today":
        today = value;
        i += 1;
        break;
      case "--file":
        file = resolve(value);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  const rows = review(JSON.parse(readFileSync(file, "utf8")), today, maxAge);
  const text = table(rows);
  const stale = rows.filter((row) => row.problem !== null);
  const verdict =
    rows.length === 0
      ? "No room allows a HUD: nothing to re-check."
      : stale.length === 0
        ? `All ${rows.length} rooms whose HUD is allowed were checked within ${maxAge} days (today ${today}).`
        : `${stale.length} of ${rows.length} rooms need their policy re-checked before a release (limit ${maxAge} days, today ${today}).`;
  console.log(`${text}\n\n${verdict}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## HUD policy check\n\n${text}\n\n${verdict}\n`);
  }
  return stale.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
