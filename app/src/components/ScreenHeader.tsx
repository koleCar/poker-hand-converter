import type { ReactNode } from "react";

import styles from "./ScreenHeader.module.css";

/** A screen's title and one-line description. */
export function ScreenHeader({ title, lead }: { title: string; lead: string }) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lead}>{lead}</p>
    </header>
  );
}

/** The empty state of a screen that is not built yet (R2.7). */
export function Placeholder({ children }: { children: ReactNode }) {
  return <div className={styles.placeholder}>{children}</div>;
}
