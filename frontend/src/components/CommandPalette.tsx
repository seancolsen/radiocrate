import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { chordMatchesEvent, formatChord } from "../commands/chord";
import { rankCommands } from "../commands/rank";
import type { CommandContext, CommandDef } from "../commands/registry";
import { selectAvailableCommands, selectBinding } from "../stores/commands";
import { selectQueryTab, selectResultCount } from "../stores/app";
import { selectFocusedForm } from "../stores/forms";
import {
  useApp,
  useCommandActions,
  useCommands,
  useForms,
} from "../stores/react";
import { cx } from "./ui/cx";

// The command palette — a VS Code-style overlay for finding and running
// commands by name, showing each command's keyboard shortcut and listing
// recently-used commands first.
//
// Ported from `components/CommandPalette.tsx`. While it's open the global
// shortcut pass stands down (see `stores/commands.ts`'s `suppressed`), so the
// palette handles its own arrow/enter/escape navigation and consumes the open
// shortcut to toggle itself closed.

/** Distance from the top of the viewport to the palette. */
const TOP_OFFSET = 72;

/** One palette row: the command title on the left, its bound shortcut (if any)
 * right-aligned in weak text. The ref forwards to the row `<div>`, so the
 * dialog can scroll the highlighted one into view. */
const PaletteRow = forwardRef<
  HTMLDivElement,
  {
    def: CommandDef;
    selected: boolean;
    onSelect: () => void;
    onHover: () => void;
  }
>(function PaletteRow(props, ref) {
  const chord = useCommands((s) => selectBinding(s, props.def.id));
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={props.selected}
      className={cx(
        "flex h-[30px] cursor-pointer items-center gap-3 rounded px-2.5",
        {
          "bg-hover": props.selected,
          "hover:bg-hover/50": !props.selected,
        },
      )}
      // Pointer *movement* re-homes the highlight, so a mouse resting over a
      // row can't fight the arrow keys.
      onMouseMove={() => props.onHover()}
      onClick={() => props.onSelect()}
    >
      <span className="text-ink min-w-0 flex-1 truncate text-[13px]">
        {props.def.title}
      </span>
      {chord && (
        <span className="text-ink-weak shrink-0 text-xs whitespace-nowrap">
          {formatChord(chord)}
        </span>
      )}
    </div>
  );
});

/** The palette dialog itself. A separate component so it's *created* on every
 * open — that's what gives the search field focus each time. */
function PaletteDialog(): JSX.Element {
  const actions = useCommandActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);

  // The `When` predicates' inputs, assembled from narrow subscriptions on the
  // app and forms stores — same shape as `selectCommandContext(app, forms)`,
  // but fed by per-field selectors so an unrelated store write doesn't
  // re-rank the list (state management rule 2).
  const activeTabId = useApp((s) => s.activeTabId);
  const queryTabActive = useApp(
    (s) =>
      s.activeTabId !== null && selectQueryTab(s, s.activeTabId) !== undefined,
  );
  const resultsAvailable = useApp(
    (s) =>
      s.activeTabId !== null && (selectResultCount(s, s.activeTabId) ?? 0) > 0,
  );
  const trackLoaded = useApp((s) => s.currentTrack !== null);
  const recordFormFocused = useForms((s) => selectFocusedForm(s) !== undefined);
  const context = useMemo<CommandContext>(
    () => ({
      activeTab: activeTabId !== null,
      queryTabActive,
      resultsAvailable,
      trackLoaded,
      recordFormFocused,
    }),
    [
      activeTabId,
      queryTabActive,
      resultsAvailable,
      trackLoaded,
      recordFormFocused,
    ],
  );

  const paletteQuery = useCommands((s) => s.paletteQuery);
  const mru = useCommands((s) => s.mru);
  const openChord = useCommands((s) => selectBinding(s, "palette.open"));
  const available = useMemo(() => selectAvailableCommands(context), [context]);
  const paletteItems = useMemo(
    () => rankCommands(paletteQuery, available, mru),
    [paletteQuery, available, mru],
  );
  const paletteIndexRaw = useCommands((s) => s.paletteIndex);
  const paletteIndex =
    paletteItems.length === 0
      ? 0
      : Math.min(paletteIndexRaw, paletteItems.length - 1);

  useLayoutEffect(() => inputRef.current?.focus(), []);

  // Keep the highlighted row in view for keyboard navigation. Re-runs on a
  // re-rank too (a new query), which re-scrolls to the new top match.
  useEffect(() => {
    rowsRef.current[paletteIndex]?.scrollIntoView({ block: "nearest" });
  }, [paletteIndex, paletteItems]);

  const choose = (def: CommandDef) => {
    // Close first: a command that opens another overlay — or the palette
    // itself, via `palette.open` — must not have it torn straight back down.
    actions.closePalette();
    actions.run(def.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The open shortcut toggles the palette closed while it's up.
    if (openChord && chordMatchesEvent(openChord, e.nativeEvent)) {
      e.preventDefault();
      actions.closePalette();
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        actions.closePalette();
        break;
      case "ArrowDown":
        e.preventDefault();
        actions.movePaletteIndex(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        actions.movePaletteIndex(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const def = paletteItems[paletteIndex];
        if (def) choose(def);
        break;
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center px-6"
      style={{ paddingTop: `${TOP_OFFSET}px` }}
      onKeyDown={onKeyDown}
    >
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => actions.closePalette()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="bg-panel border-edge relative z-10 flex w-[520px] max-w-full flex-col rounded-lg border p-2 shadow-2xl"
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          placeholder="Type a command name…"
          className="bg-panel border-edge text-ink placeholder:text-ink-weak focus:border-accent w-full rounded-md border px-2.5 py-1.5 text-sm outline-none"
          value={paletteQuery}
          onChange={(e) => actions.setPaletteQuery(e.currentTarget.value)}
        />
        {paletteItems.length > 0 ? (
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Commands"
            className="mt-1.5 max-h-[320px] overflow-x-hidden overflow-y-auto"
          >
            {paletteItems.map((def, i) => (
              <PaletteRow
                key={def.id}
                ref={(el) => {
                  rowsRef.current[i] = el;
                }}
                def={def}
                selected={i === paletteIndex}
                onSelect={() => choose(def)}
                onHover={() => actions.setPaletteIndex(i)}
              />
            ))}
          </div>
        ) : (
          <div className="text-ink-weak px-2.5 py-3 text-[13px]">
            No matching commands
          </div>
        )}
      </div>
    </div>
  );
}

/** Mounts the palette overlay while it's open. */
export default function CommandPalette(): JSX.Element | null {
  const paletteOpen = useCommands((s) => s.paletteOpen);
  if (!paletteOpen) return null;
  return createPortal(<PaletteDialog />, document.body);
}
