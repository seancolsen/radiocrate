import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import { Compartment } from "@codemirror/state";
import { EditorView, placeholder as placeholderText } from "@codemirror/view";
import type { QueryDiagnostic } from "../../query/diagnostics";
import {
  querydownExtensions,
  setDiagnostic,
  syncText,
} from "../../editor/querydownEditor";
import { cx } from "../ui/cx";

/** The editor for Querydown text, wherever it's edited: the builders, the
 * record picker, the preset editors and the prelude. A CodeMirror view in
 * place of a `<textarea>` (or, `singleLine`, an `<input>`), grown to its
 * text's height — or, `look: "sheet"`, filling a fixed, resizable box, or,
 * `look: "page"`, the rest of the flex column it's in, frameless.
 *
 * It's controlled, as a field is: `value` is what it shows, and every edit is
 * reported through `onChange`. A `value` that changes under it (an undo, a
 * Clear) replaces its text without being reported back.
 *
 * `diagnostic` is a problem in its text — the caller passes it only when it
 * is. It borders the editor in red, and while the diagnostic is about the
 * text the editor holds (its `source` is the text), its range is underlined.
 *
 * The ref forwards to the element that takes the caret, so a caller can
 * focus it. */
const QuerydownEditor = forwardRef<
  HTMLElement,
  {
    value: string;
    onChange: (text: string) => void;
    placeholder?: string;
    /** The accessible name, for an editor with no placeholder to go by. */
    label?: string;
    singleLine?: boolean;
    look?: "field" | "sheet" | "page";
    /** Room at the right for a control laid over the editor (the ⋮). */
    trailingSpace?: boolean;
    diagnostic?: QueryDiagnostic | null;
    onKeyDown?: (event: KeyboardEvent) => void;
  }
>(function QuerydownEditor(props, ref): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The props as of the last render, for the view's callbacks — synced from
  // an effect, never written during render.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const [attributes] = useState(() => new Compartment());

  const describe = (p: typeof props) => {
    const attrs: Record<string, string> = {
      "aria-invalid": p.diagnostic ? "true" : "false",
    };
    if (p.label) attrs["aria-label"] = p.label;
    if (p.placeholder) {
      // `placeholder` too, though a contenteditable has no use for it: it's
      // what finds a field by its placeholder, as with the `<textarea>` this
      // stands in for.
      attrs.placeholder = p.placeholder;
      attrs["aria-placeholder"] = p.placeholder;
    }
    return [
      EditorView.contentAttributes.of(attrs),
      p.placeholder ? placeholderText(p.placeholder) : [],
    ];
  };

  // Created once. Whether it's single-line, and its look, are read once too:
  // no caller changes them.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = latest.current;
    const view = new EditorView({
      parent: host,
      doc: initial.value,
      extensions: [
        querydownExtensions({
          singleLine: initial.singleLine ?? false,
          sheet: initial.look === "sheet" || initial.look === "page",
          onChange: (text) => latest.current.onChange(text),
          onKeyDown: (event) => latest.current.onKeyDown?.(event),
        }),
        attributes.of(describe(initial)),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once; later props reach it through the effects below
  }, []);

  useImperativeHandle(ref, () => viewRef.current!.contentDOM, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) syncText(view, props.value);
  }, [props.value]);

  const { label, placeholder, diagnostic } = props;
  const invalid = diagnostic != null;
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: attributes.reconfigure(
        describe({ ...latest.current, label, placeholder, diagnostic }),
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `describe` reads only these
  }, [attributes, label, placeholder, invalid]);

  // A new diagnostic redraws the underline: over its range, if it's about the
  // text as it stands, or not at all. (Declared after the text sync, so it
  // sees the text it's compared with.)
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current =
      diagnostic && diagnostic.source === view.state.doc.toString()
        ? diagnostic
        : null;
    view.dispatch({ effects: setDiagnostic.of(current) });
  }, [diagnostic]);

  if (props.look === "page") {
    return (
      <div
        ref={hostRef}
        className="text-ink bg-sheet block min-h-0 w-full min-w-0 flex-1 overflow-hidden font-mono text-xs leading-5 [--qd-pad:12px]"
      />
    );
  }

  return (
    <div
      ref={hostRef}
      className={cx(
        "text-ink block w-full min-w-0 rounded-md border font-mono",
        invalid ? "border-danger" : "border-edge focus-within:border-accent",
        props.look === "sheet"
          ? "bg-sheet h-64 max-h-[60vh] resize-y overflow-hidden text-xs leading-5 [--qd-pad:12px]"
          : "bg-panel text-sm leading-5",
        props.look !== "sheet" &&
          (props.trailingSpace
            ? "[--qd-pad:6px_36px_6px_10px]"
            : "[--qd-pad:6px_10px]"),
      )}
    />
  );
});

export default QuerydownEditor;
