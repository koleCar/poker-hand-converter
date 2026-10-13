import { AccountPanel } from "../../components/AccountPanel";
import { useT } from "../../i18n";
import { useAccount } from "../../lib/useAccount";
import styles from "./Settings.module.css";

/** Settings, Account (R1.7): who is signed in, sign in or out. */
export function Account() {
  const t = useT();
  const { account, error, busy, run } = useAccount();
  return (
    <section className={styles.section} aria-labelledby="settings-account">
      <h2 id="settings-account" className={styles.heading}>
        {t.account.heading}
      </h2>
      <AccountPanel account={account} error={error} busy={busy} run={run} />
    </section>
  );
}
