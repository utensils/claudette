use iced::widget::{Space, button, center, column, container, row, text};
use iced::{Background, Border, Element, Fill, Length, Theme};

use crate::message::{Message, RightSidebarTab};
use crate::model::diff::{DiffFile, DiffViewMode};
use crate::ui::{diff_file_tree, style};

pub fn view_right_sidebar<'a>(
    active_tab: RightSidebarTab,
    diff_files: &'a [DiffFile],
    selected_file: Option<&str>,
    view_mode: DiffViewMode,
    loading: bool,
    width: f32,
) -> Element<'a, Message> {
    let tab_bar = view_tab_bar(active_tab);

    let tab_divider = container(column![])
        .height(1)
        .width(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::DIVIDER)),
            ..Default::default()
        });

    let tab_content: Element<'_, Message> = match active_tab {
        RightSidebarTab::Changes => {
            if loading {
                center(text("Loading changes...").size(13).color(style::MUTED)).into()
            } else {
                diff_file_tree::view_diff_file_tree(diff_files, selected_file, view_mode)
            }
        }
        RightSidebarTab::AllFiles => {
            center(text("Coming soon").size(13).color(style::FAINT)).into()
        }
    };

    let content = column![tab_bar, tab_divider, tab_content];

    container(content)
        .width(Length::Fixed(width))
        .height(Fill)
        .style(|_theme: &Theme| container::Style {
            background: Some(Background::Color(style::SIDEBAR_BG)),
            ..Default::default()
        })
        .into()
}

fn view_tab_bar(active_tab: RightSidebarTab) -> Element<'static, Message> {
    let all_files_btn = tab_button(
        "All Files",
        active_tab == RightSidebarTab::AllFiles,
        Message::SetRightSidebarTab(RightSidebarTab::AllFiles),
    );

    let changes_btn = tab_button(
        "Changes",
        active_tab == RightSidebarTab::Changes,
        Message::SetRightSidebarTab(RightSidebarTab::Changes),
    );

    container(
        row![all_files_btn, changes_btn, Space::new().width(Fill)]
            .spacing(2)
            .align_y(iced::Alignment::Center)
            .padding([4, 8]),
    )
    .width(Fill)
    .into()
}

fn tab_button(label: &str, is_active: bool, message: Message) -> Element<'static, Message> {
    let label = label.to_string();
    button(text(label).size(12))
        .on_press(message)
        .padding([4, 10])
        .style(move |_theme: &Theme, _status| button::Style {
            background: if is_active {
                Some(Background::Color(style::FILTER_ACTIVE_BG))
            } else {
                None
            },
            text_color: if is_active {
                style::FILTER_ACTIVE
            } else {
                style::MUTED
            },
            border: Border {
                radius: 4.0.into(),
                ..Default::default()
            },
            ..Default::default()
        })
        .into()
}
