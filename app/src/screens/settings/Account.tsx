import { AccountPanel } from "../../components/AccountPanel";
import { SyncPanel } from "../../components/SyncPanel";
import { useT } from "../../i18n";
import { useAccount } from "../../lib/useAccount";
import { useSync } from "../../lib/useSync";
import styles from "./Settings.module.css";

/** Settings, Account (R1.7): who is signed in, sign in or out; and sync
 * with the web under it (R1.9). */
export function Account() {
  const t = useT();
  const { account, error, busy, run } = useAccount();
  const sync = useSync();
  return (
    <section className={styles.section} aria-labelledby="settings-account">
      <h2 id="settings-account" className={styles.heading}>
        {t.account.heading}
      </h2>
      <AccountPanel account={account} error={error} busy={busy} run={run} />
      {account !== null && account.state !== "notConfigured" && (
        <>
          <h3 id="settings-sync" className={styles.subheading}>
            {t.sync.heading}
          </h3>
          <SyncPanel sync={sync.sync} error={sync.error} busy={sync.busy} run={sync.run} />
        </>
      )}
    </section>
  );
}
