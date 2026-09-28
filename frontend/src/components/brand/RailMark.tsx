/**
 * The Rail mark: a poker table seen from above — the rail, and the board on the
 * felt.
 *
 *              ╭─────────────────╮
 *             (       ▬▬▬▬        )
 *              ╰─────────────────╯
 *
 * Why an ellipse and a bar rather than a spade: every poker product on earth
 * uses a spade, a chip, or two cards. This is unmistakably a table once you
 * have seen it in context, abstract enough to work as an avatar and an app icon
 * without reading as a casino ad, and — the part that actually matters — it is
 * one stroked ellipse plus one filled rect, which is what lets it survive 16px.
 *
 * Two earlier drawings were rejected on screen rather than in the abstract, and
 * the reasons are worth keeping because both looked fine as descriptions:
 *
 *   - A stadium outline with the button dot ON the bottom stroke. A filled
 *     circle tangent to a stroke of similar weight fuses with it, and at 100px
 *     the whole mark read as a speech bubble.
 *   - The same stadium with the dot moved inside, at the lower-left seat. That
 *     fixed the fusion and introduced a worse misread: an outlined pill with a
 *     filled dot near one end is an iOS toggle switch, which is a far more
 *     common shape than a poker table.
 *
 * A centred bar avoids both, because the misreads come from an off-centre blob.
 * It is also the better idea: the board is what every posted hand is about, and
 * it sits dead centre on the replayer's felt.
 *
 * Both parts are `currentColor`. That is the whole trick: monochrome is the
 * default state and colour is applied by an ancestor, so the mark inherits into
 * a button, inverts between themes, and prints, without a second drawing
 * existing anywhere.
 */

interface RailMarkProps {
  /** Rendered edge length in px. Drives the small-size geometry swap. */
  size?: number;
  /**
   * Accessible name. Omit it when the mark sits next to the wordmark or any
   * other text naming the product — then it is decorative and gets
   * `aria-hidden` so a screen reader does not announce "Rail" twice.
   */
  title?: string;
  className?: string;
}

/**
 * Below about 20px the 3/32 stroke lands on ~1.5 device pixels and the ellipse
 * greys out, so the small size is not the same drawing scaled — it is drawn
 * heavier, with the ellipse pulled in to keep the fatter stroke inside the box
 * and the board bar thickened so it does not disappear. Nothing is dropped;
 * there is nothing here to drop.
 */
const SMALL_SIZE_LIMIT = 20;

export function RailMark({ size = 24, title, className }: RailMarkProps) {
  const small = size <= SMALL_SIZE_LIMIT;

  const ring = small ? { rx: 13, ry: 7.5 } : { rx: 13.5, ry: 8 };
  const board = small
    ? { x: 11.5, y: 14.25, width: 9, height: 3.5, rx: 1.75 }
    : { x: 11.5, y: 14.5, width: 9, height: 3, rx: 1.5 };

  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={small ? 3.5 : 3}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <ellipse cx="16" cy="16" rx={ring.rx} ry={ring.ry} />
      <rect
        x={board.x}
        y={board.y}
        width={board.width}
        height={board.height}
        rx={board.rx}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
