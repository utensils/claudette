use iced::widget::{Space, button, column, container, row, text};
use iced::{Background, Border, Element, Fill, Theme};

use crate::message::Message;
use crate::model::diff::{DiffFile, DiffViewMode, FileDiff};
use crate::ui::{diff_content, style};

/// Renders the diff content panel (no file tree — that lives in the right sidebar).
/// Shows a thin header with the selected file path and a back button.
pub fn view_diff_content_panel<'a>(
    files: &[DiffFile],
    selected_file: Option<&'a str>,
    content: Option<&'a FileDiff>,
    view_mode: DiffViewMode,
    loading: bool,
    error: Option<&'a str>,
) -> Element<'a, Message> {
    // Header with file path and back button
    let file_label = selected_file.unwrap_or("No file selected");
    let header = container(
        row![
            button(text("\u{2190}").size(14).color(style::MUTED))
                .on_press(Message::DiffClearSelection)
                .style(|theme: &Theme, status| {
                    let mut s = button::text(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([2, 8]),
            text(file_label).size(13).color(style::TEXT),
            Space::new().width(Fill),
        ]
        .align_y(iced::Alignment::Center)
        .spacing(8)
        .padding([6, 12]),
    )
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_HEADER_BG)),
        ..Default::default()
    });

    let header_divider = container(column![])
        .height(1)
        .width(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            ..Default::default()
        });

    // Content area
    let content_area: Element<'_, Message> = if let Some(err) = error {
        container(
            column![
                text("Error loading diff").size(16).color(style::ERROR),
                Space::new().height(8),
                text(err).size(13).color(style::MUTED),
            ]
            .align_x(iced::Alignment::Center),
        )
        .width(Fill)
        .height(Fill)
        .center_x(Fill)
        .center_y(Fill)
        .into()
    } else if loading {
        diff_content::view_diff_placeholder("Loading diff...")
    } else if files.is_empty() {
        diff_content::view_diff_placeholder("No changes in this workspace")
    } else if let Some(diff) = content {
        diff_content::view_diff_content(diff, view_mode)
    } else {
        diff_content::view_diff_placeholder("Select a file to view changes")
    };

    column![header, header_divider, content_area]
        .width(Fill)
        .height(Fill)
        .into()
}
