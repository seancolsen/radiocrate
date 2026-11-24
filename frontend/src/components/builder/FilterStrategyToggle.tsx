import type { JSX } from "react";
import { Icons, type IconComponent } from "../../icons";
import {
  otherStrategy,
  strategyName,
  type FilterStrategy,
} from "../../query/filterStrategy";
import IconButton from "../ui/IconButton";
import { Menu, MenuToggleItem } from "../ui/Menu";

const STRATEGIES: readonly FilterStrategy[] = ["basic_text", "querydown"];

const ICONS: Record<FilterStrategy, IconComponent> = {
  basic_text: Icons.BasicTextFilter,
  querydown: Icons.QuerydownFilter,
};

/** What the toggle's tooltip says about each strategy. */
const ABOUT: Record<FilterStrategy, string> = {
  basic_text: "Filtering with basic text: every word must match.",
  querydown: "Filtering with Querydown conditions.",
};

/** The button left of a filter input that says how its text is read, basic text
 * or Querydown, by its icon, and opens a menu to switch. The query page's
 * filter, a filter preset in a query's builder and the record picker's search
 * box have one; a contextual query's filter and the Data structure page's
 * editors don't. Switching is the caller's: `onChange` gets the strategy
 * chosen, never the one already in force. */
export default function FilterStrategyToggle(props: {
  strategy: FilterStrategy;
  onChange: (strategy: FilterStrategy) => void;
  /** Set inside a standard-height control (a preset), as `IconButton`'s. */
  nested?: boolean;
}): JSX.Element {
  const { strategy } = props;
  const other = strategyName(otherStrategy(strategy));
  return (
    <Menu
      width="170px"
      trigger={(api) => (
        <IconButton
          icon={ICONS[strategy]}
          // Both glyphs are wide and short (`abc` is a band across the middle
          // of its box), so they're drawn a size up to read at a glance.
          iconClassName="scale-125"
          label="Filter strategy"
          description={`${ABOUT[strategy]} Click to change to ${other === "Querydown" ? other : other.toLowerCase()}.`}
          tooltipAlign="start"
          nested={props.nested}
          active={api.open}
          onClick={() => api.toggle()}
        />
      )}
    >
      {STRATEGIES.map((s) => (
        <MenuToggleItem
          key={s}
          kind="radio"
          icon={ICONS[s]}
          label={strategyName(s)}
          checked={s === strategy}
          onClick={() => {
            if (s !== strategy) props.onChange(s);
          }}
        />
      ))}
    </Menu>
  );
}
