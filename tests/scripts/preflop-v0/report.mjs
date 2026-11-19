// `node tests/scripts/preflop-v0/report.mjs [DIR]`: a markdown table of every
// v0 set's totals, read from DIR/<set-id>/summary.json (default
// ~/Projects/rail-preflop-out/v0), in the order of DIR/plan.json; sets
// without a summary are listed as pending. Plain Node, no build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), "Projects/rail-preflop-out/v0");
const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const plan = read(join(dir, "plan.json"));
const ids = plan
  ? plan.sets.map((s) => s.id)
  : existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name)
    : [];
const short = (p) => p.replace("UTG+", "U+");
const list = (obj, f = (v) => v) => Object.entries(obj ?? {}).map(([k, v]) => `${short(k)} ${f(v)}`).join(" · ");

const rows = [
  "| Set | Status | RFI % | SB fold / limp / raise % | BB defends % (3-bet %) vs open | 3-bet % vs a single open | NashConv mbb | Time |",
  "|---|---|---|---|---|---|---|---|",
];
for (const id of ids) {
  const s = read(join(dir, id, "summary.json"));
  const planned = plan?.sets.find((p) => p.id === id);
  if (!s) {
    rows.push(`| ${id} | pending${planned ? ` (~${Math.round(planned.estimateMinutes)} min)` : ""} | | | | | | |`);
    continue;
  }
  const stale = planned && planned.runKey !== s.runKey ? " (older spec)" : "";
  const t = s.totals;
  rows.push(
    [
      "",
      id,
      `done${stale}, ${s.iterations} it${s.rounds ? `, ${s.rounds} rounds` : ""}`,
      list(t.rfi),
      t.sb ? `${t.sb.fold} / ${t.sb.limp} / ${t.sb.raise}` : "-",
      list(t.bbDefence, (v) => `${v.defend} (${v.threeBet})`),
      list(t.threeBet),
      s.nashConvMbb,
      `${(s.seconds / 60).toFixed(1)} min`,
      "",
    ].join(" | ").trim(),
  );
}
console.log(ids.length ? rows.join("\n") : `no v0 output in ${dir}`);
