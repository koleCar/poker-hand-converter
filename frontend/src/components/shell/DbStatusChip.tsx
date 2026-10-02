"use client";

import { useDict } from "../../lib/i18n/client";

interface DbStatusChipProps {
  configured: boolean;
  /** Null while the count is still loading. */
  storedCount: number | null;
}

/**
 * The offline state has to stay legible: the converter works without a
 * database, the replayer library and sharing do not.
 */
export function DbStatusChip({ configured, storedCount }: DbStatusChipProps) {
  const t = useDict().chrome;
  if (!configured) {
    return (
      <span
        className="shell__status shell__status--off"
        title={t.db.offlineTitle}
      >
        <span className="shell__status-dot" />
        <span className="shell__status-full">{t.db.offline}</span>
        <span className="shell__status-short">{t.db.offlineShort}</span>
      </span>
    );
  }

  const count = storedCount === null ? null : storedCount.toLocaleString(t.intl);
  return (
    <span className="shell__status shell__status--ok" title={t.db.connected}>
      <span className="shell__status-dot" />
      <span className="shell__status-full">
        {count === null || storedCount === null ? t.db.connected : t.db.stored(count, storedCount)}
      </span>
      <span className="shell__status-short">{count ?? "DB"}</span>
    </span>
  );
}
