import { Suspense, lazy, useEffect } from "react";
import "./App.css";
import { navigate, useRoute } from "./routes/navigation";
import { toAppPath } from "./routes/routes";

/**
 * Both branches are code-split: a stranger opening `/h/:slug` should never
 * download the converter, and the app should not download the share landing
 * page. `/h/:slug` is the growth surface, so its payload is kept small.
 */
const AppPage = lazy(() => import("./routes/AppPage"));
const SharedHandPage = lazy(() => import("./routes/SharedHandPageRoute"));

function RouteFallback() {
  return <div className="route-fallback" aria-busy="true" />;
}

function App() {
  const route = useRoute();

  // Canonicalise aliases and trailing slashes without adding a history entry.
  useEffect(() => {
    const current = toAppPath(window.location.pathname);
    if (route.name !== "not-found" && current !== route.pathname) {
      navigate(`${route.pathname}${window.location.search}`, { replace: true });
    }
  }, [route]);

  return (
    <Suspense fallback={<RouteFallback />}>
      {route.name === "shared-hand" ? (
        <SharedHandPage slug={route.params.slug ?? ""} />
      ) : (
        <AppPage route={route} />
      )}
    </Suspense>
  );
}

export default App;
