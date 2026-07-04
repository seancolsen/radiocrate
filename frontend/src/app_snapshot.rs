//! Whole-app visual regression test.
//!
//! Drives the real [`App::render_root`] — the entire UI, top to bottom — rather
//! than any single widget, so this snapshot guards the app's overall look and
//! catches cross-cutting regressions. It reproduces a realistic loaded state: a
//! single fetched query named "Lemonade" (the Beyoncé album), with the explorer
//! sidebar open and the Filter builder section open, showing its twelve tracks in
//! the custom column layout the query's display spec asks for.
//!
//! The result rows are mocked exactly as the backend delivers them — encoded as
//! Arrow IPC stream bytes and fed through the real decode path
//! ([`crate::http::load_ipc_into_state`]) — so the row-formatting code
//! (Arrow value formatting, per-column formatters/prefixes/suffixes) is exercised
//! for real. Generate or refresh the baseline with
//! `UPDATE_SNAPSHOTS=1 cargo test -p frontend`.

use std::cell::Cell;
use std::sync::Arc;

use arrow_array::builder::{Float64Builder, ListBuilder, StringBuilder};
use arrow_array::{ArrayRef, Int32Array, RecordBatch, StringArray};
use arrow_ipc::writer::StreamWriter;
use eframe::egui;
use egui_kittest::Harness;
use uuid::Uuid;

use crate::App;
use crate::columns::{ColumnMetadata, FontColor, FontSize, TextAlign};
use crate::format::{DecimalPlaces, Formatter};
use crate::page::QueryPage;
use crate::query_def::{FilterParts, QueryDefinition, Section, SectionContent};
use crate::rpc::Query;

/// Render at 2× device scale (the project convention) so text stays crisp.
const PPP: f32 = 2.0;

/// The query's custom display spec, held in the query definition so the Display
/// section (were it opened) would show exactly this. The resolved per-column
/// metadata that actually drives rendering is built in [`column_metadata`] to
/// match it.
const DISPLAY_SPEC: &str = "\
$id @{hide:yes}
$artists @{width:[101 400]}
$year @{width:30}
$album.title @{width:[70 200]}
$track_number @{width:30 color:light prefix:'#' align:right size:small}
$title @{width:[100 400]}
$duration @{width:25 align:right size:small formatter:{type:duration}}
$rating @{suffix:'⭐' width:35 formatter:{type:number decimalPlaces:[0 1]} align:right}";

/// One track's mock data. `artists` is the list rendered in the artists column;
/// `duration` is in seconds (the duration formatter turns it into `M:SS`).
struct Track {
    artists: &'static [&'static str],
    title: &'static str,
    duration: i32,
    rating: f64,
}

/// The twelve tracks of *Lemonade*. The four "(feat. …)" guests from the
/// reference are lifted out of the title and into a second artist, so e.g.
/// "Don't Hurt Yourself" credits both Beyoncé and Jack White.
const TRACKS: &[Track] = &[
    Track {
        artists: &["Beyoncé"],
        title: "Pray You Catch Me",
        duration: 196,
        rating: 3.5,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Hold Up",
        duration: 221,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé", "Jack White"],
        title: "Don't Hurt Yourself",
        duration: 234,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Sorry",
        duration: 233,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé", "The Weeknd"],
        title: "6 Inch",
        duration: 260,
        rating: 4.5,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Daddy Lessons",
        duration: 288,
        rating: 3.5,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Love Drought",
        duration: 237,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Sandcastles",
        duration: 183,
        rating: 3.5,
    },
    Track {
        artists: &["Beyoncé", "James Blake"],
        title: "Forward",
        duration: 79,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé", "Kendrick Lamar"],
        title: "Freedom",
        duration: 290,
        rating: 4.5,
    },
    Track {
        artists: &["Beyoncé"],
        title: "All Night",
        duration: 322,
        rating: 4.0,
    },
    Track {
        artists: &["Beyoncé"],
        title: "Formation",
        duration: 206,
        rating: 4.5,
    },
];

/// A fake but well-formed UUID for the hidden `id` column of the `n`-th row.
fn fake_id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

/// Encodes the twelve tracks as an Arrow IPC stream, mirroring the columns the
/// backend's query response carries (in display order): the hidden `id`, the
/// `artists` string list, `year`, `album.title`, `track_number`, `title`,
/// `duration` (seconds), and `rating`.
fn mock_ipc_response() -> Vec<u8> {
    let id = StringArray::from_iter_values((1..=TRACKS.len()).map(fake_id));

    let mut artists = ListBuilder::new(StringBuilder::new());
    for track in TRACKS {
        for name in track.artists {
            artists.values().append_value(name);
        }
        artists.append(true);
    }
    let artists = artists.finish();

    let year = Int32Array::from(vec![2016; TRACKS.len()]);
    let album = StringArray::from(vec!["Lemonade"; TRACKS.len()]);
    let track_number = Int32Array::from(
        (1..=TRACKS.len())
            .map(|n| i32::try_from(n).expect("track number fits in i32"))
            .collect::<Vec<_>>(),
    );
    let title = StringArray::from(TRACKS.iter().map(|t| t.title).collect::<Vec<_>>());
    let duration = Int32Array::from(TRACKS.iter().map(|t| t.duration).collect::<Vec<_>>());
    let mut ratings = Float64Builder::new();
    for track in TRACKS {
        ratings.append_value(track.rating);
    }
    let rating = ratings.finish();

    let batch = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(id) as ArrayRef),
        ("artists", Arc::new(artists) as ArrayRef),
        ("year", Arc::new(year) as ArrayRef),
        ("album.title", Arc::new(album) as ArrayRef),
        ("track_number", Arc::new(track_number) as ArrayRef),
        ("title", Arc::new(title) as ArrayRef),
        ("duration", Arc::new(duration) as ArrayRef),
        ("rating", Arc::new(rating) as ArrayRef),
    ])
    .expect("build record batch");

    let mut bytes = Vec::new();
    {
        let mut writer =
            StreamWriter::try_new(&mut bytes, &batch.schema()).expect("new IPC writer");
        writer.write(&batch).expect("write batch");
        writer.finish().expect("finish IPC stream");
    }
    bytes
}

/// The resolved per-column metadata for [`DISPLAY_SPEC`], positionally aligned
/// with the mocked result columns.
fn column_metadata() -> Vec<ColumnMetadata> {
    let meta = |f: &dyn Fn(&mut ColumnMetadata)| {
        let mut m = ColumnMetadata::default();
        f(&mut m);
        m
    };
    vec![
        meta(&|m| m.hide = true),
        meta(&|m| {
            m.min_width = 101.0;
            m.max_width = 400.0;
        }),
        meta(&|m| {
            m.min_width = 30.0;
            m.max_width = 30.0;
        }),
        meta(&|m| {
            m.min_width = 70.0;
            m.max_width = 200.0;
        }),
        meta(&|m| {
            m.min_width = 30.0;
            m.max_width = 30.0;
            m.font_color = FontColor::Light;
            m.font_size = FontSize::Small;
            m.text_align = TextAlign::Right;
            m.prefix = "#".to_owned();
        }),
        meta(&|m| {
            m.min_width = 100.0;
            m.max_width = 400.0;
        }),
        meta(&|m| {
            m.min_width = 25.0;
            m.max_width = 25.0;
            m.font_size = FontSize::Small;
            m.text_align = TextAlign::Right;
            m.formatter = Some(Formatter::Duration {});
        }),
        meta(&|m| {
            m.min_width = 35.0;
            m.max_width = 35.0;
            m.text_align = TextAlign::Right;
            m.suffix = "⭐".to_owned();
            m.formatter = Some(Formatter::Number {
                decimal_places: DecimalPlaces::List(vec![0, 1]),
            });
        }),
    ]
}

/// Builds the single "Lemonade" query page: the custom filter/sort/display
/// definition, with its results pre-populated from the mocked Arrow IPC response
/// and marked already-fetched so the app renders them without issuing a request.
fn lemonade_page() -> QueryPage {
    let definition = QueryDefinition {
        base: "track".to_owned(),
        filter: FilterParts {
            custom: "album.title:=Lemonade".to_owned(),
            presets: Vec::new(),
        },
        sort: SectionContent::Custom("\\\\track_number".to_owned()),
        display: SectionContent::Custom(DISPLAY_SPEC.to_owned()),
        full: None,
    };
    let query = Query {
        id: Uuid::from_u128(1),
        name: "Lemonade".to_owned(),
        created_at: 0,
        modified_at: 0,
        last_play: 0,
        definition,
    };

    let mut page = QueryPage::persisted(query);
    // Already fetched, so `ensure_current_results` won't try to run the query.
    page.results_fetched = true;
    {
        let mut state = page.results.lock().unwrap();
        state.columns = column_metadata();
        state.running = false;
        state.lineage_done = true;
    }
    crate::http::load_ipc_into_state(&mock_ipc_response(), &page.results);
    page
}

/// Encodes rows of `(artist list, title)` as an Arrow IPC stream, for the pill
/// overflow snapshot: a hidden `id`, the `artists` string list, and `title`.
fn overflow_ipc_response(rows: &[(&[&str], &str)]) -> Vec<u8> {
    let id = StringArray::from_iter_values((1..=rows.len()).map(fake_id));

    let mut artists = ListBuilder::new(StringBuilder::new());
    for (names, _) in rows {
        for name in *names {
            artists.values().append_value(name);
        }
        artists.append(true);
    }
    let artists = artists.finish();

    let title = StringArray::from(rows.iter().map(|(_, t)| *t).collect::<Vec<_>>());

    let batch = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(id) as ArrayRef),
        ("artists", Arc::new(artists) as ArrayRef),
        ("title", Arc::new(title) as ArrayRef),
    ])
    .expect("build record batch");

    let mut bytes = Vec::new();
    {
        let mut writer =
            StreamWriter::try_new(&mut bytes, &batch.schema()).expect("new IPC writer");
        writer.write(&batch).expect("write batch");
        writer.finish().expect("finish IPC stream");
    }
    bytes
}

/// Builds a page whose artists column is too narrow for its pills, covering every
/// overflow behavior: all pills fitting, the last pill truncating, pills
/// collapsing into the "+N" bubble, and (with many artists) a bubble after a
/// single pill.
fn pill_overflow_page() -> QueryPage {
    let rows: &[(&[&str], &str)] = &[
        (&["Beyoncé"], "One pill, fits"),
        (&["Beyoncé", "Jay-Z"], "Two pills, fit"),
        (&["Beyoncé", "Kendrick Lamar"], "Second pill truncates"),
        (&["Beyoncé", "Jack White", "The Weeknd"], "Bubble"),
        (
            &[
                "Beyoncé",
                "Jack White",
                "The Weeknd",
                "James Blake",
                "Kendrick Lamar",
                "Jay-Z",
                "Frank Ocean",
            ],
            "Bigger bubble",
        ),
        (
            &["A very long single artist name that cannot fit", "Jay-Z"],
            "First pill truncates",
        ),
    ];

    let display_spec = "\
$id @{hide:yes}
$artists @{width:120}
$title @{width:[100 400]}";
    let definition = QueryDefinition {
        base: "track".to_owned(),
        filter: FilterParts::default(),
        sort: SectionContent::default(),
        display: SectionContent::Custom(display_spec.to_owned()),
        full: None,
    };
    let query = Query {
        id: Uuid::from_u128(2),
        name: "Pill overflow".to_owned(),
        created_at: 0,
        modified_at: 0,
        last_play: 0,
        definition,
    };

    let meta = |f: &dyn Fn(&mut ColumnMetadata)| {
        let mut m = ColumnMetadata::default();
        f(&mut m);
        m
    };
    let mut page = QueryPage::persisted(query);
    page.results_fetched = true;
    {
        let mut state = page.results.lock().unwrap();
        state.columns = vec![
            meta(&|m| m.hide = true),
            meta(&|m| {
                m.min_width = 120.0;
                m.max_width = 120.0;
            }),
            meta(&|m| {
                m.min_width = 100.0;
                m.max_width = 400.0;
            }),
        ];
        state.running = false;
        state.lineage_done = true;
    }
    crate::http::load_ipc_into_state(&overflow_ipc_response(rows), &page.results);
    page
}

#[test]
fn pill_overflow() {
    let page = pill_overflow_page();
    let id = page.live.id;
    let mut app = App {
        pages: vec![page],
        current: crate::CurrentPage::Query(id),
        auto_selected_initial: true,
        schema_fetch_started: true,
        queries_fetch_started: true,
        presets_fetch_started: true,
        ..Default::default()
    };
    app.organizer.open = false;

    let fonts_ready = Cell::new(false);
    let mut harness = Harness::builder()
        .with_size(egui::vec2(460.0, 290.0))
        .with_pixels_per_point(PPP)
        .build_ui(move |ui| {
            if !fonts_ready.replace(true) {
                crate::setup_fonts(ui.ctx());
                ui.ctx()
                    .global_style_mut(|s| s.visuals.text_cursor.blink = false);
                return;
            }
            app.render_root(ui);
        });

    harness.run();
    harness.snapshot("app/pill_overflow");
}

#[test]
fn whole_app() {
    let page = lemonade_page();
    let id = page.live.id;
    let mut app = App {
        pages: vec![page],
        current: crate::CurrentPage::Query(id),
        // Skip the one-time startup fetches: this state is already "loaded".
        auto_selected_initial: true,
        schema_fetch_started: true,
        queries_fetch_started: true,
        presets_fetch_started: true,
        // Explorer sidebar open, Filter builder section open.
        builder_section: Some(Section::Filter),
        ..Default::default()
    };
    app.organizer.open = true;

    // `build_ui` runs the closure once before the context can be configured, so
    // bind the bundled fonts + light visuals on the first frame and start drawing
    // the app from the next one (font changes only take effect the following
    // frame) — matching the other snapshot tests.
    let fonts_ready = Cell::new(false);
    let mut harness = Harness::builder()
        .with_size(egui::vec2(1040.0, 490.0))
        .with_pixels_per_point(PPP)
        .build_ui(move |ui| {
            if !fonts_ready.replace(true) {
                crate::setup_fonts(ui.ctx());
                ui.ctx()
                    .global_style_mut(|s| s.visuals.text_cursor.blink = false);
                return;
            }
            app.render_root(ui);
        });

    harness.run();
    harness.snapshot("app/whole_app");
}
