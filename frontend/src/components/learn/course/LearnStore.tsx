/**
 * Where a learner's progress lives, for every Learn screen (L1).
 *
 * Signed in (with a database): the account's rows (`lesson_progress`,
 * `lesson_cards`), read under RLS and written through the definer RPCs.
 * Signed out: the browser's storage only, with the same rules
 * (`lib/learn/progress.ts`). A learner who signs in with progress made while
 * signed out is offered to add it to the account, explicitly — the browser's
 * progress may have been someone else's.
 *
 * Every storage read and write is wrapped: a private window or blocked
 * storage gives a course that works and forgets, never one that breaks.
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../../lib/auth";
import { isDatabaseConfigured } from "../../../lib/db";
import { endOfToday } from "../../../lib/db/training";
import { addLessonCards, fetchCardCounts, fetchLessonProgress, recordLessonResults } from "../../../lib/db/learn";
import {
  LOCAL_CARDS_KEY,
  LOCAL_PROGRESS_KEY,
  addLocalCards,
  applyResult,
  parseLocalCards,
  parseLocalProgress,
  progressAsResults,
  type Card,
  type LessonResult,
  type NewCard,
  type ProgressMap,
} from "../../../lib/learn/progress";
import { isDue } from "../../../lib/training/schedule";

export type LearnMode = "loading" | "local" | "account";

export interface LearnStore {
  mode: LearnMode;
  progress: ProgressMap;
  /** Cards due now; null while unknown. */
  due: number | null;
  /** Records one result; resolves once it is kept (or rejects with why not). */
  record: (result: LessonResult) => Promise<void>;
  /** Makes review cards; resolves with how many were new. */
  addCards: (cards: readonly NewCard[]) => Promise<number>;
  /** Signed in, with progress from a signed-out session in this browser: how many lessons. */
  localLessons: number;
  mergeLocal: () => Promise<void>;
  discardLocal: () => void;
  error: string | null;
}

const LearnContext = createContext<LearnStore | null>(null);

export function readLocal(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked or full: the course still works, it just forgets.
  }
}

export function localDeck(): Card[] {
  return parseLocalCards(readLocal(LOCAL_CARDS_KEY));
}

export function saveLocalDeck(deck: readonly Card[]): void {
  writeLocal(LOCAL_CARDS_KEY, JSON.stringify(deck));
}

export function LearnProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const account = isDatabaseConfigured && auth.isSignedIn;
  const [mode, setMode] = useState<LearnMode>("loading");
  const [progress, setProgress] = useState<ProgressMap>({});
  const [due, setDue] = useState<number | null>(null);
  const [localLessons, setLocalLessons] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<ProgressMap>({});
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (auth.status === "loading") return;
    let live = true;
    const local = parseLocalProgress(readLocal(LOCAL_PROGRESS_KEY));
    const load = account
      ? Promise.all([fetchLessonProgress(), fetchCardCounts(new Date(endOfToday()))]).then(([stored, counts]) => ({
          mode: "account" as const,
          progress: stored ?? {},
          due: counts?.due ?? 0,
          localLessons: Object.keys(local).length,
        }))
      : Promise.resolve({
          mode: "local" as const,
          progress: local,
          due: localDeck().filter((card) => isDue(card.state, new Date())).length,
          localLessons: 0,
        });
    load
      .then((loaded) => {
        if (!live) return;
        setProgress(loaded.progress);
        setDue(loaded.due);
        setLocalLessons(loaded.localLessons);
        setMode(loaded.mode);
      })
      .catch((reason: unknown) => {
        if (!live) return;
        // Not migrated yet, or offline: fall back to this browser so the course still works.
        setError(reason instanceof Error ? reason.message : String(reason));
        setProgress(local);
        setMode("local");
      });
    return () => {
      live = false;
    };
  }, [account, auth.status]);

  const record = useCallback(
    async (result: LessonResult) => {
      const next = applyResult(progressRef.current, result, new Date());
      progressRef.current = next;
      setProgress(next);
      if (mode === "account") {
        await recordLessonResults([result]);
      } else {
        writeLocal(LOCAL_PROGRESS_KEY, JSON.stringify(next));
      }
    },
    [mode],
  );

  const addCards = useCallback(
    async (cards: readonly NewCard[]) => {
      if (cards.length === 0) return 0;
      if (mode === "account") {
        const inserted = await addLessonCards(cards);
        setDue((value) => (value ?? 0) + inserted);
        return inserted;
      }
      const before = localDeck();
      const after = addLocalCards(before, cards, new Date());
      saveLocalDeck(after);
      const now = new Date();
      setDue(after.filter((card) => isDue(card.state, now)).length);
      return after.length - before.length;
    },
    [mode],
  );

  const mergeLocal = useCallback(async () => {
    const local = parseLocalProgress(readLocal(LOCAL_PROGRESS_KEY));
    const cards = localDeck();
    await recordLessonResults(progressAsResults(local));
    if (cards.length > 0) await addLessonCards(cards.map(({ lesson, exercise, kind, key, item }) => ({ lesson, exercise, kind, key, item })));
    writeLocal(LOCAL_PROGRESS_KEY, null);
    writeLocal(LOCAL_CARDS_KEY, null);
    setLocalLessons(0);
    const [stored, counts] = await Promise.all([fetchLessonProgress(), fetchCardCounts(new Date(endOfToday()))]);
    setProgress(stored ?? {});
    setDue(counts?.due ?? 0);
  }, []);

  const discardLocal = useCallback(() => {
    writeLocal(LOCAL_PROGRESS_KEY, null);
    writeLocal(LOCAL_CARDS_KEY, null);
    setLocalLessons(0);
  }, []);

  const value = useMemo<LearnStore>(
    () => ({ mode, progress, due, record, addCards, localLessons, mergeLocal, discardLocal, error }),
    [mode, progress, due, record, addCards, localLessons, mergeLocal, discardLocal, error],
  );
  return <LearnContext.Provider value={value}>{children}</LearnContext.Provider>;
}

export function useLearn(): LearnStore {
  const value = useContext(LearnContext);
  if (!value) throw new Error("useLearn() must be used inside <LearnProvider>.");
  return value;
}
