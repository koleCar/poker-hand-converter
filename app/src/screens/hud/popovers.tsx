/**
 * At the tables' small popovers: a ⋯ menu and an ⓘ that holds the sentences
 * the view does not show (the owner's rule: minimal text, explanations in a
 * tooltip or a menu). Both are a button and the shared `Popover` under it,
 * closed by Escape or a click outside.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Icon } from "@rail/ui/icon/Icon";
import { Popover } from "@rail/ui/hands/Popover";

import styles from "./HudStatusPanel.module.css";

/** A button that opens a popover; `children` get the close function. */
export function PopoverButton({
  label,
  content,
  className,
  title,
  align = "end",
  popoverClassName,
  children,
}: {
  /** The popover's name, and the button's when it shows no words. */
  label: string;
  /** What the button shows. */
  content: ReactNode;
  className: string;
  title?: string;
  align?: "start" | "end";
  popoverClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span ref={anchor} className={styles.anchor}>
      <button
        type="button"
        className={className}
        aria-label={typeof content === "string" ? undefined : label}
        title={title ?? (typeof content === "string" ? undefined : label)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {content}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          label={label}
          onClose={close}
          align={align}
          className={popoverClassName ?? styles.menu}
        >
          {children(close)}
        </Popover>
      ) : null}
    </span>
  );
}

/** ⋯: a room's or the room list's menu. */
export function MoreMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  return (
    <PopoverButton label={label} content={<Icon name="more" />} className={styles.iconButton}>
      {children}
    </PopoverButton>
  );
}

/** ⓘ: the sentences behind a short line. */
export function InfoTip({
  label,
  align = "start",
  children,
}: {
  label: string;
  /** Which edge of the ⓘ the popover lines up with (`end` near the right of the window). */
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <PopoverButton
      label={label}
      content={<Icon name="info" />}
      className={styles.iconButton}
      align={align}
      popoverClassName={styles.info}
    >
      {() => children}
    </PopoverButton>
  );
}
