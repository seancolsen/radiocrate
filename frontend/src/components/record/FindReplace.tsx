import { useLayoutEffect, useRef, type JSX, type KeyboardEvent } from "react";
import { Icons, type IconComponent } from "../../icons";
import {
  hasMatch,
  matchRanges,
  replaceMatches,
  splitByMatches,
  type FindOptions,
} from "../../record/findReplace";
import IconButton from "../ui/IconButton";
import { cx } from "../ui/cx";

// Find and replace over the values a text field's records disagree on: the
// panel that opens between the field's row and its list of values, and how each
// value in that list previews what Replace would make of it. Both render from
// props alone, so the kitchen sink can show them; `RecordFields.tsx` wires them
// to the form.

/** The text input's classes, as the modals spell them. */
const INPUT =
  "control bg-panel text-ink placeholder:text-ink-weak w-52 min-w-0 rounded-md outline-none";

/** The bordered text button's classes, as the modals spell them, with room for
 * an icon. */
const BUTTON =
  "control text-ink border-edge enabled:hover:bg-hover flex shrink-0 items-center gap-1 rounded-md pr-2 disabled:opacity-40";

const TOGGLES: readonly {
  option: keyof FindOptions;
  icon: IconComponent;
  label: string;
}[] = [
  { option: "matchCase", icon: Icons.MatchCase, label: "Match case" },
  { option: "wholeWord", icon: Icons.MatchWord, label: "Match whole word" },
  {
    option: "regex",
    icon: Icons.RegularExpression,
    label: "Use regular expression",
  },
];

/** The panel: Find and Replace boxes over the three toggles and the Replace
 * button, all to the right.
 *
 * Enter in Find moves on to Replace; Enter in Replace replaces, as the button
 * does. Esc in either closes the panel, replacing nothing. */
export function FindReplacePanel(props: {
  find: string;
  replace: string;
  options: FindOptions;
  /** Why the Find text doesn't parse as a regular expression, if it doesn't. */
  error?: string;
  /** Whether Replace would change anything. */
  canReplace: boolean;
  /** Whether the Find box takes focus as the panel appears. */
  focusOnMount?: boolean;
  onFindChange: (text: string) => void;
  onReplaceChange: (text: string) => void;
  onToggleOption: (option: keyof FindOptions) => void;
  onReplace: () => void;
  onClose: () => void;
}): JSX.Element {
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const { focusOnMount } = props;

  // Before paint, so the first key the user types after opening it lands here.
  useLayoutEffect(() => {
    if (focusOnMount) findRef.current?.focus();
  }, [focusOnMount]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget === findRef.current) replaceRef.current?.focus();
      else if (props.canReplace) props.onReplace();
    }
  };

  const invalid = props.error !== undefined;
  return (
    <div className="flex flex-col items-end gap-1 py-1 pr-1">
      <label className="flex max-w-full items-center justify-end gap-1.5">
        <span className="text-ink-weak shrink-0 text-xs">Find</span>
        <input
          ref={findRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          className={cx(
            INPUT,
            invalid
              ? "border-danger focus:border-danger"
              : "border-edge focus:border-accent",
          )}
          value={props.find}
          onChange={(e) => props.onFindChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      {invalid && (
        <p className="text-danger max-w-full px-1 text-right text-xs">
          {props.error}
        </p>
      )}
      <label className="flex max-w-full items-center justify-end gap-1.5">
        <span className="text-ink-weak shrink-0 text-xs">Replace</span>
        <input
          ref={replaceRef}
          type="text"
          spellCheck={false}
          autoComplete="off"
          className={cx(INPUT, "border-edge focus:border-accent")}
          value={props.replace}
          onChange={(e) => props.onReplaceChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div className="flex items-center justify-end gap-1">
        {TOGGLES.map(({ option, icon, label }) => (
          <IconButton
            key={option}
            icon={icon}
            label={label}
            pressed={props.options[option]}
            onClick={() => props.onToggleOption(option)}
          />
        ))}
        <button
          type="button"
          className={BUTTON}
          disabled={!props.canReplace}
          onClick={() => props.onReplace()}
        >
          <Icons.Replace className="size-4" />
          Replace
        </button>
      </div>
    </div>
  );
}

/** What a value with no text says instead, as the list of values names it. */
const emptyText = (value: string | null): string =>
  value === null ? "NULL" : "(empty string)";

/** One value, as Replace would leave it: the value as it is, in gray with what
 * the Find matches highlighted, and — if Replace would change it — what it
 * would become below that, in full ink. Wrapped, every line of it, so nothing a
 * match touches is cut off. */
export function ReplacePreview(props: {
  value: string | null;
  finder: { pattern: RegExp; literal: boolean };
  replacement: string;
  /** Whether a value replaced down to nothing becomes NULL, rather than the
   * empty string — the rule a finished edit follows. */
  nullable: boolean;
}): JSX.Element {
  const { value, finder } = props;
  const changes = value !== null && hasMatch(value, finder.pattern);
  const runs =
    value === null || value === ""
      ? []
      : splitByMatches(value, matchRanges(value, finder.pattern));
  const next = changes
    ? replaceMatches(value, finder, props.replacement)
    : undefined;
  return (
    <div className="min-w-0 flex-1 px-[5px] py-[3px] text-sm/5 break-words whitespace-pre-wrap">
      <div className="text-ink-weak">
        {runs.length === 0 ? (
          <span className="italic">{emptyText(value)}</span>
        ) : (
          runs.map((run) =>
            run.matched ? (
              <mark
                key={run.start}
                className="bg-find-match text-ink rounded-[2px]"
              >
                {run.text}
              </mark>
            ) : (
              <span key={run.start}>{run.text}</span>
            ),
          )
        )}
      </div>
      {next !== undefined && (
        <div className="text-ink">
          {next === "" ? (
            <span className="italic">
              {emptyText(props.nullable ? null : "")}
            </span>
          ) : (
            next
          )}
        </div>
      )}
    </div>
  );
}
