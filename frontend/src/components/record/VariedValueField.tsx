import type { JSX } from "react";
import { Icons } from "../../icons";
import IconButton from "../ui/IconButton";
import { cx } from "../ui/cx";
import type { PrimitiveField } from "../../query/recordForm";
import {
  selectDistinctValues,
  selectIsExpanded,
  type DistinctValue,
} from "../../stores/recordForm/selectors";
import { useFormState } from "../../stores/react";
import { fieldItemId } from "../../record/formIds";
import type { RecordFormModel } from "../../stores/recordForm";

/** Displays a varied field value in an expandable format, allowing the user to
 * apply any distinct value to all records. */
export default function VariedValueField(props: {
  model: RecordFormModel;
  recordId: string;
  field: PrimitiveField;
}): JSX.Element {
  const { model, recordId, field } = props;
  const itemId = fieldItemId(recordId, field.key);

  const distinctValues = useFormState(model, (s) =>
    selectDistinctValues(s, recordId, field.column),
  );

  const expanded = useFormState(model, (s) => selectIsExpanded(s, itemId));

  const distinctCount = distinctValues.length;

  const applyValue = (value: string | null) => {
    model.commitEdit(recordId, field.column, value ?? "");
    model.toggleField(recordId, field, false);
    // After applying the value, enter edit mode so the user can edit it further
    queueMicrotask(() => {
      model.beginEdit(recordId, field.key);
    });
  };

  const getDisplayText = (value: string | null): string => {
    if (value === null) return "NULL";
    if (value === "") return "(empty string)";
    return value;
  };

  const isNullOrEmpty = (value: string | null): boolean => {
    return value === null || value === "";
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Collapsed view: show distinct count in gray italic */}
      {!expanded && (
        <span className="text-ink-weak text-sm/5 italic cursor-default">
          {distinctCount} distinct record{distinctCount !== 1 ? "s" : ""}
        </span>
      )}

      {/* Expanded view: show each distinct value with count and apply button */}
      {expanded && (
        <div className="border-edge flex flex-col gap-1 rounded border p-2 bg-panel/50">
          {distinctValues.map((item: DistinctValue, index: number) => (
            <div key={index} className="flex items-center gap-2">
              {/* Count badge */}
              <span className="bg-edge/50 text-ink-weak rounded-full px-2 text-xs leading-[18px] shrink-0">
                {item.count}
              </span>

              {/* Value */}
              <span
                className={cx(
                  "text-sm/5 flex-1 min-w-0 truncate",
                  isNullOrEmpty(item.value)
                    ? "text-ink-weak italic"
                    : "text-ink"
                )}
              >
                {getDisplayText(item.value)}
              </span>

              {/* Apply button */}
              <IconButton
                icon={Icons.FormatPaint}
                label="Use this value for all records"
                size="sm"
                tabIndex={-1}
                onClick={() => applyValue(item.value)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
