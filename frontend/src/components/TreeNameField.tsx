import { useLayoutEffect, useRef, useState, type JSX } from "react";

/** An explorer item's name (a folder's or a saved query's), being edited in
 * place in its row. Its own component so the buffer is seeded from the name,
 * and the field focused, once per edit. Enter or leaving the field keeps the
 * edit; Escape abandons it. */
export default function TreeNameField(props: {
  label: string;
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [buffer, setBuffer] = useState(() => props.name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter (or Escape) ends the edit; the blur that follows as the field goes
  // away must not end it a second time.
  const done = useRef(false);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) props.onCommit(buffer);
    else props.onCancel();
  };

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={props.label}
      className="border-accent bg-panel text-ink ml-1 h-5 min-w-0 flex-1 rounded border px-1 py-0 text-sm outline-none"
      value={buffer}
      onChange={(e) => setBuffer(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onBlur={() => finish(true)}
      // Pressing in the field edits the name; it doesn't pick the row up, and
      // a double-click selects a word rather than starting another rename.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}
