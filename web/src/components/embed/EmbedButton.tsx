"use client";

/**
 * "Embed" on a published hand (#52): opens the `<iframe>` snippet with a copy
 * button. A disclosure rather than a modal — it is two lines of code, and the
 * reader may want to read it before taking it.
 */

import { useState } from "react";
import { embedCode } from "../../lib/embed";
import { useDict } from "../../lib/i18n/client";
import "../../styles/embed.css";

export function EmbedButton({ src }: { src: string }) {
  const en = useDict();
  const [copied, setCopied] = useState(false);
  const code = embedCode(src);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (insecure context, permissions): the text is on
      // screen and selectable, which is the fallback.
    }
  }

  return (
    <details className="embed-snippet">
      <summary className="btn btn--sm">{en.embed.button}</summary>
      <div className="embed-snippet__body">
        <p className="muted">{en.embed.hint}</p>
        <textarea readOnly value={code} rows={3} onFocus={(event) => event.currentTarget.select()} />
        <div>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void copy()}>
            {copied ? en.embed.copied : en.embed.copy}
          </button>
        </div>
      </div>
    </details>
  );
}
