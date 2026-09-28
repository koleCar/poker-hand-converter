import { RailMark } from "../brand/RailMark";
import { Link } from "../../routes/router";
import { paths } from "../../routes/routes";

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
 */
export function BrandMark({ showTagline = true, className }: BrandMarkProps) {
  return (
    <Link to={paths.converter()} className={`shell__brand ${className ?? ""}`}>
      <RailMark size={32} className="shell__brand-mark" />
      <span className="shell__brand-text">
        <span className="shell__brand-name">
          {/* Split so the `i` can carry the accent tittle. The surrounding letters
              stay plain text, so the word is still selectable and searchable. */}
          ra<span className="shell__brand-i">i</span>l
        </span>
        {showTagline ? (
          <span className="shell__brand-sub">Poker hands, replayed and discussed</span>
        ) : null}
      </span>
    </Link>
  );
}
