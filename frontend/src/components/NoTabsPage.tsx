import type { JSX } from "react";
import { chordToAria } from "../commands/chord";
import type { CommandId } from "../commands/registry";
import { selectBinding } from "../stores/commands";
import { useAppActions, useCommandActions, useCommands } from "../stores/react";
import RadioCrateLogo from "./RadioCrateLogo";
import { Kbd } from "./ui/Kbd";

/** A way to get started, beside the shortcut that does the same. The shortcut
 * wraps under the label where the page is too narrow for both on one line. */
function StartButton(props: {
  label: string;
  command: CommandId;
  onClick: () => void;
}): JSX.Element {
  const chord = useCommands((s) => selectBinding(s, props.command));
  return (
    <button
      type="button"
      aria-keyshortcuts={chord ? chordToAria(chord) : undefined}
      className="control text-ink border-edge hover:bg-hover flex flex-wrap items-center justify-between gap-x-6 gap-y-1 rounded-md px-3"
      onClick={props.onClick}
    >
      {props.label}
      {chord && (
        <span aria-hidden="true" className="text-ink-weak">
          <Kbd chord={chord} />
        </span>
      )}
    </button>
  );
}

/** The content area with no tab open: the logo, and the ways to open one. */
export default function NoTabsPage(): JSX.Element {
  const { newQueryTab } = useAppActions();
  const { togglePalette } = useCommandActions();
  return (
    <div className="bg-panel flex min-h-0 flex-1 overflow-y-auto p-4">
      {/* Centered by its margins, so a short viewport scrolls to the top of it
          rather than cutting it off. */}
      <div className="m-auto flex w-full max-w-72 flex-col items-center gap-6">
        <RadioCrateLogo className="text-edge h-auto w-full max-w-32" />
        <div className="flex w-full flex-col gap-2">
          <StartButton
            label="New Query"
            command="query.new"
            onClick={() => newQueryTab()}
          />
          <StartButton
            label="Command Palette"
            command="palette.open"
            onClick={() => togglePalette()}
          />
        </div>
      </div>
    </div>
  );
}
