use iced::widget::{Space, container, mouse_area};
use iced::{Background, Border, Element, Length, Theme};

use crate::message::{DividerDrag, Message};
use crate::ui::style;

/// A vertical divider (between side panels) — draggable horizontally.
pub fn vertical_divider(drag_target: DividerDrag) -> Element<'static, Message> {
    let handle = container(Space::new())
        .width(Length::Fixed(5.0))
        .height(Length::Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            ..Default::default()
        });

    mouse_area(handle)
        .on_press(Message::DividerDragStart(drag_target))
        .interaction(iced::mouse::Interaction::ResizingHorizontally)
        .into()
}

/// A horizontal divider (between main content and terminal) — draggable vertically.
pub fn horizontal_divider(drag_target: DividerDrag) -> Element<'static, Message> {
    let handle = container(Space::new())
        .width(Length::Fill)
        .height(Length::Fixed(5.0))
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            border: Border {
                width: 0.0,
                ..Default::default()
            },
            ..Default::default()
        });

    mouse_area(handle)
        .on_press(Message::DividerDragStart(drag_target))
        .interaction(iced::mouse::Interaction::ResizingVertically)
        .into()
}
