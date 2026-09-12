//! Logging for the server binaries.
//!
//! Output is meant to be read two ways without changing shape: by a person
//! watching a terminal, and by a log collector (`journald`, Docker, a file) that
//! wants one record per line. So every record is:
//!
//! ```text
//! 2026-09-11T09:12:33.481-04:00 INFO  backend::scanner: scan complete new=12 elapsed_ms=814
//! ```
//!
//! — a timestamp, a level, the emitting module, a *static* message, and then the
//! dynamic parts as `key=value` fields.
//!
//! Two rules make that safe to pipe anywhere:
//!
//! 1. **One record is one line.** Field values are JSON-encoded, so a `DuckDB`
//!    error spanning four lines arrives as `error="Parser Error: ...\n..."`
//!    rather than four log records, three of which have no timestamp.
//! 2. **Color is decoration only.** ANSI escapes are emitted only when the sink
//!    is a terminal (see [`ColorChoice`]), so the bytes a collector receives are
//!    plain text.
//!
//! # Writing log statements
//!
//! Put the constant part in the message and the variable part in fields:
//!
//! ```ignore
//! error!(error = %e, sql, "query failed");   // good
//! error!("query failed: {e}");               // avoid: unescaped, unparseable
//! ```
//!
//! Use `%` (Display) for anything stringy — errors, `Path::display()`, IDs.
//! `&str`/`String` fields need no sigil. Numbers and booleans are written
//! unquoted, so they stay usable as numbers downstream. `?` (Debug) works but
//! embeds a Rust debug rendering inside the JSON string, which is rarely what
//! you want for a value a human has to read.
//!
//! The target (`backend::scanner` above) comes from the module path for free,
//! so messages don't need a `"scanner: "` prefix of their own.

use std::fmt::{self, Write as _};
use std::io::IsTerminal;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::EnvFilter;
use tracing_subscriber::field::RecordFields;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::registry::LookupSpan;

/// The environment variable read for per-module log filtering, e.g.
/// `RUST_LOG=info,backend::scanner=debug`. Named for the convention rather than
/// for this project, because that is the name people already try.
const FILTER_ENV: &str = "RUST_LOG";

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

/// When to colorize output.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum ColorChoice {
    /// Color when stderr is a terminal and `NO_COLOR` is unset.
    #[default]
    Auto,
    Always,
    Never,
}

impl ColorChoice {
    fn enabled(self) -> bool {
        match self {
            ColorChoice::Always => true,
            ColorChoice::Never => false,
            // `NO_COLOR` is honored at any non-empty value, per https://no-color.org.
            ColorChoice::Auto => {
                std::io::stderr().is_terminal()
                    && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
            }
        }
    }
}

/// Logging flags shared by every binary that serves a collection. Flatten this
/// into the top-level `Parser` so the options mean the same thing everywhere.
#[derive(Clone, Debug, clap::Args)]
#[command(next_help_heading = "Logging")]
pub struct LogArgs {
    /// Lowest level to log (overridden per-module by `RUST_LOG`)
    #[arg(long, value_name = "LEVEL", default_value = "info", global = true)]
    pub log_level: Level,

    /// When to colorize log output
    #[arg(long, value_name = "WHEN", default_value = "auto", global = true)]
    pub color: ColorChoice,
}

impl LogArgs {
    /// Installs these settings as the process-wide logger. Call once, first
    /// thing in `main`, so that even argument-validation failures are logged.
    pub fn init(&self) {
        init(self.log_level, self.color);
    }
}

/// Installs the process-wide logger. A second call is a no-op: the first
/// subscriber to be installed wins, which keeps tests and embedders from
/// fighting over the global.
pub fn init(default_level: Level, color: ColorChoice) {
    let filter = EnvFilter::builder()
        .with_default_directive(default_level.into())
        .with_env_var(FILTER_ENV)
        .from_env_lossy();

    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        // stderr, so that anything a subcommand ever writes to stdout stays
        // pipeable on its own.
        .with_writer(std::io::stderr)
        .with_ansi(color.enabled())
        .event_format(ServiceFormat)
        .fmt_fields(JsonFields)
        .try_init();
}

// ---------------------------------------------------------------------------
// Event layout
// ---------------------------------------------------------------------------

const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn level_color(level: Level) -> &'static str {
    if level == Level::ERROR {
        "\x1b[31m" // red
    } else if level == Level::WARN {
        "\x1b[33m" // yellow
    } else if level == Level::INFO {
        "\x1b[32m" // green
    } else if level == Level::DEBUG {
        "\x1b[34m" // blue
    } else {
        "\x1b[35m" // magenta
    }
}

/// Levels padded to a common width so the message column lines up. Done by hand
/// rather than with `{:<5}` because the padding has to sit *outside* the color
/// escapes, which are not printable width.
fn level_padded(level: Level) -> &'static str {
    if level == Level::ERROR {
        "ERROR"
    } else if level == Level::WARN {
        "WARN "
    } else if level == Level::INFO {
        "INFO "
    } else if level == Level::DEBUG {
        "DEBUG"
    } else {
        "TRACE"
    }
}

/// Local time with an explicit UTC offset, to millisecond precision — RFC 3339,
/// so it parses everywhere. Local rather than UTC because the person reading a
/// terminal is the one who needs it at a glance; the offset keeps it unambiguous
/// for everyone else.
fn write_timestamp(writer: &mut Writer<'_>) -> fmt::Result {
    let now = jiff::Zoned::now();
    write!(writer, "{}", now.strftime("%Y-%m-%dT%H:%M:%S%.3f%:z"))
}

struct ServiceFormat;

impl<S, N> FormatEvent<S, N> for ServiceFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let ansi = writer.has_ansi_escapes();
        let meta = event.metadata();
        let level = *meta.level();

        if ansi {
            writer.write_str(DIM)?;
        }
        write_timestamp(&mut writer)?;
        if ansi {
            writer.write_str(RESET)?;
        }

        writer.write_char(' ')?;
        if ansi {
            write!(writer, "{BOLD}{}", level_color(level))?;
        }
        writer.write_str(level_padded(level))?;
        if ansi {
            writer.write_str(RESET)?;
        }

        writer.write_char(' ')?;
        if ansi {
            writer.write_str(DIM)?;
        }
        writer.write_str(meta.target())?;
        writer.write_char(':')?;
        if ansi {
            writer.write_str(RESET)?;
        }
        writer.write_char(' ')?;

        // Enclosing spans, outermost first, as `name{field=value}` — the context
        // a record inherits from where it was emitted.
        if let Some(scope) = ctx.event_scope() {
            for span in scope.from_root() {
                write!(writer, "{}", span.name())?;
                let ext = span.extensions();
                if let Some(fields) = ext.get::<FormattedFields<N>>()
                    && !fields.is_empty()
                {
                    write!(writer, "{{{fields}}}")?;
                }
                writer.write_str(": ")?;
            }
        }

        ctx.format_fields(writer.by_ref(), event)?;
        writeln!(writer)
    }
}

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------

/// Renders fields as `key=value`, with every value that isn't a number or a
/// boolean JSON-encoded. See the module docs for why.
struct JsonFields;

impl<'writer> FormatFields<'writer> for JsonFields {
    fn format_fields<R: RecordFields>(&self, writer: Writer<'writer>, fields: R) -> fmt::Result {
        let ansi = writer.has_ansi_escapes();
        let mut visitor = FieldVisitor {
            writer,
            ansi,
            empty: true,
            result: Ok(()),
        };
        fields.record(&mut visitor);
        visitor.result
    }
}

struct FieldVisitor<'a> {
    writer: Writer<'a>,
    ansi: bool,
    empty: bool,
    result: fmt::Result,
}

impl FieldVisitor<'_> {
    /// Separates this item from the previous one. Nothing is written before the
    /// first, so a span's fields render as `{a=1 b=2}` with no stray padding.
    fn pad(&mut self) -> fmt::Result {
        if self.empty {
            self.empty = false;
            Ok(())
        } else {
            self.writer.write_char(' ')
        }
    }

    /// The message is written bare so it reads as prose. It is escaped only if
    /// it would otherwise break the one-record-one-line rule — which a static
    /// message never does, but a `format!`-style one might.
    fn write_message(&mut self, message: &str) -> fmt::Result {
        self.pad()?;
        if message.contains(|c: char| c.is_control()) {
            write!(self.writer, "{}", json_string(message))
        } else {
            self.writer.write_str(message)
        }
    }

    /// `value` is written verbatim, so callers pass either a JSON scalar
    /// (numbers, booleans) or an already-encoded JSON string.
    fn write_field(&mut self, name: &str, value: &str) -> fmt::Result {
        self.pad()?;
        if self.ansi {
            write!(self.writer, "{DIM}{name}={RESET}{value}")
        } else {
            write!(self.writer, "{name}={value}")
        }
    }

    fn record(&mut self, field: &Field, value: &str) {
        if self.result.is_err() {
            return;
        }
        self.result = if field.name() == "message" {
            self.write_message(value)
        } else {
            self.write_field(field.name(), &json_string(value))
        };
    }

    /// For values that are already valid JSON scalars.
    fn record_scalar(&mut self, field: &Field, value: &str) {
        if self.result.is_err() {
            return;
        }
        // A number recorded under `message` is nonsense, but rendering it bare
        // is still the right thing rather than dropping it.
        self.result = if field.name() == "message" {
            self.write_message(value)
        } else {
            self.write_field(field.name(), value)
        };
    }
}

impl Visit for FieldVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value);
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        // `%value` arrives here too, as a `format_args!` whose `Debug` is its
        // `Display` — which is exactly why `%` is the house style for anything
        // stringy: it renders the value, not a Rust literal for it.
        self.record(field, &format!("{value:?}"));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        // The whole chain, since the outermost message is often the least
        // specific ("query failed") and the cause is what's actually wanted.
        let mut rendered = value.to_string();
        let mut source = value.source();
        while let Some(err) = source {
            let _ = write!(rendered, ": {err}");
            source = err.source();
        }
        self.record(field, &rendered);
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_scalar(field, &value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_scalar(field, &value.to_string());
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.record_scalar(field, &value.to_string());
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.record_scalar(field, &value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_scalar(field, if value { "true" } else { "false" });
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        // JSON has no NaN or infinity. Those become strings rather than
        // something no parser downstream will accept.
        match serde_json::Number::from_f64(value) {
            Some(n) => self.record_scalar(field, &n.to_string()),
            None => self.record(field, &value.to_string()),
        }
    }
}

/// `value` as a JSON string literal, quotes and escapes included.
///
/// Encoding cannot fail for a `&str`, but `serde_json` can't know that, so the
/// fallback renders the Rust debug form — also quoted, also one line.
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("{value:?}"))
}
