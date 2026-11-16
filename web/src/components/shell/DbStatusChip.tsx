"use client";

import { useDict } from "../../lib/i18n/client";

interface DbStatusChipProps {
  configured: boolean;
}

/**
 * The offline state has to stay legible: the converter works without a
 * database, the replayer library and sharing do not. A connected database
 * says nothing — the stored-hand count used to sit here and was dropped from
 * the bar.
 */
export function DbStatusChip({ configured }: DbStatusChipProps) {
  const t = useDict().chrome;
  if (configured) {
    return null;
  }
  return (
    <span className="shell__status shell__status--off" title={t.db.offlineTitle}>
      <span className="shell__status-dot" />
      <span className="shell__status-full">{t.db.offline}</span>
      <span className="shell__status-short">{t.db.offlineShort}</span>
    </span>
  );
}
