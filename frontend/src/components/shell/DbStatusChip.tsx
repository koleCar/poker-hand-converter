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
  if (!configured) {
    return (
      <span
        className="shell__status shell__status--off"
        title="No database configured. The converter works offline; saved hands and sharing are unavailable."
      >
        <span className="shell__status-dot" />
        <span className="shell__status-full">Offline — no database</span>
        <span className="shell__status-short">Offline</span>
      </span>
    );
  }

  const count = storedCount === null ? null : storedCount.toLocaleString("en-GB");
  return (
    <span className="shell__status shell__status--ok" title="Database connected">
      <span className="shell__status-dot" />
      <span className="shell__status-full">
        {count === null ? "Database connected" : `${count} hands stored`}
      </span>
      <span className="shell__status-short">{count ?? "DB"}</span>
    </span>
  );
}
