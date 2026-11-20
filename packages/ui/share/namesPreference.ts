/**
 * The owner's last answer to "show the players' names on this link?" (R4.5),
 * remembered in this browser / app and applied to the next link made.
 *
 * Every press of Share on a freshly opened hand makes a NEW link, and the
 * link goes straight into the clipboard. With the switch defaulting to off on
 * each new link, an owner who had turned names on for the hand once would
 * paste a link that hid them anyway (found 2026-11-20: a link pasted into
 * Messenger showed Hero/Villain although names had been chosen). Remembering
 * the answer makes the switch mean what the owner thinks it means: "my links
 * show names".
 */

const KEY = "rail.share.showNames";

export function loadShareNamesPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShareNamesPreference(showNames: boolean): void {
  try {
    if (showNames) globalThis.localStorage?.setItem(KEY, "1");
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage off: the switch still applies to the link at hand.
  }
}
