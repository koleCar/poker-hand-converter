import { Link } from "./router";
import { paths } from "./routes";

/** Rendered inside the app shell; `AppPage` owns the document meta for it. */
export function NotFoundPage() {
  return (
    <section className="shell__notfound">
      <span className="shell__notfound-mark" aria-hidden="true">
        ♠
      </span>
      <h1>Page not found</h1>
      <p>That address does not match anything in PokerConverter.</p>
      <div className="shell__notfound-actions">
        <Link to={paths.converter()} className="btn btn--primary">
          Go to the converter
        </Link>
        <Link to={paths.replayer()} className="btn btn--ghost">
          Open the replayer
        </Link>
      </div>
    </section>
  );
}
