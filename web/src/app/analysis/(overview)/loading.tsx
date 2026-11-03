import { RouteLoading } from "../../../components/shell/RouteLoading";

/**
 * The Analysis list's wait. In a route group (`/analysis` unchanged) so the
 * boundary wraps the list alone, not `/analysis/h/…` or the concept pages,
 * which must still answer 404 for an unknown address (`RouteLoading`).
 */
export default function Loading() {
  return <RouteLoading />;
}
