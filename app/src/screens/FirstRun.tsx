/**
 * The first-run screen (R1.4; guideline §3 "Prvo pokretanje", §6): three
 * steps to the first HUD - sign in (R1.7, a placeholder for now), confirm
 * the hand-history folders Rail found, open a table. Shown on first launch
 * (`settings.firstRunDone`), reachable later from Settings (`#/setup`).
 */
import { useEffect, useState } from "react";

import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { errorText, inApp, ipc, type Discovery, type FoundFolder } from "../lib/ipc";
import { go } from "../lib/router";
import styles from "./FirstRun.module.css";

const number = new Intl.NumberFormat();
const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** A row of the folder list: a folder discovery found, or one picked by hand. */
interface Row {
  path: string;
  /** `null` for a folder added by hand. */
  found: FoundFolder | null;
  checked: boolean;
}

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

  const files = (found: FoundFolder) => {
    if (found.files === 0) {
      return d.noFiles;
    }
    const count = number.format(found.files);
    return found.complete ? count : d.atLeast(count);
  };
  const notThisRoom = (found: FoundFolder) =>
    found.sampleLooked !== null && found.sampleLooked > 0 && found.sampleClaimed === 0;

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
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">
                          <span className={styles.srOnly}>{d.folder}</span>
                        </th>
                        <th scope="col">{d.room}</th>
                        <th scope="col">{d.folder}</th>
                        <th scope="col" className={styles.number}>
                          {d.files}
                        </th>
                        <th scope="col">{d.lastHand}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.path}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={d.watch(row.path)}
                              checked={row.checked || Boolean(row.found?.watched)}
                              disabled={Boolean(row.found?.watched) || phase === "adding"}
                              onChange={(event) => toggle(row.path, event.target.checked)}
                            />
                          </td>
                          <td>
                            {row.found ? row.found.name : d.manual}
                            {row.found?.watched && <span className={styles.note}>{d.watched}</span>}
                          </td>
                          <td className={styles.mono}>
                            {row.path}
                            {row.found && !row.found.verified && (
                              <span className={styles.note}>{d.unverified}</span>
                            )}
                            {row.found && notThisRoom(row.found) && (
                              <span className={styles.warning}>{d.notThisRoom}</span>
                            )}
                          </td>
                          <td className={styles.number}>{row.found ? files(row.found) : d.unknown}</td>
                          <td>
                            {row.found?.newestMs != null
                              ? day.format(row.found.newestMs)
                              : row.found?.files === 0
                                ? d.noFiles
                                : d.unknown}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                <fieldset className={styles.choices} disabled={phase === "adding"}>
                  <legend>{d.existingHeading}</legend>
                  <label className={styles.choice}>
                    <input type="radio" name="existing" checked={!onlyNew} onChange={() => setOnlyNew(false)} />
                    <span>
                      {d.importAll}
                      <br />
                      <span className={styles.hint}>{d.importAllHint}</span>
                    </span>
                  </label>
                  <label className={styles.choice}>
                    <input type="radio" name="existing" checked={onlyNew} onChange={() => setOnlyNew(true)} />
                    <span>
                      {d.onlyNew}
                      <br />
                      <span className={styles.hint}>{d.onlyNewHint}</span>
                    </span>
                  </label>
                </fieldset>
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
