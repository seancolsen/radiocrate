pub trait AudioPlayer {
    /// Loads and plays `current`, establishing the play context around it:
    /// `preceding` are the tracks before it (nearest last) that "previous track"
    /// walks back through, and `upcoming` the tracks after it that auto-advance
    /// and "next track" walk forward through.
    fn set_playlist(&mut self, preceding: Vec<String>, current: &str, upcoming: Vec<String>);
    fn play(&mut self);
    fn pause(&mut self);
    fn is_playing(&self) -> bool;
    fn has_ended(&self) -> bool;
    fn position(&self) -> f64;
    fn duration(&self) -> Option<f64>;
    /// Whether a track is queued after the current one.
    fn has_next(&self) -> bool;
    /// Skips to the next queued track. The change surfaces through
    /// [`take_changed`](Self::take_changed) like any other transition.
    fn skip_next(&mut self);
    /// Updates the OS / lock-screen "now playing" metadata for the current track.
    fn set_metadata(&mut self, title: Option<&str>, artist: Option<&str>);
    /// Reports the current playback position and duration to the OS so the
    /// lock-screen scrubber stays in sync.
    fn update_position_state(&mut self, position: f64, duration: Option<f64>);
    /// If a track transition happened outside the egui render loop — auto-advance
    /// when a track ended, or a media-key next/previous — returns the new current
    /// track id (clearing it) so the UI can reconcile its own state.
    ///
    /// These transitions are driven by browser media events, which keep firing
    /// even while the tab is backgrounded or the screen is locked and egui has
    /// stopped painting, so the UI can be arbitrarily behind by the time it next
    /// gets to look.
    fn take_changed(&mut self) -> Option<String>;
    /// Stops playback and tears down the play context and OS media session.
    fn stop(&mut self);
}

#[cfg(target_arch = "wasm32")]
pub fn new_player() -> Box<dyn AudioPlayer> {
    Box::new(wasm_impl::WebAudioPlayer::new())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn new_player() -> Box<dyn AudioPlayer> {
    Box::<native_impl::NullAudioPlayer>::default()
}

#[cfg(target_arch = "wasm32")]
mod wasm_impl {
    #![allow(unsafe_code)]

    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};
    use web_sys::{
        HtmlAudioElement, MediaMetadata, MediaPositionState, MediaSession, MediaSessionAction,
        MediaSessionActionDetails, MediaSessionPlaybackState,
    };

    use super::AudioPlayer;

    fn stream_src(track_id: &str) -> String {
        format!("/api/tracks/{track_id}/stream")
    }

    /// The shared playback engine. Everything the browser calls back into — the
    /// `ended` event and the Media Session action handlers — runs against this
    /// through an `Rc`, independent of the egui frame loop, so playlist
    /// navigation keeps working while the app is backgrounded.
    struct Engine {
        audio: HtmlAudioElement,
        /// `navigator.mediaSession`, absent on browsers that don't support it.
        media_session: Option<MediaSession>,
        /// The currently loaded track id.
        current: RefCell<Option<String>>,
        /// Tracks played before the current one, nearest last — the "previous"
        /// stack.
        history: RefCell<Vec<String>>,
        /// Tracks queued after the current one, next up at the front.
        queue: RefCell<VecDeque<String>>,
        /// Set whenever a transition happens off the render loop, drained by the
        /// UI via [`AudioPlayer::take_changed`].
        changed: RefCell<Option<String>>,
    }

    impl Engine {
        fn play_id(&self, id: &str) {
            self.audio.set_src(&stream_src(id));
            self.audio.load();
            let _ = self.audio.play();
            *self.current.borrow_mut() = Some(id.to_string());
            self.set_playback_state(MediaSessionPlaybackState::Playing);
        }

        /// Advances to the next queued track, pushing the current one onto the
        /// history stack. Returns `false` (leaving playback untouched) when the
        /// queue is empty.
        fn go_next(&self) -> bool {
            let Some(next) = self.queue.borrow_mut().pop_front() else {
                return false;
            };
            if let Some(cur) = self.current.borrow_mut().take() {
                self.history.borrow_mut().push(cur);
            }
            self.play_id(&next);
            *self.changed.borrow_mut() = Some(next);
            true
        }

        /// Steps back to the previous track, returning the current one to the
        /// front of the queue. Returns `false` when there is no history.
        fn go_prev(&self) -> bool {
            let Some(prev) = self.history.borrow_mut().pop() else {
                return false;
            };
            if let Some(cur) = self.current.borrow_mut().take() {
                self.queue.borrow_mut().push_front(cur);
            }
            self.play_id(&prev);
            *self.changed.borrow_mut() = Some(prev);
            true
        }

        fn set_playback_state(&self, state: MediaSessionPlaybackState) {
            if let Some(ms) = &self.media_session {
                ms.set_playback_state(state);
            }
        }

        fn set_metadata(&self, title: Option<&str>, artist: Option<&str>) {
            let Some(ms) = &self.media_session else {
                return;
            };
            if let Ok(meta) = MediaMetadata::new() {
                if let Some(t) = title {
                    meta.set_title(t);
                }
                if let Some(a) = artist {
                    meta.set_artist(a);
                }
                ms.set_metadata(Some(&meta));
            }
        }

        fn update_position_state(&self, position: f64, duration: Option<f64>) {
            let Some(ms) = &self.media_session else {
                return;
            };
            let Some(d) = duration.filter(|d| d.is_finite() && *d > 0.0) else {
                return;
            };
            let state = MediaPositionState::new();
            state.set_duration(d);
            state.set_playback_rate(1.0);
            state.set_position(position.clamp(0.0, d));
            ms.set_position_state_with_state(&state);
        }

        fn seek_by(&self, offset: f64) {
            let target = (self.audio.current_time() + offset).max(0.0);
            let target = match self.duration() {
                Some(d) => target.min(d),
                None => target,
            };
            self.audio.set_current_time(target);
        }

        fn duration(&self) -> Option<f64> {
            let d = self.audio.duration();
            (d.is_finite() && d > 0.0).then_some(d)
        }

        fn clear_media_session(&self) {
            if let Some(ms) = &self.media_session {
                ms.set_metadata(None);
                ms.set_playback_state(MediaSessionPlaybackState::None);
            }
        }
    }

    pub struct WebAudioPlayer {
        engine: Rc<Engine>,
        /// The registered callbacks, kept alive for the player's lifetime so the
        /// browser can keep calling them.
        _handlers: Vec<Closure<dyn FnMut()>>,
        _seek_handlers: Vec<Closure<dyn FnMut(MediaSessionActionDetails)>>,
    }

    impl WebAudioPlayer {
        pub fn new() -> Self {
            let window = web_sys::window().expect("no window");
            let document = window.document().expect("no document");
            let element = document
                .create_element("audio")
                .expect("create audio element");
            let audio: HtmlAudioElement = element.unchecked_into();
            audio.set_preload("auto");
            let _ = audio.style().set_property("display", "none");
            if let Some(body) = document.body() {
                let _ = body.append_child(&audio);
            }

            // `navigator.mediaSession` is undefined on unsupported browsers;
            // probe before taking it so we degrade gracefully rather than trap.
            let navigator = window.navigator();
            let nav_value: &JsValue = navigator.as_ref();
            let media_session = js_sys::Reflect::has(nav_value, &JsValue::from_str("mediaSession"))
                .unwrap_or(false)
                .then(|| navigator.media_session());

            let engine = Rc::new(Engine {
                audio: audio.clone(),
                media_session,
                current: RefCell::new(None),
                history: RefCell::new(Vec::new()),
                queue: RefCell::new(VecDeque::new()),
                changed: RefCell::new(None),
            });

            let (handlers, seek_handlers) = engine.install_handlers();

            Self {
                engine,
                _handlers: handlers,
                _seek_handlers: seek_handlers,
            }
        }
    }

    /// Type alias to keep the handler-vector signatures readable.
    type Handlers = (
        Vec<Closure<dyn FnMut()>>,
        Vec<Closure<dyn FnMut(MediaSessionActionDetails)>>,
    );

    impl Engine {
        /// Registers the browser callbacks that drive playback off the render
        /// loop and returns them for the player to keep alive: the audio
        /// element's `ended` handler (auto-advance) and, when the browser
        /// supports it, the Media Session transport handlers (lock-screen /
        /// Bluetooth / headset controls).
        fn install_handlers(self: &Rc<Self>) -> Handlers {
            let mut handlers: Vec<Closure<dyn FnMut()>> = Vec::new();
            let mut seek_handlers: Vec<Closure<dyn FnMut(MediaSessionActionDetails)>> = Vec::new();

            // Auto-advance when the current track finishes. This fires from the
            // browser's media-event dispatch, so it keeps working while the tab
            // is backgrounded or the screen is locked and egui isn't painting.
            let engine = Rc::clone(self);
            let on_ended = Closure::<dyn FnMut()>::new(move || {
                engine.go_next();
            });
            self.audio
                .set_onended(Some(on_ended.as_ref().unchecked_ref()));
            handlers.push(on_ended);

            // Lock-screen / Bluetooth / headset transport controls. Registering
            // these makes the app behave like a native player: the OS shows the
            // track metadata and routes hardware media keys to us.
            let Some(ms) = &self.media_session else {
                return (handlers, seek_handlers);
            };

            let mut on = |action: MediaSessionAction, f: Box<dyn FnMut()>| {
                let cb = Closure::<dyn FnMut()>::new(f);
                ms.set_action_handler(action, Some(cb.as_ref().unchecked_ref()));
                handlers.push(cb);
            };
            let engine = Rc::clone(self);
            on(
                MediaSessionAction::Play,
                Box::new(move || {
                    let _ = engine.audio.play();
                    engine.set_playback_state(MediaSessionPlaybackState::Playing);
                }),
            );
            let engine = Rc::clone(self);
            on(
                MediaSessionAction::Pause,
                Box::new(move || {
                    let _ = engine.audio.pause();
                    engine.set_playback_state(MediaSessionPlaybackState::Paused);
                }),
            );
            let engine = Rc::clone(self);
            on(
                MediaSessionAction::Nexttrack,
                Box::new(move || {
                    engine.go_next();
                }),
            );
            let engine = Rc::clone(self);
            on(
                MediaSessionAction::Previoustrack,
                Box::new(move || {
                    engine.go_prev();
                }),
            );

            let mut on_seek =
                |action: MediaSessionAction, f: Box<dyn FnMut(MediaSessionActionDetails)>| {
                    let cb = Closure::<dyn FnMut(MediaSessionActionDetails)>::new(f);
                    ms.set_action_handler(action, Some(cb.as_ref().unchecked_ref()));
                    seek_handlers.push(cb);
                };
            let engine = Rc::clone(self);
            on_seek(
                MediaSessionAction::Seekbackward,
                Box::new(move |d: MediaSessionActionDetails| {
                    engine.seek_by(-d.get_seek_offset().unwrap_or(10.0));
                }),
            );
            let engine = Rc::clone(self);
            on_seek(
                MediaSessionAction::Seekforward,
                Box::new(move |d: MediaSessionActionDetails| {
                    engine.seek_by(d.get_seek_offset().unwrap_or(10.0));
                }),
            );
            let engine = Rc::clone(self);
            on_seek(
                MediaSessionAction::Seekto,
                Box::new(move |d: MediaSessionActionDetails| {
                    if let Some(t) = d.get_seek_time() {
                        engine.audio.set_current_time(t);
                    }
                }),
            );

            (handlers, seek_handlers)
        }
    }

    impl AudioPlayer for WebAudioPlayer {
        fn set_playlist(&mut self, preceding: Vec<String>, current: &str, upcoming: Vec<String>) {
            *self.engine.history.borrow_mut() = preceding;
            *self.engine.queue.borrow_mut() = VecDeque::from(upcoming);
            // A deliberate load supersedes any transition the UI hasn't consumed.
            *self.engine.changed.borrow_mut() = None;
            self.engine.play_id(current);
        }

        fn play(&mut self) {
            let _ = self.engine.audio.play();
            self.engine
                .set_playback_state(MediaSessionPlaybackState::Playing);
        }

        fn pause(&mut self) {
            let _ = self.engine.audio.pause();
            self.engine
                .set_playback_state(MediaSessionPlaybackState::Paused);
        }

        fn is_playing(&self) -> bool {
            !self.engine.audio.paused() && !self.engine.audio.ended()
        }

        fn has_ended(&self) -> bool {
            self.engine.audio.ended()
        }

        fn position(&self) -> f64 {
            let t = self.engine.audio.current_time();
            if t.is_finite() { t } else { 0.0 }
        }

        fn duration(&self) -> Option<f64> {
            self.engine.duration()
        }

        fn has_next(&self) -> bool {
            !self.engine.queue.borrow().is_empty()
        }

        fn skip_next(&mut self) {
            self.engine.go_next();
        }

        fn set_metadata(&mut self, title: Option<&str>, artist: Option<&str>) {
            self.engine.set_metadata(title, artist);
        }

        fn update_position_state(&mut self, position: f64, duration: Option<f64>) {
            self.engine.update_position_state(position, duration);
        }

        fn take_changed(&mut self) -> Option<String> {
            self.engine.changed.borrow_mut().take()
        }

        fn stop(&mut self) {
            let _ = self.engine.audio.pause();
            *self.engine.current.borrow_mut() = None;
            self.engine.history.borrow_mut().clear();
            self.engine.queue.borrow_mut().clear();
            *self.engine.changed.borrow_mut() = None;
            self.engine.clear_media_session();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native_impl {
    use super::AudioPlayer;

    #[derive(Default)]
    pub struct NullAudioPlayer {
        loaded_id: Option<String>,
        playing: bool,
        has_next: bool,
    }

    impl AudioPlayer for NullAudioPlayer {
        fn set_playlist(&mut self, _preceding: Vec<String>, current: &str, upcoming: Vec<String>) {
            self.loaded_id = Some(current.to_string());
            self.playing = true;
            self.has_next = !upcoming.is_empty();
        }

        fn play(&mut self) {
            if self.loaded_id.is_some() {
                self.playing = true;
            }
        }

        fn pause(&mut self) {
            self.playing = false;
        }

        fn is_playing(&self) -> bool {
            self.playing
        }

        fn has_ended(&self) -> bool {
            false
        }

        fn position(&self) -> f64 {
            0.0
        }

        fn duration(&self) -> Option<f64> {
            None
        }

        fn has_next(&self) -> bool {
            self.has_next
        }

        fn skip_next(&mut self) {}

        fn set_metadata(&mut self, _title: Option<&str>, _artist: Option<&str>) {}

        fn update_position_state(&mut self, _position: f64, _duration: Option<f64>) {}

        fn take_changed(&mut self) -> Option<String> {
            None
        }

        fn stop(&mut self) {
            self.playing = false;
            self.loaded_id = None;
            self.has_next = false;
        }
    }
}
