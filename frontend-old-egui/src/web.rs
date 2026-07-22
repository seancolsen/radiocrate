#![allow(unsafe_code)]

use wasm_bindgen::prelude::*;

use crate::{App, setup_context};

const CANVAS_ID: &str = "the_canvas_id";

/// The boot screen `index.html` paints before the wasm bundle has loaded.
const SPLASH_ID: &str = "splash";

#[wasm_bindgen(start)]
pub fn auto_start() {
    console_error_panic_hook::set_once();

    wasm_bindgen_futures::spawn_local(async {
        let document = web_sys::window()
            .expect("no window")
            .document()
            .expect("no document");
        let canvas = document
            .get_element_by_id(CANVAS_ID)
            .unwrap_or_else(|| panic!("canvas element `{CANVAS_ID}` not found"))
            .dyn_into::<web_sys::HtmlCanvasElement>()
            .expect("element is not a canvas");

        eframe::WebRunner::new()
            .start(
                canvas,
                eframe::WebOptions::default(),
                Box::new(|cc| {
                    setup_context(&cc.egui_ctx);
                    // Apply the persisted theme choice, if any (localStorage
                    // `theme`); otherwise stay on the system preference.
                    cc.egui_ctx.set_theme(crate::theme::stored_preference());
                    crate::history::install(&cc.egui_ctx);
                    Ok(Box::new(App::default()))
                }),
            )
            .await
            .expect("eframe::WebRunner failed");

        // The runner has painted, so the canvas now has something on it and the
        // boot screen can fade out. It's given a class rather than removed
        // outright so the CSS transition has something to run on; the element
        // stops taking pointer events immediately either way.
        hide_splash(&document);
    });
}

fn hide_splash(document: &web_sys::Document) {
    let Some(splash) = document.get_element_by_id(SPLASH_ID) else {
        return;
    };
    let _ = splash.set_attribute("class", "hidden");
}
