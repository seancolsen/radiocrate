import type { JSX } from "react";
import { Icons } from "../icons";
import { ratingLabel, type Rating } from "../query/ratings";
import type { RecordRef } from "../stores/app";
import { MenuItem, MenuNote, MenuSeparator, MenuSubmenu } from "./ui/Menu";

/** A result row's context-menu body: one "Edit {table}" entry per table whose
 * primary key the row carries in full — a track row joined to its album offers
 * both — then "Show album tracks" when one of those is an album and "Rate track"
 * when one of them is a track, over the "Select multiple" entry that turns
 * multi-select mode on.
 *
 * The same body backs the multi-select toolbar's actions menu, which acts on
 * the whole selection; it passes no `onSelectMultiple`, because that mode is
 * already on. A row identifying nothing then leaves the menu with only "Select
 * multiple" to offer, which is still worth raising — that's how a touch device
 * reaches multi-select on results whose rows aren't editable. */
export default function RowActionsMenu(props: {
  records: readonly RecordRef[];
  onEdit: (record: RecordRef) => void;
  /** Opens the tracks of the album records in a new tab. */
  onShowTracks: () => void;
  /** The rating vocabulary the "Rate track" submenu lists, in `value` order —
   * empty while the load hasn't landed, which is what `ratingsLoading`
   * distinguishes from a `rating` table with nothing in it. */
  ratings: readonly Rating[];
  ratingsLoading: boolean;
  /** Gives the row's track(s) that rating. */
  onRate: (ratingId: string) => void;
  /** Omitted when multi-select mode is already on, which hides the entry. */
  onSelectMultiple?: () => void;
}): JSX.Element {
  return (
    <>
      {props.records.map((record) => (
        <MenuItem
          key={record.table}
          icon={Icons.Edit}
          label={`Edit ${record.table}`}
          onClick={() => props.onEdit(record)}
        />
      ))}
      {props.records.some((record) => record.table === "album") && (
        <MenuItem
          icon={Icons.Query}
          label="Show album tracks"
          onClick={props.onShowTracks}
        />
      )}
      {props.records.some((record) => record.table === "track") && (
        <MenuSubmenu icon={Icons.Rate} label="Rate track">
          {props.ratings.map((rating) => (
            <MenuItem
              key={rating.id}
              label={ratingLabel(rating)}
              onClick={() => props.onRate(rating.id)}
            />
          ))}
          {props.ratings.length === 0 && (
            <MenuNote text={props.ratingsLoading ? "Loading…" : "No ratings"} />
          )}
        </MenuSubmenu>
      )}
      {props.onSelectMultiple && (
        <>
          {props.records.length > 0 && <MenuSeparator />}
          <MenuItem
            icon={Icons.SelectMultiple}
            label="Select multiple"
            onClick={props.onSelectMultiple}
          />
        </>
      )}
    </>
  );
}
