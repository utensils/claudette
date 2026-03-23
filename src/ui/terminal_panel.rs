use std::collections::HashMap;

use iced::widget::{Column, Row, Space, button, container, row, text};
use iced::{Background, Border, Element, Fill};
use iced_term::{Terminal, TerminalView};

use crate::message::Message;
use crate::model::TerminalTab;
use crate::ui::style;

const TAB_BAR_HEIGHT: f32 = 32.0;

pub fn view_terminal_panel<'a>(
    terminals: &'a HashMap<u64, Terminal>,
    tabs: &[TerminalTab],
    active_tab_id: Option<u64>,
    panel_visible: bool,
    workspace_id: &str,
    panel_height: f32,
) -> Element<'a, Message> {
    if tabs.is_empty() {
        return Space::new().into();
    }

    if !panel_visible {
        return Space::new().into();
    }

    let tab_bar = view_tab_bar(tabs, active_tab_id, workspace_id);

    let terminal_content: Element<'_, Message> = if let Some(active_id) = active_tab_id {
        if let Some(term) = terminals.get(&active_id) {
            TerminalView::show(term).map(Message::TerminalEvent)
        } else {
            container(text("Terminal initializing...").color(style::MUTED))
                .center(Fill)
                .into()
        }
    } else {
        container(text("No terminal selected").color(style::MUTED))
            .center(Fill)
            .into()
    };

    let content = Column::new().push(tab_bar).push(
        container(terminal_content)
            .width(Fill)
            .height(panel_height - TAB_BAR_HEIGHT),
    );

    container(content)
        .width(Fill)
        .height(panel_height)
        .style(|_theme| container::Style {
            background: Some(Background::Color(style::TERMINAL_TAB_BG)),
            border: Border {
                width: 1.0,
                color: style::TERMINAL_TAB_BORDER,
                radius: 0.0.into(),
            },
            ..Default::default()
        })
        .into()
}

fn view_tab_bar<'a>(
    tabs: &[TerminalTab],
    active_tab_id: Option<u64>,
    workspace_id: &str,
) -> Element<'a, Message> {
    let mut tab_row = Row::new().spacing(1);

    for tab in tabs {
        let is_active = active_tab_id == Some(tab.id as u64);
        let label = if tab.is_script_output {
            format!("\u{25B6} {}", tab.title)
        } else {
            tab.title.clone()
        };

        let tab_label = text(label).size(12);
        let close_btn = button(text("\u{00D7}").size(12))
            .on_press(Message::TerminalClose(tab.id as u64))
            .padding([0, 4])
            .style(|_theme, _status| button::Style {
                background: None,
                text_color: style::MUTED,
                ..Default::default()
            });

        let tab_content = row![tab_label, close_btn]
            .spacing(6)
            .align_y(iced::Alignment::Center);

        let bg = if is_active {
            style::TERMINAL_TAB_ACTIVE_BG
        } else {
            style::TERMINAL_TAB_BG
        };

        let tab_btn = button(tab_content)
            .on_press(Message::TerminalSelectTab(tab.id as u64))
            .padding([4, 10])
            .style(move |_theme, _status| button::Style {
                background: Some(Background::Color(bg)),
                text_color: if is_active { style::TEXT } else { style::MUTED },
                border: Border {
                    width: 0.0,
                    color: style::TERMINAL_TAB_BORDER,
                    radius: 4.0.into(),
                },
                ..Default::default()
            });

        tab_row = tab_row.push(tab_btn);
    }

    // "+" button to add a new terminal tab
    let ws_id = workspace_id.to_string();
    let add_btn = button(text("+").size(12))
        .on_press(Message::TerminalCreate(ws_id))
        .padding([4, 8])
        .style(|_theme, _status| button::Style {
            background: None,
            text_color: style::MUTED,
            ..Default::default()
        });

    // Toggle button to hide the panel
    let toggle_btn = button(text("\u{2014}").size(12))
        .on_press(Message::TerminalTogglePanel)
        .padding([4, 8])
        .style(|_theme, _status| button::Style {
            background: None,
            text_color: style::MUTED,
            ..Default::default()
        });

    let bar = Row::new()
        .push(tab_row)
        .push(add_btn)
        .push(Space::new().width(Fill))
        .push(toggle_btn)
        .align_y(iced::Alignment::Center)
        .height(TAB_BAR_HEIGHT)
        .width(Fill);

    container(bar)
        .width(Fill)
        .style(|_theme| container::Style {
            background: Some(Background::Color(style::TERMINAL_TAB_BG)),
            border: Border {
                width: 0.0,
                color: style::TERMINAL_TAB_BORDER,
                radius: 0.0.into(),
            },
            ..Default::default()
        })
        .into()
}
