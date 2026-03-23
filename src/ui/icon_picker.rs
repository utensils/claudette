use iced::widget::{
    Column, Row, Space, button, column, container, mouse_area, opaque, scrollable, svg, text,
    text_input,
};
use iced::{Background, Border, Element, Fill, Theme};

use crate::message::Message;
use crate::ui::style;

pub fn view_icon_picker<'a>(
    base: Element<'a, Message>,
    query: &str,
    results: &[(&'a str, &str)],
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
    .on_press(Message::HideIconPicker)
    .into();

    let search_input = text_input("Search icons...", query)
        .on_input(Message::IconPickerQueryChanged)
        .padding(12)
        .size(16);

    // Build grid of icon buttons (6 per row)
    const COLS: usize = 6;
    let mut grid = Column::new().spacing(4);
    let mut current_row = Row::new().spacing(4);

    for (i, (name, svg_data)) in results.iter().enumerate() {
        let name_owned = name.to_string();
        let icon_btn = button(
            column![
                container(svg(crate::icons::svg_handle(svg_data)).width(24).height(24))
                    .width(Fill)
                    .align_x(iced::alignment::Horizontal::Center),
                container(text(*name).size(9).color(style::FAINT))
                    .width(Fill)
                    .align_x(iced::alignment::Horizontal::Center),
            ]
            .spacing(2),
        )
        .on_press(Message::SelectIcon(Some(name_owned)))
        .style(|theme: &Theme, status| {
            let mut s = button::text(theme, status);
            if matches!(status, button::Status::Hovered) {
                s.background = Some(Background::Color(style::HOVER_BG));
            }
            s.border = Border {
                radius: 4.0.into(),
                ..Default::default()
            };
            s
        })
        .padding([8, 4])
        .width(Fill);

        current_row = current_row.push(icon_btn);

        if (i + 1) % COLS == 0 {
            grid = grid.push(current_row);
            current_row = Row::new().spacing(4);
        }
    }

    // Push remaining icons
    if !results.len().is_multiple_of(COLS) {
        // Pad with empty space
        let remaining = COLS - (results.len() % COLS);
        for _ in 0..remaining {
            current_row = current_row.push(Space::new().width(Fill));
        }
        grid = grid.push(current_row);
    }

    if results.is_empty() {
        grid = grid.push(
            container(text("No matching icons").size(14).color(style::FAINT)).padding([12, 12]),
        );
    }

    let content = column![
        text("Select Icon").size(18),
        search_input,
        Space::new().height(4),
        scrollable(grid).height(350),
    ]
    .spacing(8);

    let card = container(content)
        .width(500)
        .padding(16)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::MODAL_BG)),
            border: Border {
                radius: 8.0.into(),
                width: 1.0,
                color: style::MODAL_BORDER,
            },
            ..Default::default()
        });

    let overlay = container(
        column![Space::new().height(60), container(opaque(card))].align_x(iced::Alignment::Center),
    )
    .width(Fill)
    .height(Fill)
    .align_x(iced::alignment::Horizontal::Center);

    iced::widget::stack![base, backdrop, overlay].into()
}
