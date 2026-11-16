/**
 * A session's history: its figures, the score as it moved (per 20 hands),
 * the answers grouped by what the settings leave open (the kind of hand, the
 * best move, the seat, the street, the day) - a group's row filters the
 * hands - and every answer, newest first, filtered by grade or to the spots
 * played more than once. An answer opens to every time its spot was played
 * and "Play it again", which deals that very spot next.
 */

"use client";

import { useMemo, useState } from "react";
import type { Grade } from "../../lib/analysis/types";
import { useTrainerHost } from "./host";
import { lockedSummary, scoreBand } from "./SessionTrainer";
import { cardsOf, dayOf, earlierOn, figuresOf, handType, sessionSettings, whenText, type SessionAnswer, type TrainerSession } from "./sessions";
import styles from "./trainer.module.css";

const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };
const CHUNK = 20;
const PAGE = 100;

type Group = "type" | "best" | "seat" | "street" | "day";
type Filter = "all" | "bad" | "inaccurate" | "ok";

const GROUP_OF: Record<Group, (a: SessionAnswer) => string> = {
  type: (a) => handType(a.handClass),
  best: (a) => a.best || "—",
  seat: (a) => a.position ?? "—",
  street: (a) => a.street,
  day: (a) => dayOf(a.at),
};

const FILTERS: Record<Filter, (g: Grade) => boolean> = {
  all: () => true,
  bad: (g) => g === "mistake" || g === "blunder",
  inaccurate: (g) => g === "inaccurate",
  ok: (g) => g === "perfect" || g === "good",
};

export function SessionReview({
  session,
  answers,
  onSessions,
  onContinue,
  onPlayAgain,
}: {
  session: TrainerSession;
  answers: readonly SessionAnswer[];
  onSessions: () => void;
  onContinue: () => void;
  onPlayAgain: (answer: SessionAnswer) => void;
}) {
  const { t, locale } = useTrainerHost();
  const s = t.sessions;
  const r = s.reviewing;
  const settings = useMemo(() => sessionSettings(session), [session]);
  const figures = useMemo(() => figuresOf(answers), [answers]);

  // The groupings worth showing: only what the session's settings leave open.
  const groups = useMemo<Group[]>(() => {
    const distinct = (f: (a: SessionAnswer) => string) => new Set(answers.map(f)).size > 1;
    const out: Group[] = [];
    if (answers.some((a) => a.street === "preflop")) out.push("type");
    out.push("best");
    if (distinct(GROUP_OF.seat)) out.push("seat");
    if (distinct(GROUP_OF.street)) out.push("street");
    out.push("day");
    return out;
  }, [answers]);
  const [group, setGroup] = useState<Group>(groups[0] ?? "best");
  const by = groups.includes(group) ? group : (groups[0] ?? "best");
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [again, setAgain] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of answers) map.set(a.spotKey, (map.get(a.spotKey) ?? 0) + 1);
    return map;
  }, [answers]);

  const rows = useMemo(() => {
    const map = new Map<string, SessionAnswer[]>();
    for (const a of answers) {
      const key = GROUP_OF[by](a);
      const list = map.get(key);
      if (list) list.push(a);
      else map.set(key, [a]);
    }
    const out = [...map.entries()].map(([key, list]) => ({ key, ...figuresOf(list) }));
    return by === "day" ? out.sort((a, b) => b.key.localeCompare(a.key)) : out.sort((a, b) => b.hands - a.hands);
  }, [answers, by]);

  const list = useMemo(
    () =>
      answers
        .filter((a) => (selected === null || GROUP_OF[by](a) === selected) && FILTERS[filter](a.grade) && (!again || (counts.get(a.spotKey) ?? 0) > 1))
        .slice()
        .reverse(),
    [answers, selected, by, filter, again, counts],
  );

  // The score per 20 hands.
  const chart = useMemo(() => {
    const points: number[] = [];
    for (let i = 0; i < answers.length; i += CHUNK) {
      const part = answers.slice(i, i + CHUNK);
      points.push(part.reduce((sum, a) => sum + a.score, 0) / part.length);
    }
    if (points.length < 2) return null;
    const lo = Math.max(0, Math.floor(Math.min(...points) / 10) * 10);
    const hi = Math.min(100, Math.ceil(Math.max(...points) / 10) * 10 || 100);
    const span = Math.max(10, hi - lo);
    const w = 420;
    const h = 84;
    const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 8 - ((p - lo) / span) * (h - 16)] as const);
    return { w, h, line: xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "), xy, first: points[0], last: points[points.length - 1] };
  }, [answers]);

  const days = new Set(answers.map((a) => dayOf(a.at))).size;
  const label = (key: string) =>
    by === "type" ? (r.handTypes[key] ?? key) : by === "street" ? (t.board[key] ?? t.modes[key] ?? key) : by === "day" ? whenText(`${key}T12:00:00`, t, locale).replace(/\s\d\d[:.]\d\d$/, "") : key;
  const score = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString(locale));

  return (
    <div className={styles.trainer}>
      <div className={styles.top}>
        <span className={styles.reviewTitle}>
          <button type="button" className={styles.iconButton} onClick={onSessions} aria-label={s.all} title={s.all}>
            ‹
          </button>
          <strong>{session.name}</strong>
          <span className={styles.muted}>{lockedSummary(settings, t)}</span>
        </span>
        <button type="button" className={styles.next} onClick={onContinue}>
          {s.continue}
        </button>
      </div>

      {answers.length === 0 ? (
        <p className={styles.notice}>{r.empty}</p>
      ) : (
        <>
          <section className={styles.reviewFigures}>
            <div>
              <span className={styles.figureLabel}>{s.hands}</span>
              <strong>{figures.hands.toLocaleString(locale)}</strong>
              <span className={styles.muted}>{r.inDays(days)}</span>
            </div>
            <div>
              <span className={styles.figureLabel}>{s.score}</span>
              <strong data-score={scoreBand(figures.score)}>{score(figures.score)}</strong>
            </div>
            <div>
              <span className={styles.figureLabel}>{t.session.evLost}</span>
              <strong data-loss={figures.evLoss > 0 || undefined}>{t.lostBb(figures.evLoss)}</strong>
              <span className={styles.muted}>{r.perHand(figures.hands ? figures.evLoss / figures.hands : 0)}</span>
            </div>
            <div>
              <span className={styles.figureLabel}>{r.bestStreak}</span>
              <strong>{figures.bestStreak.toLocaleString(locale)}</strong>
            </div>
            {figures.repeated > 0 ? (
              <div>
                <span className={styles.figureLabel}>{s.playedAgain}</span>
                <strong>{figures.repeated.toLocaleString(locale)}</strong>
                <span className={styles.muted}>{s.rightNow(figures.repeatedRight / figures.repeated)}</span>
              </div>
            ) : null}
            {chart ? (
              <figure className={styles.scoreChart}>
                <svg viewBox={`0 0 ${chart.w} ${chart.h}`} role="img" aria-label={`${r.chart}: ${score(chart.first)} → ${score(chart.last)}`}>
                  <polyline points={chart.line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  {chart.xy.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y} r="2.5" fill="currentColor" />
                  ))}
                </svg>
                <figcaption className={styles.muted}>
                  <span>{r.chart}</span>
                  <span>{r.chartRange(answers.length)}</span>
                </figcaption>
              </figure>
            ) : null}
          </section>

          <div className={styles.reviewLayout}>
            <section className={styles.reviewGroups}>
              <div className={styles.modes} role="group" aria-label={r.groupLabel}>
                {groups.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={styles.mode}
                    aria-pressed={by === id}
                    onClick={() => {
                      setGroup(id);
                      setSelected(null);
                    }}
                  >
                    {r.groups[id]}
                  </button>
                ))}
              </div>
              <ul className={styles.groupRows}>
                {rows.map((row) => (
                  <li key={row.key}>
                    <button type="button" aria-pressed={selected === row.key} onClick={() => setSelected(selected === row.key ? null : row.key)}>
                      <span className={styles.groupName}>{label(row.key)}</span>
                      <span className={styles.muted}>{row.hands.toLocaleString(locale)}</span>
                      <strong data-score={scoreBand(row.score)}>{score(row.score)}</strong>
                      <span data-loss={row.evLoss > 0 || undefined}>{t.lostBb(row.evLoss)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className={styles.muted}>{r.groupHint}</p>
            </section>

            <section className={styles.reviewHands}>
              <div className={styles.reviewFilters}>
                {(Object.keys(FILTERS) as Filter[]).map((id) => (
                  <button key={id} type="button" className={styles.chip} role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>
                    {r.filters[id]}
                  </button>
                ))}
                <button type="button" className={styles.chip} role="switch" aria-checked={again} onClick={() => setAgain((v) => !v)}>
                  {r.again}
                </button>
                {selected !== null ? (
                  <button type="button" className={styles.chip} aria-checked="true" role="switch" onClick={() => setSelected(null)}>
                    {label(selected)} ✕
                  </button>
                ) : null}
                <span className={styles.muted}>{r.count(list.length)}</span>
              </div>
              {list.length === 0 ? <p className={styles.muted}>{r.noMatch}</p> : null}
              <ol className={styles.answerRows}>
                {list.slice(0, shown).map((a) => {
                  const id = `${a.at}|${a.spotKey}`;
                  const times = counts.get(a.spotKey) ?? 1;
                  const expanded = open === id;
                  return (
                    <li key={id} data-open={expanded || undefined}>
                      <button type="button" className={styles.answerRow} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : id)}>
                        <span className={styles.muted}>{whenText(a.at, t, locale)}</span>
                        <span className={styles.answerCards}>
                          {cardsOf(a.cards).join(" ")}
                          {a.board ? <span className={styles.muted}> · {cardsOf(a.board).join(" ")}</span> : null}
                        </span>
                        <span>{a.move}</span>
                        <span className={styles.muted}>{a.best}</span>
                        <span className={styles.answerGrade} data-grade={a.grade}>
                          <span aria-hidden="true">{GLYPH[a.grade]}</span> {t.words.grades[a.grade] ?? a.grade}
                        </span>
                        <span data-loss={a.evLoss > 0.005 || undefined}>{a.evLoss > 0.005 ? t.evLost(a.evLoss) : t.noLoss}</span>
                        <span className={styles.muted}>{times > 1 ? `×${times}` : ""}</span>
                      </button>
                      {expanded ? (
                        <div className={`${styles.answerMore} rail-fade`}>
                          <div>
                            <span className={styles.figureLabel}>{r.every}</span>
                            <ol className={styles.seenList}>
                              {earlierOn(answers, a.spotKey).map((e) => (
                                <li key={`${e.at}|${e.move}`} data-grade={e.grade}>
                                  <span className={styles.muted}>{whenText(e.at, t, locale)}</span>
                                  <span>{e.move}</span>
                                  <span className={styles.seenGrade}>
                                    <span aria-hidden="true">{GLYPH[e.grade]}</span> {t.words.grades[e.grade] ?? e.grade}
                                  </span>
                                  <span data-loss={e.evLoss > 0.005 || undefined}>{e.evLoss > 0.005 ? t.evLost(e.evLoss) : t.noLoss}</span>
                                </li>
                              ))}
                            </ol>
                          </div>
                          {a.ref ? (
                            <button type="button" className={styles.chip} onClick={() => onPlayAgain(a)}>
                              {r.playAgain}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {list.length > shown ? (
                <button type="button" className={styles.linkButton} onClick={() => setShown((n) => n + PAGE)}>
                  {r.count(list.length - shown)} ›
                </button>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

