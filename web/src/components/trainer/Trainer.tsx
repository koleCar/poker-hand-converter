/**
 * The Trainer: a poker spot on a table, the moves as buttons, and after the
 * answer the grade, what the reference does with the hand and why.
 *
 * Modelled on GTO Wizard's trainer (the felt, the action strip, the coloured
 * action buttons, a quick verdict, a settings sheet), on Rail's own reference
 * - the charts, the flop library and the turn and river solved on the spot -
 * and graded by the analysis itself (`lib/training`): a trainer answer is the
 * analysis' grade of the same spot by construction. "For you" deals from the
 * player's own leaks.
 *
 * Training happens in **sessions** (`sessions.ts`, `docs/TRAINER.md` §7): a
 * name and settings fixed for the session's life. This is the session list
 * and the switch between it, a session's training (`SessionTrainer`) and its
 * history (`SessionReview`); a new session is the settings sheet with a name
 * (`SettingsSheet`). A change of settings starts a new session.
 *
 * Host-neutral (`host.tsx`): the web and the desktop app render it in place;
 * the host says where sessions are kept (the account, or this device).
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GRADES } from "../../lib/analysis/types";
import { readDrills, saveDrills } from "./drills";
import { useTrainerHost } from "./host";
import { lockedSummary, scoreBand, SessionTrainer } from "./SessionTrainer";
import { SessionReview } from "./SessionReview";
import { emptyCounts, newSessionId, sessionSettings, whenText, type SessionAnswer, type TrainerSession } from "./sessions";
import { SettingsSheet } from "./SettingsSheet";
import { settingsFields, type TrainerSettings } from "./settings";
import styles from "./trainer.module.css";

type View = { kind: "list" } | { kind: "train"; id: string } | { kind: "review"; id: string };
type Sort = "recent" | "hands" | "score";

export function Trainer({ initial, suggest = false }: { initial: TrainerSettings; suggest?: boolean }) {
  const host = useTrainerHost();
  const { t } = host;
  const store = host.sessions;
  const [sessions, setSessions] = useState<TrainerSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });
  const [sheet, setSheet] = useState<{ initial: TrainerSettings; from: TrainerSession | null } | null>(null);
  const [answers, setAnswers] = useState<Record<string, SessionAnswer[]>>({});
  const [again, setAgain] = useState<{ answer: SessionAnswer; stamp: number } | null>(null);
  const opened = useRef(false);
  const asked = useRef(new Set<string>());

  const failed = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  const reload = useCallback(
    () =>
      store
        .list()
        .then((list) => setSessions(list))
        .catch((e: unknown) => {
          failed(e);
          setSessions((current) => current ?? []);
        }),
    [store, failed],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  /** A session's answers, read once; answers given meanwhile stay after them. */
  const loadAnswers = useCallback(
    (id: string) => {
      if (asked.current.has(id)) return;
      asked.current.add(id);
      store
        .answers(id)
        .then((list) => setAnswers((current) => ({ ...current, [id]: [...list, ...(current[id] ?? [])] })))
        .catch(failed);
    },
    [store, failed],
  );

  const show = useCallback(
    (next: View) => {
      setView(next);
      if (next.kind !== "list") loadAnswers(next.id);
      host.onSession?.(next.kind === "list" ? null : next.id);
      if (next.kind === "list") void reload();
    },
    [host, loadAnswers, reload],
  );

  const save = useCallback(
    (session: TrainerSession) => {
      setSessions((list) => (list ? (list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [session, ...list]) : [session]));
      store.save({ id: session.id, name: session.name, fields: session.fields, archived: session.archived }).catch(failed);
    },
    [store, failed],
  );

  const start = useCallback(
    (name: string, settings: TrainerSettings) => {
      const now = new Date().toISOString();
      const session: TrainerSession = {
        id: newSessionId(),
        name,
        fields: settingsFields(settings),
        archived: false,
        createdAt: now,
        playedAt: now,
        hands: 0,
        today: 0,
        scoreSum: 0,
        evLoss: 0,
        counts: emptyCounts(),
      };
      save(session);
      asked.current.add(session.id);
      setAnswers((current) => ({ ...current, [session.id]: [] }));
      setSheet(null);
      setAgain(null);
      setView({ kind: "train", id: session.id });
      host.onSession?.(session.id);
    },
    [save, host],
  );

  // Once the list is in: the saved drills of before become sessions, then the session the address names opens,
  // or the sheet for a new one (a link's settings, or nothing to continue yet).
  useEffect(() => {
    if (!sessions || opened.current) return;
    opened.current = true;
    const drills = typeof window === "undefined" ? [] : readDrills();
    if (drills.length > 0) {
      const now = new Date().toISOString();
      for (const drill of drills) {
        if (sessions.some((s) => s.name === drill.name)) continue;
        save({ id: newSessionId(), name: drill.name, fields: drill.fields, archived: false, createdAt: now, playedAt: now, hands: 0, today: 0, scoreSum: 0, evLoss: 0, counts: emptyCounts() });
      }
      saveDrills([]);
    }
    const wanted = host.initialSession ? sessions.find((s) => s.id === host.initialSession) : undefined;
    if (wanted) {
      setView({ kind: "train", id: wanted.id });
      loadAnswers(wanted.id);
    } else if (suggest || (sessions.length === 0 && drills.length === 0)) setSheet({ initial, from: null });
  }, [sessions, host.initialSession, suggest, initial, save, loadAnswers]);

  const openId = view.kind !== "list" ? view.id : null;
  const onAnswer = useCallback(
    (answer: SessionAnswer) => {
      if (!openId) return;
      const id = openId;
      setAnswers((current) => ({ ...current, [id]: [...(current[id] ?? []), answer] }));
      setSessions((list) =>
        list
          ? list.map((s) =>
              s.id === id
                ? {
                    ...s,
                    playedAt: answer.at,
                    hands: s.hands + 1,
                    today: s.today + 1,
                    scoreSum: s.scoreSum + answer.score,
                    evLoss: s.evLoss + Math.max(0, answer.evLoss),
                    counts: { ...s.counts, [answer.grade]: s.counts[answer.grade] + 1 },
                  }
                : s,
            )
          : list,
      );
      store.record(id, answer);
    },
    [openId, store],
  );

  const current = view.kind !== "list" ? (sessions?.find((s) => s.id === view.id) ?? null) : null;
  const canPlayHands = Boolean(host.playStart && host.playGrade && host.playAnswer);

  let body;
  if (sessions === null) {
    body = (
      <div className={styles.loading}>
        <RailLoader label={t.sessions.loading} showLabel centered />
      </div>
    );
  } else if (current && view.kind === "train") {
    body = (
      <SessionTrainer
        key={`${current.id}|${again?.stamp ?? 0}`}
        session={current}
        answers={answers[current.id] ?? []}
        onAnswer={onAnswer}
        again={again?.answer ?? null}
        onSessions={() => show({ kind: "list" })}
        onReview={() => show({ kind: "review", id: current.id })}
        onChangeSettings={() => setSheet({ initial: sessionSettings(current), from: current })}
        onRename={(name) => save({ ...current, name })}
      />
    );
  } else if (current && view.kind === "review") {
    body = (
      <SessionReview
        session={current}
        answers={answers[current.id] ?? []}
        onSessions={() => show({ kind: "list" })}
        onContinue={() => {
          setAgain(null);
          show({ kind: "train", id: current.id });
        }}
        onPlayAgain={(answer) => {
          setAgain({ answer, stamp: Date.now() });
          show({ kind: "train", id: current.id });
        }}
      />
    );
  } else {
    body = (
      <SessionList
        sessions={sessions}
        onNew={() => setSheet({ initial, from: null })}
        onOpen={(session) => {
          setAgain(null);
          show({ kind: "train", id: session.id });
        }}
        onReview={(session) => show({ kind: "review", id: session.id })}
        onFrom={(session) => setSheet({ initial: sessionSettings(session), from: null })}
        onSave={save}
      />
    );
  }

  return (
    <>
      {error ? (
        <p className={styles.notice} role="alert">
          {t.sessions.failed(error)}{" "}
          <button type="button" className={styles.linkButton} onClick={() => setError(null)}>
            {t.close}
          </button>
        </p>
      ) : null}
      {body}
      {sheet ? (
        <SettingsSheet
          initial={sheet.initial}
          from={sheet.from}
          sessions={sessions ?? []}
          canPlayHands={canPlayHands}
          onStart={start}
          onContinue={(session) => {
            setSheet(null);
            setAgain(null);
            show({ kind: "train", id: session.id });
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

/** The player's sessions: each one's name and settings, hands, score, grades, EV lost and when it was last played. */
function SessionList({
  sessions,
  onNew,
  onOpen,
  onReview,
  onFrom,
  onSave,
}: {
  sessions: readonly TrainerSession[];
  onNew: () => void;
  onOpen: (session: TrainerSession) => void;
  onReview: (session: TrainerSession) => void;
  onFrom: (session: TrainerSession) => void;
  onSave: (session: TrainerSession) => void;
}) {
  const host = useTrainerHost();
  const { t, locale } = host;
  const s = t.sessions;
  const [sort, setSort] = useState<Sort>("recent");
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const archivedCount = sessions.filter((x) => x.archived).length;
  const list = useMemo(() => {
    const shown = sessions.filter((x) => x.archived === archived);
    const score = (x: TrainerSession) => (x.hands ? x.scoreSum / x.hands : -1);
    if (sort === "hands") return [...shown].sort((a, b) => b.hands - a.hands);
    if (sort === "score") return [...shown].sort((a, b) => score(b) - score(a));
    return [...shown].sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }, [sessions, archived, sort]);

  return (
    <div className={styles.trainer}>
      <div className={styles.top}>
        <button type="button" className={styles.next} onClick={onNew}>
          + {s.newSession}
        </button>
        <span className={styles.listTools}>
          <span className={styles.modes} role="group" aria-label={s.sortLabel}>
            {(["recent", "hands", "score"] as const).map((id) => (
              <button key={id} type="button" className={styles.mode} aria-pressed={sort === id} onClick={() => setSort(id)}>
                {s.sorts[id]}
              </button>
            ))}
          </span>
          {archivedCount > 0 || archived ? (
            <button type="button" className={styles.chip} role="switch" aria-checked={archived} onClick={() => setArchived((v) => !v)}>
              {s.archived} <span className={styles.muted}>{archivedCount}</span>
            </button>
          ) : null}
          {host.extraModes}
        </span>
      </div>

      {list.length === 0 ? (
        <p className={styles.sessionsEmpty}>
          {archived ? s.noneArchived : s.none}{" "}
          {archived ? null : (
            <button type="button" className={styles.linkButton} onClick={onNew}>
              {s.newSession}
            </button>
          )}
        </p>
      ) : (
        <div className={styles.sessionTable}>
          <div className={styles.sessionHead} aria-hidden="true">
            <span>{s.columns.session}</span>
            <span>{s.columns.hands}</span>
            <span>{s.columns.score}</span>
            <span>{s.columns.grades}</span>
            <span>{s.columns.evLost}</span>
            <span>{s.columns.played}</span>
            <span />
          </div>
          <ul className={styles.sessionRows}>
            {list.map((session) => {
              const score = session.hands ? session.scoreSum / session.hands : null;
              const editing = renaming?.id === session.id;
              return (
                <li key={session.id} className={styles.sessionRow}>
                  {editing ? (
                    <form
                      className={styles.renameForm}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (renaming.name.trim()) onSave({ ...session, name: renaming.name.trim() });
                        setRenaming(null);
                      }}
                    >
                      <input
                        className={styles.input}
                        value={renaming.name}
                        maxLength={60}
                        autoFocus
                        aria-label={s.name}
                        onChange={(event) => setRenaming({ id: session.id, name: event.target.value })}
                        onKeyDown={(event) => event.key === "Escape" && setRenaming(null)}
                      />
                      <button type="submit" className={styles.chip}>
                        {s.renameSave}
                      </button>
                    </form>
                  ) : (
                    <button type="button" className={styles.sessionOpen} onClick={() => onOpen(session)}>
                      <strong>{session.name}</strong>
                      <span className={styles.muted}>{lockedSummary(sessionSettings(session), t)}</span>
                    </button>
                  )}
                  <span className={styles.sessionHands}>
                    <strong>{session.hands.toLocaleString(locale)}</strong>
                    {session.today > 0 ? <span className={styles.muted}>{s.todayCount(session.today)}</span> : null}
                  </span>
                  <strong data-score={scoreBand(score)}>{score === null ? "—" : Math.round(score).toLocaleString(locale)}</strong>
                  <span className={styles.gradeBar} title={GRADES.map((g) => `${t.words.grades[g]} ${session.counts[g]}`).join(", ")}>
                    {GRADES.map((grade) => (
                      <i key={grade} data-grade={grade} style={{ flexGrow: session.counts[grade] }} />
                    ))}
                  </span>
                  <span data-loss={session.evLoss > 0 || undefined}>{t.lostBb(session.evLoss)}</span>
                  <span className={styles.muted}>{whenText(session.playedAt, t, locale)}</span>
                  <span className={styles.sessionActions}>
                    <button type="button" className={styles.chip} onClick={() => onOpen(session)}>
                      {s.continue}
                    </button>
                    <span className={styles.menuBox}>
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={s.menu(session.name)}
                        aria-expanded={menu === session.id}
                        aria-haspopup="menu"
                        onClick={() => setMenu(menu === session.id ? null : session.id)}
                      >
                        ⋯
                      </button>
                      {menu === session.id ? (
                        <span className={styles.menu} role="menu" data-end>
                          <button type="button" role="menuitem" onClick={() => onReview(session)}>
                            {s.review}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenu(null);
                              setRenaming({ id: session.id, name: session.name });
                            }}
                          >
                            {s.rename}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenu(null);
                              onFrom(session);
                            }}
                          >
                            {s.fromThese}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenu(null);
                              onSave({ ...session, archived: !session.archived });
                            }}
                          >
                            {session.archived ? s.restore : s.archive}
                          </button>
                        </span>
                      ) : null}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
