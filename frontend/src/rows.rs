//! Query result rows, stored in their native Arrow form.
//!
//! Result batches are kept exactly as decoded from the backend's IPC stream, and
//! cells are stringified on demand each time they render. Rendering from the
//! Arrow values keeps list columns structured (so they can draw as pills, one per
//! element) and lets time-relative formatters re-evaluate against "now" every
//! frame instead of freezing at fetch time. Only the visible rows render on any
//! frame, so the repeated stringification stays cheap.

use arrow_array::{Array, ArrayRef, LargeListArray, ListArray, RecordBatch};
use arrow_cast::display::{ArrayFormatter, FormatOptions};

/// One cell's display value: scalar text, or the stringified elements of a list
/// cell (rendered as pills).
pub(crate) enum CellValue {
    Single(String),
    List(Vec<String>),
}

impl CellValue {
    /// The cell's scalar text, or `None` for a list cell.
    pub(crate) fn as_single(&self) -> Option<&str> {
        match self {
            CellValue::Single(s) => Some(s),
            CellValue::List(_) => None,
        }
    }
}

/// The accumulated result rows of a query: the decoded Arrow batches plus an
/// index mapping an overall row number to its batch.
#[derive(Default)]
pub(crate) struct ResultRows {
    batches: Vec<RecordBatch>,
    /// Starting overall row index of each batch (parallel to `batches`).
    starts: Vec<usize>,
    len: usize,
}

impl ResultRows {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn clear(&mut self) {
        self.batches.clear();
        self.starts.clear();
        self.len = 0;
    }

    pub(crate) fn col_count(&self) -> usize {
        self.batches.first().map_or(0, RecordBatch::num_columns)
    }

    pub(crate) fn push_batch(&mut self, batch: RecordBatch) {
        if batch.num_rows() == 0 {
            return;
        }
        self.starts.push(self.len);
        self.len += batch.num_rows();
        self.batches.push(batch);
    }

    /// Whether the column holds list values (and so renders as pills).
    pub(crate) fn is_list_column(&self, col: usize) -> bool {
        let Some(batch) = self.batches.first() else {
            return false;
        };
        if col >= batch.num_columns() {
            return false;
        }
        let any = batch.column(col).as_any();
        any.downcast_ref::<ListArray>().is_some() || any.downcast_ref::<LargeListArray>().is_some()
    }

    /// The batch holding overall row `row`, and the row's index within it.
    fn locate(&self, row: usize) -> Option<(&RecordBatch, usize)> {
        if row >= self.len {
            return None;
        }
        let i = self.starts.partition_point(|start| *start <= row) - 1;
        Some((&self.batches[i], row - self.starts[i]))
    }

    /// Stringifies one cell. `None` when `row` or `col` is out of range.
    pub(crate) fn cell(&self, row: usize, col: usize) -> Option<CellValue> {
        let (batch, local) = self.locate(row)?;
        (col < batch.num_columns()).then(|| format_cell(batch.column(col), local))
    }

    /// The cell's scalar text, for identity comparisons (e.g. finding the row
    /// holding a track id). `None` when out of range or the cell is a list.
    pub(crate) fn cell_text(&self, row: usize, col: usize) -> Option<String> {
        match self.cell(row, col)? {
            CellValue::Single(s) => Some(s),
            CellValue::List(_) => None,
        }
    }

    /// Stringifies every cell of one row, in column order.
    pub(crate) fn row_values(&self, row: usize) -> Vec<CellValue> {
        let Some((batch, local)) = self.locate(row) else {
            return Vec::new();
        };
        batch
            .columns()
            .iter()
            .map(|col| format_cell(col, local))
            .collect()
    }
}

/// Stringifies one cell of `col`: the elements of a list value, or the scalar's
/// display text.
fn format_cell(col: &ArrayRef, row: usize) -> CellValue {
    if let Some(list) = col.as_any().downcast_ref::<ListArray>() {
        let items = if list.is_null(row) {
            Vec::new()
        } else {
            format_all(&list.value(row))
        };
        return CellValue::List(items);
    }
    if let Some(list) = col.as_any().downcast_ref::<LargeListArray>() {
        let items = if list.is_null(row) {
            Vec::new()
        } else {
            format_all(&list.value(row))
        };
        return CellValue::List(items);
    }
    CellValue::Single(format_one(col.as_ref(), row))
}

/// One value of `arr` via Arrow's display formatter (nulls become `""`).
fn format_one(arr: &dyn Array, row: usize) -> String {
    ArrayFormatter::try_new(arr, &FormatOptions::default())
        .map(|f| f.value(row).to_string())
        .unwrap_or_default()
}

/// Every value of `arr`, in order, via Arrow's display formatter.
fn format_all(arr: &ArrayRef) -> Vec<String> {
    match ArrayFormatter::try_new(arr.as_ref(), &FormatOptions::default()) {
        Ok(f) => (0..arr.len()).map(|i| f.value(i).to_string()).collect(),
        Err(_) => Vec::new(),
    }
}
