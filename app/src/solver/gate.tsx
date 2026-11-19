/**
 * (Free tier) The solver's flops a day in the app: the Solver library's
 * `flops` slot (`SolverHost.flops`, the web's `components/solver/host.tsx`)
 * and what it shows - today's flops as chips that reopen them with "N / 3",
 * the small Pro card in place of a refused flop, and the line for a new flop
 * while the server cannot be reached.
 *
 * Only while paid plans are enforced and the plan lacks every flop
 * (`flopsCounted`): otherwise there is no gate and every flop opens, as
 * before. Each flop is asked about through Rust (`solver_open_flop`), which
 * counts it on the server, or offline keeps today's flops open and holds a
 * new one. Preflop is never asked about.
 */
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { SeeProButton } from "../components/ProLock";
import { useT } from "../i18n";
import { liveDateFormat } from "../i18n/format";
import { inApp, ipc, type EntitlementsStatus } from "../lib/ipc";
import { flopsCounted, useEntitlements } from "../lib/useEntitlements";
import styles from "./gate.module.css";

/**
 * The library's flops slot (`SolverHost.flops` in the web's
 * `components/solver/host.tsx`), restated here so the app builds with a
 * library that has none yet: the host passes it through unchanged.
 */
export type FlopGateAnswer = "open" | "refused" | "sign-in";
export interface SolverFlopGate {
  ready: boolean;
  open: (flop: string) => Promise<FlopGateAnswer>;
  today?: (reopen: (flop: string) => (() => void) | null) => ReactNode;
  closed: (answer: Exclude<FlopGateAnswer, "open">, flop: string) => ReactNode;
}

const CLOCK = liveDateFormat({ hour: "2-digit", minute: "2-digit" });
/** Free's flops a day when the app has not been told (the owner's, 2026-11-19). */
const DEFAULT_FLOP_CAP = 3;

function cardsOf(key: string): string[] {
  return key.match(/[2-9TJQKA][shdc]/g) ?? [];
}

interface Today {
  flops: string[];
  cap: number;
  resetsAtMs: number | null;
}

function todayOf(status: EntitlementsStatus | null): Today {
  return {
    flops: status?.flopsToday ?? [],
    cap: status?.dailyFlopCap ?? DEFAULT_FLOP_CAP,
    resetsAtMs: status?.dayResetsAtMs ?? null,
  };
}

/** The gate for the Solver tab, or undefined when flops are not counted for this account. */
export function useAppFlopGate(): SolverFlopGate | undefined {
  const plan = useEntitlements();
  const { status, error, signIn, upgrade } = plan;
  const counted = flopsCounted(status);
  const pending = inApp && status === null && error === null;
  // The flops the last answer held for want of a connection (the library's keys).
  const offline = useRef(new Set<string>());
  // "Try again": a new `open` makes the library ask again.
  const [attempt, setAttempt] = useState(0);

  const open = useCallback(
    async (flop: string) => {
      void attempt;
      const answer = await ipc.solverOpenFlop(flop);
      offline.current.delete(flop);
      switch (answer.verdict) {
        case "open":
          return "open" as const;
        case "signIn":
          return "sign-in" as const;
        case "offline":
          offline.current.add(flop);
          return "refused" as const;
        default:
          return "refused" as const;
      }
    },
    [attempt],
  );

  const today = useMemo(() => todayOf(status), [status]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return useMemo<SolverFlopGate | undefined>(() => {
    if (pending) return { ready: false, open, closed: () => null };
    if (!counted) return undefined;
    return {
      ready: true,
      open,
      today: (reopen) => <TodayFlops today={today} reopen={reopen} />,
      closed: (answer, flop) =>
        answer === "sign-in" ? (
          <SignInCard cap={today.cap} onSignIn={signIn} />
        ) : offline.current.has(flop) ? (
          <OfflineCard onRetry={retry} />
        ) : (
          <RefusedCard today={today} onUpgrade={upgrade} />
        ),
    };
  }, [pending, counted, open, today, signIn, upgrade, retry]);
}

/** "Today's flops [K♠7♦2♣] [Q♥J♥4♠] [1 left] 2 / 3": each opened flop reopens on the current line. */
function TodayFlops({ today, reopen }: { today: Today; reopen: (flop: string) => (() => void) | null }) {
  const t = useT().plan.solver;
  const left = Math.max(0, today.cap - today.flops.length);
  return (
    <span className={styles.today} role="group" aria-label={t.today}>
      <span className={styles.todayLabel}>{t.today}</span>
      {today.flops.map((flop) => {
        const go = reopen(flop);
        return (
          <button
            key={flop}
            type="button"
            className={styles.chip}
            onClick={go ?? undefined}
            disabled={!go}
            title={go ? t.open(flop) : t.otherLine}
            aria-label={t.open(flop)}
          >
            <CardRow cards={cardsOf(flop)} size="xs" />
          </button>
        );
      })}
      {left > 0 ? <span className={`${styles.chip} ${styles.left}`}>{t.left(left)}</span> : null}
      <span className={styles.count}>{t.count(today.flops.length, today.cap)}</span>
    </span>
  );
}

/** Today's flops are used: "3 / 3", one line, See Pro. */
function RefusedCard({ today, onUpgrade }: { today: Today; onUpgrade: () => void }) {
  const t = useT().plan.solver;
  const time = today.resetsAtMs !== null ? CLOCK.format(today.resetsAtMs) : "";
  return (
    <div className={`${styles.closed} ${styles.closedPro}`}>
      <span className={styles.closedCount}>{t.count(Math.max(today.flops.length, today.cap), today.cap)}</span>
      <p className={styles.closedText}>{t.refused(today.cap, time)}</p>
      <SeeProButton onClick={onUpgrade} />
    </div>
  );
}

/** Enforced and signed out: flops need a (free) account. */
function SignInCard({ cap, onSignIn }: { cap: number; onSignIn: () => void }) {
  const t = useT().plan;
  return (
    <div className={styles.closed}>
      <p className={styles.closedText}>{t.solver.signIn(cap)}</p>
      <button type="button" className="btn btn--primary btn--sm" onClick={onSignIn}>
        {t.signIn}
      </button>
    </div>
  );
}

/** A new flop and no connection to count it: today's flops stay open. */
function OfflineCard({ onRetry }: { onRetry: () => void }) {
  const t = useT().plan.solver;
  return (
    <div className={styles.closed}>
      <p className={styles.closedText}>{t.offline}</p>
      <button type="button" className="btn btn--sm" onClick={onRetry}>
        {t.tryAgain}
      </button>
    </div>
  );
}
