# Render DML form for records

Begin implementing a dynamic form system for CRUD on arbitrary records in the database with a user flow that originates from the query results view.

## Scope

The scope for this phase is as follows:

1. Modify the query results view to allow for this new functionality.
1. Render the edit form with all its data initialized.
1. Allow the user to interact with the form without saving the changes.
1. Track the changes that the user has made to the form, indicating which fields have been modified.

Out of scope:

- Handling submission of the form to actually save the results. (We'll handle that later.)

## Product-level design philosophy

RadioCrate is supposed to be for the user to query their music collection and play music. But it's also supposed to be a powerful tool for _organizing_ a collection of music. That means modifying data too! Currently, the only data modification we support is CRUD on some specific entities like queries and presets. We need a new API to support arbitrary DML on _anything_ in the RadioCrate database. RadioCrate will have a powerful UI that allows the user to edit relational data from the query results view. The most common workflow will be: query tracks, edit a track. But the same functionality should work for other entities too.

My vision is that the schema structure of tables and columns that gets installed by radiocrate is simply a starting point for the user. If the user wants to add their own custom columns or tables, then RadioCrate will (eventually) be able to handle that. That's why we have very little in the way of ORM type logic in the backend. The frontend dynamically introspects the schema and then uses the structure to inform its queries. I would like for DML to work in the same manner. DML should begin with dynamic introspection (already in place), then dynamic UI form-building (what you are currently building), then a request to our dml API that allows for inserting/deleting/updating almost anything (already in place). Keep in mind: RadioCrate is designed to be a single-user multi-device application. The user "owns" this data. We want to give them a lot of power over it. There will be some types of records that we don't want the user editing (e.g. "file" records, because that data comes from our scanner), but we'll implement those guard rails on top of this "edit anything" functionality later on.

## Attached mockup

In this repo, see `plans/2026-07-dml-ui-form/mockup.png` for a mockup of the UI for editing records.

Notes on the mockup:

- This is a relatively high-fidelity mockup. The spacing of things is not necessarily consistent and perfect, but the colors and styling reflect my intended outcome.
- It's modeled after a scenario in which the user is editing a track. The track results are not shown, but the record editing UI is placed between two track result rows.
- The fields show in the mockup are not a perfect representation of the fields in our model. That's okay because the form is to work dynamically anyway.
- The red text is annotation explaining terminology that we use in this prompt.

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

1. In order to allow editing, the query will need to have an id column present in the result data (possibly hidden from view via column annotations). We already have logic for tracks that utilizes this hidden id column in order to play tracks.

1. From the query results view, there should be two ways to begin editing a record:

    - (A) The user should be able to trigger a context menu on a result row. Currently there is no context menu action. Here are some more details about how the context menu should work:
        - If the context menu is triggered on a result row that is not currently selected, then the row should become selected and all other rows should become unselected. Then the context menu should open for the selected row.
        - If a single row is selected and the context menu is triggered on that row, then the context menu should open for that row.
        - When the context menu opens for a single row that is selected, It should contain one menu option with a label like "Edit track" where "track" is the name of the query base table. This is the entry point to open our new form.
        - If multiple rows are selected and the context menu is triggered on one of them, then the rows should remain selected and the context menu should not open. This is because we are not yet supporting bulk editing of rows, so we won't have any options to show in the context menu for multiple rows.

    - (B) The user should be able to execute a command from the command pallette or keyboard shortcut. Label this command "Results: Edit selected rows"

1. The record editor UI should open in a right sidebar as shown in the mockup.

1. As you can see in the mockup, the record editor UI follows a tree structure. The user should be able to collapse and expand items, where indicated by the chevron icons. Initially, all items should be collapsed.

1. The user should be able to click on a value to edit it. At this point, the value should be styled visibly as a focused text box. Hovering on an unfocused value should use a text selection cursor to cue the user that they may click there to edit. If a field is NULL or contains an empty string, then we should render a pencil button to present and focus an empty text field for editing.

1. When a field has been modified, we should render a red star as a superscript on the field label.

1. When the form has any unsaved changes, the Save button should become enabled. (But remember: we don't need to handle its submission right now.)

1. With the record editor sidebar open, the user should still be able to interact with the query results. If the user selects another query result, then the record editor should switch contexts to the record that the user selects. If the user selects multiple records, then the sidebar should display text like "2 records selected. Bulk editing not yet supported", and it should not render a record editor form.

1. When the user clicks "Cancel", the sidebar should close.

## Form structure and data loading

- **Introspection**: We should use the introspection information to build the structure of the form. Every time this form loads, it will be editing one record from a specific base table. Each column in the base table should become a field in the form. Additionally, each table which references the base table should also become a field in the form.

- **Field order**: Eventually we will give the user control over customizing the order of the fields in this form. But for now, display them with the table's intrinsic fields first, listed in the order given from introspection, then the referencing fields afterward, listed alphabetically by table.

- **Data query**: To populate the data for the form, use the introspection info to generate a Querydown query. Then compile it to SQL and run it through the query API. We'll need the value for each intrinsic field, plus the number of related records for each of the referencing fields. This should be a very straightforward Querydown query. Note that we do _not_ want to load data for any of the nested fields initially.

- **Loading data for a scalar linked record field**: When the top level of the form loads, each linked record field will only have an id value where we need to display an embedded record widget. Load the data for this widget with a subsequent request to the query endpoint. Use a Querydown query with a filter for the id and with a result column set defined by the default display preset for the table. Load this data even when the field is collapsed, because we show the embedded record when the field is collapsed. When the user expands the field, then load the data for _all_ fields (not just the default display preset), and do this using the same logic as with the top-level form, recursively.

- **Loading data for a multi-record field**: When the top-level form loads, we'll have a record count for each multi-record field. Don't load anything else until the user expands the field. When the user expands the field, then run a single query to load the data for all the related records. Use Querydown. Set a filter to show only the records related to this record. And use the default display preset for the table.

## Selection and focus

- Within the record editor form, the user should be able to select field labels and embedded records.

- We should support selection of embedded records — but only when they are siblings within a multi-record field. Field labels and embedded records in linked record fields should only support single selection.

- When an element is selected, it should also receive focus.

- Modify the label of several existing command actions to make them more general-purpose so that they apply to the selection of UI elements within the record editor form.

    | Old command action label | New label |
    | -- | -- |
    | Results: Select next result row | Selection: Select down |
    | Results: Select previous result row | Selection: Select up |
    | Results: Extend result row selection down | Selection: Extend selection down |
    | Results: Extend result row selection up | Selection: Extend selection up |

- Additionally, add the following new command actions:
    - "Selection: Expand nested items" — this should have the keyboard shortcut `RightArrow`, and it should expand the selected form items.
    - "Selection: Collapse nested items" — this should have the keyboard shortcut `LeftArrow`, and it should collapse the selected form items.
    - "Selection: Delete"
        - When a scalar field label is selected, it should set the field value to NULL (ephemerally, within the form).
        - When a multi-record field label is selected, it should delete all linked records (ephemerally, within the form).
        - When an embedded record widget within a multi-record field is selected, it should delete that single record (ephemerally, within the form).
        - When an embedded record widget within a scalar linked record field is selected, it should set the field to NULL (ephemerally, within the form).

## Form modification

- **Ephemeral changes**: Changes to the form should be stored in memory until the user clicks "Save". A user's changes should persist even after collapsing and expanding sections of the tree. Given all the intricate and dynamic nesting of this form system, I'm not sure of the best data structure to meet this requirement. I'll leave that to you.

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

- The modal record picker allows the user to search and pick an existing record for use in a scalar linked record field.

- The user opens the modal record picker via clicking on the pencil icon when the field is NULL, or via double-clicking on the field label regardless of the field's current value.

- I do not have a mockup for the modal record picker; I'd like you to improvise its design based on the following description.

- The modal should have a window title such as "Pick album".

- The title bar should have an X close button at the top right which cancels the operation, leaving the form as it was before the modal opened.

- Below the title, render a search box for the user to filter. Accept Querydown filtering code, just as we do in the filter section of the query.

- Along with the user-entered filtering code, use the default sorting preset and the default display preset to formulate a Querydown query. Execute this against the query endpoint and render the results within the modal.

- Single-clicking a result should close the modal and submit the entire loaded record back up to the form so that the form may immediately render the embedded record widget without making any subsequent requests.

- To the right of the search box, include icon-only buttons for sorting and display. These each toggle on a sorting builder UI and display builder UI identical to the query builder.

- Unlike the query page, the search UX should be a bit different within the record picker.
    - Search as the user types, instead of waiting for Ctrl+Enter.
    - Don't allow newlines to be entered into the search box.
    - Handle Up/Down arrow keys to select results without moving focus away from the filter input
    - Handle the Enter key as picking a record.

- At the bottom of the modal, include a "New record" button. This should close the record picker and scaffold the UI necessary to add a record and link it. Upon doing so, the user's entire Querydown filtering code should be copied and pasted into the first text field within the nested new record form. (This won't be a perfect mapping of search terms to fields, but it will probably be helpful in many cases, and we can improve this logic later if needed.)

## Adding a new record to a multi-record field

- When the user clicks the "+" button within a multi-record field, scaffold the UI for the user to add a new record.

- Put the new record UI at the _top_ of the record list, expand it, and activate/focus the first editable field so the user may begin typing immediately.

## The embedded record widget

- This widget should function much in the same way as our query result row widget. For example, it should have the same field layout logic.

- Some deviations from the query result row are as follows:
    - All text should be "small" size regardless of the column annotations
    - All text should be "light" color, regardless of the column annotations.
    - The widget should get a border and large border radius.

- Reuse code across these widgets, even if it means doing some refactoring.

- The embedded record widget might need to render its content on multiple lines due to the same sort of field layout logic present for query result rows. If that wrapping happens, keep the border radius the same as it is shown in the mockup. If it grows in height, it will end up with flat sides, not round sides, and that's okay.

- When the embedded record widget represents a _new record being added_, it should look a bit different. Render the text "New" in italics, centered within the widget. Don't attempt to piece together the user's field values into the data necessary to render the embedded record widget (because we could be missing things like aggregates).

## Expandable text

Text fields have some special behavior to strike a balance between information density at a high level and smooth UX at a low level.

- When we're able to render the entire text content of a field value, do not provide an expansion toggle for the field.

- When the text content of a field is too tall or too wide to fit within the available space, then provide an expansion toggle.

- When a text field is collapsed and not activated, display its content in the field value area on one line — even if the text contains multiple lines or exceeds the available space. In this display mode, render newlines as spaces and use an ellipses to indicate truncation.

- When a text field is collapsed and _activated_ (in edit mode), render the text editing box using the full height necessary to fit the content of the text with soft wrapping.

- When a text field is expanded, display its content _below_ the field label (instead of in the field value area to the right of the label). This gives the text more horizontal space. Render linebreaks as linebreaks. Use however much height is necessary to display the text with soft wrapping. Keep this layout the same whether the text field is activated or not.

