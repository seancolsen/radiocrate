import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import Pager from "../ui/Pager";
import LoadingRegion from "../ui/LoadingRegion";
import { MENU_PANEL_CLASS } from "../ui/Menu";
import { cx } from "../ui/cx";
import { placeDropdown } from "../ui/menuGeometry";
import { useResizeObserver } from "../ui/useElementWidth";
import { usePlacement } from "../ui/useMenu";
import {
  movePage,
  moveHighlight,
  START_CURSOR,
  SUGGESTIONS_PER_PAGE,
  type SuggestionCursor,
  type ValueSuggestion,
} from "../../query/valueSuggestions";

// A value's autocomplete: the list that hangs off its text box while it's in
// autocomplete mode. The box keeps focus throughout, so that typing goes on
// searching: the keyboard reaches the list through the box's own key handler,
// and pressing on the list never moves focus. (Focus leaving the box is what
// ends an edit.)

/** How long typing settles before the search runs, as in the record picker. */
const DEBOUNCE_MS = 180;

/** What a text box needs to offer its value autocomplete. A box with nothing to
 * offer is given none of this. */
export interface ValueAutocomplete {
  /** Whether autocomplete mode is on. */
  active: boolean;
  toggle: () => void;
  close: () => void;
  /** The values the column holds that match what's typed. */
  search: (text: string) => Promise<readonly ValueSuggestion[]>;
}

/** The answer to one search. */
interface Results {
  search: string;
  values: readonly ValueSuggestion[];
  failed: boolean;
}

/** The list's state: what's been found for `text`, and where the user is in it,
 * from when autocomplete mode comes on until it goes off. */
export function useValueSuggestions(
  autocomplete: ValueAutocomplete | undefined,
  text: string,
) {
  const active = autocomplete?.active === true;
  const [results, setResults] = useState<Results | null>(null);
  const [cursor, setCursor] = useState<SuggestionCursor>(START_CURSOR);

  // Typing makes a new list, so whatever was highlighted is no longer what Enter
  // should take, even for the moment before the new list lands.
  const [seen, setSeen] = useState({ active, text });
  if (seen.active !== active || seen.text !== text) {
    setSeen({ active, text });
    setCursor(START_CURSOR);
    if (!active) setResults(null);
  }

  // The latest search, for the timer to call. Synced from an effect, never
  // written during render.
  const search = useRef(autocomplete?.search);
  useEffect(() => {
    search.current = autocomplete?.search;
  });

  // Coming on, the first search doesn't wait: there's nothing to settle yet.
  const settled = useRef(false);
  useEffect(() => {
    if (!active) {
      settled.current = false;
      return;
    }
    // Only the newest search may write its results: typing outruns the network.
    let stale = false;
    const answer = (values: readonly ValueSuggestion[], failed: boolean) => {
      if (stale) return;
      setResults({ search: text, values, failed });
      setCursor(START_CURSOR);
    };
    const timer = setTimeout(
      () => {
        search.current?.(text).then(
          (values) => answer(values, false),
          (err: unknown) => {
            console.error("value suggestions failed", err);
            answer([], true);
          },
        );
      },
      settled.current ? DEBOUNCE_MS : 0,
    );
    settled.current = true;
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [active, text]);

  const values = results?.values ?? [];
  const highlighted =
    cursor.highlight === null ? undefined : values[cursor.highlight];
  return {
    active,
    values,
    cursor,
    setCursor,
    /** Whether nothing has landed yet, so there's no list to show. */
    pending: results === null,
    /** Whether the list on show is an earlier search's, a newer one being out. */
    stale: results !== null && results.search !== text,
    failed: results?.failed === true,
    /** The value that Enter or Tab takes. */
    highlighted,
    /** A key pressed in the text box, while the list is up. Returns whether the
     * list used it. Enter only has a use for it once something is highlighted:
     * until then, it's still the box's to end the edit with. */
    onKey: (e: KeyboardEvent, pick: (value: string) => void): boolean => {
      if (e.shiftKey) return false;
      const total = values.length;
      switch (e.key) {
        case "ArrowDown":
          setCursor(moveHighlight(cursor, 1, total));
          return true;
        case "ArrowUp":
          setCursor(moveHighlight(cursor, -1, total));
          return true;
        case "PageDown":
          setCursor(movePage(cursor, 1, total));
          return true;
        case "PageUp":
          setCursor(movePage(cursor, -1, total));
          return true;
        case "Enter":
          if (!highlighted) return false;
          pick(highlighted.value);
          return true;
        case "Escape":
          autocomplete?.close();
          return true;
        default:
          return false;
      }
    },
  };
}

export type ValueSuggestionsState = ReturnType<typeof useValueSuggestions>;

/** The id of one row of the list, for the text box to point at. */
export const suggestionId = (listId: string, index: number): string =>
  `${listId}-${index}`;

/** The list itself, hanging off `anchorRef` (the text box, whose width it takes)
 * at the end of the document, where the form's scrolling can't clip it. */
export function ValueSuggestionsPanel(props: {
  anchorRef: RefObject<HTMLElement | null>;
  listId: string;
  suggestions: ValueSuggestionsState;
  onPick: (value: string) => void;
}): JSX.Element {
  const { anchorRef, listId, suggestions, onPick } = props;
  const { values, cursor, setCursor } = suggestions;
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(0);
  useResizeObserver(anchorRef, (el) => setWidth(el.offsetWidth));

  usePlacement(
    panelRef,
    () => anchorRef.current,
    (anchor, size, viewport) =>
      placeDropdown(
        anchor ?? { left: 0, top: 0, right: 0, bottom: 0 },
        size,
        viewport,
        "below",
        "start",
      ),
  );

  const first = cursor.page * SUGGESTIONS_PER_PAGE;
  const rows = values.slice(first, first + SUGGESTIONS_PER_PAGE);

  // A new page starts from its top, unless the highlight is further down it.
  useLayoutEffect(() => {
    listRef.current?.scrollTo(0, 0);
  }, [cursor.page, values]);
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector("[aria-selected=true]")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const message = suggestions.pending
    ? "Loading…"
    : suggestions.failed
      ? "Couldn't load values"
      : values.length === 0
        ? "No matching values"
        : null;

  return createPortal(
    <div
      ref={panelRef}
      className={MENU_PANEL_CLASS}
      style={{ width, minWidth: 200 }}
      // Pressing anywhere in here leaves focus in the text box, and the edit going.
      onMouseDown={(e) => e.preventDefault()}
    >
      {message !== null && (
        <span className="control text-ink-weak italic">{message}</span>
      )}
      <LoadingRegion
        loading={suggestions.stale}
        className="flex min-h-0 flex-col"
      >
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Values"
          className="flex max-h-64 min-h-0 flex-col gap-0.5 overflow-y-auto"
        >
          {rows.map((row, i) => (
            <li
              key={row.value}
              id={suggestionId(listId, first + i)}
              role="option"
              aria-selected={cursor.highlight === first + i}
              className={cx(
                "control flex shrink-0 cursor-default items-center gap-2 rounded",
                cursor.highlight === first + i
                  ? "bg-hover"
                  : "hover:bg-hover/50",
              )}
              onClick={() => onPick(row.value)}
            >
              <span className="text-ink min-w-0 flex-1 truncate">
                {row.value}
              </span>
              <span className="text-ink-weak shrink-0 text-xs tabular-nums">
                {row.count}
              </span>
            </li>
          ))}
        </ul>
      </LoadingRegion>
      <Pager
        page={cursor.page}
        pageSize={SUGGESTIONS_PER_PAGE}
        total={values.length}
        onPage={(page) =>
          setCursor(
            movePage(cursor, page > cursor.page ? 1 : -1, values.length),
          )
        }
      />
    </div>,
    document.body,
  );
}

/** The chevron inside a text box that offers its autocomplete. Set inside the
 * control's own 26px, with its 20px centered. */
export function AutocompleteToggle(props: {
  active: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="absolute top-[3px] right-[3px]">
      <IconButton
        icon={Icons.ExpandOpen}
        label="Autocomplete"
        command="record.autocomplete"
        tooltipAlign="end"
        size="sm"
        tabIndex={-1}
        active={props.active}
        onClick={() => props.onToggle()}
      />
    </div>
  );
}
