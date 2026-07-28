# Record editor spec

The record editor should be a dynamic form system for CRUD operations on arbitrary database records, with a user flow originating from the query results view.

## Product-level design philosophy

RadioCrate is supposed to be for the user to query their music collection and play music. But it's also supposed to be a powerful tool for _organizing_ a collection of music. That means modifying data too! Currently, the only data modification we support is CRUD on some specific entities like queries and presets. We need a new API to support arbitrary DML on _anything_ in the RadioCrate database. RadioCrate will have a powerful UI that allows the user to edit relational data from the query results view. The most common workflow will be: query tracks, edit a track. But the same functionality should work for other entities too.

Eventually, the schema structure of tables and columns that gets installed by radiocrate will simply be a starting point for the user. If the user wants to add their own custom columns or tables, then RadioCrate will be able to handle that by virtue of its dynamic introspection-driven approach. That's why we have very little in the way of ORM type logic in the backend. The frontend dynamically introspects the schema and then uses the structure to inform its queries. DML should work in the same manner. DML should begin with dynamic introspection (already in place), then dynamic UI form-building (the record editor), then a request to the DML API for inserting/deleting/updating records (already implemented). RadioCrate is designed as a single-user multi-device application. The user "owns" this data. We want to give them a lot of power over it. There will be some types of records that we don't want the user editing (e.g. "file" records, because that data comes from our scanner), but we'll implement those guard rails on top of this "edit anything" functionality later on.

## Attached mockup

In this repo, see `specs/2026-07-record-editor/mockup.png` for a mockup of the record editor UI.

Notes on the mockup:

- This is a relatively high-fidelity mockup. The spacing of things is not necessarily consistent and perfect, but the colors and styling reflect the intended outcome.
- It's modeled after a scenario in which the user is editing a track.
- The fields show in the mockup are not a perfect representation of the fields in our model. That's okay because the form is to work dynamically anyway.
- The red text is annotation explaining terminology that we use in this spec.

## Entry point and user flow

### Prerequisites

For editing to be supported, the query must include an id column in the result data (which may be hidden from view via column annotations). Existing track-play logic already uses hidden id columns.

### Opening the record editor

From the query results view, there are two ways to begin editing a record:

- **(A) Context menu**: A context menu should appear when triggered on a result row. The context menu should render in the DOM, not in the canvas. When the context menu is open, interactions within the result set (hovering, scrolling, clicking) should be prevented. Clicking outside the context menu should close it without passing the click through to underlying elements. The following behavior should apply:

    - When the context menu is triggered on an unselected row, that row should become selected and all others should be deselected before the context menu opens.
    - When the context menu is triggered on an already-selected single row, the context menu should open for that row.
    - When the context menu is triggered on a row while multiple rows are selected, the rows should remain selected and the context menu should not open (bulk editing is not yet supported).

- **(B) Command palette**: A command palette action should exist with the label "Results: Edit selected rows", executable via keyboard shortcut or command palette.

### Context menu generation

The query column lineage (via polyglot analysis) determines which edit context menu options should appear.

- When result columns contain a primary key for a table (single or multi-column), an "Edit [table]" option should appear for that table.
- When result columns contain multiple primary keys for the same table, no "Edit" option should appear for that table (since the row may represent multiple records).
- When result columns contain primary keys for different tables, an "Edit [table]" option should appear for each table. For example, a track row might have both track and album IDs, generating "Edit track" and "Edit album" options.

The context menu option label should be "Edit [table]" where "[table]" is the base table name (e.g., "Edit track"), and clicking this option opens the record editor form.

### Sidebar panel

- The record editor should be placed in a right sidebar panel within the query page.
- When open, the sidebar should narrow the query toolbar and results pane. The tab bar and marquee should not be affected by the sidebar (they exist outside the query page).
- The sidebar should be resizable, with its size stored in a top-level app signal and persisted to localStorage.
- Sidebar visibility state and record editor form state should be managed within the query page. The record editor panel should receive primary key values for the selected record.
- The sidebar should have a subtle, tasteful shadow on the left in order to give it some depth and emphasis. The shadow should display over the query results and the query builder toolbar, but it should not interfere with any user interactions.

### Dynamic updates

When the record editor panel is open, it should update to reflect changes in query result row selection:

- When the user selects a different row, the record editor should load that record's data.
- When multiple rows are selected, the heading should display "Edit N [table] records" and show all primary keys. A message "Bulk modification not yet supported" should display in place of the form. (Bulk modification is deferred for separate UI work.)
- When all rows are deselected, the panel should close.

The user can still interact with the query results while the sidebar is open. When the user clicks "Cancel", the sidebar should close.

## Terminology

- **Record editor form**: the top-level of the new UI that we're building.
- **Form item**: The form is a tree of items. Some items have child items.
- **Field**: The form has multiple fields. Each field is also an item. Not every item is necessarily a field.
- **Field label**: the UI on the left with the colored background, border radius, and icon.
- **Field value**: the UI to the right of the field label
- **Activated field**: a field for which the user has entered edit mode, transforming the value into a focused component for data item (commonly a text box).
- **Collapsible item**: A form item that the user may expand or collapse within the tree of items in the form. An item is collapsible if it has children. Additionally, a text field with long content is also collapsible.
- **Expansion toggle**: The chevron icon that users click to expand or collapse an expandable item.
- **Scalar linked record field**: A collapsible field backed by a foreign key column which references a record in another table.
- **Multi-record field**: A collapsible field representing a set of records which each reference the record being edited.
- **Embedded record**: A component that provides a preview of a single row, usually in another table. A scalar linked record field can have a single embedded record as its field value. A multi-record field can have multiple embedded records as child form items.
- **Primitive field**: A form field that is _not_ a scalar linked record field or a multi-record field, e.g. text field, number field, etc.

## Form structure

- **Introspection**: The form structure should be built using introspection information. When the form loads for a specific base table, each column in that table should become a field in the form. Additionally, each table that references the base table should also become a field in the form.

- **Tree structure**
    - As shown in the mockup, the record editor form should follow a tree structure, with form items that are collapsible and expandable via chevron icons.
    - All items should be initially collapsed.

- **Modal editing, per field**
    - Field values should be editable via click. When a field is in edit mode, the value should be styled as a focused text box.
    - Clicking out side the editing text box should move the field back into "view" mode.
    - Unfocused values should display a text selection cursor to indicate they can be clicked to edit.
    - When a field is NULL or contains an empty string, a pencil button should render to activate an empty text field for editing.

- **Field order**: Fields should display in the following order: the table's intrinsic fields in the order given by introspection, followed by referencing fields listed alphabetically by table. (Field order customization is deferred for future work.)

- **Expansion**:
    
    The following types of form items should be expandable:

    - A non-empty multi-record field
    - A non-null scalar linked record field
    - An embedded record within a multi-record field
    - _Some_ text fields, as described further in "Expandable text" below.

    If an item is not expandable, it should not get an expansion toggle.

- **Expandable text**

    Text fields should balance information density with UX smoothness through the following behavior:

    - When the entire text content fits within available space, no expansion toggle should display.
    - When text content exceeds available space (height or width), an expansion toggle should display.
    - When collapsed and not in edit mode, text should display on a single line in the field value area. Newlines should render as spaces and truncation should be indicated with ellipses.
    - When collapsed and in edit mode, the text editing box should use the full height necessary to fit the content with soft wrapping.
    - When expanded, text should display _below_ the field label (instead of to the right) to provide more horizontal space. Linebreaks should be preserved. The layout should remain the same whether the field is in edit mode or not.

- **Display of non-text values**
    - Non-text values (e.g. UUID, timestamp, float, etc) should display on one line in view mode with truncated as needed. In edit mode, the text input should have soft wrapping which grows the height of the input as needed to contain the user's string entered.

- **Vertical alignment of form UI elements**

    A single row in the form might have the following UI elements:

    - An expansion toggle
    - A horizontal tree segment line
    - A field label
    - An embedded record
    - A field value
    - A pencil button
    - A text input
    - A record count
    - A plus button

    All of these UI elements should be vertically centered with respect to each other.

## Basic data loading

- **Loading UX**:
    - Before any data is loaded, we should render the top level of the form field tree with all the field labels, because we already know the schema structure before we fetch any data. We should render the id because we already have that. We should not render any other values (or pencil buttons).
    - While the data is loading, we should display a translucent overlay over the context for which the data is loading. Use the color of the form background so as to make the content underneath the overlay appear dimmed. This is our (subtle) loading indicator.
    - We should prevent the user from interacting with the specific elements into which data is being loaded. When expanding a form field like a scalar linked record field or a multi-record field, we should immediately have enough structural information to render a skeleton over which we'll render the loading overlay. A multi-record field containing 5 records should immediately render 5 embedded record widgets while loading the data to display inside them.

- **Data query**: The form should populate its data via a Querydown query built from introspection info, compiled to SQL, and executed through the query API. The query fo the top-level data should include the value for each intrinsic field as well as a count of related records for each referencing field. Data for nested fields should not be loaded initially.

## Progressive expansion**

The following types of form elements must load additional data when expanded:

- a scalar linked record field
- a multi-record field
- an embedded record within a multi-record field

The user should be able to infinitely recurse deeply into the form, with data loading as they go.

Specifically:

- When the user expands a **scalar linked record field**, all field data should load using the same logic as the top-level form (recursively).
- When the user expands a **multi-record field**, a single querydown query should be used to fetch all the data to render the many child records (described in more detail below).
- When the user expands **an embedded record within a multi-record field**, we treat this similar to the top-level data load, but with some special logic... We need to hide the "contextual filter field" used to filter the list of embedded record widgets. For example, in the mockup you'll notice that we're listing the credits associated with a track. We do this by dynamically generating a querydown for the `credit` table that filters on the `track` column to show only the credits for the containing track. As such, there is no need to display the `track` field within each `credit` record. Hide this field. Any time we have a contextual filter like this, hide the column used for the filter.

## Loading data to render embedded records

The UX purpose of an embedded record is to allow the user to identify a record "at a glance". We need to load the data to put into these embedded records. At some point in the future, we'd like to allow the user to configure how these records display. But for the time being, we'll need to be smart about giving the user some defaults that work well in most cases

### _When_ to load data for embedded records

- Data for **an embedded record in a scalar linked record field** should be auto-loaded using a subsequent request to the query API, after we get its id from the top-level query.
- Data for **embedded records within a multi-record field** should load when the user expands the multi-record field.

### _How_ to load data for embedded records

We'll need a dynamic querydown display generator system that looks like this:

- Inputs:
    - Target table name (the table for which we want to load data)
    - Schema structure of target table
    - Contextual filtering column (optional) e.g. when listing all the credits for a track, we need to filter the `credit` table to only return records where the `track` column has a known value. The contextual filter maps a column in the target table to a known value with an equality condition.

- Outputs:
    - The querydown code for the querydown display section, e.g. `$artist.name $role`
    - The querydown code for the querydown sorting section, e.g. `\\ord`

Specific behavior:

**The query's "display" section**

We need to dynamically produce a list of result column expressions for the target table. We should use a points-based algorithm for producing the result column list. Here is a description of how this algorithm should work, using the plan's mockup as an example reference:

1. Assemble the result column paths for which we will allocate points.

    - Do not consider any foreign key columns directly.
    - If a foreign key column is _not_ used as a contextual filtering column, then recurse one level deep into the referenced table to consider all of its columns too.

    For example, in the mockup we need to list credits for a track. Here the target table is `credit` and the contextual filtering column is `track`.
    
    - We should consider the non-FK columns in `credit` such as `id`, `ord`, and `role`.
    - We should ignore `track` (due to contextual filtering).
    - And we should also consider `artist.name` and `artist.id` because they are transitive columns through the `artist` `FK` column.

1. Assign points to each result column path based on the following system

    - **Hops:** If the column in directly in the target table, award it **1 point**. (If the column is in a transitive table, award it no points).

    - **Nullability**: If the column is required (i.e. NOT NULL), award it **1 point**. If the column is nullable, award it no points.

    - **Uniqueness**: If the column is unique then award it **1 point**. The column should be considered unique if it has a single-column unique constraint or if it is part of a two-column unique constraint which also contains the contextual filtering column. If the column is not unique then award it no points.

    - **Type**: If the column is TEXT (or similar, i.e. VARCHAR, STRING, CHAR, BPCHAR, or text-like ENUM), then award it **1 point**. IF the column is UUID, then award it **-1 point** (negative). Otherwise, award it 0 points.

    Example of listing credits for a track:

    | Column path | Hops points | Nullability points | Uniqueness points | Type points | Total points |
    | --          | --          | --                 | --                | --          | --           |
    | ord         | 1           | 0                  | 0                 |  0          | 1            |
    | role        | 1           | 0                  | 0                 |  1          | 2            |
    | artist.id   | 0           | 1                  | 1                 | -1          | 1            |
    | artist.name | 0           | 1                  | 1                 |  1          | 3            |

1. Pick the first _two_ columns that tie for the maximum number of points. In this example that would be only `artist.name`. (Note that the mockup also displays the `role` column, which is a deviation from this new logic that we'd like to implement).

**The query's "sorting" section**

For the sorting section, we'll use the same points values that we calculated for the display, plus some additional logic:

1. If the target table contains a column named `ord`, use that as the primary sorting column, sorted ascending.
1. Then sort by the display columns with sorting precedence defined by the order in which they appear in the display section. Sort dates and timestamps as descending. Sort everything else ascending.
1. Finally, sort by the primary key so that the UI is stable across refreshes.

**The full query**

Using the contextual filter, plus the sorting, plus the display, we can formulate a querydown query to convert to SQL and run through the query API. _That_ gives us the data we need to hand off to the embedded record component for rendering.

## Selection

- Embedded records within multi-link fields are to be selectable such that many of them can be selected via Shift and Ctrl just like in the query result pane. This is to allow easy deletion of many records.

- Selected elements should receive focus.

- When the user clicks on something that is _not_ a selectable embedded record widget, then the selection of embedded record widgets should be cleared.

- Add the following new command actions:
    - "Selection: Expand nested items" — this should have the keyboard shortcut `RightArrow`, and it should expand the selected form items.
    - "Selection: Collapse nested items" — this should have the keyboard shortcut `LeftArrow`, and it should collapse the selected form items.
    - "Selection: Delete" — behavior depends on the selected element:
        - When a scalar field label is selected: field value should be set to NULL (ephemerally).
        - When a multi-record field label is selected: all linked records should be deleted (ephemerally).
        - When an embedded record within a multi-record field is selected: that record should be deleted (ephemerally).
        - When an embedded record within a scalar linked record field is selected: the field should be set to NULL (ephemerally).

## Focus

- The following UI elements should be focusable:
    - Field labels
    - _Activated_ field value inputs
    - Embedded records in multi-record fields
    
- The following interactive UI elements are _not_ to be focusable:
    - Non-activated field values
    - Expansion toggle
    - Pencil icon buttons
    - Plus buttons
    - Embedded record in a scalar linked field

- Field labels and activated field value inputs should be styled with a blue border when focused. When a context menu is opened on a field label, the field label should be stylized as if it were focused.

- When a field label is focused, we should handle the following command actions:
    - "Selection: Select down" — should focus the next field label below, if there is one. This should recurse into opened child fields
    - "Selection: Select up" — should focus the next field label upward, if there is one, including parent fields.
    - "Selection: Expand nested items" — should expand a collapsed field, if expandable.
    - "Selection: Collapse nested items" — should collapse an expanded field, if possible.

## Embedded records

- The embedded record component should function similarly to the query result row component, reusing field layout logic and implementation where possible.

- The following style deviations from query result rows should apply:
    - All text should be "small" size regardless of column annotations
    - All text should be "light" color regardless of column annotations
    - The component should have a border and large border radius

- The border radius should be such that an embedded record widget with a single line of content has a perfect semicircle on the left and right. (And the border radius should remain static so that if the content wraps to multiple lines we'll see a flat border section on the left and right.)

- Embedded records should have a background gradient that matches the query result row, including the hover styling and selected row styling.

- When an embedded record component represents a _new record being added_, it should display the text "New" in italics, centered. The component should not attempt to render the user's partial field values as a preview (since aggregates and other computed columns may be unavailable until the record is saved).

## Form modification

- **Ephemeral changes**: Form modifications should be stored in memory until the user clicks "Save". Changes should persist even after collapsing and expanding tree sections.

- **Form modification while typing**: The form state should be modified immediately _while the user types_ into an activated form field input.

- **Field modification status indicators**: Use a red star to indicate fields that the user has modified. Propagate this status up through the tree so that field modification will be visible even when sections of the tree are collapsed.

- **Form state within the query page**: Changes within the record editor form should persist within the query page tab, stored per record, keyed on the record's primary key value. If a record has unsaved changes, a red star should display within the query result row. The user should be able to select a record, make changes, leave the form unsaved, then switch to another record, then select the original record and save it.

## Saving the form

- We have a powerful DML API that allows arbitrary changes to records in the database. The record editor should this DML API to submit a single API request to save the user's changes within the record editor form.
- Any errors should be handled by rendering them within the UI and retaining the changes to the form.
- On success, we should keep the form open and update its state to reflect the saved values.
- Updating the query result row with the new values is out of scope.

## Interactions

### Expansion toggle

- **Single click**: Toggle expand/collapse
- **Ctrl+Click**: Expand or collapse this form item — and take the same action for all sibling items.

### Field label for a primitive field

- **Single click**: Select
- **Double click**: Enter edit mode on the field value
- **Context menu**:
    - Edit
    - Clear
    - Copy
- **"Selection: Delete" action**: Set field to NULL

### Field label for a scalar linked record field

- **Single click**: Select
- **Double click**: Toggle expansion
- **Context menu**:
    - Pick a record
    - Enter a new record
    - Clear
- **"Selection: Delete" action**: Set field to NULL

### Field label for a multi-record field

- **Single click**: Select
- **Double click**: Toggle expansion
- **Context menu**:
    - New record
    - Delete all records
- **"Selection: Delete" action**: Delete all records within

### Directly editable field value in display mode

- **Single click**: Enter edit mode, focusing the activated input
- **Context menu**: Open a context menu with the following options:
    - Edit
    - Clear
    - Copy

### Activated field value (in edit mode)

- **`Esc` key**: exit edit mode, save field changes within the form, and select/focus the label of this field.
- **`Enter` key**:
    - If it's a text field, then add a newline
    - If it's a number/datetime field then: exit edit mode, save field changes within the form, and select/focus the label of this field.
- **`Tab` key**: exit edit mode, save field changes within the form, and select/focus the label of the **next** field (or this field if it's the last one).

### Embedded record in a scalar linked record field

- **Single click**: Select
- **Double click**: Toggle expand/collapse
- **Context menu**: 
    - Clear
- **"Selection: Delete" action**: Set field to NULL

### Embedded record in a multi-record field

- **Single click**: Select
- **Double click**: Toggle expand/collapse
- **Context menu**:
    - Delete
- **Ctrl+Click**: Select multiple (sparse)
- **Shift+Click**: Select multiple (contiguous)
- **"Selection: Delete" action**: Delete the selected items (ephemerally in the form)

## Modal record picker

- The modal record picker should enable searching and selection of existing records for scalar linked record fields.

- The modal record picker should open when the user clicks the pencil icon (for NULL fields) or double-clicks the field label (regardless of current value).

- The modal should have a window title such as "Pick album".

- The title bar should have an X close button at the top right which cancels the operation, leaving the form as it was before the modal opened.

- Below the title, a search box should render that accepts Querydown filtering code (matching the query filter section UI).

- A Querydown query should be formulated using the user-entered filtering code, the default sorting preset, and the default display preset. This query should be executed against the query endpoint and results should render within the modal.

- Single-clicking a result should close the modal and submit the entire loaded record to the form, allowing the embedded record component to render immediately without additional requests.

- Icon-only buttons for sorting and display should appear to the right of the search box. These buttons should toggle sorting and display builder UIs matching the query builder.

- The record picker search UX should differ from the query page in the following ways:
    - Search should execute as the user types, not wait for Ctrl+Enter.
    - Newlines should not be allowed in the search box.
    - Up/Down arrow keys should select results while maintaining focus on the filter input.
    - The Enter key should submit the selected record.

- At the bottom of the modal, a "New record" button should close the record picker and scaffold UI to create and link a new record. The search filter code should be auto-populated into the first text field of the nested new record form as a convenience. (This mapping may not be perfect, but serves as a helpful starting point.)

## Adding a new record to a multi-record field

- When the user clicks the "+" button within a multi-record field, UI should scaffold to allow creating a new record.

- The new record UI should appear at the _top_ of the record list, expanded, with the first editable field focused so the user can begin typing immediately.


