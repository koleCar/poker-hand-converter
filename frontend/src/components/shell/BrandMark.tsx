import { Link } from "../../routes/router";
import { paths } from "../../routes/routes";

interface BrandMarkProps {
  /** The tagline is dropped on the slim share-page header. */
  showTagline?: boolean;
  className?: string;
}

export function BrandMark({ showTagline = true, className }: BrandMarkProps) {
  return (
    <Link to={paths.converter()} className={`shell__brand ${className ?? ""}`}>
      <span className="shell__brand-mark" aria-hidden="true">
        ♠
      </span>
      <span className="shell__brand-text">
        <span className="shell__brand-name">PokerConverter</span>
        {showTagline ? (
          <span className="shell__brand-sub">Hand history converter &amp; poker replayer</span>
        ) : null}
      </span>
    </Link>
  );
}
