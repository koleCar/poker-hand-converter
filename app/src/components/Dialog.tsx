import { useEffect, useId, useRef, type ReactNode } from "react";

import styles from "./Dialog.module.css";

/**
 * A modal dialog on the platform's `<dialog>`: focus moves into it and is
 * trapped there, Escape closes it (`onClose`), the page behind is inert.
 * Mount it to open it; unmount it to close it.
 */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: the parent decides (it unmounts the dialog).
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      {children}
    </dialog>
  );
}
