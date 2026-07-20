use axum::Router;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use backend::{db, scanner, server};
use clap::Parser;
use rust_embed::Embed;
use std::path::{Path, PathBuf};

#[derive(Embed)]
#[folder = "../frontend/dist/"]
struct Assets;

#[derive(Parser)]
#[command(name = "radiocrate")]
#[command(about = "RadioCrate — manage and play your audio collection")]
#[command(version = concat!(env!("CARGO_PKG_VERSION"), " (", env!("GIT_HASH"), ")"))]
struct Args {
    /// Path to the collection of audio files
    collection_path: String,

    /// Start without running a full collection scan
    #[arg(long)]
    no_scan: bool,

    /// Path to the database file (defaults to `radiocrate.db` in the collection root)
    #[arg(long)]
    db_path: Option<PathBuf>,

    /// Port to listen on
    #[arg(short, long, default_value_t = 3000)]
    port: u16,
}

fn get_collection_path(path_str: &str) -> Result<&Path, String> {
    let path = Path::new(path_str);
    if !path.exists() {
        return Err(format!("The path '{path_str}' does not exist."));
    }
    if !path.is_dir() {
        return Err(format!("The path '{path_str}' is not a directory."));
    }
    Ok(path)
}

/// The content type to serve `path` as.
///
/// `mime_guess` covers everything the build emits except the manifest, whose
/// `.webmanifest` extension it doesn't know; browsers want
/// `application/manifest+json` there.
fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("webmanifest") => "application/manifest+json",
        _ => mime_guess::from_path(path)
            .first_raw()
            .unwrap_or("application/octet-stream"),
    }
}

/// How long a browser may reuse an asset without asking.
///
/// The frontend is built with stable (unhashed) file names, so nothing here can
/// be cached immutably — a new deployment reuses every URL. `no-cache` still
/// lets the browser keep its copy; it just has to revalidate, which costs one
/// conditional request and usually returns 304. Repeat launches don't pay even
/// that, because the service worker serves the shell from its own cache and
/// only re-fetches when the build id changes.
const CACHE_CONTROL: &str = "no-cache";

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let asset_path = if path.is_empty() { "index.html" } else { path };

    // Unknown paths fall back to the shell so the app's own routing gets them —
    // but as `text/html`, not as whatever the requested extension implied. A
    // missing `.png` served as HTML-labelled-`image/png` is just a broken image
    // the browser can't explain.
    let (asset_path, file) = match Assets::get(asset_path) {
        Some(file) => (asset_path, file),
        None => match Assets::get("index.html") {
            Some(file) => ("index.html", file),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(asset_path)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL),
    );
    if asset_path == "sw.js" {
        // Lets the worker control the whole origin regardless of where it's
        // served from. It's at the root here, so this is belt and braces — but
        // it costs nothing, and moving the file later would otherwise silently
        // narrow the scope.
        headers.insert(
            HeaderName::from_static("service-worker-allowed"),
            HeaderValue::from_static("/"),
        );
    }
    (headers, file.data).into_response()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let collection_path = get_collection_path(&args.collection_path)?;
    let db_path = args
        .db_path
        .unwrap_or_else(|| db::default_db_path(collection_path));
    let conn = db::get_db(&db_path)?;
    if !args.no_scan {
        scanner::scan(collection_path, &conn)?;
    }
    let state = server::app_state(conn, collection_path.to_path_buf());

    let app = Router::new()
        .nest("/api", server::router(state))
        .fallback(static_handler);

    let addr = format!("0.0.0.0:{}", args.port);
    println!("Listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
