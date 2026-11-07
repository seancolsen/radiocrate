/** Builds a `className` without a dependency: joins a base class string with
 * any number of conditional entries (a string included as-is, or a
 * `{ className: condition }` record whose true keys are included). */
export function cx(
  ...args: Array<
    string | false | null | undefined | Record<string, boolean | undefined>
  >
): string {
  const classes: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === "string") {
      classes.push(arg);
    } else {
      for (const [name, on] of Object.entries(arg)) {
        if (on) classes.push(name);
      }
    }
  }
  return classes.join(" ");
}

/** The focus half of `NESTED_BUTTON_CLASS`, for a nested button with no text
 * (it shows hover as a change of icon color, so it takes no tint). */
export const NESTED_FOCUS_CLASS =
  "focus-visible:outline-accent focus-visible:outline-2 focus-visible:-outline-offset-2";

/** What a button set inside a standard-height control wears (the parts of a
 * `SplitButton`, a preset's actions, an editor's ⋮). There's no room for a
 * border of its own there, so hover is a tint of the ink, which reads on
 * whatever fill the control has, and focus is an outline drawn inside the
 * button, so it can't be painted over by a neighbor. */
export const NESTED_BUTTON_CLASS = `enabled:hover:bg-ink/10 ${NESTED_FOCUS_CLASS}`;
