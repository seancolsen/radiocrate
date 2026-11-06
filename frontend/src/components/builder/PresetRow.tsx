import { useMemo, type JSX, type ReactNode } from "react";
import { Icons } from "../../icons";
import {
  presetUsageLabel,
  presetUsers,
  selectPreset,
  selectPresetUnsaved,
} from "../../stores/app";
import { useApp } from "../../stores/react";
import { cx } from "../ui/cx";
import PresetEditor from "./PresetEditor";

/** Marks what toggles a preset open or closed, for its frame's hover border. */
const TOGGLE = "preset-toggle";

/** A preset's look, given what it shows: as wide as its heading (chevron, name,
 * "Default" badge, ✱ marker, then the caller's `actions`), unless it's open,
 * when it's as wide as its column and the rest of the heading toggles it too.
 * `usage` sits at the heading's far right, and `children` (its editor) below.
 * `problem` outlines it in red: the error strip's problem is in this preset. */
export function PresetRowView(props: {
  name: string;
  isDefault?: boolean;
  unsaved?: boolean;
  expanded: boolean;
  problem?: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  usage?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const { expanded } = props;
  const named = props.name.trim() !== "";
  return (
    // The border lights while the pointer is on anything that toggles.
    <div
      className={cx("bg-preset max-w-full rounded-md border", {
        "self-stretch": expanded,
        "border-danger": props.problem,
        "has-[.preset-toggle:hover]:border-accent border-transparent":
          !props.problem,
      })}
    >
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          className={cx(
            TOGGLE,
            "focus-visible:outline-accent flex min-w-0 items-center gap-1.5 self-stretch rounded-md py-0.5 pr-1 pl-1.5 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2",
          )}
          onClick={props.onToggle}
        >
          <span className="text-ink-weak flex size-4 shrink-0 items-center justify-center">
            {expanded ? <Icons.ExpandOpen /> : <Icons.ExpandClosed />}
          </span>
          <span
            className={cx("min-w-0 truncate", {
              "text-ink": named,
              "text-ink-weak italic": !named,
            })}
          >
            {named ? props.name : "Unnamed preset"}
          </span>
          {props.isDefault && (
            <span className="border-edge text-ink-weak shrink-0 rounded border px-1.5 text-xs leading-4">
              Default
            </span>
          )}
          {props.unsaved && (
            <Icons.Unsaved
              className="text-danger size-4 shrink-0"
              aria-label="Unsaved changes"
            />
          )}
        </button>
        {props.actions && (
          <div className="flex shrink-0 items-center gap-0.5 pr-0.5">
            {props.actions}
          </div>
        )}
        {/* The rest of an open preset's heading toggles it too. A pointer
            target only: the button is the heading's keyboard control. */}
        {expanded && (
          <div
            aria-hidden="true"
            className={cx(TOGGLE, "min-w-2 flex-1 self-stretch")}
            onClick={props.onToggle}
          />
        )}
        {expanded && props.usage && (
          <span
            className={cx(
              TOGGLE,
              "text-ink-weak self-stretch pr-2 text-xs leading-6 font-light whitespace-nowrap",
            )}
            onClick={props.onToggle}
          >
            {props.usage}
          </span>
        )}
      </div>
      {props.children}
    </div>
  );
}

/** How many queries and playlists use preset `id`. Its own component, mounted
 * only while the preset is open, since what it counts changes with every write
 * to any tab. */
function PresetUsage(props: { id: string }): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const sources = useApp((s) => s.sources.data);
  const users = useMemo(
    () => presetUsers(tabs, sources, props.id),
    [tabs, sources, props.id],
  );
  return <>{presetUsageLabel(users)}</>;
}

/** A saved or unsaved preset — in a query's builder or the preset manager, which
 * bring their own `actions` and say what's open — with its editor below it when
 * it's open. Its own component so a row's subscriptions are narrow to its own
 * preset. Renders nothing for a preset that's gone. */
export default function PresetRow(props: {
  id: string;
  expanded: boolean;
  problem?: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}): JSX.Element | null {
  const preset = useApp((s) => selectPreset(s, props.id));
  const unsaved = useApp((s) => selectPresetUnsaved(s, props.id));
  if (!preset) return null;
  return (
    <PresetRowView
      name={preset.name}
      isDefault={preset.isDefault}
      unsaved={unsaved}
      expanded={props.expanded}
      problem={props.problem}
      onToggle={props.onToggle}
      actions={props.actions}
      usage={<PresetUsage id={props.id} />}
    >
      {props.expanded && <PresetEditor presetId={props.id} />}
    </PresetRowView>
  );
}

/** A built-in preset: framed as a preset is, with nothing to open. `children`
 * is whatever it offers beside its name. */
export function BuiltinPresetRow(props: {
  name: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="control bg-preset flex max-w-full items-center gap-2 rounded-md px-2">
      <span className="text-ink">{props.name}</span>
      {props.children}
    </div>
  );
}
