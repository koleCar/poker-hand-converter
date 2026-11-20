"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeSwitch } from "../account/ThemeSwitch";
import { Icon, type IconName } from "@rail/ui/icon/Icon";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { FeedbackButton } from "./FeedbackButton";
import { LanguageSwitch } from "./LanguageSwitch";
import { NavPending } from "./NavProgress";
import type { ShellTab } from "./AppShell";

/**
 * The phone's navigation (< 900px): a bottom tab bar with up to four screens
 * and "More", which opens a bottom sheet with the rest — the other screens,
 * the language, the theme (the same switch as the user menu's), feedback and the legal links. The top bar keeps
 * only the logo, the bell and the account, so it is one slim row instead of
 * three rows of wrapped tabs.
 *
 * Hidden by CSS from 900px up, where the tabs live in the top bar again.
 */
export interface MobileNavTab {
  id: ShellTab;
  label: string;
  path: string;
}

const ICONS: Record<ShellTab, IconName> = {
  forum: "home",
  convert: "upload",
  library: "cards",
  stats: "barChart",
  analysis: "trend",
  solver: "grid",
  learn: "star",
  // No download on a phone (there is no mobile app): the entry leads to the
  // page that shows what the desktop app does.
  download: "monitor",
};

/** Which screens earn a place in the bar; everything else goes under More. */
const PRIMARY_WITH_HISTORY: readonly ShellTab[] = ["forum", "library", "stats", "analysis"];
const PRIMARY_WITHOUT: readonly ShellTab[] = ["forum", "convert", "solver"];

export function MobileNav({ tabs, active, hasHistory }: { tabs: MobileNavTab[]; active: ShellTab | null; hasHistory: boolean }) {
  const en = useDict();
  const pathname = usePathname();
  const primaryIds = hasHistory ? PRIMARY_WITH_HISTORY : PRIMARY_WITHOUT;
  const primary = tabs.filter((tab) => primaryIds.includes(tab.id));
  const rest = tabs.filter((tab) => !primaryIds.includes(tab.id));
  const sheet = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const moreActive = active !== null && rest.some((tab) => tab.id === active);

  // A tap on a link inside the sheet navigates; the sheet closes with it.
  useEffect(() => {
    sheet.current?.close();
  }, [pathname]);

  function openSheet() {
    sheet.current?.showModal();
  }

  return (
    <>
      <nav className="mnav" aria-label={en.nav.sections}>
        {primary.map((tab) => (
          <Link
            key={tab.id}
            href={tab.path}
            className={`mnav__item${active === tab.id ? " is-active" : ""}`}
            aria-current={active === tab.id ? "page" : undefined}
          >
            <Icon name={ICONS[tab.id]} className="mnav__icon" />
            <span className="mnav__label">{en.nav.short[tab.id] ?? tab.label}</span>
            <NavPending mark={false} />
          </Link>
        ))}
        <button
          type="button"
          className={`mnav__item${moreActive || open ? " is-active" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openSheet}
        >
          <Icon name="more" className="mnav__icon" />
          <span className="mnav__label">{en.nav.more}</span>
        </button>
      </nav>

      <dialog
        ref={sheet}
        className="msheet"
        aria-label={en.nav.menu}
        onClose={() => setOpen(false)}
        onToggle={(event) => setOpen((event.target as HTMLDialogElement).open)}
        onClick={(event) => {
          // A tap on the backdrop (the dialog box itself, outside the panel) closes it.
          if (event.target === event.currentTarget) sheet.current?.close();
        }}
      >
        <div className="msheet__panel">
          <div className="msheet__grip" aria-hidden="true" />
          {rest.length > 0 ? (
            <ul className="msheet__list">
              {rest.map((tab) => (
                <li key={tab.id}>
                  <Link
                    href={tab.path}
                    className={`msheet__row${active === tab.id ? " is-active" : ""}`}
                    aria-current={active === tab.id ? "page" : undefined}
                    onClick={() => sheet.current?.close()}
                  >
                    <Icon name={ICONS[tab.id]} className="msheet__icon" />
                    <span>{tab.id === "download" ? en.nav.desktopApp : tab.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="msheet__settings">
            <div className="msheet__setting">
              <span>{en.language.label}</span>
              <LanguageSwitch />
            </div>
            <div className="msheet__setting">
              <span>{en.account.theme.label}</span>
              <ThemeSwitch classNames={{ group: "langswitch", option: "langswitch__option" }} />
            </div>
          </div>

          <FeedbackButton variant="row" />

          <nav aria-label={en.legal.links.label} className="msheet__legal">
            <Link href={paths.terms()}>{en.legal.links.terms}</Link>
            <Link href={paths.privacy()}>{en.legal.links.privacy}</Link>
            <Link href={paths.takedown()}>{en.legal.links.takedown}</Link>
          </nav>
        </div>
      </dialog>
    </>
  );
}
