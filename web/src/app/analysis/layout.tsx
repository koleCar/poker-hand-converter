import type { ReactNode } from "react";
import styles from "./analysisLayout.module.css";

/**
 * Every Analysis screen sits in one box that is `display: contents`, so the
 * shell's layout is untouched; it exists to carry the phone-width type scale
 * (analysisLayout.module.css) to every screen and the trainer at once.
 */
export default function AnalysisLayout({ children }: { children: ReactNode }) {
  return <div className={styles.root}>{children}</div>;
}
