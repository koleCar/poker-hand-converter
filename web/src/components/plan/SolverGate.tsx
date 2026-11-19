"use client";

/**
 * The web's flops a day for the Solver library (the pricing round's
 * contract and PR-Locks): the host's `flops` gate (`components/solver/host.tsx`)
 * and what it shows - today's flops as chips that reopen them, "N / 3", the
 * small Pro card when a flop is refused, the sign-in card for a signed-out
 * visitor - and the locked Nodelock for a Free account.
 *
 * Only while paid plans are enforced and the account is Free (or signed
 * out): otherwise there is no gate at all and every flop opens as before.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { useAuth } from "../../lib/auth";
import { dailyFlopCap, isFreeEnforced, isLocked } from "../../lib/db/entitlements";
import { useBillingEnforced } from "../../lib/entitlements/enforced";
import { useEntitlements } from "../../lib/entitlements/context";
import { canonicalFlopKey, flopsToday, openFlop, type FlopsToday } from "../../lib/entitlements/flops";
import { useDict } from "../../lib/i18n/client";
import type { FlopGateAnswer, SolverFlopGate } from "../solver/host";
import { formatClock } from "./PlanPanel";
import { LockedControl, SeeProLink } from "./ProLock";
import styles from "./gate.module.css";

/** Free's flops a day when the server has not said (the owner's, 2026-11-19). */
const DEFAULT_FLOP_CAP = 3;

type Mode = "pending" | "off" | "free" | "signed-out";

function cardsOf(key: string): string[] {
  return key.match(/[2-9TJQKA][shdc]/g) ?? [];
}

/** The gate for `/solver`, or undefined when flops are not limited for this visitor. */
export function useWebFlopGate(): SolverFlopGate | undefined {
  const auth = useAuth();
  const { status, entitlements } = useEntitlements();
  const signedOut = auth.configured && auth.status === "signed-out";
  const enforcedOut = useBillingEnforced(signedOut);
  const cap = dailyFlopCap(entitlements);

  const mode: Mode = !auth.configured
    ? "off"
    : auth.status === "loading"
      ? "pending"
      : signedOut
        ? enforcedOut === null
          ? "pending"
          : enforcedOut
            ? "signed-out"
            : "off"
        : status === "loading"
          ? "pending"
          : status === "ready" && cap !== null
            ? "free"
            : "off";

  // Today's flops: from the plan's answer, then the server's own list (another tab may have opened some).
  const seeded: FlopsToday | null =
    mode === "free" && entitlements
      ? { flops: entitlements.usage.flopsToday, cap, resetsAt: entitlements.usage.dayResetsAt }
      : null;
  const [today, setToday] = useState<FlopsToday | null>(null);
  const shown = today ?? seeded;
  const todayRef = useRef(shown);
  useEffect(() => {
    todayRef.current = shown;
  });

  useEffect(() => {
    if (mode !== "free") return;
    let active = true;
    flopsToday().then(
      (value) => {
        if (active) setToday(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [mode]);

  const open = useCallback(
    async (flop: string): Promise<FlopGateAnswer> => {
      if (mode === "signed-out") return "sign-in";
      if (mode !== "free") return "open";
      const key = canonicalFlopKey(flop);
      // Re-opening one of today's flops is free: no need to ask.
      if (key && todayRef.current?.flops.some((f) => canonicalFlopKey(f) === key)) return "open";
      try {
        const answer = await openFlop(flop);
        setToday({ flops: answer.flops, cap: answer.cap, resetsAt: answer.resetsAt });
        return answer.allowed ? "open" : "refused";
      } catch {
        // The flops are public data and the count is the gate: an unreachable count does not lock anyone out.
        return "open";
      }
    },
    [mode],
  );

  return useMemo<SolverFlopGate | undefined>(() => {
    if (mode === "off") return undefined;
    return {
      ready: mode !== "pending",
      open,
      today: mode === "free" && shown ? (reopen) => <TodayFlops today={shown} reopen={reopen} /> : undefined,
      closed: (answer) => <FlopClosed answer={answer} today={shown} />,
    };
  }, [mode, open, shown]);
}

/** The Nodelock control, locked, for a Free account under enforcement (the web has no nodelock of its own). */
export function useLockedSolverTools(): ReactNode {
  const t = useDict().pricing.solver;
  const { entitlements } = useEntitlements();
  return isFreeEnforced(entitlements) && isLocked(entitlements, "nodelock") ? <LockedControl label={t.nodelock} /> : null;
}

/** "Today's flops [K♠7♦2♣] [Q♥J♥4♠] [1 left]": each opened flop reopens on the current line. */
function TodayFlops({ today, reopen }: { today: FlopsToday; reopen: (flop: string) => (() => void) | null }) {
  const t = useDict().pricing.solver;
  const cap = today.cap ?? DEFAULT_FLOP_CAP;
  const left = Math.max(0, cap - today.flops.length);
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
      <span className={styles.count}>{t.count(today.flops.length, cap)}</span>
    </span>
  );
}

/** In place of the strategy: today's flops are used (a small Pro card), or sign in first. */
function FlopClosed({ answer, today }: { answer: Exclude<FlopGateAnswer, "open">; today: FlopsToday | null }) {
  const en = useDict();
  const t = en.pricing.solver;
  const auth = useAuth();
  const cap = today?.cap ?? DEFAULT_FLOP_CAP;
  if (answer === "sign-in") {
    return (
      <div className={styles.closed}>
        <p className={styles.closedText}>{t.signIn(cap)}</p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => auth.requestSignIn(t.signInReason)}>
          {t.signInButton}
        </button>
      </div>
    );
  }
  const used = today?.flops.length ?? cap;
  const time = today?.resetsAt ? formatClock(today.resetsAt, en.chrome.intl) : "";
  return (
    <div className={`${styles.closed} ${styles.closedPro}`}>
      <span className={styles.closedCount}>{t.count(used, cap)}</span>
      <p className={styles.closedText}>{t.refused(cap, time)}</p>
      <SeeProLink />
    </div>
  );
}
