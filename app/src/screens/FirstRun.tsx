/**
 * The first-run screen (R1.4; guideline §3 "Prvo pokretanje", §6): three
 * steps to the first HUD - sign in (R1.7, a placeholder for now), confirm
 * the hand-history folders Rail found, open a table. Shown on first launch
 * (`settings.firstRunDone`), reachable later from Settings (`#/setup`).
 */
import { useEffect, useState } from "react";

import { FoundFolderTable, type FoundRow } from "../components/FoundFolderTable";
import { ImportChoice } from "../components/ImportChoice";
import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { errorText, inApp, ipc, type Discovery } from "../lib/ipc";
import { go } from "../lib/router";
import styles from "./FirstRun.module.css";

type Row = FoundRow;

type Phase = "choose" | "adding" | "done";

export function FirstRun() {
  const t = useT();
  const d = t.firstRun.folders;
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [onlyNew, setOnlyNew] = useState(false);
  const [phase, setPhase] = useState<Phase>("choose");
  const [added, setAdded] = useState(0);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) {
      return;
    }
    let live = true;
    ipc
      .discoverFolders()
      .then((result) => {
        if (!live) {
          return;
        }
        setDiscovery(result);
        setRows(result.folders.map((found) => ({ path: found.path, found, checked: !found.watched })));
      })
      .catch((e: unknown) => {
        if (live) {
          setError(d.discoverFailed(errorText(e)));
        }
      });
    return () => {
      live = false;
    };
  }, [d]);

  const finish = () => {
    ipc
      .setFirstRunDone(true)
      .catch(() => undefined)
      .finally(() => go("today"));
  };

  const toggle = (path: string, checked: boolean) =>
    setRows((current) => current.map((row) => (row.path === path ? { ...row, checked } : row)));

  const pick = async () => {
    setPicking(true);
    try {
      const path = await ipc.pickFolder();
      if (path !== null) {
        setRows((current) =>
          current.some((row) => row.path === path)
            ? current.map((row) => (row.path === path ? { ...row, checked: true } : row))
            : [...current, { path, found: null, checked: true }],
        );
      }
    } catch (e: unknown) {
      setError(d.addFailed(errorText(e)));
    } finally {
      setPicking(false);
    }
  };

  const selected = rows.filter((row) => row.checked && !row.found?.watched);

  const confirm = async () => {
    setError(null);
    setPhase("adding");
    try {
      const result = await ipc.addFolders(
        selected.map((row) => ({ path: row.path, site: row.found?.site ?? null })),
        onlyNew,
      );
      setAdded(result.length);
      setPhase("done");
    } catch (e: unknown) {
      setError(d.addFailed(errorText(e)));
      setPhase("choose");
    }
  };

  if (!inApp) {
    return (
      <>
        <ScreenHeader title={t.firstRun.title} lead={t.firstRun.lead} />
        <p className={styles.muted}>{t.firstRun.unavailable}</p>
      </>
    );
  }

  return (
    <>
      <ScreenHeader title={t.firstRun.title} lead={t.firstRun.lead} />
      <ol className={styles.steps}>
        <li className={styles.step}>
          <div className={styles.row}>
            <h2 className={styles.heading}>{t.firstRun.signIn.heading}</h2>
            <span className={styles.badge}>{t.firstRun.signIn.later}</span>
          </div>
          <p className={styles.body}>{t.firstRun.signIn.body}</p>
        </li>

        <li className={styles.step} aria-current={phase === "done" ? undefined : "step"}>
          <h2 className={styles.heading}>{d.heading}</h2>
          {phase === "done" ? (
            <p className={styles.success}>{d.added(added)}</p>
          ) : (
            <>
              {!discovery && !error && <p className={styles.muted}>{d.searching}</p>}
              {discovery && rows.length > 0 && (
                <>
                  {discovery.folders.length > 0 && (
                    <p className={styles.body}>
                      {d.found(discovery.folders.length)} {d.lead}
                    </p>
                  )}
                  <FoundFolderTable rows={rows} onToggle={toggle} disabled={phase === "adding"} />
                </>
              )}
              {discovery && discovery.folders.length === 0 && (
                <>
                  <p className={styles.body}>{d.empty}</p>
                  <p className={styles.muted}>
                    {discovery.rooms.length > 0
                      ? d.lookedFor(discovery.rooms.map((room) => room.name).join(", "))
                      : d.noRooms}
                  </p>
                  <p className={styles.muted}>{d.verifying}</p>
                </>
              )}
              {discovery && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.link}
                    disabled={picking || phase === "adding"}
                    onClick={() => void pick()}
                  >
                    {picking ? d.choosing : d.addManually}
                  </button>
                </div>
              )}
              {selected.length > 0 && (
                <ImportChoice
                  legend={d.existingHeading}
                  onlyNew={onlyNew}
                  onChange={setOnlyNew}
                  disabled={phase === "adding"}
                />
              )}
              {error && <p className={styles.error}>{error}</p>}
              <div className={styles.actions}>
                {selected.length > 0 && (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={phase === "adding"}
                    onClick={() => void confirm()}
                  >
                    {phase === "adding" ? d.adding : d.confirm(selected.length)}
                  </button>
                )}
                <button type="button" className={styles.link} disabled={phase === "adding"} onClick={finish}>
                  {t.firstRun.skip}
                </button>
              </div>
            </>
          )}
        </li>

        <li className={styles.step} aria-current={phase === "done" ? "step" : undefined}>
          <h2 className={styles.heading}>{t.firstRun.table.heading}</h2>
          <p className={styles.body}>{t.firstRun.table.body}</p>
          {phase === "done" && (
            <div className={styles.actions}>
              <button type="button" className={styles.button} onClick={finish}>
                {t.firstRun.table.done}
              </button>
            </div>
          )}
        </li>
      </ol>
    </>
  );
}
