"use client";

/**
 * A notice the reader can close: an error, warning or note above a chart, a
 * table or a form, with an × in its top-right corner.
 *
 * It renders the element it replaces (`<p>` unless `as` says otherwise) with
 * the same class and attributes, so the surface's own look stays: the only
 * addition is the close button, floated right as the first child (it sits on
 * the first line in a block notice and, through `order`, last in a flex or
 * grid one). A grid notice that wants it in the corner places
 * `[data-notice-close]` itself (the trainer's `.notice`).
 *
 * Closing hides that message, not the slot: when the words change (a new
 * error, a different warning) the notice shows again, and so does one that
 * goes away and comes back. Nothing is remembered across a remount.
 */

import { Children, createElement, isValidElement, useState, type HTMLAttributes, type ReactNode } from "react";
import { Icon } from "../icon/Icon";
import { useOptionalUiStrings } from "../i18n";
import styles from "./Dismissible.module.css";

export interface DismissibleProps extends HTMLAttributes<HTMLElement> {
  /** The element the notice was before it could be closed. */
  as?: "p" | "div" | "span";
  /**
   * What counts as the same message, for a notice whose words change while it
   * stays the same notice (a progress count): closed, it stays closed until
   * the key changes. Without it, the words are the key.
   */
  messageKey?: string;
  children?: ReactNode;
}

/** The words a node shows, for telling one message from the next. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return Children.toArray(node.props.children).map(textOf).join("");
  }
  return "";
}

export function Dismissible({ as = "p", className, messageKey, children, ...rest }: DismissibleProps) {
  const strings = useOptionalUiStrings();
  const message = `${className ?? ""}\u0000${messageKey ?? textOf(children)}`;
  const [closed, setClosed] = useState<string | null>(null);
  // Another message took this one's place: forget the close, so that if the
  // first comes back it shows again.
  if (closed !== null && closed !== message) setClosed(null);
  if (closed === message) return null;

  return createElement(
    as,
    { ...rest, className },
    <button
      type="button"
      className={styles.close}
      data-notice-close=""
      aria-label={strings?.dismissNotice}
      title={strings?.dismissNotice}
      onClick={() => setClosed(message)}
    >
      <Icon name="close" className={styles.icon} />
    </button>,
    children,
  );
}
