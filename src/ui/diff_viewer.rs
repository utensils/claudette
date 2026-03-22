use iced::widget::{Space, column, container, row, text};
use iced::{Background, Border, Element, Fill, Theme};

use crate::message::Message;
use crate::model::diff::{DiffFile, DiffViewMode, FileDiff};
use crate::ui::{diff_content, diff_file_tree, style};

pub fn view_diff_viewer<'a>(
    files: &'a [DiffFile],
    selected_file: Option<&str>,
    content: Option<&'a FileDiff>,
    view_mode: DiffViewMode,
    loading: bool,
    error: Option<&'a str>,
) -> Element<'a, Message> {
    // File tree on the left
    let file_tree = diff_file_tree::view_diff_file_tree(files, selected_file, view_mode);

    // Divider
    let divider = container(column![])
        .width(1)
        .height(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            ..Default::default()
        });

    // Content area on the right
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

    // Header with close button
    let header = container(
        row![
            text("Diff Viewer").size(14).color(style::TEXT),
            Space::new().width(Fill),
            iced::widget::button(text("\u{2715}").size(14).color(style::MUTED))
                .on_press(Message::ToggleDiffViewer)
                .style(|theme: &Theme, status| {
                    let mut s = iced::widget::button::text(theme, status);
                    s.border = Border {
                        radius: 4.0.into(),
                        ..s.border
                    };
                    s
                })
                .padding([2, 8]),
        ]
        .align_y(iced::Alignment::Center)
        .padding([6, 12]),
    )
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_HEADER_BG)),
        border: Border {
            width: 0.0,
            ..Default::default()
        },
        ..Default::default()
    });

    let header_divider = container(column![])
        .height(1)
        .width(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            ..Default::default()
        });

    let body = row![file_tree, divider, content_area];

    column![header, header_divider, body]
        .width(Fill)
        .height(Fill)
        .into()
}
