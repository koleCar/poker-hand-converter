/**
 * The nightly flop-solve queue (`nightly.sh`): which (set, line, flop) the
 * runner solves next, from the hands in the desktop app's store.
 *
 *     cd tests && NIGHTLY_STORE=".../app.rail.desktop/rail.db" NIGHTLY_QUEUE=/path/queue.json \
 *       npx vitest run --config scripts/flop-library/vitest.config.ts nightlyQueue
 *
 * Two parts, in this order:
 *
 * 1. **review** - the hands marked "Review" in the app (`hand_tags`;
 *    `NIGHTLY_TAGS`, comma separated, any case), on their exact flop
 *    (canonical), the spot marked first on top.
 * 2. **played** - every heads-up flop the hero saw, mapped to its
 *    representative flop (`mapFlop`, as the analysis reads a flop the
 *    library has not solved exactly), most hands first. These are the solves
 *    the analysis reads most: each representative answers every flop mapped
 *    to it.
 *
 * A hand counts when two players see the flop on a library line
 * (`chunkFor`: the hand's chart set by table and depth, GTO Wizard's sets
 * since `analysis/41`) and, for the played part, the hero is one of them.
 * The runner checks each line can be played on its set (`lineSpot`) and
 * skips spots already solved. `NIGHTLY_REVIEW_ONLY=1` rebuilds the review
 * part and keeps the played part of the existing file (seconds instead of
 * minutes; the runner calls it between batches so a hand marked tonight is
 * next). The store is opened read-only; the queue holds no cards of the
 * owner's and no names.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import * as zlib from "node:zlib";
import { it } from "vitest";

import * as analysis from "../../../web/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, loadCharts } from "../../../web/src/lib/charts/index.js";
import { FLOP_REPRESENTATIVES, mapFlop } from "../../../web/src/lib/solver/index.js";
import { heroOf, type PhfHand } from "../../../web/src/lib/phf/types.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../web/src/lib/charts/data");
const STORE = process.env.NIGHTLY_STORE ?? "";
const OUT = process.env.NIGHTLY_QUEUE ?? "";
const REVIEW_ONLY = process.env.NIGHTLY_REVIEW_ONLY === "1";
const TAGS = (process.env.NIGHTLY_TAGS ?? "Review")
  .split(",")
  .map((tag) => tag.trim().toLowerCase())
  .filter(Boolean);

export interface QueueSpot {
  set: string;
  line: string;
  flop: string;
  hands: number;
}

// The store keeps each PHF zstd-compressed (node has zstd from 23.8; else the `zstd` command).
const unzstd = (bytes: Uint8Array): Buffer =>
  typeof zlib.zstdDecompressSync === "function"
    ? zlib.zstdDecompressSync(bytes)
    : execFileSync("zstd", ["-dcq"], { input: bytes, maxBuffer: 64 << 20 });

const REPRESENTATIVES = new Set(FLOP_REPRESENTATIVES);
const exactly = { has: () => true };

it("builds the nightly flop-solve queue from the app's store", () => {
  if (!STORE || !existsSync(STORE) || !OUT) {
    console.log("NIGHTLY_STORE (the app's rail.db) and NIGHTLY_QUEUE must be set; nothing to do");
    return;
  }
  const charts = chartLibrary(CHART_SETS.map((spec) => loadCharts(JSON.parse(readFileSync(join(DATA, `${spec.id}.json`), "utf8")))));
  const skipped: Record<string, number> = {};
  // The review hands that cannot be solved, by why (the app could say so one day).
  const reviewSkipped: Record<string, number> = {};
  let into = skipped;
  const skip = (why: string) => (into[why] = (into[why] ?? 0) + 1);

  /** The hand's spot: its set, line and exact canonical flop; whether the hero is one of the two. */
  const spotOf = (phf: Uint8Array): { set: string; line: string; flop: string; hero: boolean } | null => {
    let hand: PhfHand;
    try {
      hand = JSON.parse(unzstd(phf).toString("utf8")) as PhfHand;
    } catch {
      skip("could not decompress or parse the PHF");
      return null;
    }
    let context;
    try {
      context = buildContext(structuredClone(hand));
    } catch {
      skip("unreadable");
      return null;
    }
    const chunk = analysis.chunkFor(hand, context, charts, exactly);
    if (!chunk) {
      skip("no heads-up library line (multiway, no chart set, off the tree)");
      return null;
    }
    const hero = heroOf(hand);
    const heroFolded = !hero || hand.actions.some((a) => a.street === "preflop" && a.type === "fold" && a.seat === hero.seat);
    return { set: chunk.set, line: chunk.line.id, flop: chunk.flop, hero: !heroFolded };
  };

  const db = new DatabaseSync(STORE, { readOnly: true });
  const marked = db
    .prepare(
      `SELECT t.hand_key AS key, min(t.added_at) AS markedAt, h.phf AS phf
         FROM hand_tags t JOIN hands h ON h.hand_key = t.hand_key
        WHERE lower(t.tag) IN (${TAGS.map(() => "?").join(", ")})
        GROUP BY t.hand_key
        ORDER BY markedAt, t.hand_key`,
    )
    .all(...TAGS) as { key: string; markedAt: number; phf: Uint8Array }[];
  const review = new Map<string, QueueSpot>();
  into = reviewSkipped;
  for (const row of marked) {
    const spot = spotOf(row.phf);
    if (!spot) continue;
    const id = `${spot.set}/${spot.line}/${spot.flop}`;
    const at = review.get(id) ?? { set: spot.set, line: spot.line, flop: spot.flop, hands: 0 };
    at.hands += 1;
    review.set(id, at);
  }

  into = skipped;
  let played: QueueSpot[] = [];
  let read = 0;
  if (REVIEW_ONLY && existsSync(OUT)) {
    played = (JSON.parse(readFileSync(OUT, "utf8")) as { played?: QueueSpot[] }).played ?? [];
  } else {
    const counts = new Map<string, QueueSpot>();
    for (const row of db.prepare("SELECT phf FROM hands").iterate() as Iterable<{ phf: Uint8Array }>) {
      read += 1;
      const spot = spotOf(row.phf);
      if (!spot) continue;
      if (!spot.hero) {
        skip("hero not in the pot");
        continue;
      }
      const flop = REPRESENTATIVES.has(spot.flop) ? spot.flop : mapFlop(spot.flop.match(/../g) ?? []).representative;
      const id = `${spot.set}/${spot.line}/${flop}`;
      const at = counts.get(id) ?? { set: spot.set, line: spot.line, flop, hands: 0 };
      at.hands += 1;
      counts.set(id, at);
    }
    played = [...counts.values()].sort(
      (a, b) => b.hands - a.hands || (a.set < b.set ? -1 : a.set > b.set ? 1 : 0) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0) || (a.flop < b.flop ? -1 : 1),
    );
  }
  db.close();

  const queue = { built: new Date().toISOString(), tags: TAGS, marked: marked.length, reviewSkipped, read, skipped, review: [...review.values()], played };
  const tmp = `${OUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(queue, null, 1));
  execFileSync("mv", [tmp, OUT]);
  const bySet: Record<string, { spots: number; hands: number }> = {};
  for (const q of played) {
    bySet[`${q.set} ${q.line}`] ??= { spots: 0, hands: 0 };
    bySet[`${q.set} ${q.line}`].spots += 1;
    bySet[`${q.set} ${q.line}`].hands += q.hands;
  }
  console.log(JSON.stringify({ marked: marked.length, reviewSkipped, read, review: queue.review, skipped, bySet, top: played.slice(0, 10) }, null, 1));
});
