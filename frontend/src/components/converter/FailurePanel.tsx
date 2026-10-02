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
import { useDict, useLocale } from "../../lib/i18n/client";
import { INTL_LOCALE } from "../../lib/i18n/dictionaries";
import type { Dict } from "../../lib/i18n/types";
import type { ConversionFailure } from "../../lib/phf";
import { copyToClipboard, downloadText } from "./handoff";
import { formatCount } from "./inputs";

/**
 * Rooms we will not be adding, and why.
 *
 * "We do not recognise this format yet" promises a converter is coming. For
 * these two that promise is false and the user deserves the real reason
 * instead of waiting for a release that cannot happen: WPT Global withdrew
 * hand-history export entirely in June 2026, and PPPoker has never shipped
 * one. Matched on the raw text because no parser claims these files, so there
 * is no site id to key off. The explanation itself is in the dictionaries
 * (`converter.failures.refusals`), keyed by `id`.
 */
interface KnownRefusal {
  id: keyof Dict["converter"]["failures"]["refusals"];
  label: string;
  signature: RegExp;
}

const KNOWN_REFUSALS: KnownRefusal[] = [
  {
    id: "wpt-global",
    label: "WPT Global",
    signature: /^\s*WPT\s+Global\s+Hand\s+#/im,
  },
  {
    id: "pppoker",
    label: "PPPoker",
    signature: /^\s*PPPoker\s+Hand\s+#/im,
  },
];

function knownRefusal(failure: ConversionFailure): KnownRefusal | null {
  if (failure.detectedSite !== null) {
    return null;
  }
  return KNOWN_REFUSALS.find((entry) => entry.signature.test(failure.rawText)) ?? null;
}

export interface FailureGroup {
  key: string;
  site: string | null;
  stage: ConversionFailure["stage"];
  reason: string;
  message: string;
  failures: ConversionFailure[];
  /** Set when the site is one we have decided not to support. */
  refusal: KnownRefusal | null;
}

/** Buckets failures by site and reason, biggest bucket first. */
export function groupFailures(failures: ConversionFailure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const failure of failures) {
    const refusal = knownRefusal(failure);
    // Refusals bucket on their own, so each gets its own explanation instead
    // of disappearing into one "unknown format" pile.
    const key = `${failure.detectedSite ?? refusal?.id ?? "-"}::${failure.stage}::${failure.reason}`;
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
      refusal,
    });
  }
  return [...groups.values()].sort((a, b) => b.failures.length - a.failures.length);
}

/** How many raw samples one group is worth reading before it repeats itself. */
const SAMPLE_LIMIT = 3;

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
  const t = useDict().converter.failures;
  const locale = INTL_LOCALE[useLocale()];
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const groups = groupFailures(failures);

  if (groups.length === 0) {
    return null;
  }

  // "yet" is a promise. Do not make it when every failure is a room we have
  // already decided against.
  const allRefused = groups.every((group) => group.refusal !== null);

  async function copyGroup(group: FailureGroup) {
    const ok = await copyToClipboard(group.failures.slice(0, SAMPLE_LIMIT).map((f) => f.rawText).join("\n\n"));
    setCopied(ok ? group.key : null);
    setTimeout(() => setCopied(null), 2000);
  }

  function downloadGroup(group: FailureGroup) {
    const name = t.fileName(siteLabel(group.site), group.reason).replace(/[\\/:*?"<>|]/g, "-");
    downloadText(name, group.failures.map((f) => f.rawText).join("\n\n"));
  }

  return (
    <section className="card conv-failures">
      <header className="card__head">
        <div>
          <h3>{t.heading(failures.length, allRefused)}</h3>
          <p className="muted">
            {allRefused
              ? t.downloadForCopy
              : notKept === "no-database"
                ? t.notKeptNoDb
                : notKept === "saving-off"
                  ? t.notKeptSavingOff
                  : recorded === null
                    ? t.keeping
                    : t.kept(recorded.created, recorded.updated)}
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
                  <span className="conv-failure__count">{formatCount(group.failures.length, locale)}</span>
                  <div>
                    <strong>{group.refusal?.label ?? siteLabel(group.site)}</strong>
                    <span className="conv-failure__stage">
                      {group.refusal
                        ? t.notSupported
                        : (t.stages as Record<string, string>)[group.stage] ?? group.stage}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : group.key)}
                >
                  {isOpen ? t.hideHand : t.showHand}
                </button>
              </div>

              <p className="conv-failure__why">
                {group.refusal
                  ? t.refusals[group.refusal.id]
                  : (t.reasons as Record<string, string>)[group.reason] ?? group.message}
              </p>

              <div className="conv-failure__actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyGroup(group)}>
                  {copied === group.key ? t.copied : t.copySample}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => downloadGroup(group)}>
                  {t.downloadCount(group.failures.length)}
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
                      {t.moreLikeThis(group.failures.length - samples.length)}
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
