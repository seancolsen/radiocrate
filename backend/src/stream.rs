use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use audiopus::coder::Encoder as OpusEncoder;
use audiopus::{Application, Bitrate, Channels as OpusChannels, SampleRate};
use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, Request, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Deserialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, ReadBytes};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::TimeBase;
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::ReceiverStream;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use tracing::{debug, error, warn};

use crate::server::AppState;

// ---------------------------------------------------------------------------
// Pacing
//
// A stream sent as fast as the network will take it doesn't just finish
// sooner: on a link with a bottleneck (a home uplink behind a tunnel, a phone on
// a cell network) it fills that bottleneck's buffer, and every other response
// then queues behind the audio already waiting there. A query that answers in
// milliseconds on its own takes a second or more per round trip while a track
// downloads — and a form that loads in two or three round trips takes several.
//
// So after a head start, enough to begin playback promptly, a stream is sent at
// a fixed multiple of real time instead. That keeps the client comfortably
// ahead of playback (a whole track is still fetched long before it ends) while
// leaving the link's buffer empty for everything else.
// ---------------------------------------------------------------------------

/// How much faster than real time a stream is sent once past its head start.
/// Generous on purpose: a file's byte rate is an estimate (see
/// [`file_pacing`]), and a variable-bitrate file runs above its average in
/// places, so this leaves room for both before playback could ever outrun the
/// download.
const PACE_MULTIPLE: f64 = 4.0;

/// Seconds of audio a stream sends at full speed before pacing begins — what
/// the client needs to start playing without waiting on the pace.
const PACE_HEAD_START_SECS: f64 = 3.0;

/// The lowest average byte rate (128 kbps) a file is paced at. Below it the
/// estimate is more likely a bad duration than a real file, and pacing on a bad
/// estimate could starve playback — whereas a file that small hardly loads the
/// link anyway, so it's sent unpaced.
const PACE_MIN_BYTES_PER_SEC: f64 = 16_000.0;

/// Paces a stream to `rate` units per second after `head_start` units sent
/// unpaced. The units are the caller's: bytes for a file served whole, seconds
/// of audio for a transcode.
struct Pacer {
    started: std::time::Instant,
    head_start: f64,
    rate: f64,
}

impl Pacer {
    fn new(head_start: f64, rate: f64) -> Self {
        Pacer {
            started: std::time::Instant::now(),
            head_start,
            rate,
        }
    }

    /// How long to wait before sending, once `sent` units will have gone.
    fn delay(&self, sent: f64) -> std::time::Duration {
        self.delay_after(sent, self.started.elapsed())
    }

    fn delay_after(&self, sent: f64, elapsed: std::time::Duration) -> std::time::Duration {
        let due = (sent - self.head_start).max(0.0) / self.rate;
        std::time::Duration::from_secs_f64(due).saturating_sub(elapsed)
    }
}

#[derive(Deserialize)]
pub struct StreamParams {
    #[serde(default = "default_quality")]
    quality: String,
    #[serde(default)]
    start: f64,
}

fn default_quality() -> String {
    "original".to_string()
}

fn is_lossless(format: &str) -> bool {
    matches!(
        format,
        "flac" | "wav" | "aiff" | "alac" | "ape" | "wv" | "caf"
    )
}

fn format_content_type(format: &str) -> &'static str {
    match format {
        "aac" => "audio/aac",
        "adpcm" | "wav" => "audio/wav",
        "aiff" => "audio/aiff",
        "alac" | "mp4" => "audio/mp4",
        "ape" => "audio/x-ape",
        "caf" => "audio/x-caf",
        "flac" => "audio/flac",
        "mkv" => "audio/x-matroska",
        "mp1" | "mp2" | "mp3" => "audio/mpeg",
        "ogg" | "vorbis" | "opus" => "audio/ogg",
        "webm" => "audio/webm",
        "wma" => "audio/x-ms-wma",
        "wv" => "audio/x-wavpack",
        _ => "application/octet-stream",
    }
}

struct TrackFile {
    path: PathBuf,
    format: String,
    /// The file's length in seconds, as the scanner measured it.
    duration: Option<f64>,
}

fn resolve_path(collection_path: &Path, relative: &str) -> PathBuf {
    let trimmed = relative.strip_prefix("./").unwrap_or(relative);
    collection_path.join(trimmed)
}

fn lookup_track(state: &AppState, track_id: &str) -> Result<TrackFile, StatusCode> {
    // Every step here fails the same way — a broken database, not a missing
    // track — so they share one error type and one log site, which is also the
    // one place that knows the track id worth recording.
    type Row = (String, String, Option<f64>);
    let row = state.read(|conn| -> Result<Option<Row>, duckdb::Error> {
        let mut stmt = conn.prepare(
            "SELECT f.path, f.format::VARCHAR, epoch(f.duration) \
             FROM track t JOIN file f ON t.file = f.id \
             WHERE t.id = TRY_CAST(? AS UUID)",
        )?;

        let mut rows = stmt.query_map([track_id], |row| {
            let relative: String = row.get(0)?;
            let format: String = row.get(1)?;
            let duration: Option<f64> = row.get(2)?;
            Ok((relative, format, duration))
        })?;

        rows.next().transpose()
    });

    let (relative, format, duration) = match row {
        Ok(Some(found)) => found,
        Ok(None) => return Err(StatusCode::NOT_FOUND),
        Err(e) => {
            error!(track_id, error = %e, "track lookup failed");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    Ok(TrackFile {
        path: resolve_path(&state.collection_path, &relative),
        format,
        duration,
    })
}

pub async fn stream_track(
    State(state): State<Arc<AppState>>,
    AxumPath(track_id): AxumPath<String>,
    Query(params): Query<StreamParams>,
    request: Request,
) -> Response {
    // On a blocking thread, like every other handler's database work: the
    // connection lock can be held for a while (a checkpoint after a write, a
    // query streaming to a slow client), and waiting on it here would stall a
    // runtime worker and every request queued behind it.
    let lookup = {
        let state = Arc::clone(&state);
        let track_id = track_id.clone();
        tokio::task::spawn_blocking(move || lookup_track(&state, &track_id)).await
    };
    let track = match lookup {
        Ok(Ok(t)) => t,
        Ok(Err(StatusCode::NOT_FOUND)) => {
            return (StatusCode::NOT_FOUND, "track not found").into_response();
        }
        Ok(Err(status)) => return (status, "database error").into_response(),
        Err(_) => {
            error!(track_id, "track lookup task panicked");
            return (StatusCode::INTERNAL_SERVER_ERROR, "track lookup panicked").into_response();
        }
    };

    if !track.path.exists() {
        // The database and the collection disagree — the file moved or was
        // deleted without a rescan. A 404 tells the client; only the log says
        // which file, which is what makes it fixable.
        warn!(track_id, path = %track.path.display(), "track file missing on disk");
        return (StatusCode::NOT_FOUND, "file not found on disk").into_response();
    }

    let should_transcode = params.quality == "opus128" && is_lossless(&track.format);

    if should_transcode {
        let wants = StreamRequest::from(&request);
        transcode_response(&track, &track_id, params.start, &wants).await
    } else {
        passthrough_response(&track, request).await
    }
}

async fn passthrough_response(track: &TrackFile, request: Request) -> Response {
    let content_type = format_content_type(&track.format);
    let request_method = request.method().clone();

    let result = ServeFile::new(&track.path).oneshot(request).await;
    let mut response = match result {
        Ok(resp) => resp.into_response(),
        Err(err) => {
            error!(path = %track.path.display(), error = %err, "serving file failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("read failed: {err}"),
            )
                .into_response();
        }
    };

    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type.parse().unwrap());

    // Only a body of audio is worth pacing: not a 304, a 416, or a HEAD.
    let status = response.status();
    if !(status == StatusCode::OK || status == StatusCode::PARTIAL_CONTENT)
        || request_method == Method::HEAD
    {
        return response;
    }

    let path = track.path.clone();
    let duration = track.duration;
    let Ok(Some(pacing)) = tokio::task::spawn_blocking(move || file_pacing(&path, duration)).await
    else {
        return response;
    };

    // A range request's body starts part-way into the file, perhaps past the
    // metadata its head start would otherwise have to cover.
    let start = range_start(&response);
    let head_start = pacing.audio_offset.saturating_sub(start) as f64
        + PACE_HEAD_START_SECS * pacing.bytes_per_sec;
    let pacer = Pacer::new(head_start, PACE_MULTIPLE * pacing.bytes_per_sec);

    // The `Content-Length` (and `Content-Range`) headers stay as `ServeFile` set
    // them; hyper frames the response by them rather than by the stream.
    let (parts, body) = response.into_parts();
    Response::from_parts(parts, paced_body(body, pacer))
}

/// What pacing a file served whole needs to know: where its audio begins, and
/// the rate its audio runs at in bytes per second.
struct FilePacing {
    audio_offset: u64,
    bytes_per_sec: f64,
}

/// Works out how to pace the file at `path`, or `None` to send it unpaced.
///
/// A file's average byte rate is its size over its duration, but only once the
/// metadata at its front is set aside: embedded cover art can run to megabytes,
/// which would inflate the rate, and which the client must have before it can
/// play a note — so it's sent in the head start, not at the pace. Probing the
/// file reads past that metadata and stops where the audio begins. Should a
/// reader end up somewhere else — past the audio, say, having read an index at
/// the far end — the rate comes out too low to trust, and the file goes unpaced.
fn file_pacing(path: &Path, duration: Option<f64>) -> Option<FilePacing> {
    let duration = duration.filter(|d| d.is_finite() && *d > 0.0)?;
    let file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mss = MediaSourceStream::new(
        Box::new(file),
        symphonia::core::io::MediaSourceStreamOptions::default(),
    );

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let audio_offset = probed.format.into_inner().pos();

    let bytes_per_sec = size.checked_sub(audio_offset)? as f64 / duration;
    (bytes_per_sec >= PACE_MIN_BYTES_PER_SEC).then_some(FilePacing {
        audio_offset,
        bytes_per_sec,
    })
}

/// Where a response's body starts within the file: the first byte of its
/// `Content-Range` (`bytes 1000-1999/5000`), or zero for a whole file.
fn range_start(response: &Response) -> u64 {
    response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes "))
        .and_then(|v| v.split('-').next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Re-sends `body` through a channel, holding each chunk back until `pacer`
/// says it's due. The task ends when the body does, or as soon as the client
/// goes away (the receiving stream is dropped and the send fails).
fn paced_body(body: Body, pacer: Pacer) -> Body {
    let (tx, rx) = mpsc::channel::<Result<Bytes, axum::Error>>(4);
    tokio::spawn(async move {
        let mut chunks = body.into_data_stream();
        let mut sent = 0;
        while let Some(chunk) = chunks.next().await {
            if let Ok(bytes) = &chunk {
                sent += bytes.len();
                tokio::time::sleep(pacer.delay(sent as f64)).await;
            }
            let failed = chunk.is_err();
            if tx.send(chunk).await.is_err() || failed {
                return;
            }
        }
    });
    Body::from_stream(ReceiverStream::new(rx))
}

// ---------------------------------------------------------------------------
// Transcoding
//
// A lossless source is sent as Ogg Opus, encoded as it's sent. The encode is
// arranged so that its bytes are *predictable*: hard constant-bitrate Opus,
// one packet to a page, so every audio page is the same size and byte N of
// the stream always belongs to a known 20 ms frame. That gives the stream a
// length the client can be told up front, and lets any part of it be encoded
// on its own (see `Job`), without encoding the track ahead of time and without
// keeping anything on disk.
//
// The layout, in full (RFC 7845 for the Opus parts, RFC 3533 for Ogg):
//
// - Two header pages, `OpusHead` then `OpusTags`, `H` bytes together.
// - Audio page `i` (from 0) holds one packet of `OPUS_PACKET_BYTES`, so it's
//   `AUDIO_PAGE_BYTES` long and sits at `H + i × AUDIO_PAGE_BYTES`, with page
//   sequence number `i + 2`. Its granule position is `(i + 1) × 960`, except
//   the last page's, which is `P + N`: the pre-skip plus the audio's length at
//   48 kHz, which tells the decoder to drop the padding at the end.
// - `F`, the number of audio pages, is `ceil((P + N) / 960)`: the decoder
//   drops the first `P` samples, so the encoder has to emit `P + N` samples'
//   worth to reach the audio's end.
//
// A source whose frame count the container doesn't record has no `N`, and is
// sent as before: a stream without a length. So is a `?start=` request.
// ---------------------------------------------------------------------------

/// Bumped whenever the bytes a transcode produces for the same input could
/// change: the encoder settings, the vendor string, the page layout. It goes
/// into the `ETag`, so a range can never be spliced onto bytes from an older
/// layout.
const LAYOUT_VERSION: u32 = 1;

const OPUS_SAMPLE_RATE: u32 = 48_000;
/// 20 ms at 48 kHz.
const OPUS_FRAME_SAMPLES: usize = 960;
const OPUS_BITRATE: u32 = 128_000;
/// Every packet's length under hard constant bitrate: the bitrate, over fifty
/// frames a second.
const OPUS_PACKET_BYTES: usize = (OPUS_BITRATE / 8 / 50) as usize;
/// How far ahead of the first page wanted an encode begins, so the resampler
/// and the encoder have settled by the time they reach it.
const PRE_ROLL_SAMPLES: u64 = OPUS_SAMPLE_RATE as u64;
const RESAMPLE_CHUNK_SIZE: usize = 1024;
/// How much of a stream is gathered before it's handed to the response.
const CHUNK_BYTES: usize = 16 * 1024;

// ── Ogg pages ───────────────────────────────────────────────────────────────

const OGG_HEADER_BYTES: usize = 27;
const OGG_BOS: u8 = 0x02;
const OGG_EOS: u8 = 0x04;

/// How many lacing bytes a packet of `len` bytes takes: one per 255 bytes,
/// and one more for the remainder (a zero, if the length is a multiple).
const fn lacing_len(len: usize) -> usize {
    len / 255 + 1
}

/// The size of a page holding one packet of `len` bytes.
const fn page_len(len: usize) -> usize {
    OGG_HEADER_BYTES + lacing_len(len) + len
}

const AUDIO_PAGE_BYTES: u64 = page_len(OPUS_PACKET_BYTES) as u64;

/// The Ogg CRC-32: polynomial `0x04C11DB7`, not reflected, no initial value
/// and no final XOR.
const OGG_CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut j = 0;
        while j < 8 {
            r = if r & 0x8000_0000 != 0 {
                (r << 1) ^ 0x04C1_1DB7
            } else {
                r << 1
            };
            j += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
};

fn ogg_crc(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0u32, |crc, &b| {
        (crc << 8) ^ OGG_CRC_TABLE[(((crc >> 24) as u8) ^ b) as usize]
    })
}

/// One Ogg page holding one whole packet.
fn ogg_page(flags: u8, granule: u64, serial: u32, seq: u32, packet: &[u8]) -> Vec<u8> {
    let mut page = Vec::with_capacity(page_len(packet.len()));
    page.extend_from_slice(b"OggS");
    page.push(0); // version
    page.push(flags);
    page.extend_from_slice(&granule.to_le_bytes());
    page.extend_from_slice(&serial.to_le_bytes());
    page.extend_from_slice(&seq.to_le_bytes());
    page.extend_from_slice(&[0; 4]); // CRC, over the whole page, filled below
    page.push(lacing_len(packet.len()) as u8);
    let mut rest = packet.len();
    while rest >= 255 {
        page.push(255);
        rest -= 255;
    }
    page.push(rest as u8);
    page.extend_from_slice(packet);
    let crc = ogg_crc(&page);
    page[22..26].copy_from_slice(&crc.to_le_bytes());
    page
}

fn build_opus_head(channels: u8, pre_skip: u16, original_sample_rate: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(channels);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&original_sample_rate.to_le_bytes());
    head.extend_from_slice(&0_i16.to_le_bytes()); // output gain
    head.push(0); // channel mapping family (0 = mono/stereo)
    head
}

fn build_opus_tags() -> Vec<u8> {
    let vendor = b"radiocrate";
    let mut tags = Vec::with_capacity(8 + 4 + vendor.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0_u32.to_le_bytes()); // zero user comments
    tags
}

/// The two header pages: `OpusHead` (beginning of stream, sequence 0) and
/// `OpusTags` (sequence 1), both at granule 0.
fn header_pages(channels: u8, pre_skip: u16, source_rate: u32, serial: u32) -> Vec<u8> {
    let mut pages = ogg_page(
        OGG_BOS,
        0,
        serial,
        0,
        &build_opus_head(channels, pre_skip, source_rate),
    );
    pages.extend(ogg_page(0, 0, serial, 1, &build_opus_tags()));
    pages
}

// ── The layout ──────────────────────────────────────────────────────────────

/// The byte layout of a stream whose length is known (see the module comment).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Layout {
    /// `H`: the header pages' length.
    header_len: u64,
    /// `P`: the samples a decoder drops from the start, the encoder's lookahead.
    pre_skip: u16,
    /// `N`: the audio's length in samples at 48 kHz.
    samples: u64,
}

impl Layout {
    /// `F`, the number of audio pages.
    fn pages(&self) -> u64 {
        (u64::from(self.pre_skip) + self.samples).div_ceil(OPUS_FRAME_SAMPLES as u64)
    }

    /// `L`, the whole stream's length in bytes.
    fn len(&self) -> u64 {
        self.header_len + self.pages() * AUDIO_PAGE_BYTES
    }

    /// The audio page holding `byte`, which must be past the headers.
    fn page_at(&self, byte: u64) -> u64 {
        (byte - self.header_len) / AUDIO_PAGE_BYTES
    }

    /// Audio page `i`'s granule position.
    fn granule(&self, i: u64) -> u64 {
        if i + 1 == self.pages() {
            u64::from(self.pre_skip) + self.samples
        } else {
            (i + 1) * OPUS_FRAME_SAMPLES as u64
        }
    }
}

/// Where audio page `i` begins, after `header_len` bytes of headers.
fn page_offset(header_len: u64, i: u64) -> u64 {
    header_len + i * AUDIO_PAGE_BYTES
}

/// `N` for a source of `frames` frames at `rate`: its length at 48 kHz,
/// rounded up.
fn output_samples(frames: u64, rate: u32) -> u64 {
    (u128::from(frames) * u128::from(OPUS_SAMPLE_RATE)).div_ceil(u128::from(rate)) as u64
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

// ── The source ──────────────────────────────────────────────────────────────

/// The decoded source: frames at its own rate, from wherever it was last
/// positioned.
struct Source {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    rate: u32,
    channels: usize,
    /// How many frames the container says it holds, if it says.
    frames: Option<u64>,
    sample_buf: Option<SampleBuffer<f32>>,
    /// Where the next packet is expected to begin, for a container whose
    /// packets carry no timestamps.
    position: u64,
    /// Frames before this one are dropped: a seek lands early.
    start: u64,
    exhausted: bool,
}

impl Source {
    fn open(path: &Path) -> Result<Source, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
        let mss = MediaSourceStream::new(
            Box::new(file),
            symphonia::core::io::MediaSourceStreamOptions::default(),
        );
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|e| format!("probe failed: {e}"))?;
        let format = probed.format;
        let track = format.default_track().ok_or("no audio track found")?;
        let track_id = track.id;
        let params = track.codec_params.clone();
        let rate = params.sample_rate.ok_or("unknown sample rate")?;
        let channels = params.channels.ok_or("unknown channel layout")?.count();
        if channels == 0 || channels > 2 {
            return Err(format!("{channels}-channel audio isn't supported"));
        }
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(|e| format!("decoder creation failed: {e}"))?;
        Ok(Source {
            format,
            decoder,
            track_id,
            time_base: params.time_base,
            rate,
            channels,
            frames: params.n_frames,
            sample_buf: None,
            position: 0,
            start: 0,
            exhausted: false,
        })
    }

    /// A timestamp in the track's time base, as a frame count.
    fn frames_of(&self, ts: u64) -> u64 {
        match self.time_base {
            Some(tb) => {
                (u128::from(ts) * u128::from(tb.numer) * u128::from(self.rate)
                    / u128::from(tb.denom)) as u64
            }
            None => ts,
        }
    }

    /// A frame, as a timestamp in the track's time base.
    fn ts_of(&self, frame: u64) -> u64 {
        match self.time_base {
            Some(tb) => {
                (u128::from(frame) * u128::from(tb.denom)
                    / (u128::from(tb.numer) * u128::from(self.rate))) as u64
            }
            None => frame,
        }
    }

    /// Positions the source so that reading begins at `frame`. The container
    /// lands at or before it (a whole block early, for FLAC); the frames in
    /// between are dropped as they're read.
    fn seek(&mut self, frame: u64) -> Result<(), String> {
        self.start = frame;
        if frame == 0 {
            return Ok(());
        }
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::TimeStamp {
                    ts: self.ts_of(frame),
                    track_id: self.track_id,
                },
            )
            .map_err(|e| format!("seek failed: {e}"))?;
        self.decoder.reset();
        self.position = self.frames_of(seeked.actual_ts);
        Ok(())
    }

    /// Appends the next packet's frames, interleaved, to `out`. A packet that
    /// won't decode becomes silence of its own length, so what follows doesn't
    /// shift earlier. `false` once the source has nothing more.
    fn read(&mut self, out: &mut Vec<f32>) -> bool {
        use symphonia::core::errors::Error;
        loop {
            if self.exhausted {
                return false;
            }
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(Error::IoError(ref e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    self.exhausted = true;
                    return false;
                }
                Err(e) => {
                    warn!(error = %e, "source ended early");
                    self.exhausted = true;
                    return false;
                }
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let at = if self.time_base.is_some() {
                self.frames_of(packet.ts())
            } else {
                self.position
            };
            let dur = self.frames_of(packet.dur());
            let ch = self.channels;
            let frames = match self.decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    let capacity = decoded.capacity();
                    if self
                        .sample_buf
                        .as_ref()
                        .is_none_or(|b| b.capacity() < capacity * spec.channels.count())
                    {
                        self.sample_buf = Some(SampleBuffer::new(capacity as u64, spec));
                    }
                    let buf = self.sample_buf.as_mut().unwrap();
                    buf.copy_interleaved_ref(decoded);
                    let samples = buf.samples();
                    let frames = (samples.len() / spec.channels.count()) as u64;
                    let skip = self.start.saturating_sub(at).min(frames) as usize;
                    if spec.channels.count() == ch {
                        out.extend_from_slice(&samples[skip * ch..]);
                    } else {
                        warn!("packet with an unexpected channel count; filled with silence");
                        out.resize(out.len() + (frames as usize - skip) * ch, 0.0);
                    }
                    frames
                }
                Err(Error::DecodeError(e)) => {
                    warn!(error = e, "packet failed to decode; filled with silence");
                    let skip = self.start.saturating_sub(at).min(dur);
                    out.resize(out.len() + (dur - skip) as usize * ch, 0.0);
                    dur
                }
                Err(e) => {
                    warn!(error = %e, "decoding stopped early");
                    self.exhausted = true;
                    return false;
                }
            };
            self.position = at + frames;
            return true;
        }
    }
}

// ── The output: the source at 48 kHz ────────────────────────────────────────

/// The source resampled to 48 kHz, with any frames before the first one wanted
/// dropped.
///
/// Output sample `o` is source frame `o × rate / 48000`: rubato's sinc
/// resampler keeps its output on the input's timeline (its `output_delay` is
/// latency, not an offset; the stream tests measure the alignment), so an
/// encode begun on a whole source frame lines up with one from the start.
struct Output {
    source: Source,
    resampler: Option<SincFixedIn<f32>>,
    /// Source frames waiting for a full resampler chunk, by channel.
    planar: Vec<Vec<f32>>,
    scratch: Vec<f32>,
    /// Output frames still to drop.
    discard: usize,
    /// Nothing more will come: the source is spent and the resampler flushed.
    exhausted: bool,
}

impl Output {
    fn new(source: Source, discard: u64) -> Result<Output, String> {
        let channels = source.channels;
        let resampler = if source.rate == OPUS_SAMPLE_RATE {
            None
        } else {
            let params = SincInterpolationParameters {
                sinc_len: 256,
                f_cutoff: 0.95,
                oversampling_factor: 256,
                interpolation: SincInterpolationType::Linear,
                window: WindowFunction::BlackmanHarris2,
            };
            Some(
                SincFixedIn::<f32>::new(
                    f64::from(OPUS_SAMPLE_RATE) / f64::from(source.rate),
                    2.0,
                    params,
                    RESAMPLE_CHUNK_SIZE,
                    channels,
                )
                .map_err(|e| format!("resampler creation failed: {e}"))?,
            )
        };
        Ok(Output {
            source,
            resampler,
            planar: vec![Vec::new(); channels],
            scratch: Vec::new(),
            discard: discard as usize,
            exhausted: false,
        })
    }

    /// Appends whatever the next source packet yields to `out`, interleaved.
    /// `false` once nothing more will come.
    fn produce(&mut self, out: &mut Vec<f32>) -> Result<bool, String> {
        if self.exhausted {
            return Ok(false);
        }
        let ch = self.source.channels;
        self.scratch.clear();
        let more = self.source.read(&mut self.scratch);
        let Some(rs) = self.resampler.as_mut() else {
            push_output(&mut self.discard, ch, &self.scratch, out);
            self.exhausted = !more;
            return Ok(more);
        };
        for (i, &s) in self.scratch.iter().enumerate() {
            self.planar[i % ch].push(s);
        }
        if more {
            while self.planar[0].len() >= RESAMPLE_CHUNK_SIZE {
                let chunk: Vec<&[f32]> = self
                    .planar
                    .iter()
                    .map(|c| &c[..RESAMPLE_CHUNK_SIZE])
                    .collect();
                let resampled = rs
                    .process(&chunk, None)
                    .map_err(|e| format!("resample failed: {e}"))?;
                for c in &mut self.planar {
                    c.drain(..RESAMPLE_CHUNK_SIZE);
                }
                push_planar(&mut self.discard, &resampled, out);
            }
        } else {
            // The remainder, then a chunk of silence to push the delay through.
            if !self.planar[0].is_empty() {
                let chunk: Vec<&[f32]> = self.planar.iter().map(|c| &c[..]).collect();
                let tail = rs
                    .process_partial(Some(&chunk), None)
                    .map_err(|e| format!("resample flush failed: {e}"))?;
                push_planar(&mut self.discard, &tail, out);
                for c in &mut self.planar {
                    c.clear();
                }
            }
            let tail = rs
                .process_partial::<Vec<f32>>(None, None)
                .map_err(|e| format!("resample flush failed: {e}"))?;
            push_planar(&mut self.discard, &tail, out);
            self.exhausted = true;
        }
        Ok(more)
    }
}

/// Appends interleaved `samples` to `out`, less the frames still to discard.
fn push_output(discard: &mut usize, channels: usize, samples: &[f32], out: &mut Vec<f32>) {
    let skip = (*discard * channels).min(samples.len());
    *discard -= skip / channels;
    out.extend_from_slice(&samples[skip..]);
}

/// Appends planar `channels` to `out`, interleaved, less the frames still to
/// discard.
fn push_planar(discard: &mut usize, channels: &[Vec<f32>], out: &mut Vec<f32>) {
    let frames = channels.first().map_or(0, Vec::len);
    let skip = (*discard).min(frames);
    *discard -= skip;
    out.reserve((frames - skip) * channels.len());
    for i in skip..frames {
        for c in channels {
            out.push(c[i]);
        }
    }
}

// ── An encode ───────────────────────────────────────────────────────────────

/// A source opened and probed, with its encoder made: everything a response's
/// headers need, before anything is encoded.
struct Prepared {
    source: Source,
    opus: OpusEncoder,
    pre_skip: u16,
    serial: u32,
    /// The two header pages.
    header: Vec<u8>,
    /// The stream's layout, or `None` when the source doesn't say how many
    /// frames it holds.
    layout: Option<Layout>,
    etag: String,
}

/// Opens `path` and makes the encoder for it. `track_id` fixes the stream's
/// serial number, so every request for a track agrees on it.
fn prepare(path: &Path, track_id: &str) -> Result<Prepared, String> {
    let source = Source::open(path)?;
    let opus_channels = if source.channels == 1 {
        OpusChannels::Mono
    } else {
        OpusChannels::Stereo
    };
    let mut opus = OpusEncoder::new(SampleRate::Hz48000, opus_channels, Application::Audio)
        .map_err(|e| format!("opus encoder creation failed: {e}"))?;
    opus.set_bitrate(Bitrate::BitsPerSecond(OPUS_BITRATE.cast_signed()))
        .map_err(|e| format!("set bitrate failed: {e}"))?;
    // Hard constant bitrate: every packet exactly `OPUS_PACKET_BYTES`, which is
    // what makes the layout predictable. DTX is off by default and must stay
    // off, or a silent frame would shrink.
    opus.set_vbr(false)
        .map_err(|e| format!("set constant bitrate failed: {e}"))?;
    let pre_skip = opus.lookahead().map_err(|e| format!("lookahead: {e}"))? as u16;

    let serial = u32::from_le_bytes(
        blake3::hash(track_id.as_bytes()).as_bytes()[..4]
            .try_into()
            .unwrap(),
    );
    let header = header_pages(source.channels as u8, pre_skip, source.rate, serial);
    let layout = source.frames.map(|frames| Layout {
        header_len: header.len() as u64,
        pre_skip,
        samples: output_samples(frames, source.rate),
    });
    let meta = std::fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    Ok(Prepared {
        source,
        opus,
        pre_skip,
        serial,
        header,
        layout,
        etag: etag(path, &meta),
    })
}

/// A strong `ETag` for a transcode: the source file's identity, the quality
/// and the layout version, so it changes whenever the bytes could.
fn etag(path: &Path, meta: &std::fs::Metadata) -> String {
    let mut h = blake3::Hasher::new();
    h.update(path.as_os_str().as_encoded_bytes());
    h.update(&meta.len().to_le_bytes());
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    h.update(&mtime.to_le_bytes());
    h.update(b"opus128");
    h.update(&LAYOUT_VERSION.to_le_bytes());
    format!("\"{}\"", &h.finalize().to_hex()[..16])
}

/// What one request wants encoded.
#[derive(Clone, Copy, Debug)]
struct Job {
    /// The output sample the stream's timeline begins at: 0, or where a
    /// `?start=` request begins.
    base: u64,
    /// The first audio page wanted.
    first_page: u64,
    /// The last audio page wanted, inclusive, or `None` for the stream's end.
    last_page: Option<u64>,
    /// The stream's layout when its length is known in advance. Without one,
    /// the stream runs until the source does.
    layout: Option<Layout>,
    /// The bytes to send, `[first, last]` inclusive within the whole stream,
    /// or `None` for everything from the first page.
    window: Option<(u64, u64)>,
}

impl Job {
    /// The whole stream, as laid out.
    fn whole(layout: Layout) -> Job {
        Job {
            base: 0,
            first_page: 0,
            last_page: None,
            layout: Some(layout),
            window: None,
        }
    }

    /// A stream without a length, from output sample `base`.
    fn unranged(base: u64) -> Job {
        Job {
            base,
            first_page: 0,
            last_page: None,
            layout: None,
            window: None,
        }
    }

    /// Bytes `[first, last]` of the stream `layout` describes.
    fn range(layout: Layout, first: u64, last: u64) -> Job {
        let first_page = if first < layout.header_len {
            0
        } else {
            layout.page_at(first)
        };
        let last_page = (last >= layout.header_len).then(|| layout.page_at(last));
        Job {
            base: 0,
            first_page,
            last_page,
            layout: Some(layout),
            window: Some((first, last)),
        }
    }

    /// For the log.
    fn describe(&self) -> String {
        match self.window {
            Some((first, last)) => format!("bytes {first}-{last}"),
            None if self.base > 0 => format!(
                "unranged, from {:.3} s",
                self.base as f64 / f64::from(OPUS_SAMPLE_RATE)
            ),
            None => "whole".to_string(),
        }
    }
}

/// Where a stream's bytes go.
trait Sink {
    /// `false` once the receiver has gone away.
    fn send(&mut self, bytes: Bytes) -> bool;
}

impl Sink for mpsc::Sender<io::Result<Bytes>> {
    fn send(&mut self, bytes: Bytes) -> bool {
        self.blocking_send(Ok(bytes)).is_ok()
    }
}

impl Sink for Vec<u8> {
    fn send(&mut self, bytes: Bytes) -> bool {
        self.extend_from_slice(&bytes);
        true
    }
}

/// The client stopped reading.
struct ClientGone;

/// Gathers a stream's bytes into chunks, keeps only those inside the job's
/// window, and paces them (in seconds of audio from the first page sent) on
/// their way to the sink.
struct Emitter<'a, S: Sink> {
    sink: &'a mut S,
    window: Option<(u64, u64)>,
    chunk: Vec<u8>,
    pacer: Pacer,
    /// Audio pages sent so far, which is what the pacing counts.
    pages: u64,
    /// Bytes sent so far.
    sent: u64,
}

impl<'a, S: Sink> Emitter<'a, S> {
    fn new(sink: &'a mut S, window: Option<(u64, u64)>) -> Self {
        Emitter {
            sink,
            window,
            chunk: Vec::with_capacity(CHUNK_BYTES),
            pacer: Pacer::new(PACE_HEAD_START_SECS, PACE_MULTIPLE),
            pages: 0,
            sent: 0,
        }
    }

    /// The part of `bytes`, which sit at `offset` in the whole stream, that
    /// falls inside the window.
    fn inside(&self, offset: u64, len: usize) -> (usize, usize) {
        match self.window {
            Some((first, last)) => {
                let lo = first.saturating_sub(offset).min(len as u64) as usize;
                let hi = (last + 1).saturating_sub(offset).min(len as u64) as usize;
                (lo, hi.max(lo))
            }
            None => (0, len),
        }
    }

    /// Sends the part of `bytes` (at `offset` in the whole stream) that's
    /// wanted.
    fn emit(&mut self, offset: u64, bytes: &[u8]) -> Result<(), ClientGone> {
        let (lo, hi) = self.inside(offset, bytes.len());
        if lo < hi {
            self.chunk.extend_from_slice(&bytes[lo..hi]);
        }
        if self.chunk.len() >= CHUNK_BYTES {
            self.flush()?;
        }
        Ok(())
    }

    /// Sends an audio page, or the part of it that's wanted.
    fn emit_page(&mut self, offset: u64, page: &[u8]) -> Result<(), ClientGone> {
        let (lo, hi) = self.inside(offset, page.len());
        if lo < hi {
            self.pages += 1;
        }
        self.emit(offset, page)
    }

    fn flush(&mut self) -> Result<(), ClientGone> {
        if self.chunk.is_empty() {
            return Ok(());
        }
        let delay = self
            .pacer
            .delay(self.pages as f64 * OPUS_FRAME_SAMPLES as f64 / f64::from(OPUS_SAMPLE_RATE));
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        let bytes = Bytes::from(std::mem::take(&mut self.chunk));
        self.sent += bytes.len() as u64;
        if self.sink.send(bytes) {
            Ok(())
        } else {
            Err(ClientGone)
        }
    }

    fn finish(&mut self) -> Result<(), ClientGone> {
        self.flush()
    }
}

enum Outcome {
    Completed,
    ClientGone,
}

/// Encodes what `job` asks for and sends it through `out`.
///
/// An encode that starts part-way in has to sound the same, at every page, as
/// one from the start, since the client splices them. So it begins a second
/// early (`PRE_ROLL_SAMPLES`) to settle the resampler and the encoder, and
/// that second begins on a sample where the resampler's phase matches the
/// from-the-start encode's: a multiple of `48000 / gcd(rate, 48000)` output
/// samples, which is a whole source frame. The frames before the first page
/// wanted are encoded and thrown away.
#[allow(clippy::too_many_lines)]
fn encode<S: Sink>(
    prepared: Prepared,
    job: &Job,
    out: &mut Emitter<'_, S>,
) -> Result<Outcome, String> {
    let Prepared {
        mut source,
        opus,
        pre_skip,
        serial,
        header,
        ..
    } = prepared;
    let ch = source.channels;
    let rate = source.rate;
    let header_len = header.len() as u64;
    let frame = OPUS_FRAME_SAMPLES as u64;

    // Output samples: `keep_from` is the first page wanted; the resampler
    // starts at `s0`, the encoder at `e0`, a whole number of frames before
    // `keep_from`.
    let keep_from = job.base + job.first_page * frame;
    let step = u64::from(OPUS_SAMPLE_RATE) / gcd(u64::from(rate), u64::from(OPUS_SAMPLE_RATE));
    let s0 = keep_from.saturating_sub(PRE_ROLL_SAMPLES) / step * step;
    let e0 = keep_from - (keep_from - s0) / frame * frame;
    let f0 = (u128::from(s0) * u128::from(rate) / u128::from(OPUS_SAMPLE_RATE)) as u64;
    source.seek(f0)?;
    let mut output = Output::new(source, e0 - s0)?;

    let mut layout = job.layout;
    let mut buf: Vec<f32> = Vec::new();
    let mut pos = e0;
    let mut frame_buf = vec![0f32; OPUS_FRAME_SAMPLES * ch];
    let mut packet = vec![0u8; 1275];

    if out.emit(0, &header).is_err() {
        return Ok(Outcome::ClientGone);
    }
    if job.last_page.is_none() && job.window.is_some_and(|(_, last)| last < header_len) {
        // A range inside the headers: nothing to encode.
        return Ok(match out.finish() {
            Ok(()) => Outcome::Completed,
            Err(ClientGone) => Outcome::ClientGone,
        });
    }

    loop {
        // A stream without a layout learns its length only when the source runs
        // out, and has to know before it writes the last page.
        if layout.is_none() {
            while buf.len() <= frame_buf.len() && output.produce(&mut buf)? {}
            if output.exhausted {
                let samples = (pos + (buf.len() / ch) as u64).saturating_sub(job.base);
                layout = Some(Layout {
                    header_len,
                    pre_skip,
                    samples,
                });
            }
        }
        let page = (pos >= keep_from).then(|| (pos - job.base) / frame);
        let pages = layout.map(|l| l.pages());
        if let (Some(i), Some(total)) = (page, pages)
            && i >= total
        {
            break;
        }

        // The frame's input: audio up to `N`, silence from there on.
        let real = match layout {
            Some(l) => (job.base + l.samples).saturating_sub(pos).min(frame) as usize,
            None => OPUS_FRAME_SAMPLES,
        };
        while buf.len() < real * ch && output.produce(&mut buf)? {}
        let have = buf.len().min(real * ch);
        frame_buf[..have].copy_from_slice(&buf[..have]);
        frame_buf[have..].fill(0.0);
        buf.drain(..have);

        let len = opus
            .encode_float(&frame_buf, &mut packet)
            .map_err(|e| format!("opus encode failed: {e}"))?;
        if len != OPUS_PACKET_BYTES {
            return Err(format!(
                "opus packet of {len} bytes, not {OPUS_PACKET_BYTES}: the layout is broken"
            ));
        }
        if let Some(i) = page {
            let last = pages.is_some_and(|total| i + 1 == total);
            let granule = match layout {
                Some(l) => l.granule(i),
                None => (i + 1) * frame,
            };
            let bytes = ogg_page(
                if last { OGG_EOS } else { 0 },
                granule,
                serial,
                (i + 2) as u32,
                &packet[..len],
            );
            if out.emit_page(page_offset(header_len, i), &bytes).is_err() {
                return Ok(Outcome::ClientGone);
            }
            if last || job.last_page == Some(i) {
                break;
            }
        }
        pos += frame;
    }
    match out.finish() {
        Ok(()) => Ok(Outcome::Completed),
        Err(ClientGone) => Ok(Outcome::ClientGone),
    }
}

/// Runs an encode for a response, and records how it went. A client going
/// away is routine (every skip is one); only a failure is an error, and it
/// aborts the body rather than ending it short, so the client knows.
fn run_encode(
    prepared: Prepared,
    job: Job,
    mut tx: mpsc::Sender<io::Result<Bytes>>,
    track_id: &str,
) {
    let range = job.describe();
    let mut out = Emitter::new(&mut tx, job.window);
    let result = encode(prepared, &job, &mut out);
    let bytes = out.sent;
    match result {
        Ok(Outcome::Completed) => debug!(track_id, range, bytes, "stream completed"),
        Ok(Outcome::ClientGone) => {
            debug!(
                track_id,
                range, bytes, "stream stopped: the client went away"
            );
        }
        Err(e) => {
            error!(track_id, range, bytes, error = %e, "transcode stream failed");
            let _ = tx.blocking_send(Err(io::Error::other(e)));
        }
    }
}

// ── The response ────────────────────────────────────────────────────────────

/// What a request for a stream of `len` bytes is answered with, by its
/// `Range` and `If-Range` headers (RFC 9110, §14).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Answer {
    /// The whole stream: no range asked for, one that can't be read, more than
    /// one (which the RFC allows ignoring), or a condition that isn't met.
    Whole,
    /// Bytes `first..=last`.
    Part { first: u64, last: u64 },
    /// A range that starts past the end.
    Unsatisfiable,
}

fn answer(range: Option<&str>, if_range: Option<&str>, etag: &str, len: u64) -> Answer {
    let Some(range) = range else {
        return Answer::Whole;
    };
    // A client with an older copy of the stream must get the whole of this one.
    if if_range.is_some_and(|tag| tag.trim() != etag) {
        return Answer::Whole;
    }
    let Some(spec) = range.trim().strip_prefix("bytes=") else {
        return Answer::Whole;
    };
    if spec.contains(',') {
        return Answer::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Answer::Whole;
    };
    let number = |s: &str| s.trim().parse::<u64>().ok();
    match (first.trim(), last.trim()) {
        ("", suffix) => {
            // The last `suffix` bytes.
            let Some(suffix) = number(suffix) else {
                return Answer::Whole;
            };
            if suffix == 0 || len == 0 {
                return Answer::Unsatisfiable;
            }
            Answer::Part {
                first: len.saturating_sub(suffix),
                last: len - 1,
            }
        }
        (first, "") => {
            let Some(first) = number(first) else {
                return Answer::Whole;
            };
            if first >= len {
                return Answer::Unsatisfiable;
            }
            Answer::Part {
                first,
                last: len - 1,
            }
        }
        (first, last) => {
            let (Some(first), Some(last)) = (number(first), number(last)) else {
                return Answer::Whole;
            };
            if first > last {
                return Answer::Whole;
            }
            if first >= len {
                return Answer::Unsatisfiable;
            }
            Answer::Part {
                first,
                last: last.min(len - 1),
            }
        }
    }
}

/// What a transcode needs to know about the request: taken out of it up
/// front, so nothing of the request is held while the source is prepared.
struct StreamRequest {
    method: Method,
    range: Option<String>,
    if_range: Option<String>,
}

impl From<&Request> for StreamRequest {
    fn from(request: &Request) -> Self {
        let text = |name: header::HeaderName| {
            request
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        StreamRequest {
            method: request.method().clone(),
            range: text(header::RANGE),
            if_range: text(header::IF_RANGE),
        }
    }
}

async fn transcode_response(
    track: &TrackFile,
    track_id: &str,
    start: f64,
    request: &StreamRequest,
) -> Response {
    let prepared = {
        let path = track.path.clone();
        let id = track_id.to_string();
        tokio::task::spawn_blocking(move || prepare(&path, &id)).await
    };
    let prepared = match prepared {
        Ok(Ok(p)) => p,
        Ok(Err(msg)) => {
            error!(track_id, path = %track.path.display(), error = %msg, "transcode setup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response();
        }
        Err(_) => {
            error!(track_id, path = %track.path.display(), "transcode setup panicked");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "transcode setup panicked",
            )
                .into_response();
        }
    };

    let base = (start.max(0.0) * f64::from(OPUS_SAMPLE_RATE)).round() as u64;
    let (job, response) = match prepared.layout {
        Some(layout) if base == 0 => {
            let len = layout.len();
            let response = Response::builder()
                .header(header::CONTENT_TYPE, "audio/ogg")
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ETAG, &prepared.etag);
            match answer(
                request.range.as_deref(),
                request.if_range.as_deref(),
                &prepared.etag,
                len,
            ) {
                Answer::Whole => (
                    Job::whole(layout),
                    response
                        .status(StatusCode::OK)
                        .header(header::CONTENT_LENGTH, len),
                ),
                Answer::Part { first, last } => (
                    Job::range(layout, first, last),
                    response
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_RANGE, format!("bytes {first}-{last}/{len}"))
                        .header(header::CONTENT_LENGTH, last - first + 1),
                ),
                Answer::Unsatisfiable => {
                    return response
                        .status(StatusCode::RANGE_NOT_SATISFIABLE)
                        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                        .body(Body::empty())
                        .unwrap();
                }
            }
        }
        layout => {
            if layout.is_none() {
                warn!(track_id, path = %track.path.display(), "source length unknown: serving an unranged stream");
            }
            let response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "audio/ogg");
            (Job::unranged(base), response)
        }
    };

    if request.method == Method::HEAD {
        return response.body(Body::empty()).unwrap();
    }
    let (tx, rx) = mpsc::channel::<io::Result<Bytes>>(16);
    let id = track_id.to_string();
    tokio::task::spawn_blocking(move || run_encode(prepared, job, tx, &id));
    response
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use audiopus::coder::Decoder as OpusDecoder;
    use audiopus::{MutSignals, packet::Packet};
    use std::time::Duration;

    #[test]
    fn pacer_sends_the_head_start_unpaced() {
        let pacer = Pacer::new(1000.0, 100.0);
        assert_eq!(pacer.delay_after(1000.0, Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn pacer_holds_back_whatever_is_early() {
        let pacer = Pacer::new(1000.0, 100.0);
        // 500 past the head start is due 5s in; at 2s, that's 3s to wait.
        assert_eq!(
            pacer.delay_after(1500.0, Duration::from_secs(2)),
            Duration::from_secs(3)
        );
    }

    #[test]
    fn pacer_never_waits_once_behind() {
        let pacer = Pacer::new(1000.0, 100.0);
        assert_eq!(
            pacer.delay_after(1500.0, Duration::from_secs(9)),
            Duration::ZERO
        );
    }

    #[test]
    fn range_start_reads_content_range() {
        let response = ([(header::CONTENT_RANGE, "bytes 1000-1999/5000")], "").into_response();
        assert_eq!(range_start(&response), 1000);
    }

    #[test]
    fn range_start_is_zero_for_a_whole_file() {
        assert_eq!(range_start(&"".into_response()), 0);
    }

    // ── Source audio ────────────────────────────────────────────────────────

    /// A directory of its own for one test's files, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let dir = std::env::temp_dir()
                .join(format!("radiocrate-stream-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self, file: &str) -> PathBuf {
            self.0.join(file)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Sample `i` of channel `c` of the test signal: a tone per channel, with
    /// a touch of harmonic so the encoder has something to work on.
    fn tone(i: u64, channel: usize, rate: u32) -> f32 {
        let seconds = i as f64 / f64::from(rate);
        let hz = if channel == 0 { 440.0 } else { 660.0 };
        let phase = 2.0 * std::f64::consts::PI * hz * seconds;
        (0.5 * phase.sin() + 0.1 * (3.0 * phase).sin()) as f32
    }

    /// Writes `frames` frames of the test signal as a 16-bit PCM WAV.
    fn write_wav(path: &Path, rate: u32, channels: usize, frames: u64) {
        let data_len = (frames as usize * channels * 2) as u32;
        let mut bytes = Vec::with_capacity(44 + data_len as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&(channels as u16).to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        bytes.extend_from_slice(&(channels as u16 * 2).to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            for c in 0..channels {
                let v = (f64::from(tone(i, c, rate)) * 32767.0).round() as i16;
                bytes.extend_from_slice(&v.to_le_bytes());
            }
        }
        std::fs::write(path, bytes).unwrap();
    }

    const TRACK: &str = "0b2a6c1e-6e0f-4a3d-9c1a-5f3c2d1e0b9a";

    /// Encodes what `job` asks of `path`, unpaced in effect (the test files are
    /// shorter than the head start).
    fn encode_job(path: &Path, job: &Job) -> Vec<u8> {
        let prepared = prepare(path, TRACK).unwrap();
        let mut bytes = Vec::new();
        let mut out = Emitter::new(&mut bytes, job.window);
        match encode(prepared, job, &mut out) {
            Ok(Outcome::Completed) => {}
            Ok(Outcome::ClientGone) => panic!("a Vec never goes away"),
            Err(e) => panic!("encode failed: {e}"),
        }
        bytes
    }

    fn encode_whole(path: &Path) -> (Vec<u8>, Layout) {
        let layout = prepare(path, TRACK).unwrap().layout.unwrap();
        (encode_job(path, &Job::whole(layout)), layout)
    }

    // ── Reading the stream back ─────────────────────────────────────────────

    struct Page {
        flags: u8,
        granule: u64,
        serial: u32,
        seq: u32,
        packet: Vec<u8>,
        len: usize,
    }

    /// Parses `bytes` as Ogg pages of one packet each, checking each page's
    /// capture pattern, version and CRC.
    fn parse_pages(bytes: &[u8]) -> Vec<Page> {
        let mut pages = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            let h = &bytes[at..];
            assert_eq!(&h[0..4], b"OggS", "capture pattern at {at}");
            assert_eq!(h[4], 0, "version");
            let segments = h[26] as usize;
            let lacing = &h[27..27 + segments];
            let packet_len: usize = lacing.iter().map(|&l| l as usize).sum();
            let len = 27 + segments + packet_len;
            let page = &bytes[at..at + len];
            let mut unsigned = page.to_vec();
            unsigned[22..26].fill(0);
            let crc = u32::from_le_bytes(page[22..26].try_into().unwrap());
            assert_eq!(crc, ogg_crc(&unsigned), "CRC of page at {at}");
            pages.push(Page {
                flags: h[5],
                granule: u64::from_le_bytes(h[6..14].try_into().unwrap()),
                serial: u32::from_le_bytes(h[14..18].try_into().unwrap()),
                seq: u32::from_le_bytes(h[18..22].try_into().unwrap()),
                packet: page[27 + segments..].to_vec(),
                len,
            });
            at += len;
        }
        pages
    }

    /// Decodes the audio pages' packets to interleaved samples at 48 kHz,
    /// nothing dropped.
    fn decode(pages: &[Page], channels: usize) -> Vec<f32> {
        let opus_channels = if channels == 1 {
            OpusChannels::Mono
        } else {
            OpusChannels::Stereo
        };
        let mut decoder = OpusDecoder::new(SampleRate::Hz48000, opus_channels).unwrap();
        let mut out = Vec::new();
        let mut frame = vec![0f32; 5760 * channels];
        for page in &pages[2..] {
            let n = decoder
                .decode_float(
                    Some(Packet::try_from(&page.packet[..]).unwrap()),
                    MutSignals::try_from(&mut frame[..]).unwrap(),
                    false,
                )
                .unwrap();
            assert_eq!(n, OPUS_FRAME_SAMPLES);
            out.extend_from_slice(&frame[..n * channels]);
        }
        out
    }

    /// The signal-to-noise ratio of `test` against `reference`, in dB.
    fn snr_db(reference: &[f32], test: &[f32]) -> f64 {
        assert_eq!(reference.len(), test.len());
        let signal: f64 = reference.iter().map(|&s| f64::from(s).powi(2)).sum();
        let noise: f64 = reference
            .iter()
            .zip(test)
            .map(|(&r, &t)| (f64::from(r) - f64::from(t)).powi(2))
            .sum();
        10.0 * (signal / noise.max(1e-12)).log10()
    }

    // ── Pages ───────────────────────────────────────────────────────────────

    /// A page as the `ogg` crate wrote it (before that dependency was dropped),
    /// so the hand-written CRC and header have an independent check.
    #[test]
    fn a_page_matches_a_reference_writer() {
        const REFERENCE: &str = "4f67675300020000000000000000efbeadde00000000459617b501134f707573486561640102380144ac0000000000";
        let expected: Vec<u8> = (0..REFERENCE.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&REFERENCE[i..i + 2], 16).unwrap())
            .collect();
        let head = build_opus_head(2, 312, 44_100);
        assert_eq!(ogg_page(OGG_BOS, 0, 0xdead_beef, 0, &head), expected);
    }

    #[test]
    fn the_layout_follows_from_the_constants() {
        assert_eq!(OPUS_PACKET_BYTES, 320);
        assert_eq!(AUDIO_PAGE_BYTES, 349);
        let header = header_pages(2, 312, 44_100, 1);
        assert_eq!(header.len(), 47 + 54);
        let layout = Layout {
            header_len: header.len() as u64,
            pre_skip: 312,
            samples: 48_000,
        };
        assert_eq!(layout.pages(), 51); // 48 312 / 960, rounded up
        assert_eq!(layout.len(), 101 + 51 * 349);
        assert_eq!(page_offset(layout.header_len, 0), 101);
        assert_eq!(layout.page_at(101 + 349 * 3 + 348), 3);
        assert_eq!(layout.page_at(101 + 349 * 4), 4);
        assert_eq!(layout.granule(0), 960);
        assert_eq!(layout.granule(50), 48_312);
    }

    #[test]
    fn output_length_rounds_up() {
        assert_eq!(output_samples(44_100, 44_100), 48_000);
        assert_eq!(output_samples(44_101, 44_100), 48_002);
        assert_eq!(output_samples(1, 96_000), 1);
        assert_eq!(output_samples(0, 96_000), 0);
    }

    // ── The whole stream ────────────────────────────────────────────────────

    /// Checks everything the layout promises about a whole stream of `path`.
    fn check_whole(path: &Path, channels: usize) -> (Vec<u8>, Layout, Vec<Page>) {
        let (bytes, layout) = encode_whole(path);
        assert_eq!(bytes.len() as u64, layout.len(), "body length");
        let pages = parse_pages(&bytes);
        assert_eq!(pages.len() as u64, layout.pages() + 2);
        for (i, page) in pages.iter().enumerate() {
            assert_eq!(page.seq as usize, i, "sequence number");
            assert_eq!(page.serial, pages[0].serial);
            let bos = page.flags & OGG_BOS != 0;
            let eos = page.flags & OGG_EOS != 0;
            assert_eq!(bos, i == 0, "BOS on page {i}");
            assert_eq!(eos, i + 1 == pages.len(), "EOS on page {i}");
            if i >= 2 {
                assert_eq!(page.len as u64, AUDIO_PAGE_BYTES, "page {i} length");
                assert_eq!(page.packet.len(), OPUS_PACKET_BYTES);
                assert_eq!(page.granule, layout.granule(i as u64 - 2), "granule {i}");
            } else {
                assert_eq!(page.granule, 0);
            }
        }
        let last = pages.last().unwrap();
        assert_eq!(last.granule, u64::from(layout.pre_skip) + layout.samples);
        assert!(&pages[0].packet.starts_with(b"OpusHead"));
        assert!(&pages[1].packet.starts_with(b"OpusTags"));
        let decoded = decode(&pages, channels);
        assert_eq!(
            decoded.len(),
            layout.pages() as usize * OPUS_FRAME_SAMPLES * channels
        );
        (bytes, layout, pages)
    }

    #[test]
    fn whole_streams_match_their_layout() {
        let dir = TempDir::new("whole");
        for &rate in &[44_100_u32, 48_000, 96_000] {
            for channels in [1, 2] {
                // Shorter than a frame; exactly a whole number of frames at 48
                // kHz (`rate` frames is a second, 50 frames); and neither.
                for &frames in &[u64::from(rate) / 100, u64::from(rate), 12_345] {
                    let path = dir.path(&format!("{rate}-{channels}-{frames}.wav"));
                    write_wav(&path, rate, channels, frames);
                    let (_, layout, _) = check_whole(&path, channels);
                    assert_eq!(layout.samples, output_samples(frames, rate));
                }
            }
        }
    }

    #[test]
    fn a_whole_stream_decodes_to_the_source() {
        let dir = TempDir::new("decode");
        let path = dir.path("tone.wav");
        let (rate, channels, frames) = (48_000, 2, 100_000);
        write_wav(&path, rate, channels, frames);
        let (_, layout, pages) = check_whole(&path, channels);
        let decoded = decode(&pages, channels);
        let p = layout.pre_skip as usize;
        let n = layout.samples as usize;
        assert_eq!(n, frames as usize);
        let audio = &decoded[p * channels..(p + n) * channels];
        let source: Vec<f32> = (0..frames)
            .flat_map(|i| (0..channels).map(move |c| tone(i, c, rate)))
            .collect();
        let snr = snr_db(&source, audio);
        assert!(snr > 20.0, "SNR {snr:.1} dB");
    }

    #[test]
    fn a_resampled_stream_decodes_to_the_source() {
        let dir = TempDir::new("resampled");
        let path = dir.path("tone.wav");
        let (rate, channels, frames) = (44_100, 1, 88_200);
        write_wav(&path, rate, channels, frames);
        let (_, layout, pages) = check_whole(&path, channels);
        let decoded = decode(&pages, channels);
        let p = layout.pre_skip as usize;
        let n = layout.samples as usize;
        assert_eq!(n, 96_000);
        // The tone at 48 kHz, skipping the resampler's first and last few
        // milliseconds, where its filter has nothing on one side.
        let edge = 2_000;
        let audio = &decoded[(p + edge) * channels..(p + n - edge) * channels];
        let source: Vec<f32> = (edge as u64..(n - edge) as u64)
            .map(|i| tone(i, 0, 48_000))
            .collect();
        let snr = snr_db(&source, audio);
        assert!(snr > 20.0, "SNR {snr:.1} dB");
    }

    #[test]
    fn a_stream_is_the_same_every_time() {
        let dir = TempDir::new("deterministic");
        let path = dir.path("tone.wav");
        write_wav(&path, 44_100, 2, 50_000);
        assert_eq!(encode_whole(&path).0, encode_whole(&path).0);
    }

    #[test]
    fn an_unranged_stream_has_no_layout_but_ends_cleanly() {
        let dir = TempDir::new("unranged");
        let path = dir.path("tone.wav");
        write_wav(&path, 48_000, 1, 20_000);
        let bytes = encode_job(&path, &Job::unranged(0));
        let (whole, _) = encode_whole(&path);
        assert_eq!(bytes, whole);

        // From a second in: the stream's timeline starts there.
        let bytes = encode_job(&path, &Job::unranged(4_800));
        let pages = parse_pages(&bytes);
        let layout = Layout {
            header_len: 101,
            pre_skip: u16::from_le_bytes([pages[0].packet[10], pages[0].packet[11]]),
            samples: 20_000 - 4_800,
        };
        assert_eq!(pages.len() as u64, layout.pages() + 2);
        assert_eq!(
            pages.last().unwrap().granule,
            layout.granule(layout.pages() - 1)
        );
        assert!(pages.last().unwrap().flags & OGG_EOS != 0);
    }

    // ── Ranges ──────────────────────────────────────────────────────────────

    #[test]
    fn a_range_is_answered_by_the_rfc() {
        let tag = "\"abc\"";
        let ask = |range: Option<&str>, if_range: Option<&str>| answer(range, if_range, tag, 1000);
        let part = |first, last| Answer::Part { first, last };
        assert_eq!(ask(None, None), Answer::Whole);
        assert_eq!(ask(Some("bytes=0-499"), None), part(0, 499));
        assert_eq!(ask(Some("bytes=500-"), None), part(500, 999));
        assert_eq!(ask(Some("bytes=-100"), None), part(900, 999));
        assert_eq!(ask(Some("bytes=-5000"), None), part(0, 999));
        assert_eq!(ask(Some("bytes=0-5000"), None), part(0, 999));
        assert_eq!(ask(Some("bytes=999-999"), None), part(999, 999));
        assert_eq!(ask(Some("bytes=1000-"), None), Answer::Unsatisfiable);
        assert_eq!(ask(Some("bytes=1000-1005"), None), Answer::Unsatisfiable);
        assert_eq!(ask(Some("bytes=-0"), None), Answer::Unsatisfiable);
        assert_eq!(ask(Some("bytes=0-10,20-30"), None), Answer::Whole);
        assert_eq!(ask(Some("bytes=30-20"), None), Answer::Whole);
        assert_eq!(ask(Some("bytes=abc"), None), Answer::Whole);
        assert_eq!(ask(Some("items=0-10"), None), Answer::Whole);
        assert_eq!(ask(Some("bytes=0-10"), Some(tag)), part(0, 10));
        assert_eq!(ask(Some("bytes=0-10"), Some("\"old\"")), Answer::Whole);
        assert_eq!(
            ask(Some("bytes=0-10"), Some("Tue, 10 Nov 2026 10:00:00 GMT")),
            Answer::Whole
        );
        assert_eq!(
            answer(Some("bytes=-10"), None, tag, 0),
            Answer::Unsatisfiable
        );
    }

    #[test]
    fn a_range_job_covers_the_pages_it_touches() {
        let layout = Layout {
            header_len: 101,
            pre_skip: 312,
            samples: 48_000,
        };
        let job = Job::range(layout, 0, 50);
        assert_eq!((job.first_page, job.last_page), (0, None));
        let job = Job::range(layout, 100, 101);
        assert_eq!((job.first_page, job.last_page), (0, Some(0)));
        let job = Job::range(layout, 101 + 349 * 3 + 10, 101 + 349 * 5);
        assert_eq!((job.first_page, job.last_page), (3, Some(5)));
        let job = Job::range(layout, layout.len() - 1, layout.len() - 1);
        assert_eq!((job.first_page, job.last_page), (50, Some(50)));
    }

    /// Checks a range `first..=last` of the stream of `path` against the whole
    /// stream `whole`: the right length; byte-identical when its pre-roll
    /// reaches the start; and every page's header fields the same otherwise.
    fn check_range(path: &Path, layout: Layout, whole: &[u8], first: u64, last: u64) {
        let job = Job::range(layout, first, last);
        let bytes = encode_job(path, &job);
        assert_eq!(
            bytes.len() as u64,
            last - first + 1,
            "length of {first}-{last}"
        );
        let expected = &whole[first as usize..=last as usize];
        let from_start = job.first_page * OPUS_FRAME_SAMPLES as u64 <= PRE_ROLL_SAMPLES;
        if from_start {
            assert!(bytes == expected, "bytes of {first}-{last} differ");
            return;
        }
        // Each page's header, up to the CRC, where the two coincide.
        let mut at = page_offset(layout.header_len, job.first_page);
        while at + AUDIO_PAGE_BYTES <= last + 1 {
            if at >= first {
                let lo = (at - first) as usize;
                assert_eq!(
                    &bytes[lo..lo + 22],
                    &whole[at as usize..at as usize + 22],
                    "page header at {at} in {first}-{last}"
                );
            }
            at += AUDIO_PAGE_BYTES;
        }
    }

    #[test]
    fn ranges_line_up_with_the_whole_stream() {
        let dir = TempDir::new("ranges");
        let path = dir.path("tone.wav");
        write_wav(&path, 44_100, 2, 110_250); // 2.5 s: 120 000 samples, 126 pages
        let (whole, layout) = encode_whole(&path);
        let len = layout.len();
        assert_eq!(layout.pages(), 126);
        let page = |i: u64| page_offset(layout.header_len, i);
        let firsts = [
            0,
            1,
            50,
            100,
            101,
            102,
            page(1),
            page(10) + 5,
            page(50),
            page(51),
            page(60) + 348,
            page(100) + 17,
            len - 1000,
            len - 1,
        ];
        for &first in &firsts {
            check_range(&path, layout, &whole, first, len - 1);
        }
        check_range(&path, layout, &whole, 0, 0);
        check_range(&path, layout, &whole, 0, 100);
        check_range(&path, layout, &whole, 46, 47);
        check_range(&path, layout, &whole, 100, 101);
        check_range(&path, layout, &whole, page(3) + 100, page(3) + 200);
        check_range(&path, layout, &whole, page(70) + 100, page(72) + 200);
        check_range(&path, layout, &whole, page(125), len - 1);
    }

    #[test]
    fn a_stream_begun_part_way_in_sounds_like_the_whole() {
        let dir = TempDir::new("splice");
        let path = dir.path("tone.wav");
        write_wav(&path, 44_100, 2, 132_300); // 3 s, resampled: the phase alignment matters
        let (whole, layout) = encode_whole(&path);
        let k = 100usize; // 2 s in: the pre-roll starts at 1 s, not at the start
        let bytes = encode_job(
            &path,
            &Job::range(
                layout,
                page_offset(layout.header_len, k as u64),
                layout.len() - 1,
            ),
        );
        let whole_pages = parse_pages(&whole);
        let part_audio = parse_pages(&bytes);
        assert_eq!(part_audio.len() as u64, layout.pages() - k as u64);
        assert_eq!(part_audio[0].seq as usize, k + 2);
        let reference = decode(&whole_pages, 2);
        let total = reference.len();
        let frame = OPUS_FRAME_SAMPLES * 2;

        // A retry after a dropped connection: the decoder has played the whole
        // stream up to page k, and goes on with the range's pages.
        let mut spliced = parse_pages(&whole[..page_offset(layout.header_len, k as u64) as usize]);
        spliced.extend(part_audio);
        let warm = decode(&spliced, 2);
        let snr = snr_db(&reference[k * frame..], &warm[k * frame..total]);
        assert!(snr > 40.0, "spliced onto a warm decoder: SNR {snr:.1} dB");

        // A seek: the decoder starts cold at page k. Opus predicts each frame's
        // band energies from the last, so a cold decoder takes a few frames to
        // converge, which is why RFC 7845 has players pre-roll 80 ms (four
        // pages) after a seek. The same happens in any Ogg Opus file.
        let mut from_k = parse_pages(&whole[..layout.header_len as usize]);
        from_k.extend(parse_pages(&bytes));
        let cold = decode(&from_k, 2);
        let settle = 4;
        let snr = snr_db(
            &reference[(k + settle) * frame..],
            &cold[settle * frame..cold.len()],
        );
        assert!(snr > 30.0, "cold decoder, 80 ms in: SNR {snr:.1} dB");
    }
}
