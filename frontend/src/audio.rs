pub trait AudioPlayer {
    fn load(&mut self, track_id: &str);
    fn play(&mut self);
    fn pause(&mut self);
    fn is_playing(&self) -> bool;
    fn has_ended(&self) -> bool;
    fn position(&self) -> f64;
    fn duration(&self) -> Option<f64>;
    /// Replaces the queue of track ids to play after the current one, in order.
    ///
    /// The web player advances through this queue from the audio element's
    /// `ended` event rather than from the egui render loop. That matters on
    /// mobile: when Chrome is backgrounded or the screen is locked, the browser
    /// suspends `requestAnimationFrame` (and throttles timers), so egui stops
    /// painting — but media events still fire and playback continues. Handing
    /// the upcoming ids to the audio layer lets it auto-advance without us.
    fn set_queue(&mut self, upcoming_ids: Vec<String>);
    /// If the `ended` handler auto-advanced to a queued track since the last
    /// call, returns that track id (clearing it) so the UI can reconcile its
    /// own state (now-playing bar, row highlight, metadata) the next time it
    /// paints. Returns `None` if no auto-advance is pending.
    fn take_auto_advanced(&mut self) -> Option<String>;
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

    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;
    use web_sys::HtmlAudioElement;

    use super::AudioPlayer;

    fn stream_src(track_id: &str) -> String {
        format!("/api/tracks/{track_id}/stream")
    }

    pub struct WebAudioPlayer {
        audio: HtmlAudioElement,
        /// The id currently loaded into the audio element. Shared so the `ended`
        /// handler can keep it in sync when it swaps in the next track.
        loaded_id: Rc<RefCell<Option<String>>>,
        /// Track ids queued to play after the current one, front = next up.
        queue: Rc<RefCell<VecDeque<String>>>,
        /// Set by the `ended` handler to the id it just auto-advanced to; drained
        /// by the UI via [`AudioPlayer::take_auto_advanced`].
        auto_advanced: Rc<RefCell<Option<String>>>,
        /// Kept alive for as long as the player lives so the `ended` callback
        /// stays registered on the audio element.
        _on_ended: Closure<dyn FnMut()>,
    }

    impl WebAudioPlayer {
        pub fn new() -> Self {
            let document = web_sys::window()
                .expect("no window")
                .document()
                .expect("no document");
            let element = document
                .create_element("audio")
                .expect("create audio element");
            let audio: HtmlAudioElement = element.unchecked_into();
            audio.set_preload("auto");
            let _ = audio.style().set_property("display", "none");
            if let Some(body) = document.body() {
                let _ = body.append_child(&audio);
            }

            let loaded_id: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
            let queue: Rc<RefCell<VecDeque<String>>> = Rc::new(RefCell::new(VecDeque::new()));
            let auto_advanced: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));

            // Advance to the next queued track when the current one finishes.
            // This runs from the browser's media-event dispatch, independent of
            // the egui frame loop, so it keeps working while the tab is
            // backgrounded or the screen is locked.
            let on_ended = {
                let audio = audio.clone();
                let loaded_id = Rc::clone(&loaded_id);
                let queue = Rc::clone(&queue);
                let auto_advanced = Rc::clone(&auto_advanced);
                Closure::<dyn FnMut()>::new(move || {
                    let Some(next_id) = queue.borrow_mut().pop_front() else {
                        return;
                    };
                    audio.set_src(&stream_src(&next_id));
                    audio.load();
                    let _ = audio.play();
                    *loaded_id.borrow_mut() = Some(next_id.clone());
                    *auto_advanced.borrow_mut() = Some(next_id);
                })
            };
            audio.set_onended(Some(on_ended.as_ref().unchecked_ref()));

            Self {
                audio,
                loaded_id,
                queue,
                auto_advanced,
                _on_ended: on_ended,
            }
        }
    }

    impl AudioPlayer for WebAudioPlayer {
        fn load(&mut self, track_id: &str) {
            if self.loaded_id.borrow().as_deref() == Some(track_id) {
                return;
            }
            self.audio.set_src(&stream_src(track_id));
            self.audio.load();
            *self.loaded_id.borrow_mut() = Some(track_id.to_string());
            // A deliberate load (user picked a track, or "Next") supersedes any
            // background auto-advance the UI hasn't consumed yet.
            *self.auto_advanced.borrow_mut() = None;
        }

        fn play(&mut self) {
            let _ = self.audio.play();
        }

        fn pause(&mut self) {
            let _ = self.audio.pause();
        }

        fn is_playing(&self) -> bool {
            !self.audio.paused() && !self.audio.ended()
        }

        fn has_ended(&self) -> bool {
            self.audio.ended()
        }

        fn position(&self) -> f64 {
            let t = self.audio.current_time();
            if t.is_finite() { t } else { 0.0 }
        }

        fn duration(&self) -> Option<f64> {
            let d = self.audio.duration();
            if d.is_finite() && d > 0.0 {
                Some(d)
            } else {
                None
            }
        }

        fn set_queue(&mut self, upcoming_ids: Vec<String>) {
            *self.queue.borrow_mut() = VecDeque::from(upcoming_ids);
        }

        fn take_auto_advanced(&mut self) -> Option<String> {
            self.auto_advanced.borrow_mut().take()
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
    }

    impl AudioPlayer for NullAudioPlayer {
        fn load(&mut self, track_id: &str) {
            self.loaded_id = Some(track_id.to_string());
            self.playing = false;
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

        fn set_queue(&mut self, _upcoming_ids: Vec<String>) {}

        fn take_auto_advanced(&mut self) -> Option<String> {
            None
        }
    }
}
