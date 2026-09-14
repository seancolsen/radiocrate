/** A minimal stand-in for Solid's `classList={{…}}`: joins a base class string
 * with any number of conditional entries (a string included as-is, or a
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
