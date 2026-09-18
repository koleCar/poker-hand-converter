import {
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { NAV_EVENT, RouteContext, navigate, readLocation, type AppLocation } from "./navigation";
import { matchRoute, toHref } from "./routes";

/**
 * A History API router in ~60 lines.
 *
 * Deliberately not `react-router`: the app has three routes, and `/h/:slug` is
 * a public landing page where every kilobyte of router runtime is paid for by a
 * stranger on a phone. Everything needed is here — match, navigate, link,
 * back/forward — and the matcher lives in `routes.ts`.
 *
 * Non-component exports (`navigate`, `useRoute`) live in `./navigation`.
 */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<AppLocation>(readLocation);

  useEffect(() => {
    const sync = () => setLocation(readLocation());
    window.addEventListener("popstate", sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);

  const match = useMemo(
    () => matchRoute(location.pathname, location.search),
    [location.pathname, location.search],
  );

  return <RouteContext.Provider value={match}>{children}</RouteContext.Provider>;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  replace?: boolean;
};

/** Anchor that keeps real `href` semantics (middle-click, copy link) but routes in-app. */
export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (rest.target && rest.target !== "_self")
    ) {
      return;
    }
    event.preventDefault();
    navigate(to, { replace });
  }

  return (
    <a href={toHref(to)} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
