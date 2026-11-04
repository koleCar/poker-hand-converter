/**
 * The overview's drill line (phase A7): how many of your own Mistakes are due
 * today, how many new ones the next sync would add, and the way to the
 * trainer. Quiet when the drills are not installed or the reader has none.
 */

"use client";

import type { GameKind } from "@rail/ui/hands/gameKind";
import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchDrillSummary, type DrillSummary } from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import { trainQuery, DEFAULT_TRAIN_STATE } from "./trainState";
import own from "./train.module.css";

/** `kind`: the overview's kind of game - its drills only, never both kinds' together. */
export function DrillsDue({ generation, kind }: { generation: number; kind: GameKind }) {
  const t = useDict().analysis.train.overview;
  const [summary, setSummary] = useState<DrillSummary | null>(null);

  useEffect(() => {
    let live = true;
    fetchDrillSummary(kind)
      .then((value) => {
        if (live) setSummary(value);
      })
      .catch(() => {
        if (live) setSummary(null);
      });
    return () => {
      live = false;
    };
  }, [generation, kind]);

  if (!summary || summary.items + summary.candidates === 0) return null;
  // Undrilled Mistakes become drills, due at once, on the trainer's first sync.
  const due = summary.due + summary.candidates;
  const today = summary.dueToday + summary.candidates;
  return (
    <section className={`card ${own.dueCard} rail-enter`} aria-labelledby="drills-due">
      <h3 id="drills-due" className={own.spotHead}>
        {t.heading}
      </h3>
      <p>
        {t.due(due, today)}
        {summary.candidates > 0 ? ` ${t.candidates(summary.candidates)}` : ""}
      </p>
      <Link href={paths.analysisTrain(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills", kind }))} className="btn btn--primary btn--sm">
        {t.train}
      </Link>
    </section>
  );
}
