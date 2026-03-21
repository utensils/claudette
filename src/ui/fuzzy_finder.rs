use iced::widget::{
    Column, Space, button, column, container, mouse_area, opaque, scrollable, text, text_input,
};
use iced::{Background, Border, Element, Fill, Theme};

use crate::message::Message;
use crate::model::{Repository, Workspace};
use crate::ui::style;

pub fn view_fuzzy_finder<'a>(
    base: Element<'a, Message>,
    query: &str,
    results: &[&'a Workspace],
    selected_index: usize,
    repositories: &'a [Repository],
) -> Element<'a, Message> {
    let backdrop: Element<'_, Message> = mouse_area(
        container(column![])
            .width(Fill)
            .height(Fill)
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::BACKDROP)),
                ..Default::default()
            }),
    )
    .on_press(Message::ToggleFuzzyFinder)
    .into();

    let search_input = text_input("Search workspaces...", query)
        .on_input(Message::FuzzyQueryChanged)
        .padding(12)
        .size(16);

    let mut list = Column::new().spacing(2);

    for (i, ws) in results.iter().enumerate() {
        let is_selected = i == selected_index;
        let repo_name = repositories
            .iter()
            .find(|r| r.id == ws.repository_id)
            .map(|r| r.name.as_str())
            .unwrap_or("?");

        let bg = if is_selected {
            Some(Background::Color(style::SELECTED_BG))
        } else {
            None
        };

        let ws_id = ws.id.clone();
        let entry = button(
            column![
                text(&ws.name).size(14),
                text(format!("{repo_name} \u{2022} {}", ws.branch_name))
                    .size(11)
                    .color(style::DIM),
            ]
            .spacing(2),
        )
        .on_press(Message::SelectWorkspace(ws_id))
        .style(move |theme: &Theme, status| {
            let mut s = button::text(theme, status);
            if matches!(status, button::Status::Hovered) && !is_selected {
                s.background = Some(Background::Color(style::HOVER_BG_SUBTLE));
            } else {
                s.background = bg;
            }
            s
        })
        .padding([8, 12])
        .width(Fill);

        list = list.push(entry);
    }

    if results.is_empty() {
        list = list.push(
            container(text("No matching workspaces").size(14).color(style::FAINT))
                .padding([12, 12]),
        );
    }

    let content = column![
        search_input,
        Space::new().height(4),
        scrollable(list).height(300),
    ]
    .spacing(4);

    let card = container(content)
        .width(500)
        .padding(12)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::MODAL_BG)),
            border: Border {
                radius: 8.0.into(),
                width: 1.0,
                color: style::MODAL_BORDER,
            },
            ..Default::default()
        });

    // Position near top of screen
    let overlay = container(
        column![Space::new().height(80), container(opaque(card))].align_x(iced::Alignment::Center),
    )
    .width(Fill)
    .height(Fill)
    .align_x(iced::alignment::Horizontal::Center);

    iced::widget::stack![base, backdrop, overlay].into()
}
