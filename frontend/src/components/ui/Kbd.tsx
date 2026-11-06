import { Fragment, type JSX } from "react";
import { chordKeys, isMac, type Chord } from "../../commands/chord";
import { cx } from "./cx";

/** A keyboard shortcut, drawn as keycaps: `⇧` `⌘` `P` on macOS, `Ctrl`+`Shift`+`P`
 * elsewhere. The `+` between the caps off-Mac keeps the text the same as
 * `formatChord`'s, so the chord reads (and is found) as `Ctrl+Shift+P`.
 *
 * The caps take their text color from around them; `className` tints them
 * (the shortcuts editor's accent for an overridden binding). */
export function Kbd(props: { chord: Chord; className?: string }): JSX.Element {
  const mac = isMac();
  return (
    <kbd
      className={cx(
        "inline-flex items-center gap-0.5 font-sans whitespace-nowrap",
        props.className,
      )}
    >
      {chordKeys(props.chord, mac).map((key, i) => (
        <Fragment key={key}>
          {i > 0 && !mac && <span className="text-[11px] opacity-60">+</span>}
          <kbd className="border-edge bg-panel inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[3px] border border-b-2 px-1 font-sans text-[11px] leading-none">
            {key}
          </kbd>
        </Fragment>
      ))}
    </kbd>
  );
}
