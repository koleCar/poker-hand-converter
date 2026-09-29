"use client";

import Link from "next/link";
import { RailMark } from "../brand/RailMark";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";

interface BrandMarkProps {
  /** The tagline is dropped on the slim share-page header. */
  showTagline?: boolean;
  className?: string;
}

/**
 * The lockup: mark plus wordmark.
 *
 * The wordmark is lowercase, and the tittle of the `i` is redrawn as its own
 * element so it can carry the accent colour and a size the typeface would not
 * give it. It is the one spot of accent in the word, which is what keeps the
 * lockup from being a plain bold noun sitting next to a shape.
 *
 * It points at `/` — which since #27 is the feed, not the converter. That is
 * the intended change: a logo goes home, and home is now a different screen.
 */
export function BrandMark({ showTagline = true, className }: BrandMarkProps) {
  return (
    <Link href={paths.home()} className={`shell__brand ${className ?? ""}`}>
      <RailMark size={32} className="shell__brand-mark" />
      <span className="shell__brand-text">
        <span className="shell__brand-name">
          {/* Split so the `i` can carry the accent tittle. The surrounding letters
              stay plain text, so the word is still selectable and searchable. */}
          ra<span className="shell__brand-i">i</span>l
        </span>
        {showTagline ? <span className="shell__brand-sub">{en.brand.tagline}</span> : null}
      </span>
    </Link>
  );
}
