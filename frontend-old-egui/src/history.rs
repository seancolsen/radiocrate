//! Back-button integration for the installed web app.
//!
//! In a browser tab, Back means "the previous page" and nobody expects
//! otherwise. Installed on Android, though, the system Back gesture is the
//! *only* way out of a sheet or dialog, and an app that quits instead of
//! closing the thing on screen feels broken.
//!
//! So we mirror the app's dismissible layers into browser history: when the
//! first one opens we push a sentinel entry, and a Back that pops it is
//! translated into "close the top layer" rather than a navigation. With nothing
//! open there's no sentinel, so Back leaves the app — which is what it should
//! do from a home screen.
//!
//! The native build has no history to speak of; everything here compiles to
//! nothing there.

/// Whether any layer that Back should close is currently on screen.
///
/// Ordered the same way [`crate::App::dismiss_top_layer`] closes them.
pub(crate) fn any_open(app: &crate::App, organizer_is_drawer: bool) -> bool {
    app.record_picker.is_some()
        || app.palette.is_some()
        || app.view_sql.is_some()
        || app.manage_presets
        || app.preset_save.is_some()
        || app.pending_delete.is_some()
        || (organizer_is_drawer && app.organizer.open)
}

impl crate::App {
    /// Closes the topmost dismissible layer, if any.
    ///
    /// The order matches how the layers stack on screen: the record picker
    /// opens over the editor, the command palette over everything, and the
    /// organizer drawer is the backstop underneath them all.
    pub(crate) fn dismiss_top_layer(&mut self, organizer_is_drawer: bool) {
        if self.record_picker.take().is_some() {
            return;
        }
        if self.palette.take().is_some() {
            return;
        }
        if self.view_sql.take().is_some() {
            return;
        }
        if self.manage_presets {
            self.manage_presets = false;
            self.manage_expanded = None;
            return;
        }
        if self.preset_save.take().is_some() {
            return;
        }
        if self.pending_delete.take().is_some() {
            return;
        }
        if organizer_is_drawer {
            self.organizer.open = false;
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) use wasm_impl::{install, sync, take_back};

// [`install`] has no native counterpart: it's called from `crate::web`, which
// only exists on wasm. The other two are called from the shared render loop and
// so need stubs.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use native_impl::{sync, take_back};

#[cfg(not(target_arch = "wasm32"))]
mod native_impl {
    pub(crate) fn take_back() -> bool {
        false
    }
    pub(crate) fn sync(_open: bool) {}
}

#[cfg(target_arch = "wasm32")]
mod wasm_impl {
    use std::cell::Cell;

    use eframe::egui;
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};

    thread_local! {
        /// A Back press waiting to be handled by the next frame.
        static PENDING_BACK: Cell<bool> = const { Cell::new(false) };
        /// Whether our sentinel entry is currently on the history stack.
        static SENTINEL: Cell<bool> = const { Cell::new(false) };
        /// Set while we pop the sentinel ourselves, so the `popstate` it causes
        /// isn't mistaken for the user pressing Back.
        static SELF_POP: Cell<bool> = const { Cell::new(false) };
    }

    /// The `popstate` listener is registered for the life of the page, so it's
    /// leaked deliberately rather than tied to a handle nobody would drop.
    pub(crate) fn install(ctx: &egui::Context) {
        let Some(window) = web_sys::window() else {
            return;
        };
        let ctx = ctx.clone();
        let on_popstate = Closure::<dyn FnMut()>::new(move || {
            if SELF_POP.with(|f| f.replace(false)) {
                // We popped it; the layer is already closing.
                return;
            }
            SENTINEL.with(|f| f.set(false));
            PENDING_BACK.with(|f| f.set(true));
            // The app may be idle (nothing animating, tab in the background),
            // in which case nothing would look at the flag until some other
            // input arrived.
            ctx.request_repaint();
        });
        let _ = window
            .add_event_listener_with_callback("popstate", on_popstate.as_ref().unchecked_ref());
        on_popstate.forget();
    }

    /// Consumes a pending Back press.
    pub(crate) fn take_back() -> bool {
        PENDING_BACK.with(|f| f.replace(false))
    }

    /// Reconciles the history stack with whether a dismissible layer is open.
    pub(crate) fn sync(open: bool) {
        let Some(history) = web_sys::window().and_then(|w| w.history().ok()) else {
            return;
        };
        let sentinel = SENTINEL.with(Cell::get);
        if open && !sentinel {
            // No URL change: the sentinel exists only to give Back something to
            // consume, and rewriting the address bar would be visible in a
            // browser tab for no benefit.
            if history
                .push_state_with_url(&JsValue::from_str("radiocrate:layer"), "", None)
                .is_ok()
            {
                SENTINEL.with(|f| f.set(true));
            }
        } else if !open && sentinel {
            // The layer was closed some other way (Escape, a click on the
            // backdrop, a button). Drop the now-meaningless sentinel so a later
            // Back still exits the app rather than being swallowed.
            SENTINEL.with(|f| f.set(false));
            SELF_POP.with(|f| f.set(true));
            if history.back().is_err() {
                SELF_POP.with(|f| f.set(false));
            }
        }
    }
}
