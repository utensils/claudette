mod app;
mod db;
mod git;
mod message;
mod model;
mod ui;

use app::App;

fn main() -> iced::Result {
    iced::application(App::new, App::update, App::view)
        .title("Claudette")
        .theme(App::theme)
        .subscription(App::subscription)
        .centered()
        .run()
}
