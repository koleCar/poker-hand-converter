import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/shell.css";
import "./styles/share.css";
import "./styles/auth.css";
import App from "./App.tsx";
import { AuthProvider } from "./lib/auth";
import { RouterProvider } from "./routes/router";

// AuthProvider sits above the router rather than inside a route: the session is
// the same on every screen, and re-subscribing to `onAuthStateChange` on each
// navigation would drop and recreate the listener for no reason.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
