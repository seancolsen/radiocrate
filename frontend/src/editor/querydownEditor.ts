// The CodeMirror side of the Querydown editors: everything an editor view is
// built from, apart from React. `components/builder/QuerydownEditor.tsx`
// creates the view from these and feeds it its props.
//
// What the editors add to a plain text field:
//
// - Highlighting and completion, from `querydown-codemirror` over the
//   compiler's own `tokenize` and `QuerydownCompleter` (see
//   {@link querydownSupport}). Completion knows the schema's tables and
//   columns, the definitions the text is compiled under, and the column
//   annotations RadioCrate reads (`ANNOTATION_SCHEMA`).
// - The problem underline: a diagnostic (`query/diagnostics.ts`) located in
//   the editor's text is drawn as a wavy underline over its range, with its
//   notes' ranges dotted. An empty range — "unexpected end of input" — has no
//   characters to underline, so it's drawn as a short bar at the position
//   instead.

import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  tooltips,
  type DecorationSet,
} from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import { querydown, type Completer, type Grammar } from "querydown-codemirror";
import { tokenize } from "querydown-js";
import { ANNOTATION_SCHEMA } from "../query/columns";
import type { Section } from "../query/definition";
import type { QueryDiagnostic } from "../query/diagnostics";

/** Draws `diagnostic`'s ranges over the editor's text (`null` clears them).
 * The caller makes sure the diagnostic is about the text the editor holds:
 * its `source` is the document. Once drawn, the marks follow the text as
 * it's edited, until the next diagnostic replaces them. */
export const setDiagnostic = StateEffect.define<QueryDiagnostic | null>();

/** Marks a change that came from outside the editor — the value it's handed
 * changing under it (an undo, a Clear) — which it doesn't report back. */
const external = Annotation.define<boolean>();

/** A mark at a position with no characters to mark. */
class PointMark extends WidgetType {
  constructor(
    readonly className: string,
    readonly title: string,
  ) {
    super();
  }

  eq(other: PointMark): boolean {
    return other.className === this.className && other.title === this.title;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.className;
    el.title = this.title;
    return el;
  }
}

function marksFor(
  diagnostic: QueryDiagnostic | null,
  length: number,
): DecorationSet {
  if (!diagnostic?.range) return Decoration.none;
  const marks: Range<Decoration>[] = [];
  const mark = (
    range: { start: number; end: number },
    className: string,
    title: string,
  ) => {
    const start = Math.min(range.start, length);
    const end = Math.min(Math.max(range.end, start), length);
    marks.push(
      end > start
        ? Decoration.mark({ class: className, attributes: { title } }).range(
            start,
            end,
          )
        : Decoration.widget({
            widget: new PointMark(`${className}-point`, title),
            side: 1,
          }).range(start),
    );
  };
  mark(diagnostic.range, "cm-qd-problem", diagnostic.reason);
  for (const note of diagnostic.notes) {
    mark(note.range, "cm-qd-note", note.message);
  }
  return Decoration.set(marks, true);
}

const diagnosticMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setDiagnostic)) {
        next = marksFor(effect.value, tr.state.doc.length);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** How a Querydown editor looks: the app's field — or, for the prelude, its
 * sheet — over whatever the wrapper around it sets (font, colors, border).
 * Padding comes from the wrapper's `--qd-pad`, so the whole box, padding and
 * all, is the editor's to click in. */
const theme = EditorView.theme({
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": {
    padding: "var(--qd-pad)",
    caretColor: "var(--color-ink)",
  },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--color-ink-weak)" },
  ".cm-qd-problem": {
    textDecoration: "underline wavy var(--color-danger)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
  ".cm-qd-note": {
    textDecoration: "underline dotted var(--color-ink-weak)",
    textUnderlineOffset: "3px",
  },
  ".cm-qd-problem-point, .cm-qd-note-point": { position: "relative" },
  ".cm-qd-problem-point::after, .cm-qd-note-point::after": {
    content: '""',
    position: "absolute",
    left: "0",
    bottom: "-3px",
    width: "0.7ch",
    height: "2px",
  },
  ".cm-qd-problem-point::after": { background: "var(--color-danger)" },
  ".cm-qd-note-point::after": { background: "var(--color-ink-weak)" },
  // The completion popup, and the description beside it, as the app's menus
  // look. They're portaled to the body (see `querydownExtensions`), out from
  // under the editor's font, so they set their own.
  ".cm-tooltip.cm-tooltip-autocomplete, .cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--color-panel)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-edge)",
    borderRadius: "6px",
    boxShadow: "var(--shadow-lg)",
    fontSize: "var(--text-xs)",
    lineHeight: "20px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    padding: "4px",
    maxHeight: "16em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "0 8px 0 4px",
    borderRadius: "4px",
    lineHeight: "20px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--color-hover)",
    color: "var(--color-ink)",
  },
  ".cm-tooltip.cm-completionInfo": {
    fontFamily: "var(--font-sans)",
    padding: "6px 10px",
    maxWidth: "320px",
  },
  ".cm-tooltip-autocomplete .cm-completionIcon": {
    opacity: "1",
    color: "var(--color-ink-weak)",
  },
  ".cm-tooltip-autocomplete .cm-completionDetail": {
    marginLeft: "1em",
    fontStyle: "normal",
    color: "var(--color-ink-weak)",
  },
  ".cm-tooltip-autocomplete .cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "700",
  },
});

/** A sheet editor fills the box it's given, scrolling inside it. `&` alone
 * would also match the tooltip host in the body, which wears the theme's
 * classes: a full-height box over the whole app, eating every click. */
const sheetTheme = EditorView.theme({
  "&.cm-editor": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

/** Turns down any edit that would leave the text on more than one line —
 * what keeps a single-line editor single-line, as an `<input>` is. */
const oneLine = EditorState.transactionFilter.of((tr) =>
  tr.newDoc.lines > 1 ? [] : tr,
);

/** What an editor's text is to the compiler, for highlighting and
 * completing it. */
export interface QuerydownContext {
  /** Which grammar the text is read with: a whole query, or one section of a
   * sectioned one. */
  grammar: Grammar;
  /** For a section: the query's base table, whose columns are offered. */
  baseTable?: string;
  /** The definitions the text is compiled under — the prelude — whose
   * computed columns, functions and constants are offered too. */
  definitions?: string;
}

/** The grammar a builder section's text is read with. */
export function sectionGrammar(section: Section): Grammar {
  return section === "filter"
    ? "conditions"
    : section === "sort"
      ? "sorting"
      : "display";
}

/** A whole query is compiled with the definitions prepended (see
 * `compileWhole`), so it's completed that way too, the completer's offsets
 * shifted back into the editor's text. A section's definitions go to the
 * completer separately, as they do to `compile_sections`. Exported for unit
 * tests. */
export function prepending(
  completer: Completer,
  definitions: () => string | undefined,
): Completer {
  return {
    complete(source, cursor, options) {
      const prelude = definitions();
      const head = prelude ? `${prelude}\n` : "";
      const found = completer.complete(
        head + source,
        cursor + head.length,
        options,
      );
      return {
        ...found,
        from: Math.max(0, found.from - head.length),
        to: Math.max(0, found.to - head.length),
      };
    },
  };
}

/** Querydown's highlighting, and its completion when there's a `completer`
 * (there's none until the schema has loaded). Only once the compiler has
 * loaded: highlighting runs on its `tokenize`. `context` is read each time
 * completion runs, so a base table or prelude that changes needs no
 * reconfiguring. */
export function querydownSupport(
  grammar: Grammar,
  completer: Completer | null,
  context: () => QuerydownContext,
): Extension {
  const baseTable = () => context().baseTable;
  const definitions = () => context().definitions;
  return querydown({
    tokenize,
    grammar,
    ...(completer && {
      completion:
        grammar === "query"
          ? {
              completer: prepending(completer, definitions),
              annotations: ANNOTATION_SCHEMA,
            }
          : {
              completer,
              baseTable,
              definitions,
              annotations: ANNOTATION_SCHEMA,
            },
    }),
  });
}

const DARK_SCHEME = "(prefers-color-scheme: dark)";

/** Whether the document is painted dark: `data-theme` when the user picked a
 * theme, the system's otherwise (see `stores/app/theme.ts`). */
function documentIsDark(doc: Document): boolean {
  const pinned = doc.documentElement.getAttribute("data-theme");
  if (pinned === "light" || pinned === "dark") return pinned === "dark";
  return doc.defaultView?.matchMedia(DARK_SCHEME).matches ?? false;
}

const scheme = new Compartment();

/** Tells CodeMirror whether the editor is dark — what picks the highlighting's
 * dark palette — and keeps telling it as the theme changes. The app's own
 * colors switch through CSS (`light-dark()`), which CodeMirror can't see. */
function followColorScheme(): Extension {
  const watcher = ViewPlugin.define((view) => {
    const doc = view.dom.ownerDocument;
    const sync = () => {
      const dark = documentIsDark(doc);
      if (view.state.facet(EditorView.darkTheme) !== dark) {
        view.dispatch({
          effects: scheme.reconfigure(EditorView.darkTheme.of(dark)),
        });
      }
    };
    const system = doc.defaultView?.matchMedia(DARK_SCHEME);
    system?.addEventListener("change", sync);
    const pinned = new MutationObserver(sync);
    pinned.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return {
      destroy() {
        system?.removeEventListener("change", sync);
        pinned.disconnect();
      },
    };
  });
  return [
    scheme.of(EditorView.darkTheme.of(documentIsDark(document))),
    watcher,
  ];
}

/** The keys the completion popup drives while it's open. */
const COMPLETION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Enter",
  "Escape",
]);

/** The extensions every Querydown editor is built from. `onKeyDown` sees each
 * key before the editor does, and preventing its default keeps the editor
 * from acting on it — except, while the completion popup is open, the keys
 * that drive it, which are the popup's. `language` holds
 * {@link querydownSupport}, once there's one to give it. */
export function querydownExtensions(options: {
  singleLine: boolean;
  sheet: boolean;
  language: Extension;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}): Extension {
  return [
    history(),
    keymap.of([...standardKeymap, ...historyKeymap]),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (
            completionStatus(view.state) === "active" &&
            COMPLETION_KEYS.has(event.key)
          ) {
            return false;
          }
          options.onKeyDown(event);
          return event.defaultPrevented;
        },
      }),
    ),
    options.language,
    autocompletion(),
    // In the body, as the app's other popups are, so no box the editor sits
    // in clips it.
    tooltips({ parent: document.body }),
    followColorScheme(),
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
    }),
    EditorView.updateListener.of((update) => {
      if (
        update.docChanged &&
        !update.transactions.some((tr) => tr.annotation(external))
      ) {
        options.onChange(update.state.doc.toString());
      }
    }),
    options.singleLine ? oneLine : EditorView.lineWrapping,
    diagnosticMarks,
    theme,
    options.sheet ? sheetTheme : [],
  ];
}

/** Replaces the editor's text with `text`, as a change from outside (see
 * {@link external}); a no-op when it already holds it. */
export function syncText(view: EditorView, text: string): void {
  const doc = view.state.doc.toString();
  if (doc === text) return;
  view.dispatch({
    changes: { from: 0, to: doc.length, insert: text },
    annotations: external.of(true),
  });
}
