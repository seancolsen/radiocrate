//! A pinned clock for end-to-end tests.
//!
//! The E2E suite runs the app against a fixture generated as if it were one
//! fixed instant, and freezes the browser's `Date` at that instant too (see
//! `specs/2026-11-e2e-tests/spec.md`, "Time"). The database's own `now()` has
//! to agree, or a time-relative filter such as `added:<6m` would match a
//! different set of rows as the calendar moves away from the fixture's date.
//!
//! `--fixed-now` does that by shadowing `DuckDB`'s clock functions with
//! temporary macros on the app's one connection. A temp macro is visible only
//! to the connection that made it and writes nothing to the file, and it's
//! picked up everywhere the built-in would be: in a query, inside
//! `CAST(NOW() AS TIMESTAMP)`, and in a column's `DEFAULT now()`.
//!
//! The option is hidden from `--help`. Nothing but the test suite should use it.

use duckdb::Connection;
use jiff::Timestamp;
use tracing::info;

/// The clock flag shared by every subcommand that opens a database. Flatten
/// this into the subcommand's arguments and hand it to [`crate::db::get_db`].
#[derive(Clone, Debug, Default, clap::Args)]
pub struct ClockArgs {
    /// Pin the database's `now()` to this instant (RFC 3339, with an offset,
    /// e.g. `2026-01-15T12:00:00Z`). For end-to-end tests only.
    #[arg(long, value_name = "INSTANT", hide = true)]
    pub fixed_now: Option<Timestamp>,
}

/// The clock functions shadowed, each with the type the built-in returns.
/// `current_timestamp` and `current_date` are spelled without parentheses in
/// SQL, but resolve to these macros all the same. `transaction_timestamp()`
/// and `current_localtimestamp()` aren't covered; nothing in the app calls
/// them.
const TIMESTAMP_FUNCTIONS: &[&str] = &["now", "current_timestamp", "get_current_timestamp"];
const DATE_FUNCTIONS: &[&str] = &["today", "current_date"];

/// The SQL that pins `conn`'s clock at `instant`, in UTC.
fn pin_sql(instant: Timestamp) -> String {
    // Formatted from a parsed `Timestamp`, never from the user's text, so
    // nothing but a well-formed literal can reach the SQL.
    let utc = instant.to_zoned(jiff::tz::TimeZone::UTC);
    let timestamp = utc.strftime("%Y-%m-%d %H:%M:%S%.f+00");
    let date = utc.strftime("%Y-%m-%d");
    let timestamps = TIMESTAMP_FUNCTIONS.iter().map(|name| {
        format!("CREATE OR REPLACE TEMP MACRO {name}() AS (TIMESTAMPTZ '{timestamp}');")
    });
    let dates = DATE_FUNCTIONS
        .iter()
        .map(|name| format!("CREATE OR REPLACE TEMP MACRO {name}() AS (DATE '{date}');"));
    timestamps.chain(dates).collect::<Vec<_>>().join("\n")
}

impl ClockArgs {
    /// Pins `conn`'s clock if `--fixed-now` was given. Call it before anything
    /// else runs on the connection, migrations included, so that every
    /// timestamp they write comes from the pinned instant.
    pub fn apply(&self, conn: &Connection) -> Result<(), duckdb::Error> {
        let Some(instant) = self.fixed_now else {
            return Ok(());
        };
        conn.execute_batch(&pin_sql(instant))?;
        info!(%instant, "pinned the database clock");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTANT: &str = "TIMESTAMPTZ '2026-01-15 12:00:00+00'";

    fn pinned() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let args = ClockArgs {
            fixed_now: Some("2026-01-15T12:00:00Z".parse().unwrap()),
        };
        args.apply(&conn).unwrap();
        conn
    }

    fn holds(conn: &Connection, condition: &str) -> bool {
        conn.query_row(&format!("SELECT {condition}"), [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn pins_every_clock_function() {
        let conn = pinned();
        for expr in ["now()", "current_timestamp", "get_current_timestamp()"] {
            assert!(holds(&conn, &format!("{expr} = {INSTANT}")), "{expr}");
        }
        // The cast to a civil time is what Querydown compiles a relative
        // filter to. It goes through the session's time zone either way.
        assert!(holds(
            &conn,
            &format!("CAST(NOW() AS TIMESTAMP) = CAST({INSTANT} AS TIMESTAMP)")
        ));
        for expr in ["today()", "current_date"] {
            assert!(
                holds(&conn, &format!("{expr} = DATE '2026-01-15'")),
                "{expr}"
            );
        }
    }

    #[test]
    fn pins_a_column_default() {
        let conn = pinned();
        conn.execute_batch(
            "CREATE TABLE t (a INT, ts TIMESTAMPTZ NOT NULL DEFAULT now());
             INSERT INTO t (a) VALUES (1);",
        )
        .unwrap();
        assert!(holds(&conn, &format!("(SELECT ts FROM t) = {INSTANT}")));
    }

    #[test]
    fn leaves_the_clock_alone_by_default() {
        let conn = Connection::open_in_memory().unwrap();
        ClockArgs::default().apply(&conn).unwrap();
        assert!(!holds(&conn, &format!("now() = {INSTANT}")));
    }
}
