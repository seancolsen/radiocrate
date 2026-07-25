import { createEffect, For, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { useCommands } from "../state/commands";
import { chordMatchesEvent, formatChord } from "../commands/chord";
import type { CommandDef } from "../commands/registry";

// The command palette — a VS Code-style overlay for finding and running
// commands by name, showing each command's keyboard shortcut and listing
// recently-used commands first.
//
// While it's open the global shortcut pass stands down (see
// `commands.tsx:suppressed`), so the palette handles its own arrow/enter/escape
// navigation and consumes the open shortcut to toggle itself closed.

/** Distance from the top of the viewport to the palette. */
const TOP_OFFSET = 72;

/** One palette row: the command title on the left, its bound shortcut (if any)
 * right-aligned in weak text. */
function PaletteRow(props: {
  def: CommandDef;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
  ref: (el: HTMLDivElement) => void;
}): JSX.Element {
  const commands = useCommands();
  const chord = () => commands.binding(props.def.id);
  return (
    <div
      ref={(el) => props.ref(el)}
      role="option"
      aria-selected={props.selected}
      class="flex h-[30px] cursor-pointer items-center gap-3 rounded px-2.5"
      classList={{
        "bg-hover": props.selected,
        "hover:bg-hover/50": !props.selected,
      }}
      // Pointer *movement* re-homes the highlight, so a mouse resting over a
      // row can't fight the arrow keys.
      onMouseMove={() => props.onHover()}
      onClick={() => props.onSelect()}
    >
      <span class="text-ink min-w-0 flex-1 truncate text-[13px]">
        {props.def.title}
      </span>
      <Show when={chord()}>
        {(c) => (
          <span class="text-ink-weak shrink-0 text-xs whitespace-nowrap">
            {formatChord(c())}
          </span>
        )}
      </Show>
    </div>
  );
}

/** The palette dialog itself. A separate component so it's *created* on every
 * open — that's what gives the search field focus each time. */
function PaletteDialog(): JSX.Element {
  const commands = useCommands();
  let input: HTMLInputElement | undefined;
  const rows: HTMLDivElement[] = [];

  onMount(() => input?.focus());

  // Keep the highlighted row in view for keyboard navigation.
  createEffect(() => {
    const index = commands.paletteIndex();
    // Read the list too, so a re-rank (a new query) re-scrolls to its top.
    commands.paletteItems();
    rows[index]?.scrollIntoView({ block: "nearest" });
  });

  const choose = (def: CommandDef) => {
    // Close first: a command that opens another overlay — or the palette
    // itself, via `palette.open` — must not have it torn straight back down.
    commands.closePalette();
    commands.run(def.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The open shortcut toggles the palette closed while it's up.
    const open = commands.binding("palette.open");
    if (open && chordMatchesEvent(open, e)) {
      e.preventDefault();
      commands.closePalette();
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        commands.closePalette();
        break;
      case "ArrowDown":
        e.preventDefault();
        commands.movePaletteIndex(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        commands.movePaletteIndex(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const def = commands.paletteItems()[commands.paletteIndex()];
        if (def) choose(def);
        break;
      }
    }
  };

  return (
    <div
      class="fixed inset-0 z-[110] flex items-start justify-center px-6"
      style={{ "padding-top": `${TOP_OFFSET}px` }}
      onKeyDown={onKeyDown}
    >
      <div
        class="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => commands.closePalette()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        class="bg-panel border-edge relative z-10 flex w-[520px] max-w-full flex-col rounded-lg border p-2 shadow-2xl"
      >
        <input
          ref={(el) => (input = el)}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          placeholder="Type a command name…"
          class="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
          value={commands.paletteQuery()}
          onInput={(e) => commands.setPaletteQuery(e.currentTarget.value)}
        />
        <Show
          when={commands.paletteItems().length > 0}
          fallback={
            <div class="text-ink-weak px-2.5 py-3 text-[13px]">
              No matching commands
            </div>
          }
        >
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            class="mt-1.5 max-h-[320px] overflow-x-hidden overflow-y-auto"
          >
            <For each={commands.paletteItems()}>
              {(def, i) => (
                <PaletteRow
                  def={def}
                  selected={i() === commands.paletteIndex()}
                  onSelect={() => choose(def)}
                  onHover={() => commands.setPaletteIndex(i())}
                  ref={(el) => (rows[i()] = el)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Mounts the palette overlay while it's open. */
export default function CommandPalette(): JSX.Element {
  const commands = useCommands();
  return (
    <Show when={commands.paletteOpen()}>
      <Portal>
        <PaletteDialog />
      </Portal>
    </Show>
  );
}
