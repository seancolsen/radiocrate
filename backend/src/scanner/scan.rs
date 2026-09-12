use std::path::Path;
use std::time::Instant;

use duckdb::Connection;
use tracing::info;

use super::classify;
use super::prepare;
use super::staging;

pub fn scan(collection_path: &Path, conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    info!(collection = %collection_path.display(), "scan started");

    let existing_artists = staging::load_existing_artists(conn)?;
    let existing_files = staging::load_existing_files(conn)?;

    let mut results = classify::classify_all(collection_path, &existing_files);

    info!(
        skipped = results.skipped.len(),
        moved = results.moved.len(),
        modified = results.modified.len(),
        new = results.new_files.len(),
        "classified collection"
    );

    classify::resolve_conflicts(&mut results);

    let deleted_ids = classify::detect_deletions(&results, &existing_files);
    info!(deleted = deleted_ids.len(), "detected deletions");

    let staging_data = prepare::prepare_staging_data(&results, &existing_artists, deleted_ids);

    staging::create_staging_tables(conn)?;
    staging::insert_staging_data(conn, &staging_data)?;
    staging::execute_batch(conn)?;
    staging::drop_staging_tables(conn)?;
    conn.execute_batch("CHECKPOINT;")?;

    info!(elapsed_ms = started.elapsed().as_millis(), "scan complete");
    Ok(())
}
