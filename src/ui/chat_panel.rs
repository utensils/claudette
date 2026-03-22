use iced::widget::{Space, button, column, container, markdown, row, scrollable, text, text_input};
use iced::{Background, Border, Element, Fill, Length, Theme};

use crate::message::Message;
use crate::model::{ChatMessage, ChatRole, Repository, Workspace};
use crate::ui::style;

/// Renders the full chat panel for a selected workspace.
pub fn view_chat_panel<'a>(
    ws: &'a Workspace,
    repositories: &'a [Repository],
    chat_messages: &'a [ChatMessage],
    chat_input: &str,
    streaming_text: &'a str,
    markdown_items: &'a [Vec<markdown::Item>],
    is_agent_running: bool,
) -> Element<'a, Message> {
    let repo_name = repositories
        .iter()
        .find(|r| r.id == ws.repository_id)
        .map(|r| r.name.as_str())
        .unwrap_or("Unknown");

    // Header bar
    let status_color = style::agent_status_color(&ws.agent_status);

    let agent_button: Element<'_, Message> = if is_agent_running {
        button(text("\u{25A0}").size(14)) // Stop icon
            .on_press(Message::AgentStop(ws.id.clone()))
            .style(|theme: &Theme, status| {
                let mut s = button::secondary(theme, status);
                s.border = Border {
                    radius: 4.0.into(),
                    ..s.border
                };
                s
            })
            .padding([4, 10])
            .into()
    } else {
        button(text("\u{25B6}").size(12)) // Play icon
            .on_press(Message::AgentStart(ws.id.clone()))
            .style(|theme: &Theme, status| {
                let mut s = button::secondary(theme, status);
                s.border = Border {
                    radius: 4.0.into(),
                    ..s.border
                };
                s
            })
            .padding([4, 10])
            .into()
    };

    let header = container(
        row![
            column![
                text(&ws.name).size(16),
                text(format!("{repo_name} / {}", ws.branch_name))
                    .size(12)
                    .color(style::DIM),
            ]
            .spacing(2),
            Space::new().width(Fill),
            row![
                text("\u{25CF}").size(10).color(status_color),
                Space::new().width(4),
                text(ws.agent_status.label()).size(12).color(status_color),
            ]
            .align_y(iced::Alignment::Center),
            Space::new().width(12),
            agent_button,
        ]
        .align_y(iced::Alignment::Center),
    )
    .padding([12, 16])
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_HEADER_BG)),
        border: Border {
            width: 0.0,
            ..Default::default()
        },
        ..Default::default()
    });

    // Chat messages area
    let mut messages_col = column![].spacing(8).padding([12, 16]);

    for (i, msg) in chat_messages.iter().enumerate() {
        let bubble = match msg.role {
            ChatRole::User => view_user_message(&msg.content),
            ChatRole::Assistant => {
                if let Some(items) = markdown_items.get(i) {
                    view_assistant_message(items)
                } else {
                    view_user_message(&msg.content) // fallback
                }
            }
            ChatRole::System => view_system_message(&msg.content),
        };
        messages_col = messages_col.push(bubble);
    }

    // Streaming content (agent is currently responding)
    if !streaming_text.is_empty() {
        messages_col = messages_col.push(view_streaming_indicator(streaming_text));
    }

    let chat_area = scrollable(messages_col)
        .width(Fill)
        .height(Fill)
        .anchor_bottom();

    // Input area
    let send_enabled = !chat_input.trim().is_empty() && is_agent_running;
    let mut send_btn = button(text("Send").size(14)).style(|theme: &Theme, status| {
        let mut s = button::primary(theme, status);
        s.border = Border {
            radius: 4.0.into(),
            ..s.border
        };
        s
    });
    if send_enabled {
        send_btn = send_btn.on_press(Message::ChatSend);
    }

    let input_row = row![
        text_input("Type a message...", chat_input)
            .on_input(Message::ChatInputChanged)
            .on_submit(Message::ChatSend)
            .padding(10)
            .size(14)
            .width(Fill),
        Space::new().width(8),
        send_btn.padding([8, 16]),
    ]
    .align_y(iced::Alignment::Center);

    let input_area = container(
        column![
            input_row,
            text("Enter to send").size(11).color(style::FAINT),
        ]
        .spacing(4),
    )
    .padding([12, 16])
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_INPUT_BG)),
        border: Border {
            width: 1.0,
            color: style::CHAT_INPUT_BORDER,
            ..Default::default()
        },
        ..Default::default()
    });

    // Compose layout
    column![header, chat_area, input_area]
        .width(Fill)
        .height(Fill)
        .into()
}

fn view_user_message(content: &str) -> Element<'_, Message> {
    container(column![
        text("You").size(12).color(style::MUTED),
        Space::new().height(4),
        text(content).size(14),
    ])
    .padding([10, 14])
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_USER_BG)),
        border: Border {
            radius: 6.0.into(),
            ..Default::default()
        },
        ..Default::default()
    })
    .into()
}

fn view_assistant_message<'a>(items: &'a [markdown::Item]) -> Element<'a, Message> {
    container(column![
        text("Agent").size(12).color(style::MUTED),
        Space::new().height(4),
        markdown::view(items, Theme::Dark).map(Message::ChatLinkClicked),
    ])
    .padding([10, 14])
    .width(Fill)
    .into()
}

fn view_system_message(content: &str) -> Element<'_, Message> {
    container(
        text(content)
            .size(12)
            .color(style::WARNING)
            .width(Length::Fill)
            .align_x(iced::alignment::Horizontal::Center),
    )
    .padding([6, 14])
    .width(Fill)
    .style(|_theme: &Theme| container::Style {
        background: Some(Background::Color(style::CHAT_SYSTEM_BG)),
        border: Border {
            radius: 4.0.into(),
            ..Default::default()
        },
        ..Default::default()
    })
    .into()
}

fn view_streaming_indicator(content: &str) -> Element<'_, Message> {
    container(column![
        text("Agent").size(12).color(style::STATUS_RUNNING),
        Space::new().height(4),
        text(content).size(14),
        text("\u{2588}").size(14).color(style::STATUS_RUNNING), // blinking cursor
    ])
    .padding([10, 14])
    .width(Fill)
    .into()
}
