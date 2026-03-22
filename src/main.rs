mod app;
mod db;
mod git;
mod message;
mod model;
mod names;
mod ui;

use app::App;

fn main() -> iced::Result {
    let icon = {
        let img = image::load_from_memory_with_format(
            include_bytes!("../assets/logo.png"),
            image::ImageFormat::Png,
        )
        .expect("Failed to decode icon")
        .into_rgba8();
        let (w, h) = img.dimensions();
        iced::window::icon::from_rgba(img.into_raw(), w, h).ok()
    };

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
