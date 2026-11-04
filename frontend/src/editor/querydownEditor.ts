// The CodeMirror side of the Querydown editors: everything an editor view is
// built from, apart from React. `components/builder/QuerydownEditor.tsx`
// creates the view from these and feeds it its props.
//
// What the editors add to a plain text field is the problem underline: a
// diagnostic (`query/diagnostics.ts`) located in the editor's text is drawn as
// a wavy underline over its range, with its notes' ranges dotted. An empty
// range — "unexpected end of input" — has no characters to underline, so it's
// drawn as a short bar at the position instead.

import {
  Annotation,
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
  WidgetType,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
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
});

/** A sheet editor fills the box it's given, scrolling inside it. */
const sheetTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

/** Turns down any edit that would leave the text on more than one line —
 * what keeps a single-line editor single-line, as an `<input>` is. */
const oneLine = EditorState.transactionFilter.of((tr) =>
  tr.newDoc.lines > 1 ? [] : tr,
);

/** The extensions every Querydown editor is built from. `onKeyDown` sees each
 * key before the editor does, and preventing its default keeps the editor
 * from acting on it. */
export function querydownExtensions(options: {
  singleLine: boolean;
  sheet: boolean;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}): Extension {
  return [
    history(),
    keymap.of([...standardKeymap, ...historyKeymap]),
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event) => {
          options.onKeyDown(event);
          return event.defaultPrevented;
        },
      }),
    ),
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
