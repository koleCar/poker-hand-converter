"use client";

import type { FeedbackKind, FeedbackStatus } from "../../lib/db/admin";
import { useDict } from "../../lib/i18n/client";
import styles from "./admin.module.css";

const KIND_CLASS: Record<FeedbackKind, string> = {
  bug: styles.kindBug,
  feature: styles.kindFeature,
  question: styles.kindQuestion,
};

const STATUS_CLASS: Record<FeedbackStatus, string> = {
  new: styles.statusNew,
  read: styles.statusRead,
  done: styles.statusDone,
  spam: styles.statusSpam,
};

export function KindBadge({ kind }: { kind: FeedbackKind }) {
  const t = useDict().admin.reports.kind;
  return <span className={`${styles.kind} ${KIND_CLASS[kind]}`}>{t[kind] ?? kind}</span>;
}

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  const t = useDict().admin.reports.status;
  return <span className={`${styles.status} ${STATUS_CLASS[status]}`}>{t[status] ?? status}</span>;
}
