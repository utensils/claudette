use iced::widget::{Space, center, column, container, markdown, text};
use iced::{Element, Fill};

use crate::message::Message;
use crate::model::diff::DiffViewState;
use crate::model::{AgentStatus, ChatMessage, Repository, Workspace};
use crate::ui::{chat_panel, diff_viewer, style};

#[allow(clippy::too_many_arguments)]
pub fn view_main_content<'a>(
    repositories: &'a [Repository],
    workspaces: &'a [Workspace],
    selected_workspace: Option<&str>,
    chat_messages: &'a [ChatMessage],
    chat_input: &str,
    streaming_text: &'a str,
    markdown_items: &'a [Vec<markdown::Item>],
    diff: &DiffViewState<'a>,
) -> Element<'a, Message> {
    let content: Element<'_, Message> = if let Some(ws_id) = selected_workspace {
        if let Some(ws) = workspaces.iter().find(|w| w.id == ws_id) {
            if diff.visible {
                diff_viewer::view_diff_viewer(
                    diff.files,
                    diff.selected_file,
                    diff.content,
                    diff.view_mode,
                    diff.loading,
                    diff.error,
                )
            } else {
                let is_running = ws.agent_status == AgentStatus::Running;
                chat_panel::view_chat_panel(
                    ws,
                    repositories,
                    chat_messages,
                    chat_input,
                    streaming_text,
                    markdown_items,
                    is_running,
                )
            }
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
