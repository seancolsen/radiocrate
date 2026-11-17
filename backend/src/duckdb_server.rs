//! Lets other `DuckDB` clients reach the collection's database while the app runs.
//!
//! `DuckDB` locks its database file to the one process that opens it, so while
//! the app is serving, `duckdb radiocrate.db` can't open the file, not even
//! read-only. `DuckDB` 2.0's Quack protocol gets around that: the process that
//! owns the database serves it, and clients `ATTACH 'quack:…'` to it. This
//! module runs that server from inside the app when asked to with
//! `--duckdb-server`. Using it from the `duckdb` CLI is documented in the
//! README, under "Connecting `DuckDB` clients".
//!
//! Quack lives in the `quack` extension, which the bundled build can't compile
//! in (the crate has no feature for it), so it's installed from `DuckDB`'s
//! extension repository on first use and loaded from the local cache after
//! that. `DuckDB` publishes no extensions for 32-bit ARM, so this can't work in
//! the Raspberry Pi build. That's why it's opt-in and fails loudly.

use duckdb::{Connection, params};
use tracing::info;

/// The environment variable holding the token clients must present. It's read
/// from the environment, not taken as a flag, so it stays out of `ps` and
/// shell history.
pub const TOKEN_ENV: &str = "RADIOCRATE_DUCKDB_TOKEN";

/// Quack's own default port, so a client's `quack:localhost` finds us unaided.
pub const DEFAULT_PORT: u16 = 9494;

/// Flags for serving the database to other `DuckDB` clients. Flatten this into
/// a subcommand's arguments, then call [`DuckdbServerArgs::start_if_enabled`]
/// once the database is open.
#[derive(Clone, Debug, clap::Args)]
#[command(next_help_heading = "DuckDB server")]
pub struct DuckdbServerArgs {
    // Help text as an attribute rather than a doc comment: clap prints it
    // verbatim, so it can't carry the backticks clippy wants around names.
    #[arg(
        long,
        help = "Let DuckDB clients, such as the duckdb CLI, connect to the database \
                while the app runs (DuckDB's Quack protocol). Listens on localhost \
                only. Clients authenticate with the token in $RADIOCRATE_DUCKDB_TOKEN, \
                or with a random one, logged at startup, if that isn't set"
    )]
    pub duckdb_server: bool,

    /// Port for --duckdb-server to listen on
    #[arg(
        long,
        value_name = "PORT",
        default_value_t = DEFAULT_PORT,
        requires = "duckdb_server"
    )]
    pub duckdb_server_port: u16,
}

impl DuckdbServerArgs {
    /// Starts the server on `conn`'s database if `--duckdb-server` was given.
    /// The server runs on `DuckDB`'s own threads and lives as long as the
    /// database does, so `conn` can go on to be used (and moved) as usual.
    pub fn start_if_enabled(&self, conn: &Connection) -> Result<(), String> {
        if !self.duckdb_server {
            return Ok(());
        }
        let (token, generated) = match std::env::var(TOKEN_ENV) {
            Ok(token) if !token.is_empty() => (token, false),
            _ => (uuid::Uuid::new_v4().simple().to_string(), true),
        };
        let uri = start(conn, self.duckdb_server_port, &token)?;
        info!(uri, "DuckDB server listening");
        if generated {
            // The only way the user can learn it. Choosing one through the
            // environment keeps it out of the log and stable across restarts.
            info!(
                token,
                "generated a DuckDB server token (set {TOKEN_ENV} to choose one)"
            );
        }
        Ok(())
    }
}

/// The path of the database `conn` is using. Asked of both ends to confirm
/// that the server on the port really is this one.
const OWN_PATH_SQL: &str =
    "SELECT path FROM duckdb_databases() WHERE database_name = current_database()";

/// Loads Quack, serves `conn`'s database on localhost at `port`, and checks
/// that the server answers. Returns the URI clients attach to.
fn start(conn: &Connection, port: u16, token: &str) -> Result<String, String> {
    conn.execute_batch("INSTALL quack; LOAD quack;")
        .map_err(|e| {
            format!(
                "--duckdb-server needs DuckDB's quack extension, which couldn't be loaded. \
                 DuckDB downloads it from extensions.duckdb.org the first time, so that needs \
                 network access, and there is no build of it for 32-bit ARM: {e}"
            )
        })?;

    let uri = format!("quack:localhost:{port}");
    // `CALL` can't be prepared, but the table-function form can, which keeps
    // the token out of the SQL text.
    conn.query_row(
        "SELECT listen_uri FROM quack_serve(?, token = ?)",
        params![uri, token],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| format!("couldn't start the DuckDB server on {uri}: {e}"))?;

    verify(conn, &uri, port, token)?;
    Ok(uri)
}

/// Queries the new server through Quack, as a client would, and checks that it
/// answers for this database.
///
/// `quack_serve` reports success even when another `DuckDB` process already
/// serves the port. Both then accept connections on it, and a client's
/// requests land on one or the other. Asking the server which file it serves
/// catches that in practice, either as the other database's path or as a
/// failed request. It's a check, not a guarantee, since every request could
/// happen to land on us. It also proves the round trip works.
fn verify(conn: &Connection, uri: &str, port: u16, token: &str) -> Result<(), String> {
    let ours: Option<String> = conn
        .query_row(OWN_PATH_SQL, [], |row| row.get(0))
        .map_err(|e| format!("couldn't read this database's path: {e}"))?;
    let theirs: Option<String> = conn
        .query_row(
            "SELECT path FROM quack_query(?, ?, token = ?)",
            params![uri, OWN_PATH_SQL, token],
            |row| row.get(0),
        )
        .map_err(|e| {
            format!(
                "the DuckDB server on {uri} doesn't answer ({e}). If another program is using \
                 port {port}, choose a different one with --duckdb-server-port"
            )
        })?;
    if theirs != ours {
        return Err(format!(
            "port {port} is answered by another DuckDB server (serving {}); choose a different \
             port with --duckdb-server-port",
            theirs.as_deref().unwrap_or("an in-memory database")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};
    use std::fs;
    use std::path::PathBuf;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        server: DuckdbServerArgs,
    }

    #[test]
    fn the_flags_parse() {
        Cli::command().debug_assert();

        let off = Cli::try_parse_from(["rc"]).unwrap().server;
        assert!(!off.duckdb_server);

        let on = Cli::try_parse_from(["rc", "--duckdb-server"])
            .unwrap()
            .server;
        assert!(on.duckdb_server);
        assert_eq!(on.duckdb_server_port, DEFAULT_PORT);

        let port = Cli::try_parse_from(["rc", "--duckdb-server", "--duckdb-server-port", "9500"])
            .unwrap()
            .server;
        assert_eq!(port.duckdb_server_port, 9500);

        // A port alone is a mistake, not a quiet no-op.
        assert!(Cli::try_parse_from(["rc", "--duckdb-server-port", "9500"]).is_err());
    }

    #[test]
    fn disabled_does_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        let args = Cli::try_parse_from(["rc"]).unwrap().server;
        args.start_if_enabled(&conn).unwrap();
        let loaded: bool = conn
            .query_row(
                "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'quack'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!loaded, "quack was loaded without --duckdb-server");
    }

    /// A fresh scratch directory for one test, unique across the parallel
    /// tests of this process.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "radiocrate-duckdb-server-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Serves a database, then reads and writes it from a second, separate
    /// `DuckDB` instance over Quack, the way the `duckdb` CLI would.
    ///
    /// Ignored by default: the first run downloads the quack extension from
    /// extensions.duckdb.org. Run it with `cargo test -p backend duckdb_server
    /// -- --ignored`.
    #[test]
    #[ignore = "downloads DuckDB's quack extension"]
    fn a_separate_duckdb_instance_reads_and_writes_through_the_server() {
        let dir = scratch_dir("roundtrip");
        let server = Connection::open(dir.join("served.db")).unwrap();
        server
            .execute_batch("CREATE TABLE track (title VARCHAR); INSERT INTO track VALUES ('One');")
            .unwrap();
        let port = 9_811;
        let uri = start(&server, port, "test-token").unwrap();
        assert_eq!(uri, format!("quack:localhost:{port}"));

        let client = Connection::open_in_memory().unwrap();
        client
            .execute_batch(&format!(
                "LOAD quack; ATTACH '{uri}' AS rc (TOKEN 'test-token'); \
                 INSERT INTO rc.track VALUES ('Two');"
            ))
            .unwrap();
        let titles: String = client
            .query_row(
                "SELECT string_agg(title, ',' ORDER BY title) FROM rc.track",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(titles, "One,Two");

        // The client's write landed in the served database itself.
        let count: i64 = server
            .query_row("SELECT count(*) FROM track", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // A wrong token is turned away.
        let stranger = Connection::open_in_memory().unwrap();
        let refused = stranger.execute_batch(&format!(
            "LOAD quack; ATTACH '{uri}' AS rc (TOKEN 'wrong-token'); FROM rc.track;"
        ));
        assert!(refused.is_err(), "a wrong token was accepted");

        drop((client, stranger, server));
        fs::remove_dir_all(&dir).unwrap();
    }
}
