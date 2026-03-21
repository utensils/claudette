use iced::widget::{center, text};
use iced::{Element, Task, Theme};

fn main() -> iced::Result {
    iced::application(App::new, App::update, App::view)
        .title("Claudette")
        .theme(App::theme)
        .centered()
        .run()
}

struct App;

#[derive(Debug, Clone)]
enum Message {}

impl App {
    fn new() -> (Self, Task<Message>) {
        (Self, Task::none())
    }

    fn update(&mut self, _message: Message) -> Task<Message> {
        Task::none()
    }

    fn view(&self) -> Element<'_, Message> {
        center(text("Claudette").size(32)).into()
    }

    fn theme(&self) -> Theme {
        Theme::Dark
    }
}
