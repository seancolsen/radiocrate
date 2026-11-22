use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use api_schema::Topic;
use arrow_ipc::writer::StreamWriter;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{Response, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post};
use bytes::Bytes;
use duckdb::Connection;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;
use tracing::{Instrument, debug, error, info, info_span, warn};

use crate::changes::{Changes, OutsideWrites};

pub struct AppState {
    db: Mutex<Connection>,
    /// The change topics' versions, and the stream their changes go out on.
    pub changes: Changes,
    /// The outside-writer check, once [`crate::changes::watch_outside_writes`]
    /// has started it: the app's own writes re-take its fingerprint.
    outside_writes: OnceLock<OutsideWrites>,
    pub collection_path: PathBuf,
    /// Identifies the frontend build this binary serves, reported over
    /// `app.version` so a client can tell whether it's the one that came with
    /// this binary. Supplied by the caller rather than read here: the embedded
    /// assets belong to the `radiocrate` crate, not to this one.
    pub build_id: String,
    /// This binary's version string, for display only.
    pub server_version: String,
}

impl AppState {
    /// Run a read-only DB operation under the connection lock.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let conn = self.db.lock().unwrap();
        f(&conn)
    }

    /// Run a data-modifying DB operation under the lock, then `CHECKPOINT`,
    /// then announce `topics` on the change stream.
    ///
    /// On success the WAL has been flushed to the main database file. Every
    /// mutation must flow through this method so the checkpoint can never be
    /// forgotten; this is why [`AppState::db`] is private.
    ///
    /// `topics` are the kinds of live data the write changes (see
    /// [`crate::changes`]). They're required for the same reason the checkpoint
    /// is built in: a write that changes nothing live says so with `&[]`, so a
    /// new method can't announce nothing by accident. `origin` is the client
    /// that asked for the write, which its own announcement carries so it can
    /// skip its echo.
    ///
    /// If the mutation succeeds but the `CHECKPOINT` fails, this returns
    /// `Err("checkpoint failed after write: ...")`. The mutation is already
    /// committed and durable in the WAL, so that error is not a signal to retry
    /// the write — and the topics are still announced, since they did change.
    pub fn write<T>(
        &self,
        origin: Option<&str>,
        topics: &[Topic],
        f: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        self.write_mut(origin, topics, |conn| f(conn))
    }

    /// Like [`AppState::write`], but hands the closure a `&mut Connection` so it can open a
    /// transaction (`DuckDB`'s `Connection::transaction` requires `&mut`). Used by the DML API, which
    /// runs a whole batch of operations inside one `BEGIN … COMMIT` and then checkpoints once.
    ///
    /// The same checkpoint and announcement invariants apply. The error type is generic so callers
    /// can carry structured errors (e.g. [`crate::rpc::RpcErr`]); a checkpoint failure is surfaced
    /// through `E: From<String>`.
    pub fn write_mut<T, E: From<String>>(
        &self,
        origin: Option<&str>,
        topics: &[Topic],
        f: impl FnOnce(&mut Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut conn = self.db.lock().unwrap();
        let value = f(&mut conn)?;
        let checkpoint = conn.execute_batch("CHECKPOINT;");
        // Still under the lock, so no outside write can slip in between this
        // write and its being counted as the app's own.
        if let Some(outside) = self.outside_writes.get() {
            outside.rebaseline(&conn);
        }
        self.changes.announce(topics, origin);
        checkpoint.map_err(|e| E::from(format!("checkpoint failed after write: {e}")))?;
        Ok(value)
    }

    /// Takes the outside-writer check's first fingerprint. `false` if it was
    /// already started.
    pub(crate) fn start_watching_outside_writes(&self) -> bool {
        let conn = self.db.lock().unwrap();
        self.outside_writes.set(OutsideWrites::new(&conn)).is_ok()
    }

    /// Announces each topic an outside writer has changed since the last look.
    pub(crate) fn announce_outside_writes(&self) {
        let Some(outside) = self.outside_writes.get() else {
            return;
        };
        let conn = self.db.lock().unwrap();
        let changed = outside.changed(&conn);
        if !changed.is_empty() {
            info!(?changed, "a DuckDB client changed live data");
            self.changes.announce(&changed, None);
        }
    }
}

pub fn app_state(
    conn: Connection,
    collection_path: PathBuf,
    build_id: String,
    server_version: String,
) -> Arc<AppState> {
    let collection_path = std::fs::canonicalize(&collection_path).unwrap_or(collection_path);
    Arc::new(AppState {
        db: Mutex::new(conn),
        changes: Changes::new(),
        outside_writes: OnceLock::new(),
        collection_path,
        build_id,
        server_version,
    })
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/query", post(query))
        .route("/rpc", post(crate::rpc::rpc))
        .route("/events", get(crate::changes::events))
        .route("/tracks/{id}/stream", get(crate::stream::stream_track))
        .route("/reauth", get(reauth))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Sends a browser back to the app once an authenticating reverse proxy has let
/// it through — the client's way out of a login it cannot otherwise reach.
///
/// A PWA behind a redirect-based identity proxy (Cloudflare Access here, but
/// oauth2-proxy and friends work the same way) has a bootstrapping problem: the
/// service worker answers navigations from its precache, so the proxy never gets
/// to redirect one to its sign-in page. All that reaches the network are
/// `fetch`es, and a `fetch` cannot render a sign-in page — it just fails. The
/// session cannot be renewed from inside the app, no matter how many times it is
/// reopened.
///
/// So the client navigates here instead. This path lives under `/api`, which the
/// service worker is configured never to answer (see
/// `navigateFallbackDenylist`), so the request reaches the proxy, which
/// intercepts it, authenticates the browser and sends it back — at which point
/// this handler bounces it to the app root. The response body is never seen; the
/// redirect is the whole payload.
///
/// With nothing in front of us it is simply a redirect to `/`, which is what
/// lets the client call it without knowing whether it is proxied.
async fn reauth() -> impl IntoResponse {
    // `no-store` because a cached bounce would skip the trip to the proxy that
    // is the entire point of this endpoint.
    (
        [(header::CACHE_CONTROL, "no-store")],
        // 303: this is a redirect to a different resource, not a relocation of
        // `/api/reauth` itself, and it must be followed with GET.
        Redirect::to("/"),
    )
}

/// Bridges synchronous Arrow IPC writes to an async byte stream.
///
/// Arrow's `StreamWriter` requires a synchronous `Write` target. This adapter
/// buffers incoming writes and flushes completed chunks through a tokio mpsc
/// channel, which the Axum handler consumes as a streaming HTTP response body.
struct ChannelWriter {
    tx: mpsc::Sender<io::Result<Bytes>>,
    buf: Vec<u8>,
}

impl ChannelWriter {
    fn send_buffered(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            let bytes = Bytes::from(std::mem::take(&mut self.buf));
            self.tx
                .blocking_send(Ok(bytes))
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "client disconnected"))?;
        }
        Ok(())
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send_buffered()
    }
}

impl Drop for ChannelWriter {
    fn drop(&mut self) {
        let _ = self.send_buffered();
    }
}

/// Logs one record per HTTP request, and puts every record a handler emits while
/// serving it inside a `request{…}` span so it can be tied back to the request
/// that caused it.
///
/// At `DEBUG`, because a music player asks for a lot of bytes and an access log
/// at `INFO` would bury everything else; `RUST_LOG=backend::server=debug` turns
/// it on. Server errors are logged at `WARN` regardless, since those are worth
/// seeing without knowing in advance to ask.
///
/// Apply this once, at the outermost router, so the count is one record per
/// request rather than one per nested layer.
pub async fn log_requests(request: Request, next: Next) -> axum::response::Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    async move {
        let started = Instant::now();
        let response = next.run(request).await;
        let status = response.status();
        let elapsed_ms = started.elapsed().as_millis();
        if status.is_server_error() {
            warn!(status = status.as_u16(), elapsed_ms, "request failed");
        } else {
            debug!(status = status.as_u16(), elapsed_ms, "request");
        }
        response
    }
    .instrument(info_span!("request", %method, path))
    .await
}

async fn query(State(state): State<Arc<AppState>>, body: String) -> Response<Body> {
    // Kept for the error paths below; the body itself moves into the blocking
    // task. Cheap for the queries this endpoint sees, and it is the single most
    // useful thing to have in the log when one of them fails.
    let sql = body.clone();
    let (tx, rx) = mpsc::channel::<io::Result<Bytes>>(8);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    tokio::task::spawn_blocking(move || {
        state.read(|conn| {
            let mut stmt = match conn.prepare(&body) {
                Ok(stmt) => stmt,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };

            let batches = match stmt.query_arrow([]) {
                Ok(b) => b,
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };

            let schema = batches.get_schema();
            let _ = ready_tx.send(Ok(()));

            // Past this point, errors during streaming simply truncate the
            // response. The client will detect the missing IPC EOS marker.
            let writer = ChannelWriter {
                tx,
                buf: Vec::new(),
            };
            let Ok(mut ipc_writer) = StreamWriter::try_new(writer, &schema) else {
                return;
            };
            for batch in batches {
                if ipc_writer.write(&batch).is_err() {
                    return;
                }
            }
            let _ = ipc_writer.finish();
        });
    });

    match ready_rx.await {
        Ok(Ok(())) => {
            let stream = ReceiverStream::new(rx);
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/vnd.apache.arrow.stream")
                .body(Body::from_stream(stream))
                .unwrap()
        }
        Ok(Err(msg)) => {
            // `WARN`, not `ERROR`: a rejected query is normally someone typing
            // SQL, not the server misbehaving. Both the query and DuckDB's
            // reply are multi-line more often than not, which is exactly what
            // the JSON field encoding is for.
            warn!(sql = %sql, error = %msg, "query rejected");
            Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::from(msg))
                .unwrap()
        }
        Err(_) => {
            error!(sql = %sql, "query task panicked");
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("query task panicked"))
                .unwrap()
        }
    }
}

/// Serves the API alone. `watch_outside_writes` says whether `DuckDB` clients
/// can write to the database meanwhile (`--duckdb-server`), so the change
/// stream has to watch for them (see [`crate::changes::watch_outside_writes`]).
pub async fn serve(
    conn: Connection,
    collection_path: PathBuf,
    port: u16,
    watch_outside_writes: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Nest under `/api` so this standalone (frontend-less) dev server exposes the
    // same paths the production `radiocrate` binary does (which does the same nest
    // in its own `main.rs`). That lets the Vite dev server proxy `/api` straight
    // here with no path rewriting, and keeps client URLs origin-relative and
    // identical across dev and prod. See `frontend/README.md`.
    // `DEV_BUILD_ID` because this server embeds no frontend: the client it talks
    // to is whatever the Vite dev server is serving, which is by definition
    // current. Reporting the sentinel tells the client to skip the staleness
    // check rather than compare against an id that can't ever match.
    let state = app_state(
        conn,
        collection_path,
        api_schema::DEV_BUILD_ID.to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    );
    if watch_outside_writes {
        crate::changes::watch_outside_writes(&state);
    }
    let app = Router::new()
        .nest("/api", router(state))
        .layer(axum::middleware::from_fn(log_requests));
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    info!(addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
