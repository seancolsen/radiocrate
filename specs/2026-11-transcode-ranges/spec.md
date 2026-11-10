# Range requests for transcoded streams

Give the Opus transcode a known length and byte-range support, **without
encoding the track ahead of time and without a cache**. It does this by making
the transcode's byte layout predictable: hard constant-bitrate Opus, one packet
per Ogg page, so every page is the same size and byte N always belongs to a
known 20 ms frame.

Status: **proposed**, 2026-11-10. Nothing implemented yet. The stopgap that
prompted it, `resumeCutShort` in the audio engine, landed in 3a44c72.

## Status

Update this table as phases land, so a session starting cold doesn't have to
reconstruct progress from `git log`.

| Phase | Status |
| ----- | ------ |
| 1 — Playback logging | not started |
| 2 — Fixed layout, whole stream with `Content-Length` | not started |
| 3 — Range requests | not started |
| 4 — Client cleanup | not started |
| 5 — Stress testing on the phone | not started (the user does this; see "Validation") |

## For the implementing agent

- Read the whole spec before starting. The sections "Why" and "Options
  considered" record decisions the user has already made. Don't reopen them
  unless something here turns out to be factually wrong; if it does, stop and
  say so.
- Follow `CLAUDE.md`. In particular:
  - **No new backend dependencies are needed**, and none should be added.
    Changing `backend/Cargo.toml` means you must stop and ask the user to run
    cargo. The Ogg page writer and its CRC are small enough to write by hand
    (see "Writing pages by hand"). Leave the now-unused `ogg` crate in
    `Cargo.toml`; removing it is a later chore for the user.
  - Run cargo one crate at a time (`cargo check -p backend`,
    `cargo clippy -p backend`, `cargo test -p backend stream`). `--workspace`
    or several `-p` flags rebuilds DuckDB. Never `cargo build`.
  - If `cargo test -p backend` fails to *link* (a `rust-lld` relocation error),
    that's a known environmental problem, not your change. Tell the user;
    don't `cargo clean`.
- Commit at the end of each phase, and update the status table above in the
  same commit.

## Background

### How a transcode works today

`backend/src/stream.rs`, `transcode_response` and `transcode_inner`:

1. Symphonia decodes the lossless source (`is_lossless`: flac, wav, aiff, alac,
   ape, wv, caf). Only `quality=opus128` requests for those formats are
   transcoded. Everything else goes through `passthrough_response`, which uses
   `ServeFile` and already supports ranges.
2. rubato's `SincFixedIn` resamples to 48 kHz, if needed.
3. libopus (`audiopus`) encodes **variable-bitrate** 128 kbps, 20 ms frames.
4. Each packet goes into its own Ogg page (`PacketWriteEndInfo::EndPage`), via
   the `ogg` crate's `PacketWriter`, and out through an mpsc channel as the
   response body.
5. The response is `200` with `Content-Type: audio/ogg`, **no
   `Content-Length`, no `Accept-Ranges`**. The serial number is taken from the
   clock, so two requests for the same track differ.
6. After a 3 s head start, the body is paced to 4× real time (`Pacer`), so a
   download doesn't fill a slow link's buffer and delay every other request.
7. `?start=<seconds>` seeks the source and transcodes from there. The client
   uses it to seek beyond what has buffered, because the browser can't seek in
   a stream it can't range-request.

On the client (`frontend/src/audio/engine.ts`) the element reports an infinite
duration for such a stream. The engine works around that in several places,
all keyed on `Number.isFinite(el.duration)` or the `unbounded` set:

- `knownDuration`: the library's length, fetched with the track's metadata,
  used for the timeline and the lock screen.
- `seek` → `restartAt`, with `offset`: a seek beyond the buffer re-requests the
  transcode with `start=`, and the engine shifts everything the element reports
  by `offset`.
- `resumeCutShort`: see the next section.

### The bug that prompted this

On Chrome for Android, about 1 track in 40–80 skipped to the next track
part-way through. A log from the app (Settings → Logging) captured one:

- Track 5f62a92b (6:16) fired `ended` at **2:07.6**. The engine advanced and
  logged a completed play.
- That track had been **preloaded on the standby player and left paused for six
  minutes** while the track before it played. For a paused element, Chrome reads
  roughly 2 MB of a stream, then stops reading and holds the connection open.
  At this stream's bitrate, 2:07 is about 2 MB.
- When the track took over, its download showed "downloading" for 63 s with no
  new data, then went idle. Playback ran on what was cached until it ran out.
  Healthy handoffs in the same log went idle within a fraction of a second.

So the held connection died at some point during those six minutes: the
server, the Cloudflare tunnel or the phone's network dropped it. Because the
response had no length and no range support, Chrome couldn't ask for the rest
and couldn't even tell the stream was incomplete. It fired `ended`, not
`error`. A file served whole doesn't have this problem, because Chrome
range-requests whatever is missing.

The stopgap (`resumeCutShort`, commit 3a44c72): on `ended`, if a transcode
stopped more than 2 s short of the library's length, restart it with `start=`
where it stopped. That turns a skip into a short gap, but only after the
cached audio has run out.

## Why range support

With a `Content-Length` and range support, the transcode behaves like a file
to the browser:

1. **A dropped connection is retried by Chrome, from the byte it reached,
   without the listener noticing.** In the log above, Chrome had about a minute
   of audio cached when the dead connection became visible. Plenty of time to
   refill it. This is the main reason for the work.
2. **A short body becomes detectable.** With a `Content-Length`, a connection
   that closes early is a network error (which Chrome retries), never a silent
   end of track.
3. **Native seeking.** No `start=` restart and no `offset` bookkeeping for
   transcodes.
4. **A real duration.** Chrome reads the final page's granule position, so the
   element reports the track's length.
5. **A meaningful `buffered`.** Today, for a transcode, `buffered` is only what
   Chrome has demuxed, a couple of seconds ahead of the playhead. It isn't what
   has downloaded. With a known length, it's the downloaded byte ranges mapped
   to time, as for a file. The now-playing bar's loaded stretch becomes true.
6. **Room for later work.** Caching (service worker, offline) needs
   addressable bytes. Safari is known to be strict about range support for
   media.

## Requirements

These come from the user, and they ruled out the obvious designs:

1. **No wait before audio starts.** Time to first audio stays about what it is
   today. A full encode is out: a 7:47 hi-res FLAC (169 MiB) took **7.6 s** to
   encode with ffmpeg/libopus on the user's laptop (about 60× real time), and
   the server is about as fast.
2. **No persistent cache of transcoded audio.** A new user would miss the cache
   on nearly everything. The user's last three months of listening alone would
   be about 16 GB, and they often play tracks older than that.
3. **No audible artifacts in normal playback.** A recovery from a dropped
   connection may cost at most a tiny glitch.
4. **Pacing stays.** Responses are still sent at 4× real time after a head
   start (see the module comment on pacing in `stream.rs`).
5. **It works through the deployment:** a Cloudflare tunnel with Access in
   front, and the PWA's service worker, which passes `/api/` through
   (`NetworkOnly` in `frontend/vite.config.ts`).

## Options considered

- **Encode the whole track to disk, serve the file with ranges.** Simple, and
  `ServeFile` would do the rest. Rejected on requirements 1 and 2: several
  seconds before a long track starts on every cache miss, and a cache that
  would have to be tens of GB.
- **Stream live at first, then switch to the finished file.** Rejected: the
  switch, from one `<audio>` element to another at the same position, mid-music,
  can't be made seamless. `play()` on the second element takes some tens of ms
  to produce sound on Android, and that delay varies. `currentTime` doesn't say
  exactly which sample is sounding, so the switch skips or repeats a little.
  The second decoder starts cold. A volume crossfade would hide it on Android
  but not iOS, where a page can't set an element's volume. And it still needs
  files on disk, and downloads the track twice.
- **Switch to a short-lived file only where playback breaks anyway** (track
  boundaries, seeks, recoveries). Fixes the bug for primed tracks without
  mid-music switches. Rejected in favour of the option below, which gets the
  same benefits with one code path, no disk use and no full-speed encode.
- **Refetch a primed transcode shortly before the boundary.** Cheap, and it
  would avoid the six-minute hold. It treats only this one bug, though, and
  none of the other benefits above. Unnecessary once ranges work.
- **Media Source Extensions.** The page would fetch the audio itself and feed
  one element, so it would control retries and buffering. It would also allow
  gapless playback and remove the keep-alive player. It's the largest change
  and the least proven in the background on Android and iOS, and Chrome's MSE
  needs WebM rather than Ogg. Left for if gapless playback is ever wanted (see
  the header comment in `engine.ts`).
- **Chosen: a fixed byte layout, encoded on demand.** Each range request
  encodes just the frames it covers, starting about a second early so the
  resampler and encoder settle. Time to first audio is unchanged and nothing is
  stored.

## Design

### Hard constant bitrate

`opus.set_vbr(false)` (audiopus exposes it) makes libopus emit every 20 ms
packet at exactly `128_000 / 8 / 50 = 320` bytes. DTX is off by default and
must stay off.

- Assert every packet's length. A packet of any other size is a bug: end the
  response (see "Errors mid-body") and log it at `error`. Never send a body
  that doesn't match the `Content-Length`.
- At 128 kbps, constant bitrate costs some bits on quiet passages. That's an
  accepted trade.

### The byte layout

All sizes below follow from the constants. Compute them in code from the
builders, rather than hard-coding the totals, so changing the Opus Tags vendor
string can't silently break them.

**Pages.** An Ogg page is a 27-byte header, then one lacing byte per 255-byte
segment of the packet, then the packet. Its fields:

- capture pattern `OggS`
- version 0
- header-type flags: `0x02` on the first page (BOS), `0x04` on the last (EOS)
- granule position: i64
- serial number: u32
- page sequence number: u32
- CRC: u32
- segment count: u8

So:
- **OpusHead page:** 19-byte packet, 1 lacing byte, so 47 bytes. Granule 0,
  BOS.
- **OpusTags page:** a 26-byte packet with the current `build_opus_tags`
  (vendor `radiocrate`, no comments), 1 lacing byte, so 54 bytes. Granule 0.
- `H` is the two header pages together: 101 bytes today.
- **Audio page `i`** (0-based): a 320-byte packet, laced `255, 65`, so
  `PAGE = 27 + 2 + 320 = 349` bytes. It sits at `H + i × PAGE`, with sequence
  number `i + 2`.

**Counts.** These need the source's sample count, `n_src`, which Symphonia
reads from the container: `codec_params.n_frames`, from FLAC's STREAMINFO or a
WAV data chunk, for example. It's available after probing, with no decoding.

- `rate` is the source sample rate.
- `N` is the output length at 48 kHz: `ceil(n_src × 48000 / rate)`. Use
  integer arithmetic (u128), not floats.
- `P` is the pre-skip, the encoder's lookahead (`opus.lookahead()`; 312 at
  these settings). It must be known before the headers are written. It
  already is: the encoder is created first.
- `F` is the number of audio pages, `ceil((P + N) / 960)`. The decoder drops
  the first `P` samples it produces, so the encoder has to emit `P + N`
  samples' worth to reach the audio's end.
- `L`, the `Content-Length`, is `H + F × PAGE`.

**Granule positions.** Per RFC 7845, page `i` carries `(i + 1) × 960`, except
the last page, which carries `P + N`. That's less than `F × 960`, which tells
the decoder to drop the padding at the end, so the element's duration comes
out at exactly `N / 48000` s. The last page also carries EOS.

**Serial number.** Make it deterministic per track, for example the first four
bytes of the track's UUID. Every request for a track must agree, or a range
won't splice onto bytes from an earlier request.

**Encoder input.** The encoder input is the 48 kHz audio, exactly `N` samples,
then zeros up to `F × 960`. Packet `i` encodes input samples
`[i × 960, (i + 1) × 960)`. The byte count is then guaranteed, whatever the
decoder does:
- If the source yields fewer samples than `n_src` said, or a packet fails to
  decode, fill the gap with silence.
- If it yields more, truncate.
- Never skip a lost packet's duration. Today's `continue` on a decode error
  shifts the rest of the audio earlier.

Today's encoder loses the last `P` samples of audio (the input isn't padded
past `N`) and ignores the resampler's delay. The layout above fixes both.

**When the length isn't known.** If `n_frames` is `None`, or `?start=` is
present, serve today's unranged stream: `200`, no `Content-Length`, no
`Accept-Ranges`. Log `warn` once per request when `n_frames` is missing, so we
learn which files lack it. The client already handles that kind of stream (see
"Client").

### Starting an encode part-way in

A request starting at audio page `k` must produce page `k` and every page
after it, sounding the same as a from-the-start encode at the same positions:

1. **Pre-roll.** Begin encoder input at `s0 = max(0, k × 960 − R)`, where `R`
   is one second (48 000 samples). Encode the pre-roll and throw those packets
   away, keeping packets from `k` on. This settles the resampler's filter and
   the encoder's state, so page `k` decodes smoothly after pages from another
   encode. When `s0` is 0, the output is byte-identical to the from-the-start
   encode (libopus is deterministic for identical input).
2. **Resampler phase.** With a fixed ratio, output sample `o` corresponds to
   source frame `o × rate / 48000`, which is fractional in general. Round `s0`
   down to a multiple of `48000 / g` output samples, where
   `g = gcd(rate, 48000)` (for 44.1 kHz, a multiple of 160). The source start
   `s0 × rate / 48000` is then a whole frame and on the same resampling phase as
   the from-the-start encode.
3. **Seeking the source.** `format.seek(SeekMode::Accurate, …)` returns
   `SeekedTo { required_ts, actual_ts }`. Decoding resumes at `actual_ts`,
   which can be a whole FLAC block (up to 4096 frames) early. Discard the
   decoded frames before `required_ts`. Today's `start=` path doesn't do this,
   so it lands up to about 90 ms off.
4. **Resampler delay.** Discard the first `output_delay()` frames rubato
   produces, in *every* encode, from-the-start included, so output sample `o`
   means the same thing however the encode started. Flush the resampler at the
   end (`process_partial`) so no tail is lost.

**A splice can glitch for one frame.** When Chrome retries a dropped
connection, it asks for `bytes=<where it stopped>-`, which can fall mid-page.
That page then holds the start of one encode and the end of another, and its
CRC won't match. Expect at most one 20 ms frame to be dropped or garbled on a
retry. That's accepted (requirement 3). A *seek* doesn't have this problem:
Chrome resets the decoder and resyncs to the next page.

### Writing pages by hand

The `ogg` crate's `PacketWriter` numbers pages from 0 for each serial and
can't start at sequence `k + 2`. Writing pages directly is about 40 lines:

- The header fields above.
- The Ogg CRC-32: polynomial `0x04C11DB7`, not reflected, initial value 0,
  computed over the whole page with the CRC field zeroed. Use a 256-entry table
  from a `const fn`.
- One function, `page(flags, granule, serial, seq, packet) -> Vec<u8>`, used for
  both the header pages and the audio pages.

### HTTP

`stream_track`, for a request that would be transcoded and whose length is
known:

| Request | Response |
| --- | --- |
| No `Range` | `200`, `Content-Length: L`, the whole stream |
| `Range: bytes=a-b`, `bytes=a-` or `bytes=-n` (satisfiable) | `206`, `Content-Range: bytes a-b/L`, `Content-Length: b-a+1` |
| A range starting at or past `L` | `416`, `Content-Range: bytes */L` |
| More than one range | `200`, the whole stream (RFC 9110 allows ignoring `Range`) |
| `If-Range` that doesn't match the ETag | `200`, the whole stream |
| `HEAD` | The headers the matching `GET` would get. Don't encode anything. |

On every response, ranged or not:
- `Accept-Ranges: bytes` and `Content-Type: audio/ogg`.
- A strong `ETag` built from the source file's identity (path, size, mtime),
  the quality, and a `LAYOUT_VERSION` constant. Bump that constant whenever the
  bytes for the same input could change: the encoder settings, the vendor
  string, the page layout. Then a range can never be spliced onto bytes from an
  older layout.

To build a range body:
1. If `a < H`, start with the header pages. Otherwise
   `k = (a − H) / PAGE`, and encode from page `k` with pre-roll.
2. Drop the bytes of the first page that come before `a`.
3. Stop once byte `b` has been sent, and stop encoding at the page containing
   it.

Chrome makes a few small requests of its own: one near the end, to read the
last page's granule position for the duration, and several while bisecting a
seek. Each costs a second of pre-roll, roughly 16 ms of work at 60× real time.
That's cheap, but each request is its own encode, so it must stop as soon as
its client goes away. The existing `blocking_send` failure already does that.

**Pacing.** Keep `Pacer`, counting seconds of audio from the first page sent.
Requests of a few pages finish inside the head start, so only the long ones
are paced.

**Errors mid-body.** Once the headers have gone out, a short body is a
protocol error, and Chrome retries it. That's the right outcome:
- Return an error from the body stream: send `Err` through the channel, so
  hyper aborts the response rather than ending it cleanly.
- Never end a body short with a clean finish, which is what today's
  `Err(_) => break` amounts to.

### Client

`engine.ts` already treats a stream with a finite duration like a file served
whole. `seek` checks `Number.isFinite(el.duration)`, and `resumeCutShort`
checks `unbounded`. So once transcodes have a length, behaviour changes
without any engine logic changing:
- Seeks happen in place.
- `restartAt` and `offset` stay at zero.
- `resumeCutShort` never fires for them.

**Keep** `start=`, `restartAt`, `offset` and `resumeCutShort`. They are still
the right handling for the unranged fallback (a source whose length isn't
known), and they cost nothing for ranged streams.

Phase 4 is therefore comments, docs and tests:
- Update the comments that say a transcode *has* no length. The header section
  "A transcode cut off mid-track" and the comments on `knownDuration`,
  `unbounded` and `seek` should say "a stream without a known length (a
  transcode of a file whose length isn't recorded)".
- Add an engine test: a transcode URL whose element reports a finite duration
  seeks in place and doesn't restart.

## Playback logging improvements (phase 1)

These are permanent improvements to the app's log, not instrumentation for
this project. Each answers a question that was hard to answer from the log in
the bug above, and they'll matter as much for whatever comes next. The rules
are those in `frontend/src/log/log.ts`:
- Entries are in plain words, one fact per line in the details.
- Nothing is built while logging is off.
- Entries driven by events must be bounded, never one per `progress` event.
  The log keeps 2000 entries, which is about an hour of locked playback at
  today's status rate.

1. **When each player last received data.** Track the time of each element's
   last `progress` event. Add "last data 63 s ago" to `describe()`'s line while
   the element is downloading. Also add two event entries, each at most once
   per stall:
   - "Player A (current) has been downloading for 10 s without receiving any
     data", when an element has sat in `NETWORK_LOADING` with no `progress`
     for 10 s. Checked on the status timer.
   - "Player A (current) is receiving data again, after 63 s without any".

   Chrome's own `stalled` event didn't fire in the bug's log, so the engine
   can't rely on it. **Verify on the device** that `progress` reflects network
   bytes and not just demuxing. If it doesn't, use item 5 instead.
2. **Each player's length.** Add "length 6:16" or "no length (live stream)" to
   `describe()`, and log `durationchange` for each player, with what the
   length changed to. It tells a ranged stream from the fallback at a glance,
   and shows when Chrome revises a length.
3. **Where the track is against its length.** Status entries say "track
   5f62a92b at 2:07.6 of 6:16" when the library's length is known.
4. **A warning on every early end.** In the `ended` handler, before anything
   else: if the position is more than `CUT_SHORT_SECS` short of the library's
   length, log "Player A (current) stopped 4:08 before the end of track
   5f62a92b (6:16)". Do this for *every* kind of stream, served whole too:
   - For a transcode, it records the cut whether or not the engine recovers.
   - For a file, it reveals a wrong library length.

   `resumeCutShort` keeps its own entry about what it did next.
5. **The players' requests, from Resource Timing.** Media-element requests
   aren't visible to page code, but a `PerformanceObserver` for `resource`
   entries sees them once each finishes. For each one under
   `/api/tracks/*/stream`, log an entry like:

   > A download for track 5f62a92b finished: response 206, 2.0 MB in 6 min 11 s

   - The track, from the URL.
   - `responseStatus`, which tells a range response (206) from a whole one
     (200).
   - `encodedBodySize`.
   - The time from `startTime` to `responseEnd`.

   This is the only view the page gets of Chrome's range requests and retries,
   which is exactly what stress testing needs to see. **Verify on the device**:
   - Do media requests produce entries at all, given they go through the
     service worker? Expect `initiatorType` `audio`, or `other`.
   - Are the fields populated? A same-origin request should report its sizes.

   If the entries don't appear, drop this item rather than guess. Use the
   observer, not `getEntriesByType`, so the 250-entry buffer limit doesn't
   apply.
6. **Server side, for completeness.** Not part of the app's log, but it pairs
   with item 5. In `stream.rs`, log each stream request at `debug`:
   - the track
   - the range asked for
   - the bytes sent
   - how it ended: completed, the client went away, or an error

   Today "client disconnected" is logged at `error` on every skip, which is
   noise. Make a client going away `debug`, and keep `error` for real failures.
   Document the `RUST_LOG=backend::stream=debug` switch in `DEVELOPMENT.md`
   beside the existing access-log one.

Tests: `engine.test.ts` has a logging engine (`describe("a logging engine")`).
Extend it for items 1–4. Item 1's and item 5's device questions can't be unit
tested; note the answers in this spec once known.

Phase 1 doesn't depend on the others and should land first, so the user can
compare logs before and after the server change.

## Phases

1. **Playback logging.** The section above. Frontend only.
2. **Fixed layout, whole stream.** Hard constant bitrate, the hand-written
   pages, the layout arithmetic, padding and truncating to `N`, the resampler
   delay, the deterministic serial, and a `200` with `Content-Length` and the
   ETag. No ranges yet, but `Accept-Ranges` must not be sent until phase 3.
   - Chrome now gets a duration, but a dropped connection now ends in `error`
     instead of a skip. That's acceptable for the time between phases.
   - Tests, in `stream.rs`'s test module. Generate source audio in the test: a
     sine WAV written by hand into a temporary directory, since WAV is in
     `is_lossless`. Check:
     - At 44.1, 48 and 96 kHz, mono and stereo, and at lengths shorter than one
       frame, an exact multiple of 960, and otherwise: the body length equals
       the computed `L`.
     - Every page parses: capture pattern, CRC, sequence numbers in order,
       granule positions, BOS and EOS. Every audio page is 349 bytes.
     - The final granule is `P + N`.
     - Decoding the stream (audiopus has a `Decoder`) yields `N` samples
       after pre-skip and trimming.
3. **Range requests.** Range parsing, `206`/`416`/`HEAD`/`If-Range`, encoding
   part-way in with pre-roll, phase alignment, seek-and-discard, slicing, and
   pacing. More tests:
   - For assorted `a`: the ranged body's page boundaries line up with the
     whole stream's, and when the pre-roll reaches 0, the bytes are identical.
   - Decoding from page `k + 1` onward of a stream started at page `k` closely
     matches the whole stream's samples: a small error, by a signal-to-noise
     threshold. Use 44.1 kHz input, so the phase alignment is exercised.
   - The handler's responses for each row of the HTTP table.
   - Check by hand with curl (see "Validation").
4. **Client cleanup.** The comments and the test in "Client".
5. **Stress testing.** The user, on the phone. See "Validation".

## Validation

Locally, against `cargo run` or a release binary (`TRACK` is a lossless
track's id):

```sh
U="http://localhost:3000/api/tracks/$TRACK/stream?quality=opus128"
curl -sI "$U"                        # 200, Content-Length, Accept-Ranges, ETag
curl -s "$U" | wc -c                 # equals Content-Length
curl -s -r 100000-199999 "$U" -D - -o /dev/null   # 206, Content-Range
curl -s -r -1000 "$U" | wc -c        # 1000
curl -s "$U" -o t.opus && ffmpeg -v error -i t.opus -f null -   # no errors
```

Then the same `curl -sI` and `-r` against the public URL, through the
Cloudflare tunnel (with the `CF_Authorization` cookie). Confirm that the `206`
and `Content-Length` survive the tunnel.

In desktop Chrome, check DevTools' network panel: a transcode shows `206`s, a
seek far ahead makes a ranged request (not a `start=` one), and the timeline
shows the whole length.

On the phone, with logging on:
- Play long queues with the phone locked, including a long track followed by
  others, which recreates the six-minute prime hold.
- Mid-track, briefly turn on aeroplane mode, switch between Wi-Fi and mobile
  data, and restart the server while a primed track is waiting.
- Expected: no skips. Playback continues, at worst with a 20 ms glitch, and the
  log shows the player stop receiving data, then a ranged download resume
  (phase 1, items 1 and 5).
- Any "stopped … before the end" entry (item 4) is a finding.

## Risks and open questions

- **Chrome's retry.** On a failed load, Chrome's media loader retries with a
  range request if the server supports ranges. That's well established for
  files. Whether it holds for this stream through HTTP/2, Cloudflare and the
  service worker is what stress testing confirms.
- **Cloudflare and ranges on `/api/`.** Responses on `/api/` aren't cached, so
  Cloudflare should pass `Range` through to the server and return its `206`
  unchanged. It shouldn't recompress `audio/ogg`, which would drop
  `Content-Length`. The curl check above confirms both.
- **Missing `n_frames`.** Probably rare for FLAC and WAV; less certain for APE,
  WavPack and CAF. Those files get the unranged fallback. The `warn` log tells
  us how often.
- **CPU.** Every range request is its own encode on a blocking thread.
  Bisection while seeking means several short ones. They're cheap, but watch
  for pile-ups if the client fires many overlapping requests.
- **Older installed clients** keep working. A client from before the change
  sees a finite duration and seeks natively. It never sends `start=` for a
  ranged stream, because its `seek` checks for a finite duration first.

## Out of scope

- Media Source Extensions and gapless playback.
- Any change to files served whole.
- Refetching primed tracks before the boundary.
- Removing `start=` and the client's unranged-stream handling. They stay for
  the fallback.
