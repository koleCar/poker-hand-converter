import type { Metadata } from "next";
import { DesktopSignInScreen } from "./DesktopSignInScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * `/auth/desktop`: the Rail desktop app signs in through this page
 * (docs/RAIL-PLAN.md R1.7, amendment A6). The app opens it in the system
 * browser; the user signs in here as usual (Turnstile, password managers and
 * Google all work in a browser, not in the app), confirms, and the page hands
 * the app an encrypted one-time sign-in through a `rail://` link.
 *
 * Client-rendered: everything on it is this browser's session and this tab's
 * request, and nothing about it is worth indexing.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.desktop.metaTitle,
    description: en.desktop.metaDescription,
    alternates: { canonical: paths.desktopSignIn() },
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default function DesktopSignInPage() {
  return <DesktopSignInScreen />;
}
