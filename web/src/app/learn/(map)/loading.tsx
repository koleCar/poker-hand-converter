import { RouteLoading } from "../../../components/shell/RouteLoading";

/**
 * The course map's wait. In a route group (`/learn` unchanged) so the boundary
 * wraps the map alone, not the lessons and reference pages beside it, which
 * must still answer 404 (or 308) for an unknown address (`RouteLoading`).
 */
export default function Loading() {
  return <RouteLoading />;
}
