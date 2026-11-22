//! Change topics: how the server tells every device in the foreground that a
//! kind of live data has changed, so it can refetch that list.
//!
//! A [`Topic`] is a kind of live data (sources, keybindings, the prelude …) and
//! a version number. Every write names the topics it changes (see
//! [`crate::server::AppState::write`]), and once it has committed each one's
//! version goes up and a [`TopicChanged`] goes out to every subscriber. The
//! stream (`GET /api/events`, [`events`]) carries only which topic changed,
//! never what it changed to: a device refetches through the same RPC it boots
//! with.
//!
//! Versions are kept in memory and start over at 0 on every start, under a new
//! random `epoch`, so a device that sees a new epoch knows to forget what it
//! knew. See `specs/2026-11-live-updates/spec.md`.

use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use api_schema::{EventsHello, Topic, TopicChanged};
use axum::extract::State;
use axum::http::header;
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use duckdb::Connection;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, info, warn};

use crate::server::AppState;

/// How many announcements a subscriber may fall behind by before it's dropped.
/// A dropped subscriber reconnects into a fresh `hello`, so falling behind
/// never means missing a change; this only bounds the memory a stalled
/// connection can hold.
const CHANNEL_CAPACITY: usize = 256;

/// How often the stream sends a comment when nothing has changed, so a proxy
/// doesn't close an idle connection. Cloudflare's idle limit is 100 s.
const KEEP_ALIVE: Duration = Duration::from_secs(25);

/// How often the outside-writer check takes its fingerprint (see
/// [`OutsideWrites`]).
const FINGERPRINT_INTERVAL: Duration = Duration::from_secs(3);

/// The topics' versions, and the channel their changes go out on.
pub struct Changes {
    epoch: String,
    versions: Mutex<BTreeMap<Topic, u64>>,
    sender: broadcast::Sender<TopicChanged>,
}

impl Default for Changes {
    fn default() -> Self {
        Self::new()
    }
}

impl Changes {
    #[must_use]
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            versions: Mutex::new(Topic::ALL.iter().map(|&t| (t, 0)).collect()),
            sender,
        }
    }

    /// Bumps each of `topics` once (a topic named twice still moves by one) and
    /// tells every subscriber. `origin` is the client that made the write, or
    /// `None` for the server's own and for outside writers.
    pub fn announce(&self, topics: &[Topic], origin: Option<&str>) {
        if topics.is_empty() {
            return;
        }
        let topics: BTreeSet<Topic> = topics.iter().copied().collect();
        // Sent under the lock, so a subscriber's `hello` (taken under it too)
        // and the changes that follow it can never overlap or leave a gap.
        let mut versions = self.versions.lock().unwrap();
        for topic in topics {
            let version = versions.entry(topic).or_default();
            *version += 1;
            debug!(?topic, version = *version, origin, "topic changed");
            // An error only means nobody is listening.
            let _ = self.sender.send(TopicChanged {
                topic,
                version: *version,
                origin: origin.map(str::to_owned),
            });
        }
    }

    /// The `hello` for a new subscriber, and the receiver its changes arrive
    /// on: every change after the versions in `hello`, and none before.
    pub fn subscribe(&self) -> (EventsHello, broadcast::Receiver<TopicChanged>) {
        let versions = self.versions.lock().unwrap();
        let receiver = self.sender.subscribe();
        let hello = EventsHello {
            epoch: self.epoch.clone(),
            versions: versions.clone(),
        };
        (hello, receiver)
    }

    /// How many devices are listening right now.
    pub fn listeners(&self) -> usize {
        self.sender.receiver_count()
    }
}

/// `GET /api/events`: the change stream, as Server-Sent Events. A `hello`
/// first, then a `changed` for every announcement, and a comment every
/// [`KEEP_ALIVE`] in between.
pub(crate) async fn events(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (hello, mut changes) = state.changes.subscribe();
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(16);
    tokio::spawn(async move {
        if tx.send(Ok(event("hello", &hello))).await.is_err() {
            return;
        }
        loop {
            tokio::select! {
                // The client went away: let go of the subscription now rather
                // than on the next change.
                () = tx.closed() => return,
                received = changes.recv() => match received {
                    Ok(change) => {
                        if tx.send(Ok(event("changed", &change))).await.is_err() {
                            return;
                        }
                    }
                    // Fell behind (or the server is shutting down). Closing
                    // the stream sends the client back for a fresh `hello`,
                    // which tells it what it missed.
                    Err(e) => {
                        debug!(error = %e, "closing a change stream");
                        return;
                    }
                },
            }
        }
    });
    (
        [
            (header::CACHE_CONTROL, "no-cache"),
            // Tells nginx-style proxies not to buffer the stream.
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::new().interval(KEEP_ALIVE)),
    )
}

fn event(name: &str, payload: &impl serde::Serialize) -> Event {
    // Serializing these plain structs can't fail.
    let data = serde_json::to_string(payload).unwrap_or_default();
    Event::default().event(name).data(data)
}

// ---------------------------------------------------------------------------
// Outside writers
// ---------------------------------------------------------------------------

/// The tables each topic's list is read from, for the outside-writer
/// fingerprint. `Schema` has none: it's the catalog, fingerprinted whole.
const TOPIC_TABLES: &[(Topic, &[&str])] = &[
    (
        Topic::Sources,
        &["source", "query", "playlist", "source_folder"],
    ),
    (Topic::Presets, &["preset"]),
    (Topic::Settings, &["settings.settings"]),
    (Topic::Keybindings, &["settings.keybinding"]),
    (Topic::FieldMetadata, &["metadata.field"]),
    (Topic::TableSettings, &["metadata.\"table\""]),
    (Topic::ComputedColumns, &["metadata.computed_column"]),
    (Topic::CustomComparisons, &["metadata.custom_comparison"]),
    (Topic::ContextualQueries, &["contextual_query"]),
    (Topic::Ratings, &["rating"]),
];

/// Watches for writes that don't go through [`AppState::write`]: a `DuckDB`
/// client attached through `--duckdb-server`, the only other thing that can
/// write while the app runs.
///
/// Every [`FINGERPRINT_INTERVAL`], while a device is listening, it hashes the
/// catalog and each topic's tables (all small), and announces each topic whose
/// hash moved, with no origin. The app's own writes re-take the fingerprint
/// before they let go of the connection (see [`OutsideWrites::rebaseline`]),
/// so they're never mistaken for an outside writer's.
pub struct OutsideWrites {
    baseline: Mutex<BTreeMap<Topic, String>>,
}

impl OutsideWrites {
    pub(crate) fn new(conn: &Connection) -> Self {
        Self {
            baseline: Mutex::new(fingerprint(conn)),
        }
    }

    /// Takes the fingerprint afresh, so whatever is in the database now counts
    /// as already announced. Called with the connection still locked after
    /// each of the app's own writes.
    pub(crate) fn rebaseline(&self, conn: &Connection) {
        *self.baseline.lock().unwrap() = fingerprint(conn);
    }

    /// The topics whose fingerprint has moved since the last look, which then
    /// becomes the baseline.
    pub(crate) fn changed(&self, conn: &Connection) -> Vec<Topic> {
        let now = fingerprint(conn);
        let mut baseline = self.baseline.lock().unwrap();
        let changed = now
            .iter()
            .filter(|(topic, hash)| baseline.get(topic) != Some(hash))
            .map(|(&topic, _)| topic)
            .collect();
        *baseline = now;
        changed
    }
}

/// Starts the outside-writer check for `state` (see [`OutsideWrites`]). Call it
/// only when `--duckdb-server` is on: without it there is nothing to watch.
pub fn watch_outside_writes(state: &Arc<AppState>) {
    if !state.start_watching_outside_writes() {
        return;
    }
    info!("watching for writes from DuckDB clients");
    let state = Arc::clone(state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(FINGERPRINT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            // Nobody to tell. The baseline stays where it was, so a change made
            // meanwhile is still caught on the first look once someone is.
            if state.changes.listeners() == 0 {
                continue;
            }
            let state = Arc::clone(&state);
            let result = tokio::task::spawn_blocking(move || state.announce_outside_writes()).await;
            if let Err(e) = result {
                warn!(error = %e, "the outside-writer check panicked");
            }
        }
    });
}

/// Each topic's hash, and the catalog's under `Schema`. A table that can't be
/// read (dropped by an outside writer, say) hashes as the error, which still
/// differs from what it was.
fn fingerprint(conn: &Connection) -> BTreeMap<Topic, String> {
    let mut out = BTreeMap::new();
    for (topic, tables) in TOPIC_TABLES {
        let mut hasher = blake3::Hasher::new();
        for table in *tables {
            hasher.update(table_hash(conn, table).as_bytes());
            hasher.update(b"\n");
        }
        out.insert(*topic, hasher.finalize().to_hex().to_string());
    }
    let catalog = conn
        .query_row(introspection::introspection_sql(), [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap_or_else(|e| format!("error: {e}"));
    out.insert(
        Topic::Schema,
        blake3::hash(catalog.as_bytes()).to_hex().to_string(),
    );
    out
}

/// An order-independent hash of every row of `table`, and how many there are.
fn table_hash(conn: &Connection, table: &str) -> String {
    conn.query_row(
        &format!("SELECT count(*), coalesce(sum(hash(t)::hugeint), 0)::varchar FROM {table} t"),
        [],
        |row| {
            Ok(format!(
                "{}:{}",
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?
            ))
        },
    )
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_through(&mut conn, u32::MAX);
        conn
    }

    #[test]
    fn a_subscriber_hears_each_change_after_its_hello() {
        let changes = Changes::new();
        changes.announce(&[Topic::Sources], None);
        let (hello, mut rx) = changes.subscribe();
        assert_eq!(hello.versions[&Topic::Sources], 1);
        assert_eq!(hello.versions[&Topic::Presets], 0);
        assert_eq!(hello.versions.len(), Topic::ALL.len());

        changes.announce(&[Topic::Sources, Topic::Presets, Topic::Sources], Some("a"));
        let first = rx.try_recv().unwrap();
        let second = rx.try_recv().unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(
            (first.topic, first.version, first.origin.as_deref()),
            (Topic::Sources, 2, Some("a"))
        );
        assert_eq!((second.topic, second.version), (Topic::Presets, 1));
    }

    #[test]
    fn nothing_to_announce_bumps_nothing() {
        let changes = Changes::new();
        let (_, mut rx) = changes.subscribe();
        changes.announce(&[], None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn every_live_topic_but_schema_has_tables_to_fingerprint() {
        let listed: BTreeSet<Topic> = TOPIC_TABLES.iter().map(|(t, _)| *t).collect();
        let expected: BTreeSet<Topic> = Topic::ALL
            .iter()
            .copied()
            .filter(|t| *t != Topic::Schema)
            .collect();
        assert_eq!(listed, expected);
    }

    #[test]
    fn the_fingerprint_reads_every_table() {
        let conn = setup();
        for (topic, hash) in fingerprint(&conn) {
            let tables = TOPIC_TABLES
                .iter()
                .find(|(t, _)| *t == topic)
                .map_or(&[][..], |(_, tables)| *tables);
            for table in tables {
                assert!(
                    !table_hash(&conn, table).starts_with("error"),
                    "{table} can't be read"
                );
            }
            assert!(!hash.is_empty());
        }
    }

    #[test]
    fn an_outside_write_moves_only_its_topic() {
        let conn = setup();
        let outside = OutsideWrites::new(&conn);
        assert!(outside.changed(&conn).is_empty());

        conn.execute_batch("INSERT INTO settings.keybinding VALUES ('tabs.save_active', 'Ctrl+S')")
            .unwrap();
        assert_eq!(outside.changed(&conn), vec![Topic::Keybindings]);
        assert!(outside.changed(&conn).is_empty());

        conn.execute_batch("ALTER TABLE track ADD COLUMN mood VARCHAR")
            .unwrap();
        assert_eq!(outside.changed(&conn), vec![Topic::Schema]);
    }

    #[test]
    fn a_rebaselined_write_isnt_an_outside_one() {
        let conn = setup();
        let outside = OutsideWrites::new(&conn);
        conn.execute_batch("INSERT INTO settings.settings VALUES ('prelude', 'x')")
            .unwrap();
        outside.rebaseline(&conn);
        assert!(outside.changed(&conn).is_empty());
    }

    /// Reads the next SSE message (one whose lines end in a blank line) off
    /// `body`, skipping keep-alive comments.
    async fn next_message(
        body: &mut (impl tokio_stream::Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin),
        buffer: &mut String,
    ) -> (String, String) {
        use tokio_stream::StreamExt;
        loop {
            if let Some(end) = buffer.find("\n\n") {
                let message: String = buffer.drain(..end + 2).collect();
                let mut name = String::new();
                let mut data = String::new();
                for line in message.lines() {
                    if let Some(rest) = line.strip_prefix("event: ") {
                        name = rest.to_owned();
                    } else if let Some(rest) = line.strip_prefix("data: ") {
                        data.push_str(rest);
                    }
                }
                if !name.is_empty() {
                    return (name, data);
                }
                continue;
            }
            let chunk = tokio::time::timeout(Duration::from_secs(5), body.next())
                .await
                .expect("the stream went quiet")
                .expect("the stream ended")
                .unwrap();
            buffer.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    #[tokio::test]
    async fn the_stream_says_hello_then_what_changed() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let dir = std::env::temp_dir().join(format!("radiocrate-events-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = crate::server::app_state(setup(), dir, "test".into(), "test".into());
        let response = crate::server::router(Arc::clone(&state))
            .oneshot(Request::get("/events").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        let mut body = response.into_body().into_data_stream();
        let mut buffer = String::new();

        let (name, data) = next_message(&mut body, &mut buffer).await;
        assert_eq!(name, "hello");
        let hello: EventsHello = serde_json::from_str(&data).unwrap();
        assert_eq!(hello.versions[&Topic::Keybindings], 0);

        state
            .write(Some("device-a"), &[Topic::Keybindings], |conn| {
                conn.execute_batch("INSERT INTO settings.keybinding VALUES ('a', 'b')")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        let (name, data) = next_message(&mut body, &mut buffer).await;
        assert_eq!(name, "changed");
        let changed: TopicChanged = serde_json::from_str(&data).unwrap();
        assert_eq!(
            changed,
            TopicChanged {
                topic: Topic::Keybindings,
                version: 1,
                origin: Some("device-a".into()),
            }
        );
    }
}
