use std::fs;
use std::path::{Path, PathBuf};

use tracing::{debug, info};

use crate::clock::ClockArgs;

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
    Migration {
        version: 13,
        sql: include_str!("migrations/0013.sql"),
    },
    Migration {
        version: 14,
        sql: include_str!("migrations/0014.sql"),
    },
    Migration {
        version: 15,
        sql: include_str!("migrations/0015.sql"),
    },
    Migration {
        version: 16,
        sql: include_str!("migrations/0016.sql"),
    },
    Migration {
        version: 17,
        sql: include_str!("migrations/0017.sql"),
    },
    Migration {
        version: 18,
        sql: include_str!("migrations/0018.sql"),
    },
    Migration {
        version: 19,
        sql: include_str!("migrations/0019.sql"),
    },
    Migration {
        version: 20,
        sql: include_str!("migrations/0020.sql"),
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

/// The directory, within the database directory, that `DuckDB` installs and
/// loads extensions from for this library.
static EXTENSION_DIR_NAME: &str = "extensions";

/// The configuration every connection to a library's database opens with.
///
/// Every timestamp the database makes has to be UTC (see
/// `specs/2026-11-utc-timestamps/decision.md`). The bundled `DuckDB` has no
/// ICU, the extension that knows time zones, and without it `now()` and every
/// cast between `TIMESTAMP` and `TIMESTAMPTZ` are UTC. The danger is ICU
/// arriving mid-session: a query that touches a time zone (`date_trunc` on a
/// `TIMESTAMPTZ`, say) loads it from `DuckDB`'s shared extension cache
/// (`~/.duckdb/extensions`) if some earlier `DuckDB` put it there, *even with
/// autoloading off*. From then on `CAST(NOW() AS TIMESTAMP)` answers in the
/// server's local zone, and time-relative filters shift by its offset. So:
///
/// - extensions live in a directory of the library's own
///   (`<db-dir>/extensions`), which ICU is never installed into, so there's
///   nothing for that lazy load to find: the query fails instead;
/// - autoloading and autoinstalling are off, so nothing is fetched from the
///   network behind a query's back either, and a query behaves the same on
///   every machine, the Raspberry Pi (which has no extensions at all)
///   included.
///
/// Extensions loaded on purpose still load: `--duckdb-server` runs `INSTALL
/// quack; LOAD quack;`, which downloads it into this directory the first time.
pub(crate) fn config(db_dir: &Path) -> Result<duckdb::Config, Box<dyn std::error::Error>> {
    let extensions = db_dir.join(EXTENSION_DIR_NAME);
    let extensions = extensions.to_str().ok_or_else(|| {
        format!(
            "the database directory '{}' isn't valid UTF-8",
            db_dir.display()
        )
    })?;
    Ok(duckdb::Config::default()
        .enable_autoload_extension(false)?
        .with("autoinstall_known_extensions", "false")?
        .with("extension_directory", extensions)?)
}

/// Opens the database in `db_dir`, migrating it if needed. The directory is
/// created (with any missing parents) if it doesn't exist yet.
///
/// `clock` is applied first, before the migrations, so a pinned clock (see
/// [`crate::clock`]) also stamps whatever they write.
pub fn get_db(db_dir: &Path, clock: &ClockArgs) -> Result<Connection, Box<dyn std::error::Error>> {
    fs::create_dir_all(db_dir).map_err(|e| {
        format!(
            "couldn't create the database directory '{}': {e}",
            db_dir.display()
        )
    })?;
    let db_path = db_dir.join(DB_FILE_NAME);
    let mut conn = Connection::open_with_flags(&db_path, config(db_dir)?)?;
    clock.apply(&conn)?;
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

    /// One value of `sql` on a library connection.
    fn value<T: duckdb::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// Every timestamp the database makes is UTC civil time, whatever the
    /// server's zone: `CAST(NOW() AS TIMESTAMP)` is the same instant as
    /// `now()` read as UTC. This is what time-relative filters compare stored
    /// timestamps against. See `specs/2026-11-utc-timestamps/decision.md`.
    #[test]
    fn the_database_clock_reads_utc() {
        let dir = scratch_dir("utc");
        let conn = get_db(&dir, &ClockArgs::default()).unwrap();
        let utc: bool = value(
            &conn,
            "SELECT epoch_ms(CAST(NOW() AS TIMESTAMP)) = epoch_ms(now())",
        );
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();
        assert!(utc, "CAST(NOW() AS TIMESTAMP) isn't UTC");
    }

    /// A query that would need ICU fails instead of loading it, so the
    /// database's zone can't change mid-session or between machines. Without
    /// the library's own extension directory, this loads ICU from the shared
    /// cache on any machine where some `DuckDB` once installed it, autoloading
    /// off or not.
    #[test]
    fn a_query_needing_icu_does_not_load_it() {
        let dir = scratch_dir("icu");
        let conn = get_db(&dir, &ClockArgs::default()).unwrap();
        let _ = conn.query_row("SELECT date_trunc('day', now())", [], |row| {
            row.get::<_, String>(0)
        });
        let loaded: bool = value(
            &conn,
            "SELECT coalesce(bool_or(loaded), false) FROM duckdb_extensions() \
             WHERE extension_name = 'icu'",
        );
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();
        assert!(!loaded, "ICU was loaded");
    }

    /// The time functions the app and its queries rely on, on the plain
    /// `TIMESTAMP` type every stored timestamp has, work without ICU.
    #[test]
    fn timestamp_functions_work_without_icu() {
        let dir = scratch_dir("functions");
        let conn = get_db(&dir, &ClockArgs::default()).unwrap();
        let ts = "TIMESTAMP '2026-01-15 12:00:00'";
        for (sql, expected) in [
            (format!("{ts} + INTERVAL 1 hour"), "2026-01-15 13:00:00"),
            (format!("{ts} - INTERVAL 1 month"), "2025-12-15 12:00:00"),
            (format!("date_trunc('day', {ts})"), "2026-01-15 00:00:00"),
            (format!("CAST({ts} AS TIMESTAMP_S)"), "2026-01-15 12:00:00"),
        ] {
            let got: String = value(&conn, &format!("SELECT CAST({sql} AS TEXT)"));
            assert_eq!(got, expected, "{sql}");
        }
        let formatted: String = value(&conn, &format!("SELECT strftime({ts}, '%H:%M')"));
        assert_eq!(formatted, "12:00");
        // The shape Querydown compiles a relative filter to: a stored
        // timestamp's age.
        let fresh: bool = value(
            &conn,
            "SELECT ABS(EXTRACT(epoch FROM CAST(NOW() AS TIMESTAMP) - \
             (CAST(NOW() AS TIMESTAMP) - INTERVAL 30 minute))) = 1800",
        );
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();
        assert!(fresh);
    }

    #[test]
    fn migrating_leaves_no_wal_behind() {
        let dir = scratch_dir("wal");
        let wal_path = dir.join(format!("{DB_FILE_NAME}.wal"));

        let conn = get_db(&dir, &ClockArgs::default()).unwrap();
        let wal_exists = wal_path.exists();
        drop(conn);
        fs::remove_dir_all(&dir).unwrap();

        assert!(!wal_exists, "migrations left a WAL file behind");
    }

    #[test]
    fn creates_a_missing_db_dir() {
        let root = scratch_dir("create");
        let dir = root.join("nested").join(DB_DIR_NAME);

        let conn = get_db(&dir, &ClockArgs::default()).unwrap();
        let db_exists = dir.join(DB_FILE_NAME).is_file();
        drop(conn);
        fs::remove_dir_all(&root).unwrap();

        assert!(db_exists, "no database file in the new directory");
    }
}
