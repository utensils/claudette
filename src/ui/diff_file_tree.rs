use iced::widget::{Space, button, column, container, row, scrollable, text};
use iced::{Background, Border, Element, Fill, Length, Theme};

use crate::message::Message;
use crate::model::diff::{DiffFile, DiffViewMode, FileStatus};
use crate::ui::style;

pub fn view_diff_file_tree<'a>(
    files: &'a [DiffFile],
    selected_file: Option<&str>,
    view_mode: DiffViewMode,
) -> Element<'a, Message> {
    let file_count = files.len();
    let mode_label = match view_mode {
        DiffViewMode::Unified => "\u{2261}",    // ≡ unified
        DiffViewMode::SideBySide => "\u{2016}", // ‖ side-by-side
    };
    let next_mode = match view_mode {
        DiffViewMode::Unified => DiffViewMode::SideBySide,
        DiffViewMode::SideBySide => DiffViewMode::Unified,
    };

    let header = row![
        text(format!("Changed Files ({file_count})"))
            .size(13)
            .color(style::TEXT),
        Space::new().width(Fill),
        button(text("\u{21BB}").size(14).color(style::MUTED))
            .on_press(Message::DiffRefresh)
            .style(|theme: &Theme, status| {
                let mut s = button::text(theme, status);
                s.border = Border {
                    radius: 4.0.into(),
                    ..s.border
                };
                s
            })
            .padding([2, 6]),
        button(text(mode_label).size(14).color(style::MUTED))
            .on_press(Message::DiffSetViewMode(next_mode))
            .style(|theme: &Theme, status| {
                let mut s = button::text(theme, status);
                s.border = Border {
                    radius: 4.0.into(),
                    ..s.border
                };
                s
            })
            .padding([2, 6]),
    ]
    .align_y(iced::Alignment::Center)
    .padding([8, 12]);

    let mut file_list = column![].spacing(1);

    for file in files {
        let is_selected = selected_file == Some(file.path.as_str());

        let (status_char, status_color) = match &file.status {
            FileStatus::Added => ("A", style::FILE_STATUS_ADDED),
            FileStatus::Modified => ("M", style::FILE_STATUS_MODIFIED),
            FileStatus::Deleted => ("D", style::FILE_STATUS_DELETED),
            FileStatus::Renamed { .. } => ("R", style::FILE_STATUS_RENAMED),
        };

        let bg = if is_selected {
            style::SELECTED_BG
        } else {
            iced::Color::TRANSPARENT
        };

        let file_path = file.path.clone();
        let revert_path = file.path.clone();

        let file_row = button(
            row![
                text(status_char)
                    .size(12)
                    .color(status_color)
                    .width(Length::Fixed(18.0)),
                text(&file.path).size(13).color(style::TEXT),
                Space::new().width(Fill),
                button(text("\u{21A9}").size(12).color(style::MUTED))
                    .on_press(Message::DiffRevertFile(revert_path))
                    .style(|theme: &Theme, status| {
                        let mut s = button::text(theme, status);
                        s.border = Border {
                            radius: 4.0.into(),
                            ..s.border
                        };
                        s
                    })
                    .padding([1, 4]),
            ]
            .align_y(iced::Alignment::Center)
            .spacing(4),
        )
        .on_press(Message::DiffSelectFile(file_path))
        .width(Fill)
        .padding([4, 12])
        .style(move |_theme: &Theme, _status| button::Style {
            background: Some(Background::Color(bg)),
            text_color: style::TEXT,
            border: Border {
                radius: 0.0.into(),
                ..Default::default()
            },
            ..Default::default()
        });

        file_list = file_list.push(file_row);
    }

    let content = column![
        header,
        container(column![])
            .height(1)
            .width(Fill)
            .style(|_theme: &Theme| container::Style {
                background: Some(Background::Color(style::DIVIDER)),
                ..Default::default()
            }),
        scrollable(file_list).height(Fill),
    ];

    container(content)
        .width(Fill)
        .height(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::SIDEBAR_BG)),
            border: Border {
                width: 0.0,
                ..Default::default()
            },
            ..Default::default()
        })
        .into()
}
