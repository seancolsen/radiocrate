mod classify;
mod metadata;
mod prepare;
mod scan;
mod staging;
mod types;

pub(crate) use classify::is_audio_file;
pub use scan::scan;
