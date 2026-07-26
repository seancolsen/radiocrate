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

## Container and entry point

- The record editor should be placed in a right sidebar panel within the query page.

- The panel should open when an "Edit [table]" action is triggered from the query result row context menu.

- The context menu should render in the DOM, not in the canvas. When the context menu is open, interactions within the result set (hovering, scrolling, clicking) should be prevented. Clicking outside the context menu should close it without passing the click through to underlying elements.

- Sidebar visibility state and record editor form state should be managed within the query page. When open, the sidebar should narrow the query toolbar and results pane. The tab bar and marquee should not be affected by the sidebar (they exist outside the query page). The sidebar should be resizable, with its size stored in a top-level app signal and persisted to localStorage.

- The record editor panel should receive primary key values for the selected record. The query column lineage (via polyglot analysis) determines whether edit context menu options should appear. Context menu options should be generated based on the following rules:
  - When result columns contain a primary key for a table (single or multi-column), an "Edit [table]" option should appear for that table.
  - When result columns contain multiple primary keys for the same table, no "Edit" option should appear for that table (since the row may represent multiple records).
  - When result columns contain primary keys for different tables, an "Edit [table]" option should appear for each table. For example, a track row might have both track and album IDs, generating "Edit track" and "Edit album" options.

- When the record editor panel is open, it should update to reflect changes in query result row selection. When the user selects a different row, the record editor should load that record's data. When multiple rows are selected, the heading should display "Edit N [table] records" and show all primary keys. When all rows are deselected, the panel should close.

- When multiple records are selected, a message "Bulk modification not yet supported" should display in place of the form. (Bulk modification is deferred for separate UI work.)

## Terminology

- **Record editor form**: the top-level of the new UI that we're building.
- **Form item**: The form is a tree of items. Some items have child items.
- **Field**: The form has multiple fields. Each field is also an item. Not every item is necessarily a field.
- **Field label**: the UI on the left with the colored background, border radius, and icon.
- **Field value**: the UI to the right of the field label
- **Activated field**: a field for which the user has entered edit mode, transforming the value into a focused widget for data item (commonly a text box).
- **Collapsible item**: A form item that the user may expand or collapse within the tree of items in the form. An item is collapsible if it has children. Additionally, a text field with long content is also collapsible.
- **Expansion toggle**: The chevron icon that users click to expand or collapse an expandable item.
- **Scalar linked record field**: A collapsible field backed by a foreign key column which references a record in another table.
- **Multi-record field**: A collapsible field representing a set of records which each reference the record being edited.
- **Embedded record**: A widget that provides a preview of a single row, usually in another table. A scalar linked record field can have a single embedded record as its field value. A multi-record field can have multiple embedded records as child form items.
- **Primitive field**: A form field that is _not_ a scalar linked record field or a multi-record field, e.g. text field, number field, etc.

## User flow

1. For editing to be supported, the query must include an id column in the result data (which may be hidden from view via column annotations). Existing track-play logic already uses hidden id columns.

1. From the query results view, there should be two ways to begin editing a record:

    - (A) A context menu should appear when triggered on a result row. The following behavior should apply:
        - When the context menu is triggered on an unselected row, that row should become selected and all others should be deselected before the context menu opens.
        - When the context menu is triggered on an already-selected single row, the context menu should open for that row.
        - When the context menu opens for a single selected row, it should contain one menu option labeled "Edit [table]" where "[table]" is the base table name (e.g., "Edit track"). This opens the record editor form.
        - When the context menu is triggered on a row while multiple rows are selected, the rows should remain selected and the context menu should not open (bulk editing is not yet supported).

    - (B) A command palette action should exist with the label "Results: Edit selected rows", executable via keyboard shortcut or command palette.

1. The record editor UI should open in a right sidebar as shown in the mockup.

1. The record editor UI follows a tree structure. Form items should be collapsible and expandable via chevron icons. All items should be initially collapsed.

1. Field values should be editable via click. When a field is in edit mode, the value should be styled as a focused text box. Unfocused values should display a text selection cursor to indicate they can be clicked to edit. When a field is NULL or contains an empty string, a pencil button should render to activate an empty text field for editing.

1. When a field has been modified, a red star should render as a superscript on the field label.

1. When the form has any unsaved changes, the Save button should become enabled. (Submission handling is deferred.)

1. With the record editor sidebar open, the user should still be able to interact with the query results. When the user selects a different result row, the record editor should update to display that record's data. When the user selects multiple records, the sidebar should display text like "2 records selected. Bulk editing not yet supported" instead of the form.

1. When the user clicks "Cancel", the sidebar should close.

## Form structure and data loading

- **Introspection**: The form structure should be built using introspection information. When the form loads for a specific base table, each column in that table should become a field in the form. Additionally, each table that references the base table should also become a field in the form.

- **Field order**: Fields should display in the following order: the table's intrinsic fields in the order given by introspection, followed by referencing fields listed alphabetically by table. (Field order customization is deferred for future work.)

- **Data query**: The form should populate its data via a Querydown query built from introspection info, compiled to SQL, and executed through the query API. This query should include the value for each intrinsic field and a count of related records for each referencing field. Data for nested fields should not be loaded initially.

- **Loading data for a scalar linked record field**: Scalar linked record fields initially contain only an ID value. Data for the embedded record widget should be loaded immediately via a subsequent query API request. Use a Querydown query filtered by ID with result columns from the default display preset for that table. This data should load even when the field is collapsed, since the embedded record displays regardless of expansion state. When the user expands the field, all field data (not just the default display preset) should load recursively using the same logic as the top-level form.

- **Loading data for a multi-record field**: Multi-record fields should load only the record count initially when the top-level form loads. Additional data should not load until the user expands the field. When expanded, a single query should retrieve all related records using Querydown with a filter showing only records related to this record, displaying columns from the default display preset for that table.

## Selection and focus

- Within the record editor form, field labels and embedded records should be selectable.

- Embedded records should be selectable only when they are siblings within a multi-record field. Field labels and embedded records in linked record fields should support single selection only.

- Selected elements should receive focus.

- The following command action labels should be updated to apply to UI element selection within the record editor form:

    | Old command action label | New label |
    | -- | -- |
    | Results: Select next result row | Selection: Select down |
    | Results: Select previous result row | Selection: Select up |
    | Results: Extend result row selection down | Selection: Extend selection down |
    | Results: Extend result row selection up | Selection: Extend selection up |

- Additionally, add the following new command actions:
    - "Selection: Expand nested items" — this should have the keyboard shortcut `RightArrow`, and it should expand the selected form items.
    - "Selection: Collapse nested items" — this should have the keyboard shortcut `LeftArrow`, and it should collapse the selected form items.
    - "Selection: Delete" — behavior depends on the selected element:
        - When a scalar field label is selected: field value should be set to NULL (ephemerally).
        - When a multi-record field label is selected: all linked records should be deleted (ephemerally).
        - When an embedded record within a multi-record field is selected: that record should be deleted (ephemerally).
        - When an embedded record within a scalar linked record field is selected: the field should be set to NULL (ephemerally).

## Form modification

- **Ephemeral changes**: Form modifications should be stored in memory until the user clicks "Save". Changes should persist even after collapsing and expanding tree sections.

- **Form state within the query page**: Changes within the record editor form should persist within the query page tab, stored per record, keyed on the record's primary key value. If a record has unsaved changes, a red star should display within the query result row. The user should be able to select a record, make changes, leave the form unsaved, then switch to another record, then select the original record and save it.

- **Field modification status indicators**: Use a red star to indicate fields that the user has modified. Propagate this status up through the tree so that field modification will be visible even when sections of the tree are collapsed.

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

- Single-clicking a result should close the modal and submit the entire loaded record to the form, allowing the embedded record widget to render immediately without additional requests.

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

## The embedded record widget

- The embedded record widget should function similarly to the query result row widget, reusing field layout logic and implementation where possible.

- The following style deviations from query result rows should apply:
    - All text should be "small" size regardless of column annotations
    - All text should be "light" color regardless of column annotations
    - The widget should have a border and large border radius

- The embedded record widget might need to render its content on multiple lines due to the same sort of field layout logic present for query result rows. If that wrapping happens, keep the border radius the same as it is shown in the mockup. If it grows in height, it will end up with flat sides, not round sides, and that's okay.

- When an embedded record widget represents a _new record being added_, it should display the text "New" in italics, centered. The widget should not attempt to render the user's partial field values as a preview (since aggregates and other computed columns may be unavailable until the record is saved).

## Expandable text

Text fields should balance information density with UX smoothness through the following behavior:

- When the entire text content fits within available space, no expansion toggle should display.

- When text content exceeds available space (height or width), an expansion toggle should display.

- When collapsed and not in edit mode, text should display on a single line in the field value area. Newlines should render as spaces and truncation should be indicated with ellipses.

- When collapsed and in edit mode, the text editing box should use the full height necessary to fit the content with soft wrapping.

- When expanded, text should display _below_ the field label (instead of to the right) to provide more horizontal space. Linebreaks should be preserved. The layout should remain the same whether the field is in edit mode or not.

