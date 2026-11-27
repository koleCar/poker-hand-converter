"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppFrame } from "../../../components/shell/AppFrame";
import { useAuth } from "../../../lib/auth";
import { findHandId, isDatabaseConfigured } from "../../../lib/db";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import styles from "../../../components/analysis/analysis.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

/** Client half of `/analysis/hand?key=`: find the row, then its analysis page. */
export function HandByKeyScreen({ handKey, position }: { handKey: string | null; position: string | null }) {
  return <AppFrame tab="analysis">{() => <ByKey handKey={handKey} position={position} />}</AppFrame>;
}

function ByKey({ handKey, position }: { handKey: string | null; position: string | null }) {
  const t = useDict().analysis;
  const auth = useAuth();
  const router = useRouter();
  const [state, setState] = useState<"looking" | "missing" | { error: string }>("looking");

  useEffect(() => {
    if (!handKey || !isDatabaseConfigured || !auth.isSignedIn) return;
    let live = true;
    void findHandId(handKey)
      .then((id) => {
        if (!live) return;
        if (id) router.replace(paths.analysisHand(id, position ? `t=${encodeURIComponent(position)}` : undefined));
        else setState("missing");
      })
      .catch((error: unknown) => {
        if (live) setState({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, handKey, position, router]);

  if (isDatabaseConfigured && !auth.isSignedIn && handKey) {
    return (
      <div className={styles.handPage}>
        <div className="card stats-empty">
          <h3>{t.tab.signInHeading}</h3>
          <p className="muted">{t.tab.signInBody}</p>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
            {t.tab.signIn}
          </button>
        </div>
      </div>
    );
  }
  if (!handKey) {
    return (
      <div className={styles.handPage}>
        <Dismissible className="notice notice--warn">{t.hand.notFound}</Dismissible>
      </div>
    );
  }
  return (
    <div className={styles.handPage}>
      {state === "looking" ? <RailLoader size="page" label={t.hand.loading} showLabel centered /> : null}
      {state === "missing" ? <Dismissible className="notice notice--warn">{t.hand.notSynced}</Dismissible> : null}
      {typeof state === "object" ? <Dismissible className="notice notice--error">{state.error}</Dismissible> : null}
    </div>
  );
}
