/**
 * What happened to the hands we could not convert.
 *
 * This is a product feature, not an error list. A hand we cannot read is the
 * raw material for the next parser, so it gets stored on purpose and the user
 * is told so in plain words. The tone matters: "we know what this is, we kept
 * it, support is coming, and here is your copy of it" reads very differently
 * from a red box with a stack trace in it.
 *
 * Failures are grouped by site and reason rather than listed flat, because a
 * 6 000-hand upload can produce 179 of them and a flat list of 179 identical
 * sentences tells the user nothing.
 */

import { useState } from "react";
import type { ConversionFailure } from "../../lib/phf";
import { FAILURE_REASON_COPY, FAILURE_STAGE_COPY } from "./handSummary";
import { copyToClipboard, downloadText } from "./handoff";
import { formatCount } from "./inputs";

export interface FailureGroup {
  key: string;
  site: string | null;
  stage: ConversionFailure["stage"];
  reason: string;
  message: string;
  failures: ConversionFailure[];
}

/** Buckets failures by site and reason, biggest bucket first. */
export function groupFailures(failures: ConversionFailure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const failure of failures) {
    const key = `${failure.detectedSite ?? "-"}::${failure.stage}::${failure.reason}`;
    const existing = groups.get(key);
    if (existing) {
      existing.failures.push(failure);
      continue;
    }
    groups.set(key, {
      key,
      site: failure.detectedSite,
      stage: failure.stage,
      reason: failure.reason,
      message: failure.message,
      failures: [failure],
    });
  }
  return [...groups.values()].sort((a, b) => b.failures.length - a.failures.length);
}

/** How many raw samples one group is worth reading before it repeats itself. */
const SAMPLE_LIMIT = 3;

/**
 * What we did with the samples, in a sentence.
 *
 * Re-uploading the same unsupported file is the common case — people try again
 * after an update — so "0 new samples" has to read as the non-event it is
 * rather than as a failure.
 */
function keptCopy(created: number, updated: number): string {
  const plural = (n: number) => (n === 1 ? "hand" : "hands");
  if (created > 0 && updated > 0) {
    return `We kept ${formatCount(created)} new ${plural(created)} and already had ${formatCount(updated)}. They are the queue we write the next converters from.`;
  }
  if (created > 0) {
    return `We kept ${formatCount(created)} new ${plural(created)}. They are the queue we write the next converters from.`;
  }
  if (updated > 0) {
    return `We already had ${updated === 1 ? "this one" : `all ${formatCount(updated)} of these`} — your upload moved ${updated === 1 ? "it" : "them"} up the queue.`;
  }
  return "We could not keep a copy of these, so download them if you want us to see them.";
}

interface FailurePanelProps {
  failures: ConversionFailure[];
  /** Display name for a registry site id. */
  siteLabel(siteId: string | null): string;
  /** null while the save is still running, otherwise how many we stored. */
  recorded: { created: number; updated: number } | null;
  /**
   * Why nothing was kept, when nothing was kept. `"no-database"` is a property
   * of the build; `"saving-off"` is the user's own choice. Telling someone
   * "this build has no database" when they simply flipped the switch is the
   * kind of small lie that makes the rest of the page less believable.
   */
  notKept: "no-database" | "saving-off" | null;
}

export function FailurePanel({ failures, siteLabel, recorded, notKept }: FailurePanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const groups = groupFailures(failures);

  if (groups.length === 0) {
    return null;
  }

  async function copyGroup(group: FailureGroup) {
    const ok = await copyToClipboard(group.failures.slice(0, SAMPLE_LIMIT).map((f) => f.rawText).join("\n\n"));
    setCopied(ok ? group.key : null);
    setTimeout(() => setCopied(null), 2000);
  }

  function downloadGroup(group: FailureGroup) {
    const name = `unconverted - ${siteLabel(group.site)} - ${group.reason}.txt`.replace(/[\\/:*?"<>|]/g, "-");
    downloadText(name, group.failures.map((f) => f.rawText).join("\n\n"));
  }

  return (
    <section className="card conv-failures">
      <header className="card__head">
        <div>
          <h3>{formatCount(failures.length)} hands we could not convert yet</h3>
          <p className="muted">
            {notKept === "no-database"
              ? "Nothing left your browser — this build has no database. Download them below if you want us to see them."
              : notKept === "saving-off"
                ? "Nothing left your browser, because saving is switched off. Turn it on, or download them below, if you want us to add your site."
                : recorded === null
                  ? "Keeping a copy so we can build a converter for them…"
                  : keptCopy(recorded.created, recorded.updated)}
          </p>
        </div>
      </header>

      <ul className="conv-failure-list">
        {groups.map((group) => {
          const isOpen = open === group.key;
          const samples = group.failures.slice(0, SAMPLE_LIMIT);
          return (
            <li key={group.key} className="conv-failure">
              <div className="conv-failure__head">
                <div className="conv-failure__title">
                  <span className="conv-failure__count">{formatCount(group.failures.length)}</span>
                  <div>
                    <strong>{siteLabel(group.site)}</strong>
                    <span className="conv-failure__stage">
                      {FAILURE_STAGE_COPY[group.stage] ?? group.stage}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : group.key)}
                >
                  {isOpen ? "Hide hand" : "Show hand"}
                </button>
              </div>

              <p className="conv-failure__why">
                {FAILURE_REASON_COPY[group.reason] ?? group.message}
              </p>

              <div className="conv-failure__actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyGroup(group)}>
                  {copied === group.key ? "Copied" : "Copy sample"}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => downloadGroup(group)}>
                  Download {formatCount(group.failures.length)}
                </button>
                <code className="conv-failure__code">{group.reason}</code>
              </div>

              {isOpen ? (
                <div className="conv-failure__samples">
                  {samples.map((failure, index) => (
                    <pre key={failure.fingerprint + index} className="conv-pre">
                      {failure.rawText.slice(0, 4000)}
                    </pre>
                  ))}
                  {group.failures.length > samples.length ? (
                    <p className="muted conv-failure__more">
                      {formatCount(group.failures.length - samples.length)} more like this — download the group
                      to see them all.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
