import { RouteLoading } from "../../components/shell/RouteLoading";

/**
 * The feed's wait. In a route group (`/` unchanged) so the boundary wraps the
 * feed alone: a root `loading.tsx` would wrap every page, and a page under a
 * boundary can no longer answer 404 or 308 (`RouteLoading`).
 */
export default function Loading() {
  return <RouteLoading />;
}
