#[cfg(not(target_arch = "wasm32"))]
mod native {
    use clap::Parser;
    use eframe::egui;
    use frontend::{App, setup_context};

    #[derive(Clone, Copy, clap::ValueEnum)]
    enum Theme {
        Light,
        Dark,
    }

    #[derive(Parser)]
    struct Cli {
        /// UI scale factor (e.g. 1.5, 2)
        #[arg(long, short)]
        scale: Option<f32>,
        /// Force the UI theme (default: follow the system preference)
        #[arg(long, value_enum)]
        theme: Option<Theme>,
    }

    pub fn run() -> eframe::Result {
        let cli = Cli::parse();
        let options = eframe::NativeOptions::default();
        eframe::run_native(
            "Collectune",
            options,
            Box::new(move |cc| {
                setup_context(&cc.egui_ctx);
                if let Some(s) = cli.scale {
                    cc.egui_ctx.set_pixels_per_point(s);
                }
                if let Some(theme) = cli.theme {
                    cc.egui_ctx.set_theme(match theme {
                        Theme::Light => egui::ThemePreference::Light,
                        Theme::Dark => egui::ThemePreference::Dark,
                    });
                }
                Ok(Box::new(App::default()))
            }),
        )
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> eframe::Result {
    native::run()
}

#[cfg(target_arch = "wasm32")]
fn main() {}
