use iced::widget::{Space, center, column, container, row, text};
use iced::{Element, Fill};

use crate::message::Message;
use crate::model::{Repository, Workspace};
use crate::ui::style;

pub fn view_main_content<'a>(
    repositories: &'a [Repository],
    workspaces: &'a [Workspace],
    selected_workspace: Option<&str>,
) -> Element<'a, Message> {
    let content: Element<'_, Message> = if let Some(ws_id) = selected_workspace {
        if let Some(ws) = workspaces.iter().find(|w| w.id == ws_id) {
            let repo_name = repositories
                .iter()
                .find(|r| r.id == ws.repository_id)
                .map(|r| r.name.as_str())
                .unwrap_or("Unknown");

            center(
                column![
                    text(&ws.name).size(24),
                    text(format!("{} / {}", repo_name, ws.branch_name))
                        .size(14)
                        .color(style::DIM),
                    Space::new().height(12),
                    row![
                        text("\u{25CF}")
                            .size(12)
                            .color(style::agent_status_color(&ws.agent_status)),
                        Space::new().width(6),
                        text(ws.agent_status.label())
                            .size(14)
                            .color(style::agent_status_color(&ws.agent_status)),
                    ]
                    .align_y(iced::Alignment::Center),
                ]
                .spacing(4)
                .align_x(iced::Alignment::Center),
            )
            .into()
        } else {
            center(text("Workspace not found").size(16).color(style::FAINT)).into()
        }
    } else {
        center(
            column![
                text("Claudette").size(28),
                Space::new().height(8),
                text("Select a workspace to get started")
                    .size(16)
                    .color(style::FAINT),
            ]
            .align_x(iced::Alignment::Center),
        )
        .into()
    };

    container(content).width(Fill).height(Fill).into()
}
