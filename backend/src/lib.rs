/// Re-exported so the `radiocrate` binary can name the sentinel without taking
/// its own dependency on `api-schema` — it hands `server::app_state` plain
/// strings and never touches another wire type.
pub use api_schema::DEV_BUILD_ID;

pub mod db;
pub mod dml;
pub mod rpc;
pub mod scanner;
pub mod server;
pub mod stream;
