mod agent;
mod app;
mod db;
mod diff;
mod git;
mod icons;
mod message;
mod model;
mod names;
mod ui;

use app::App;

pub const ICON_PNG: &[u8] = include_bytes!("../assets/logo.png");

fn main() -> iced::Result {
    let icon = image::load_from_memory_with_format(ICON_PNG, image::ImageFormat::Png)
        .map(|img| {
            img.resize(256, 256, image::imageops::FilterType::Lanczos3)
                .into_rgba8()
        })
        .map_err(|e| eprintln!("Warning: failed to decode window icon: {e}"))
        .ok()
        .and_then(|img| {
            let (w, h) = img.dimensions();
            iced::window::icon::from_rgba(img.into_raw(), w, h).ok()
        });

    let window_settings = iced::window::Settings {
        icon,
        ..iced::window::Settings::default()
    };

    iced::application(App::new, App::update, App::view)
        .title("Claudette")
        .window(window_settings)
        .theme(App::theme)
        .subscription(App::subscription)
        .centered()
        .run()
}
