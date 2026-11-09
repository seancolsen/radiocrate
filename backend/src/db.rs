use std::fs;
use std::path::{Path, PathBuf};

use tracing::{debug, info};

/// Re-exported so a binary can name the type `get_db` hands back without taking
/// its own dependency on `duckdb`.
pub use duckdb::Connection;

/// The database directory within a collection, unless the user names another.
static DB_DIR_NAME: &str = ".radiocrate";

/// The database file within the database directory. Not configurable: the user
/// chooses the directory, never the file's name.
static DB_FILE_NAME: &str = "radiocrate.db";

/// The default database directory when the user does not supply one:
/// `.radiocrate` within the collection root.
#[must_use]
pub fn default_db_dir(collection_path: &Path) -> PathBuf {
    collection_path.join(DB_DIR_NAME)
}

struct Migration {
    version: u32,
    sql: &'static str,
}

/// All known migrations, embedded at compile time.
///
/// To add a new migration, create a SQL file in this directory named with a
/// four-digit version prefix (e.g. `0002.sql`) and append a corresponding
/// entry here. Migrations must be listed in strictly ascending order.
const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("migrations/0001.sql"),
    },
    Migration {
        version: 2,
        sql: include_str!("migrations/0002.sql"),
    },
    Migration {
        version: 3,
        sql: include_str!("migrations/0003.sql"),
    },
    Migration {
        version: 4,
        sql: include_str!("migrations/0004.sql"),
    },
    Migration {
        version: 5,
        sql: include_str!("migrations/0005.sql"),
    },
    Migration {
        version: 6,
        sql: include_str!("migrations/0006.sql"),
    },
    Migration {
        version: 7,
        sql: include_str!("migrations/0007.sql"),
    },
    Migration {
        version: 8,
        sql: include_str!("migrations/0008.sql"),
    },
    Migration {
        version: 9,
        sql: include_str!("migrations/0009.sql"),
    },
    Migration {
        version: 10,
        sql: include_str!("migrations/0010.sql"),
    },
    Migration {
        version: 11,
        sql: include_str!("migrations/0011.sql"),
    },
    Migration {
        version: 12,
        sql: include_str!("migrations/0012.sql"),
    },
];

fn init_db_version_metadata(conn: &Connection) -> Result<(), duckdb::Error> {
    let sql = "
        CREATE SCHEMA IF NOT EXISTS meta;
        CREATE TABLE IF NOT EXISTS meta.version (value UINTEGER NOT NULL);
        INSERT INTO meta.version SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM meta.version);
    ";
    conn.execute_batch(sql)
}

fn get_current_version(conn: &Connection) -> Result<u32, duckdb::Error> {
    conn.query_row("SELECT value FROM meta.version", [], |row| row.get(0))
}

/// Applies one migration and records the new version, all within a single
/// transaction: either the whole SQL file lands and `meta.version` moves with
/// it, or nothing does. A migration's SQL must therefore not open or close a
/// transaction of its own.
fn run_migration(conn: &mut Connection, migration: &Migration) -> Result<(), duckdb::Error> {
    let tx = conn.transaction()?;
    tx.execute_batch(migration.sql)?;
    tx.execute("UPDATE meta.version SET value = ?", [migration.version])?;
    tx.commit()?;
    info!(version = migration.version, "applied migration");
    Ok(())
}

/// Opens the database in `db_dir`, migrating it if needed. The directory is
/// created (with any missing parents) if it doesn't exist yet.
pub fn get_db(db_dir: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    fs::create_dir_all(db_dir).map_err(|e| {
        format!(
            "couldn't create the database directory '{}': {e}",
            db_dir.display()
        )
    })?;
    let db_path = db_dir.join(DB_FILE_NAME);
    let mut conn = Connection::open(&db_path)?;
    init_db_version_metadata(&conn)?;
    let current_version = get_current_version(&conn)?;
    debug!(path = %db_path.display(), version = current_version, "opened database");
    let pending_migrations = MIGRATIONS
        .iter()
        .filter(|m| m.version > current_version)
        .collect::<Vec<_>>();

    for migration in &pending_migrations {
        run_migration(&mut conn, migration)?;
    }

    // Flush the migrated schema and data out of the WAL into the main file, as
    // every other write does (see `AppState::write`). Without this the WAL
    // lingers until something else checkpoints — the startup scan, which
    // `--no-scan` skips, or a clean shutdown.
    if !pending_migrations.is_empty() {
        conn.execute_batch("CHECKPOINT;")?;
        info!("checkpointed after migrations");
    }

    Ok(conn)
}

/// Applies every migration up to and including `version` to `conn`, each in its
/// own transaction exactly as [`get_db`] does. Tests use it for a fresh schema
/// (`u32::MAX` for all of them), or to stop short of a migration under test.
#[cfg(test)]
pub(crate) fn migrate_through(conn: &mut Connection, version: u32) {
    init_db_version_metadata(conn).unwrap();
    let current = get_current_version(conn).unwrap();
    for migration in MIGRATIONS
        .iter()
        .filter(|m| m.version > current && m.version <= version)
    {
        run_migration(conn, migration).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh scratch directory for one test, unique across the parallel
    /// tests of this process.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("radiocrate-db-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn migrating_leaves_no_wal_behind() {
        let dir = scratch_dir("wal");
        let wal_path = dir.join(format!("{DB_FILE_NAME}.wal"));

        let conn = get_db(&dir).unwrap();
        let wal_exists = wal_path.exists();
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();

        assert!(!wal_exists, "migrations left a WAL file behind");
    }

    #[test]
    fn creates_a_missing_db_dir() {
        let root = scratch_dir("create");
        let dir = root.join("nested").join(DB_DIR_NAME);

        let conn = get_db(&dir).unwrap();
        let db_exists = dir.join(DB_FILE_NAME).is_file();
        drop(conn);
        fs::remove_dir_all(&root).unwrap();

        assert!(db_exists, "no database file in the new directory");
    }
}
