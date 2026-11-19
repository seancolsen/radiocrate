import { forwardRef, useMemo, type ReactNode } from "react";
import DiagnosticMessage from "../builder/DiagnosticMessage";
import QuerydownEditor from "../builder/QuerydownEditor";
import {
  useCheckContext,
  useSettledDiagnostic,
} from "../builder/useDiagnostics";
import IconButton from "../ui/IconButton";
import { Icons, type IconComponent } from "../../icons";
import { checkFragment } from "../../query/compile";
import {
  sectionLabel,
  sectionNoun,
  type Section,
} from "../../query/definition";
import { sectionGrammar } from "../../editor/querydownEditor";

/** Each section's toggle, in the query builder's order. */
const SECTION_ICONS: Record<Section, IconComponent> = {
  filter: Icons.Filter,
  sort: Icons.Sort,
  display: Icons.Display,
};

/** An editor for the Querydown behind a field, a section at a time: a toolbar —
 * a toggle for each of `sections`, one shown at once, then a "?" when there's
 * `help` to give, and whatever the caller ends it with (`trailing`: the way out,
 * "Restore default") — over the text of the section shown.
 *
 * The text is the caller's, as is what a change to it does. It's checked here as
 * it's typed, compiled as that section of a query on `base` under
 * `definitions`, and a problem with it shows below.
 *
 * The record editor shows one under a contextual query's field
 * (`ContextQueryEditor`), and the Data structure page under a contextual query's
 * and a related-records field's.
 *
 * The ref forwards to the element that takes the caret, so a caller can focus
 * it. */
const QuerySectionsEditor = forwardRef<
  HTMLElement,
  {
    sections: readonly Section[];
    section: Section;
    onSection: (section: Section) => void;
    /** The field's label, which the editor is named after. */
    label: string;
    /** The table the query lists. */
    base: string;
    /** The definitions the text runs under. */
    definitions: string;
    text: string;
    onChange: (text: string) => void;
    help?: string;
    trailing?: ReactNode;
    /** Escape, in the text. */
    onEscape?: () => void;
    className?: string;
    testId?: string;
  }
>(function QuerySectionsEditor(props, ref) {
  const { section, base, definitions, text } = props;
  const schemaJson = useCheckContext()?.schemaJson;
  const latest = useMemo(
    () =>
      schemaJson === undefined
        ? null
        : checkFragment(schemaJson, definitions, base, section, text, {
            kind: "custom",
            section,
          }),
    [schemaJson, definitions, base, section, text],
  );
  const problem = useSettledDiagnostic(latest);
  const { onEscape } = props;

  return (
    <div className={props.className} data-testid={props.testId}>
      <div className="flex items-center gap-0.5 pb-0.5">
        {props.sections.map((s) => (
          <IconButton
            key={s}
            icon={SECTION_ICONS[s]}
            label={sectionLabel(s)}
            size="sm"
            active={section === s}
            onClick={() => props.onSection(s)}
          />
        ))}
        {props.help !== undefined && (
          <IconButton
            icon={Icons.Help}
            label="Help"
            description={props.help}
            size="sm"
            tooltipAlign="start"
          />
        )}
        <div className="flex-1" />
        {props.trailing}
      </div>
      <QuerydownEditor
        // One editor per section, each opening on that section's text.
        key={section}
        ref={ref}
        label={`${sectionNoun(section)} of ${props.label}`}
        value={text}
        context={{
          grammar: sectionGrammar(section),
          baseTable: base,
          definitions,
        }}
        onChange={props.onChange}
        diagnostic={problem}
        onKeyDown={
          onEscape &&
          ((e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            onEscape();
          })
        }
      />
      {problem && (
        <div className="pt-1">
          <DiagnosticMessage
            diagnostic={problem}
            place={sectionNoun(section)}
          />
        </div>
      )}
    </div>
  );
});

export default QuerySectionsEditor;
